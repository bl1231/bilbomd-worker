import {
  Job as DBJob,
  User,
  IJob,
  IBilboMDSteps,
  IStepStatus,
  IBilboMDCRDJob,
  IBilboMDPDBJob,
  IBilboMDAutoJob,
  IBilboMDAlphaFoldJob,
  StepStatusEnum,
  INerscInfo
} from '@bl1231/bilbomd-mongodb-schema'
import { logger } from '../helpers/loggers.js'
import { config } from '../config/config.js'
import axios from 'axios'
import fs from 'fs-extra'
import { exec } from 'node:child_process'
import { promisify } from 'util'
import { ensureValidToken } from '../services/functions/nersc-api-token-functions.js'
import { JobStatusOutputSacct } from '../types/nersc.js'
import { updateStepStatus } from '../services/functions/mongo-utils.js'
import {
  executeNerscScript,
  monitorTaskAtNERSC,
  getSlurmStatusFile
} from '../services/functions/nersc-api-functions.js'
import {
  isBilboMDPDBJob,
  isBilboMDCRDJob,
  isBilboMDAutoJob,
  isBilboMDAlphaFoldJob
} from '../services/functions/bilbomd-step-functions-nersc.js'
import {
  getNumEnsembles,
  extractPdbPaths,
  concatenateAndSaveAsEnsemble,
  spawnFeedbackScript,
  spawnRgyrDmaxScript,
  createReadmeFile
} from '../services/functions/bilbomd-step-functions.js'
import path from 'path'
import { FileCopyParamsNew } from '../types/index.js'
import { sendJobCompleteEmail } from '../helpers/mailer.js'
const execPromise = promisify(exec)

interface EmailMessage {
  message: string
  error?: boolean
}

interface MonitoringError {
  message: string
}

const fetchJobs = async (): Promise<IJob[]> => {
  return DBJob.find({
    'nersc.state': { $ne: null }, // Jobs with a non-null NERSC state
    cleanup_in_progress: false // Ensure they are not being cleaned
  }).exec()
}

const queryNERSCForJobState = async (job: IJob): Promise<INerscInfo | null> => {
  try {
    const nerscState = await fetchNERSCJobState(job.nersc?.jobid)
    if (!nerscState) {
      logger.warn(`Failed to fetch NERSC state for job ${job.nersc?.jobid}.`)
      await handleStateFetchFailure(job)
      return null
    }
    return nerscState
  } catch (error) {
    logger.error(`Error querying NERSC for job ${job.nersc?.jobid}: ${error.message}`)
    await handleMonitoringError(job, error)
    return null
  }
}

const updateJobStateInMongoDB = async (
  job: IJob,
  nerscState: INerscInfo
): Promise<void> => {
  try {
    await updateJobNerscState(job, nerscState) // Update state in MongoDB
    const progress = await calculateProgress(job.toObject().steps) // Calculate progress
    job.progress = progress
    logger.info(
      `Job: ${job.nersc.jobid} State: ${job.nersc.state} Progress: ${progress}%`
    )
    await job.save() // Save the updated job
  } catch (error) {
    logger.error(`Error updating job ${job.nersc?.jobid} in MongoDB: ${error.message}`)
    await handleMonitoringError(job, error)
  }
}

const handleCompletedJob = async (job: IJob): Promise<void> => {
  try {
    // Skip if already completed or cleanup is already in progress
    if (job.status === 'Completed') {
      logger.info(
        `Job ${job.nersc?.jobid} is already marked as Completed. Skipping cleanup.`
      )
      return
    }

    if (job.cleanup_in_progress) {
      logger.info(`Cleanup already in progress for job ${job.nersc?.jobid}. Skipping.`)
      return
    }

    logger.info(`Job ${job.nersc?.jobid} is COMPLETED. Initiating cleanup.`)
    job.cleanup_in_progress = true
    await job.save()

    await performJobCleanup(job)

    job.status = 'Completed'
    job.cleanup_in_progress = false
    await job.save()

    logger.info(`Cleanup completed for job ${job.nersc?.jobid}.`)
  } catch (error) {
    logger.error(`Error during cleanup for job ${job.nersc?.jobid}: ${error.message}`)

    // Make sure to reset the flag so it's not stuck forever
    job.cleanup_in_progress = false
    await job.save()
  }
}

const markJobAsFailed = async (job: IJob) => {
  try {
    logger.info(`Marking job ${job.nersc?.jobid} as FAILED`)

    // Optionally store NERSC state details like completion time
    // job.nersc.state = nerscState.state
    // job.nersc.time_completed = nerscState.time_completed || new Date()

    // Update your job status field if you have one
    job.status = 'Failed' // or whatever your schema expects

    await job.save()
  } catch (err) {
    logger.error(`Error marking job ${job.nersc?.jobid} as FAILED: ${err.message}`)
  }
}

const markJobAsCancelled = async (job: IJob) => {
  try {
    logger.info(`Marking job ${job.nersc?.jobid} as CANCELLED`)

    // job.nersc.state = nerscState.state
    // job.nersc.time_completed = nerscState.time_completed || new Date()

    job.status = 'Cancelled'

    await job.save()
  } catch (err) {
    logger.error(`Error marking job ${job.nersc?.jobid} as CANCELLED: ${err.message}`)
  }
}

const markJobAsPending = async (job: IJob) => {
  try {
    logger.info(`Marking job ${job.nersc?.jobid} as PENDING`)

    // job.nersc.state = nerscState.state
    // job.nersc.time_completed = nerscState.time_completed || new Date()

    job.status = 'Pending'

    await job.save()
  } catch (err) {
    logger.error(`Error marking job ${job.nersc?.jobid} as PENDING: ${err.message}`)
  }
}

const monitorAndCleanupJobs = async () => {
  try {
    logger.info('Starting job monitoring and cleanup...')

    // Step 1: Fetch all jobs where nersc.state is not null
    //  from MongoDB
    const jobs = await fetchJobs()
    logger.info(`Found ${jobs.length} jobs in with non-null state.`)

    for (const job of jobs) {
      const nerscState = await queryNERSCForJobState(job)
      if (!nerscState) continue // Skip if NERSC state could not be fetched

      // Step 2: Update the job state in MongoDB
      await updateJobStateInMongoDB(job, nerscState)

      // Step 3: Handle the job based on its NERSC state
      switch (nerscState.state) {
        case 'COMPLETED':
          await handleCompletedJob(job)
          break

        case 'FAILED':
        case 'TIMEOUT':
        case 'OUT_OF_MEMORY':
        case 'NODE_FAIL':
          logger.warn(`Job ${job.nersc?.jobid} failed with state: ${nerscState.state}`)
          await markJobAsFailed(job)
          break

        case 'CANCELLED':
        case 'PREEMPTED':
          logger.info(`Job ${job.nersc?.jobid} was cancelled or preempted.`)
          await markJobAsCancelled(job)
          break

        case 'PENDING':
          // logger.info(`Job ${job.nersc?.jobid} is still pending.`)
          await markJobAsPending(job)
          break

        case 'RUNNING':
          // logger.info(`Job ${job.nersc?.jobid} is still in running `)
          break

        case 'SUSPENDED':
          logger.warn(`Job ${job.nersc?.jobid} is suspended. Will retry later.`)
          break

        case 'UNKNOWN':
        default:
          logger.error(
            `Job ${job.nersc?.jobid} is in an unexpected state: ${nerscState.state}`
          )
          break
      }
    }
  } catch (error) {
    logger.error(`Error during job monitoring: ${error.message}`)
  }
}

const handleMonitoringError = async (
  job: IJob,
  error: MonitoringError
): Promise<void> => {
  await updateSingleJobStep(job, 'nersc_job_status', 'Error', `Error: ${error.message}`)
  job.status = 'Error'
  await job.save()
}

const updateJobNerscState = async (job: IJob, nerscState: INerscInfo) => {
  job.nersc.state = nerscState.state
  job.nersc.qos = nerscState.qos
  job.nersc.time_started = nerscState.time_started
  job.nersc.time_completed = nerscState.time_completed

  await job.save()
  // logger.info(`Updated job ${job.nersc.jobid} with state: ${nerscState.state}`)

  // Update NERSC job status step
  await updateSingleJobStep(
    job,
    'nersc_job_status',
    'Success',
    `NERSC job status: ${nerscState.state}`
  )

  // Update the job steps from the Slurm status file
  await updateJobStepsFromSlurmStatusFile(job)
}

const fetchNERSCJobState = async (jobID: string): Promise<INerscInfo> => {
  const url = `${config.nerscBaseAPI}/compute/jobs/perlmutter/${jobID}?sacct=true`
  // logger.info(`Fetching state for NERSC job: ${jobID} from URL: ${url}`)

  const token = await ensureValidToken() // Fetch or refresh the token
  const headers = {
    accept: 'application/json',
    Authorization: `Bearer ${token}`
  }

  try {
    const response = await axios.get(url, { headers })

    if (response.data.output && response.data.output.length > 0) {
      const jobDetails: JobStatusOutputSacct = response.data.output[0]

      // Log the entire jobDetails object for debugging
      // logger.info(`Job Details for ${jobID}: ${JSON.stringify(jobDetails, null, 2)}`)
      const parseDate = (dateStr: string | undefined): Date | null => {
        const parsedDate = dateStr ? new Date(dateStr) : null
        return parsedDate instanceof Date && !isNaN(parsedDate.getTime())
          ? parsedDate
          : null
      }

      return {
        jobid: jobID,
        state: jobDetails.state || null,
        qos: jobDetails.qos || null,
        time_submitted: parseDate(jobDetails.submit),
        time_started: parseDate(jobDetails.start),
        time_completed: parseDate(jobDetails.end)
      }
    } else {
      logger.warn(`No output received for NERSC job: ${jobID}`)
      return null
    }
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 403) {
      logger.error(`Authorization error for job ${jobID}. Check your token.`)
      throw new Error('Authorization failed. Token might need refresh.')
    } else {
      logger.error(`Error fetching state for NERSC job ${jobID}: ${error.message}`)
      throw error
    }
  }
}

const handleStateFetchFailure = async (job: IJob) => {
  await updateSingleJobStep(
    job,
    'nersc_job_status',
    'Error',
    'Failed to fetch NERSC job state.'
  )
}

const performJobCleanup = async (DBjob: IJob) => {
  try {
    logger.info(
      `Starting cleanup for job: ${DBjob.nersc.jobid}, current state: ${DBjob.nersc.state}`
    )

    if (DBjob.nersc.state === 'COMPLETED') {
      // Perform cleanup tasks if job is COMPLETED
      logger.info(
        `Job ${DBjob.nersc.jobid} is COMPLETED. Proceeding with cleanup tasks...`
      )
      await copyBilboMDResults(DBjob)
      await prepareBilboMDResults(DBjob)
      await sendBilboMDEmail(DBjob, {
        message: 'Cleanup completed successfully.',
        error: false
      })

      // Update job status to 'Completed'
      DBjob.status = 'Completed'
      DBjob.progress = 100
      logger.info(`Cleanup completed successfully for job ${DBjob.nersc.jobid}`)
    } else {
      // Log the unexpected state and send an email notification
      const errorMsg = `Job ${DBjob.nersc.jobid} is in state: ${DBjob.nersc.state}, not COMPLETED. Please contact Scott.`
      logger.error(errorMsg)

      // Send email to notify about the unexpected state
      await sendBilboMDEmail(DBjob, {
        message: errorMsg,
        error: true
      })

      DBjob.status = 'Error'
      DBjob.progress = 100
    }

    // Save the updated job status
    await DBjob.save()
  } catch (error) {
    // Handle unexpected errors during cleanup
    logger.error(`Error during cleanup for job ${DBjob.nersc.jobid}: ${error.message}`)

    // Mark job as 'Error' and save
    DBjob.status = 'Error'
    await DBjob.save()
  }
}

const copyBilboMDResults = async (DBjob: IJob) => {
  try {
    await updateSingleJobStep(
      DBjob,
      'copy_results_to_cfs',
      'Running',
      'Copying results from PSCRATCH to CFS has started.'
    )
    await updateSingleJobStep(
      DBjob,
      'nersc_copy_results_to_cfs',
      'Running',
      'Copying results from PSCRATCH to CFS has started.'
    )

    const copyID = await executeNerscScript(
      config.scripts.copyFromScratchToCFSScript,
      DBjob.uuid
    )

    const copyResult = await monitorTaskAtNERSC(copyID)
    logger.info(`copyResult: ${JSON.stringify(copyResult)}`)

    await updateSingleJobStep(
      DBjob,
      'copy_results_to_cfs',
      'Success',
      'Copying results from PSCRATCH to CFS successful.'
    )
    await updateSingleJobStep(
      DBjob,
      'nersc_copy_results_to_cfs',
      'Success',
      'Copying results from PSCRATCH to CFS successful.'
    )
  } catch (error) {
    let errorMessage = 'Unknown error'
    if (error instanceof Error) {
      errorMessage = error.message
    }
    await updateSingleJobStep(
      DBjob,
      'copy_results_to_cfs',
      'Error',
      `Failed to copy BilboMD results from PSCRATCH to CFS: ${errorMessage}`
    )
    await updateSingleJobStep(
      DBjob,
      'nersc_copy_results_to_cfs',
      'Error',
      `Failed to copy BilboMD results from PSCRATCH to CFS: ${errorMessage}`
    )
    logger.error(`Error during copyBilboMDResults job: ${errorMessage}`)
  }
}

const prepareBilboMDResults = async (DBjob: IJob): Promise<void> => {
  try {
    await updateSingleJobStep(
      DBjob,
      'results',
      'Running',
      'Gathering BilboMD job results has started.'
    )

    // Ensure DBjob is one of the acceptable types before calling prepareResults
    if (
      isBilboMDCRDJob(DBjob) ||
      isBilboMDPDBJob(DBjob) ||
      isBilboMDAutoJob(DBjob) ||
      isBilboMDAlphaFoldJob(DBjob)
    ) {
      await prepareResults(DBjob)
      await updateSingleJobStep(
        DBjob,
        'results',
        'Success',
        'BilboMD job results gathered successfully.'
      )
    } else {
      throw new Error('Invalid job type')
    }
  } catch (error) {
    let errorMessage = 'Unknown error'
    if (error instanceof Error) {
      errorMessage = error.message
    }
    await updateSingleJobStep(
      DBjob,
      'results',
      'Error',
      `Failed to gather BilboMD results: ${errorMessage}`
    )
    logger.error(`Error during prepareBilboMDResults job: ${errorMessage}`)
  }
}

const prepareResults = async (
  DBjob: IBilboMDCRDJob | IBilboMDPDBJob | IBilboMDAutoJob | IBilboMDAlphaFoldJob
): Promise<void> => {
  try {
    const outputDir = path.join(config.uploadDir, DBjob.uuid)
    const multiFoxsDir = path.join(outputDir, 'multifoxs')
    const logFile = path.join(multiFoxsDir, 'multi_foxs.log')
    const resultsDir = path.join(outputDir, 'results')

    // Create new empty results directory
    try {
      await makeDir(resultsDir)
    } catch (error) {
      logger.error(`Error creating results directory: ${error}`)
    }

    // Copy the minimized PDB
    await copyFiles({
      source: `${outputDir}/minimization_output.pdb`,
      destination: resultsDir,
      filename: 'minimization_output.pdb',
      isCritical: false
    })

    // Copy the DAT file for the minimized PDB
    await copyFiles({
      source: `${outputDir}/minimization_output.pdb.dat`,
      destination: resultsDir,
      filename: 'minimization_output.pdb.dat',
      isCritical: false
    })

    // Copy ensemble_size_*.txt files
    await copyFiles({
      source: `${multiFoxsDir}/ensembles_size*.txt`,
      destination: resultsDir,
      filename: 'ensembles_size*.txt',
      isCritical: false
    })

    // Copy multi_state_model_*_1_1.dat files
    await copyFiles({
      source: `${multiFoxsDir}/multi_state_model_*_1_1.dat`,
      destination: resultsDir,
      filename: 'multi_state_model_*_1_1.dat',
      isCritical: false
    })

    // Gather original uploaded files
    const filesToCopy = [
      { file: DBjob.data_file, label: 'data_file' } // Assuming data_file is common
    ]

    if ('pdb_file' in DBjob && DBjob.pdb_file) {
      filesToCopy.push({ file: DBjob.pdb_file, label: 'pdb_file' })
    }

    if ('crd_file' in DBjob && DBjob.crd_file) {
      filesToCopy.push({ file: DBjob.crd_file, label: 'crd_file' })
    }

    if ('psf_file' in DBjob && DBjob.psf_file) {
      filesToCopy.push({ file: DBjob.psf_file, label: 'psf_file' })
    }

    if ('pae_file' in DBjob && DBjob.pae_file) {
      filesToCopy.push({ file: DBjob.pae_file, label: 'pae_file' })
    }

    if ('const_inp_file' in DBjob && DBjob.const_inp_file) {
      filesToCopy.push({ file: DBjob.const_inp_file, label: 'const_inp_file' })
    }

    // FASTA file generated from the alphafold_entities
    if ('fasta_file' in DBjob && DBjob.fasta_file) {
      filesToCopy.push({ file: DBjob.fasta_file, label: 'fasta_file' })
    }

    // Additional AlphaFold-specific files
    // These files are not present in MongoDB because we currently do not update
    // MongoDB during a NERSC job.
    if (DBjob.__t === 'BilboMdAlphaFold') {
      const alphafoldExtraFiles = [
        'af-pae.json',
        'af-rank1.pdb',
        'bilbomd_pdb2crd.psf',
        'bilbomd_pdb2crd.crd'
      ]
      alphafoldExtraFiles.forEach((file) => {
        filesToCopy.push({ file, label: file })
      })
    }

    for (const { file, label } of filesToCopy) {
      if (file) {
        await copyFiles({
          source: path.join(outputDir, file),
          destination: resultsDir,
          filename: label,
          isCritical: false
        })
      } else {
        logger.warn(`Expected file for '${label}' is undefined.`)
      }
    }

    // Only want to add N best PDBs equal to number_of_states N in logfile.
    const numEnsembles = await getNumEnsembles(logFile)
    logger.info(`prepareResults numEnsembles: ${numEnsembles}`)

    if (numEnsembles) {
      // Iterate through each ensembles_siz_*.txt file
      for (let i = 1; i <= numEnsembles; i++) {
        const ensembleFile = path.join(multiFoxsDir, `ensembles_size_${i}.txt`)
        logger.info(`prepareResults ensembleFile: ${ensembleFile}`)
        const ensembleFileContent = await fs.readFile(ensembleFile, 'utf8')
        const pdbFilesRelative = extractPdbPaths(ensembleFileContent)

        const pdbFilesFullPath = pdbFilesRelative.map((item) =>
          path.join(outputDir, item)
        )
        // Extract the first N PDB files to string[]
        const numToCopy = Math.min(pdbFilesFullPath.length, i)
        const ensembleModelFiles = pdbFilesFullPath.slice(0, numToCopy)
        const ensembleSize = ensembleModelFiles.length
        await concatenateAndSaveAsEnsemble(ensembleModelFiles, ensembleSize, resultsDir)
      }
    }

    // scripts/pipeline_decision_tree.py
    try {
      await spawnFeedbackScript(DBjob)
      logger.info(`Feedback script executed successfully`)
    } catch (error) {
      logger.error(`Error running feedback script: ${error}`)
    }

    // create the rgyr vs. dmax multifoxs ensembles plots
    try {
      await spawnRgyrDmaxScript(DBjob)
      logger.info(`Rgyr vs. Dmax script executed successfully`)
    } catch (error) {
      logger.error(`Error running Rgyr vs. Dmax script: ${error}`)
    }

    // Create Job-specific README file.
    try {
      await createReadmeFile(DBjob, numEnsembles, resultsDir)
      logger.info(`wrote README.md file`)
    } catch (error) {
      logger.error(`Error creating README file: ${error}`)
    }

    // Create the results tar.gz file
    try {
      const uuidPrefix = DBjob.uuid.split('-')[0]
      const archiveName = `results-${uuidPrefix}.tar.gz`
      await execPromise(`tar czvf ${archiveName} results`, { cwd: outputDir })
      logger.info(`created ${archiveName} file`)
    } catch (error) {
      logger.error(`Error creating tar file: ${error}`)
      throw error
    }
  } catch (error) {
    await handleError(error, DBjob, 'results')
  }
}

const sendBilboMDEmail = async (DBjob: IJob, message: EmailMessage): Promise<void> => {
  try {
    // Log the beginning of the process
    await updateSingleJobStep(
      DBjob,
      'email',
      'Running',
      'Cleaning up & sending email has started.'
    )

    // Perform the cleanup job and send email
    await cleanupJob(DBjob, message)

    // Log success
    await updateSingleJobStep(
      DBjob,
      'email',
      'Success',
      'Cleaning up & sending email successful.'
    )

    logger.info(
      `Email sent for job ${DBjob.nersc.jobid} with message: ${message.message}`
    )
  } catch (error) {
    let errorMessage = 'Unknown error'
    if (error instanceof Error) {
      errorMessage = error.message
    }

    const statusMessage = `Failed to send email: ${errorMessage}`
    // Update job status to indicate error
    await updateSingleJobStep(DBjob, 'email', 'Error', statusMessage)
    await updateSingleJobStep(DBjob, 'nersc_job_status', 'Error', statusMessage)

    logger.error(`Error during sendBilboMDEmail job: ${errorMessage}`)
  }
}

const cleanupJob = async (DBjob: IJob, message: EmailMessage): Promise<void> => {
  try {
    // Update MongoDB job status and completion time
    DBjob.status = 'Completed'
    DBjob.time_completed = new Date()
    await DBjob.save()

    // Retrieve the user email from the associated User model
    const user = await User.findById(DBjob.user).lean().exec()
    if (!user) {
      logger.error(`No user found for: ${DBjob.uuid}`)
      return
    }

    // Send job completion email and log the notification
    if (config.sendEmailNotifications) {
      sendJobCompleteEmail(
        user.email,
        config.bilbomdUrl,
        DBjob.id,
        DBjob.title,
        message.error
      )
      logger.info(`email notification sent to ${user.email}`)
    }
  } catch (error) {
    logger.error(`Error in cleanupJob: ${error}`)
    throw error
  }
}

const calculateProgress = async (steps: IBilboMDSteps): Promise<number> => {
  if (!steps) return 0

  // Extract all step statuses from the steps object
  const stepStatuses = Object.values(steps)

  // Filter out undefined steps (in case some steps are optional or not defined yet)
  const validSteps = stepStatuses.filter((step) => step !== undefined)

  const totalSteps = validSteps.length

  if (totalSteps === 0) return 0 // Avoid division by zero

  // Count the steps marked as 'Success'
  const completedSteps = validSteps.filter((step) => step?.status === 'Success').length

  // Calculate the percentage of completed steps
  return Math.round((completedSteps / totalSteps) * 100)
}

const updateSingleJobStep = async (
  DBJob: IJob,
  stepName: keyof IBilboMDSteps,
  status: StepStatusEnum,
  message: string
): Promise<void> => {
  try {
    DBJob.steps[stepName] = { status, message }
    await DBJob.save()
  } catch (error) {
    logger.error(
      `Error updating step status for job ${DBJob.uuid} in step ${stepName}: ${error}`
    )
  }
}

const updateJobStepsFromSlurmStatusFile = async (DBJob: IJob): Promise<void> => {
  try {
    const UUID = DBJob.uuid
    const contents: string = await getSlurmStatusFile(UUID)
    const lines = contents.split('\n').filter(Boolean) // Filter out empty lines

    // Update steps from the status file
    const updatedSteps = lines.reduce(
      (acc, line) => {
        const [step, status] = line.split(':').map((part) => part.trim())
        if (step in DBJob.steps) {
          const key = step as keyof IBilboMDSteps
          acc[key] = { status: status as StepStatusEnum, message: status }
        }
        return acc
      },
      { ...DBJob.steps } as IBilboMDSteps
    )

    // Apply the updated steps to the job
    DBJob.steps = updatedSteps
    await DBJob.save()
  } catch (error) {
    logger.error(`Unable to update job status for ${DBJob._id}: ${error}`)
    throw error
  }
}

const copyFiles = async ({
  source,
  destination,
  filename,
  isCritical
}: FileCopyParamsNew): Promise<void> => {
  try {
    await execPromise(`cp ${source} ${destination}`)
  } catch (error) {
    logger.error(`Error copying ${filename}: ${error}`)
    if (isCritical) {
      throw new Error(`Critical error copying ${filename}: ${error}`)
    }
  }
}

const makeDir = async (directory: string) => {
  await fs.ensureDir(directory)
  logger.info(`Create Dir: ${directory}`)
}

const handleError = async (
  error: Error | unknown,
  DBJob: IJob,
  step?: keyof IBilboMDSteps
) => {
  const errorMsg = step || (error instanceof Error ? error.message : String(error))

  // Updates top level job status in MongoDB
  DBJob.status = 'Error'
  // Update the specific step status
  if (step) {
    const status: IStepStatus = {
      status: 'Error',
      message: `Error in step ${step}: ${errorMsg}`
    }
    await updateStepStatus(DBJob, step, status)
  } else {
    logger.error(`Step not provided or invalid when handling error: ${errorMsg}`)
  }

  logger.error(`handleError errorMsg: ${errorMsg}`)

  // const recipientEmail = (DBjob.user as IUser).email
  // if (MQjob.attemptsMade >= 3) {
  //   if (config.sendEmailNotifications) {
  //     sendJobCompleteEmail(recipientEmail, BILBOMD_URL, DBjob.id, DBjob.title, true)
  //     logger.warn(`email notification sent to ${recipientEmail}`)
  //     await MQjob.log(`email notification sent to ${recipientEmail}`)
  //   }
  // }
  throw new Error('BilboMD failed')
}

export { monitorAndCleanupJobs }
