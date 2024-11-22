import { config } from '../../config/config.js'
import { logger } from '../../helpers/loggers.js'
import fs from 'fs-extra'
import path from 'path'
import { IMultiJob, IStepStatus, User, IUser } from '@bl1231/bilbomd-mongodb-schema'
import { updateStepStatus } from './mongo-utils.js'
import { makeDir } from './job-utils.js'
import { spawn, ChildProcess, exec } from 'node:child_process'
import { promisify } from 'util'
import { FileCopyParamsNew } from '../../types/index.js'
import { sendJobCompleteEmail } from '../../helpers/mailer.js'
import {
  getNumEnsembles,
  extractPdbPaths,
  concatenateAndSaveAsEnsemble
} from './bilbomd-step-functions.js'

const execPromise = promisify(exec)

const prepareMultiMDdatFileList = async (DBJob: IMultiJob): Promise<void> => {
  const startingDir = path.join(config.uploadDir, DBJob.uuid)
  const outputFilePath = path.join(startingDir, 'multi_md_foxs_files.txt')
  logger.info(`Starting directory: ${startingDir}`)
  logger.info(`Output file: ${outputFilePath}`)

  // Helper function to recursively traverse directories
  const findPdbDatFiles = async (dir: string): Promise<string[]> => {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    const files: string[] = []

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        // Recursively search in subdirectories
        const subDirFiles = await findPdbDatFiles(fullPath)
        files.push(...subDirFiles)
      } else if (entry.isFile() && entry.name.endsWith('.pdb.dat')) {
        files.push(fullPath)
      }
    }

    return files
  }

  try {
    // Clear or create the output file
    await fs.writeFile(outputFilePath, '')

    // Iterate over each UUID and find `.pdb.dat` files in the foxs directory
    for (const uuid of DBJob.bilbomd_uuids) {
      const foxsDir = path.join(config.uploadDir, uuid, 'foxs')
      logger.info(`Processing UUID: ${uuid}, Foxs directory: ${foxsDir}`)

      if (await fs.pathExists(foxsDir)) {
        const pdbDatFiles = await findPdbDatFiles(foxsDir)

        // Append file paths to the output file
        for (const filePath of pdbDatFiles) {
          await fs.appendFile(outputFilePath, `${filePath}\n`)
        }

        logger.info(`Found ${pdbDatFiles.length} .pdb.dat files for UUID: ${uuid}`)
      } else {
        logger.warn(`Foxs directory does not exist for UUID: ${uuid}`)
      }
    }

    logger.info(`MultiFoXS .dat file list created: ${outputFilePath}`)
  } catch (error) {
    logger.error(`Error preparing MultiFoXS .dat file list: ${error}`)
    throw error
  }
}

const getMainSAXSDataFileName = async (DBJob: IMultiJob): Promise<string> => {
  try {
    logger.info(`Processing MultiJob: ${DBJob.title}`)

    // Check if bilbomd_jobs is populated
    if (!DBJob.bilbomd_jobs || DBJob.bilbomd_jobs.length === 0) {
      logger.info('No associated jobs found or bilbomd_jobs is not populated.')
      return
    }

    logger.info(`Running MultiFoXS with ${DBJob.data_file_from} SAXS data`)

    // Find the job matching the UUID in data_file_from
    const mainBilboMDRun = DBJob.bilbomd_jobs.find(
      (job) => job.uuid === DBJob.data_file_from
    )

    if (mainBilboMDRun) {
      logger.info(
        `Experimental SAXS Data file for main BilboMD job (UUID: ${DBJob.data_file_from}): ${mainBilboMDRun.data_file}`
      )
      return mainBilboMDRun.data_file
    } else {
      logger.warn(
        `No job found in bilbomd_jobs with UUID matching data_file_from: ${DBJob.data_file_from}`
      )
    }
  } catch (error) {
    logger.error('Error processing jobs:', error)
  }
}

const runMultiFoxs = async (DBjob: IMultiJob): Promise<void> => {
  const outputDir = path.join(config.uploadDir, DBjob.uuid)
  let status: IStepStatus = {
    status: 'Running',
    message: 'MultiFoXS Calculations have started.'
  }
  try {
    await updateStepStatus(DBjob, 'multifoxs', status)
    const multiFoxsDir = path.join(outputDir, 'multifoxs')
    await makeDir(multiFoxsDir)
    await spawnMultiFoxs(DBjob)
    status = {
      status: 'Success',
      message: 'MultiFoXS Calculations have completed.'
    }
    await updateStepStatus(DBjob, 'multifoxs', status)
  } catch (error) {
    status = {
      status: 'Error',
      message: `Error during MultiFoXS Calculations: ${error.message}`
    }
    await updateStepStatus(DBjob, 'multifoxs', status)
    logger.error(`MultiFoXS Calculation failed: ${error.message}`)
  }
}

const prepareMultiMDResults = async (DBjob: IMultiJob): Promise<void> => {
  const jobDir = path.join(config.uploadDir, DBjob.uuid)
  let status: IStepStatus = {
    status: 'Running',
    message: 'Prepare BilboMD job results has started.'
  }
  try {
    await updateStepStatus(DBjob, 'results', status)
    const resultsDir = path.join(jobDir, 'results')
    await makeDir(resultsDir)
    await prepareResults(DBjob)
    status = {
      status: 'Success',
      message: 'BilboMD job results prepared successfully.'
    }
    await updateStepStatus(DBjob, 'results', status)
  } catch (error) {
    status = {
      status: 'Error',
      message: `Error during Prepare BilboMD job results: ${error.message}`
    }
    await updateStepStatus(DBjob, 'results', status)
    logger.error(`Prepare BilboMD job results failed: ${error.message}`)
  }
}

const spawnMultiFoxs = async (DBjob: IMultiJob): Promise<void> => {
  const outputDir = path.join(config.uploadDir, DBjob.uuid)
  const multiFoxsDir = path.join(outputDir, 'multifoxs')
  const logFile = path.join(multiFoxsDir, 'multi_foxs.log')
  const errorFile = path.join(multiFoxsDir, 'multi_foxs_error.log')
  const logStream = fs.createWriteStream(logFile)
  const errorStream = fs.createWriteStream(errorFile)
  const saxsData = path.join(
    config.uploadDir,
    DBjob.data_file_from,
    await getMainSAXSDataFileName(DBjob)
  )
  const multiFoxArgs = ['-o', saxsData, '../multi_md_foxs_files.txt']
  const multiFoxOpts = { cwd: multiFoxsDir }

  return new Promise((resolve, reject) => {
    const multiFoxs: ChildProcess = spawn(config.multifoxsBin, multiFoxArgs, multiFoxOpts)
    multiFoxs.stdout?.on('data', (data) => {
      logStream.write(data.toString())
    })
    multiFoxs.stderr?.on('data', (data) => {
      errorStream.write(data.toString())
    })
    multiFoxs.on('error', (error) => {
      logger.error(`spawnMultiFoxs error: ${error}`)
      reject(error)
    })
    multiFoxs.on('exit', (code: number) => {
      const closeStreamsPromises = [
        new Promise((resolveStream) => logStream.end(resolveStream)),
        new Promise((resolveStream) => errorStream.end(resolveStream))
      ]
      Promise.all(closeStreamsPromises)
        .then(() => {
          if (code === 0) {
            logger.info(`spawnMultiFoxs close success exit code: ${code}`)
            resolve()
          } else {
            logger.info(`spawnMultiFoxs close error exit code: ${code}`)
            reject(`spawnMultiFoxs on close reject`)
          }
        })
        .catch((streamError) => {
          logger.error(`Error closing file streams: ${streamError}`)
          reject(streamError)
        })
    })
  })
}

const prepareResults = async (DBjob: IMultiJob): Promise<void> => {
  const jobDir = path.join(config.uploadDir, DBjob.uuid)
  const resultsDir = path.join(jobDir, 'results')
  const multiFoxsDir = path.join(jobDir, 'multifoxs')
  const multifoxsLogFile = path.join(multiFoxsDir, 'multi_foxs.log')

  try {
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

    // Write the DBjob to a JSON file
    const simplifiedJob = {
      title: DBjob.title,
      uuid: DBjob.uuid,
      bilbomd_uuids: DBjob.bilbomd_uuids,
      data_file_from: DBjob.data_file_from,
      user: {
        username: DBjob.user.username,
        email: DBjob.user.email
      },
      status: DBjob.status,
      progress: DBjob.progress,
      time_submitted: DBjob.time_submitted,
      time_started: DBjob.time_started,
      time_completed: DBjob.time_completed,
      bilbomd_jobs: DBjob.bilbomd_jobs?.map((job) => ({
        title: job.title,
        uuid: job.uuid,
        data_file: job.data_file,
        rg: job.rg,
        rg_min: job.rg_min,
        rg_max: job.rg_max,
        status: job.status,
        progress: job.progress,
        time_submitted: job.time_submitted,
        time_started: job.time_started,
        time_completed: job.time_completed
      }))
    }
    await writeJsonFile(path.join(resultsDir, 'bilbomd_job.json'), simplifiedJob)

    // Construct ensemble PDB files
    const numEnsembles = await getNumEnsembles(multifoxsLogFile)
    logger.info(`prepareResults numEnsembles: ${numEnsembles}`)

    if (numEnsembles > 0) {
      const ensemblePromises = Array.from({ length: numEnsembles }, (_, i) => i + 1).map(
        async (i) => {
          const ensembleFile = path.join(multiFoxsDir, `ensembles_size_${i}.txt`)
          const ensembleContent = await fs.readFile(ensembleFile, 'utf8')
          const pdbFiles = extractPdbPaths(ensembleContent)

          if (pdbFiles.length > 0) {
            const numToCopy = Math.min(pdbFiles.length, i)
            const filesToConcatenate = pdbFiles.slice(0, numToCopy)
            await concatenateAndSaveAsEnsemble(
              filesToConcatenate,
              filesToConcatenate.length,
              resultsDir
            )
          }
        }
      )
      await Promise.all(ensemblePromises)
    }

    // Create tar.gz archive
    const archiveName = `results-${DBjob.uuid.split('-')[0]}.tar.gz`
    await execPromise(`tar czvf ${archiveName} results`, { cwd: jobDir })
  } catch (error) {
    logger.error(`Error in prepareResults: ${error.message}`)
    throw error
  }
}

const writeJsonFile = async (filePath: string, data: unknown) => {
  try {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8')
    logger.info(`JSON file written to: ${filePath}`)
  } catch (error) {
    logger.error(`Error writing JSON file to ${filePath}: ${error.message}`)
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

const initializeJob = async (DBjob: IMultiJob): Promise<void> => {
  try {
    // Make sure the user exists in MongoDB
    const foundUser = await User.findById(DBjob.user).lean().exec()
    if (!foundUser) {
      throw new Error(`No user found for: ${DBjob.uuid}`)
    }
    // Set MongoDB status to Running and update the start time
    DBjob.status = 'Running'
    DBjob.time_started = new Date()
    await DBjob.save()
  } catch (error) {
    logger.error(`Error in initializeJob: ${error}`)
    throw error
  }
}

const cleanupJob = async (DBjob: IMultiJob): Promise<void> => {
  try {
    // Mark job as completed in the database
    DBjob.status = 'Completed'
    DBjob.time_completed = new Date()
    DBjob.progress = 100
    await DBjob.save()

    // Fetch user associated with the job
    const user = await User.findById(DBjob.user).lean<IUser>().exec()
    if (!user) {
      logger.error(`No user found for: ${DBjob.uuid}`)
      return
    }

    await handleJobEmailNotification(DBjob, user)
  } catch (error) {
    logger.error(`Error in cleanupJob: ${error}`)
    throw error
  }
}

const handleJobEmailNotification = async (
  DBjob: IMultiJob,
  user: IUser
): Promise<void> => {
  if (config.sendEmailNotifications) {
    let status: IStepStatus = {
      status: 'Running',
      message: `Sending email to: ${user.email}`
    }
    await updateStepStatus(DBjob, 'email', status)

    try {
      sendJobCompleteEmail(user.email, config.bilbomdUrl, DBjob.id, DBjob.title, false)
      logger.info(`Email notification sent to ${user.email}`)
      status = {
        status: 'Success',
        message: `Email sent to: ${user.email}`
      }
      await updateStepStatus(DBjob, 'email', status)
    } catch (emailError) {
      logger.error(`Failed to send email to ${user.email}: ${emailError.message}`)
      status = {
        status: 'Error',
        message: `Failed to send email: ${emailError.message}`
      }
      await updateStepStatus(DBjob, 'email', status)
    }
  } else {
    logger.info(`Skipping email notification for ${user.email}`)
  }
}

export {
  prepareMultiMDdatFileList,
  runMultiFoxs,
  prepareMultiMDResults,
  initializeJob,
  cleanupJob
}
