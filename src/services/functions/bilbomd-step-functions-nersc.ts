import { config } from '../../config/config'
import { Job as BullMQJob } from 'bullmq'
import {
  IJob,
  IStepStatus,
  IBilboMDPDBJob,
  IBilboMDCRDJob,
  IBilboMDAutoJob
} from '@bl1231/bilbomd-mongodb-schema'
import { logger } from '../../helpers/loggers'
import { updateStepStatus } from './mongo-utils'
import {
  executeNerscScript,
  submitJobToNersc,
  monitorTaskAtNERSC,
  monitorJobAtNERSC
} from './nersc-api-functions'
import { prepareResults } from './bilbomd-step-functions'
import { cleanupJob } from './job-utils'

interface INerscTaskResult {
  id: string
  status: 'completed' | 'failed' | 'running' | 'pending' | string
  result:
    | string
    | {
        status: 'ok' | 'error' | string
        output: string
        error: string
      }
}

// Define type guard functions
function isBilboMDCRDJob(job: IJob): job is IBilboMDCRDJob {
  return (job as IBilboMDCRDJob).crd_file !== undefined
}

function isBilboMDPDBJob(job: IJob): job is IBilboMDPDBJob {
  return (job as IBilboMDPDBJob).pdb_file !== undefined
}

function isBilboMDAutoJob(job: IJob): job is IBilboMDAutoJob {
  return (job as IBilboMDAutoJob).conformational_sampling !== undefined
}

const makeBilboMDSlurm = async (MQjob: BullMQJob, DBjob: IJob) => {
  try {
    await MQjob.log('start nersc prepare slurm batch')

    let status: IStepStatus = {
      status: 'Running',
      message: 'Preparation of Slurm batch file has started.'
    }
    await updateStepStatus(DBjob, 'nersc_prepare_slurm_batch', status)

    const prepTaskID = await executeNerscScript(
      config.scripts.prepareSlurmScript,
      DBjob.uuid
    )

    const prepResult: INerscTaskResult = await monitorTaskAtNERSC(prepTaskID)
    logger.info(`prepResult: ${JSON.stringify(prepResult)}`)

    if (prepResult.status === 'completed') {
      let resultData

      if (typeof prepResult.result === 'string') {
        try {
          resultData = JSON.parse(prepResult.result)
        } catch (parseError) {
          logger.error(`Failed to parse result JSON: ${parseError}`)
          throw new Error(`Failed to parse result JSON: ${prepResult.result}`)
        }
      } else {
        resultData = prepResult.result
      }

      if (resultData && resultData.status === 'ok') {
        status = {
          status: 'Success',
          message: 'Slurm batch file prepared successfully.'
        }
        await updateStepStatus(DBjob, 'nersc_prepare_slurm_batch', status)
      } else {
        let errorMessage = `Task failed with status: ${prepResult.status}`
        if (resultData && resultData.error) {
          errorMessage += `, error: ${resultData.error}`
        }
        status = {
          status: 'Error',
          message: errorMessage
        }
        await updateStepStatus(DBjob, 'nersc_prepare_slurm_batch', status)
        throw new Error(errorMessage)
      }
    } else {
      const errorMessage = `Unexpected task status: ${prepResult.status}`
      status = {
        status: 'Error',
        message: errorMessage
      }
      await updateStepStatus(DBjob, 'nersc_prepare_slurm_batch', status)
      throw new Error(errorMessage)
    }

    await MQjob.log('end nersc prepare slurm batch')
  } catch (error) {
    const errorMessage = `Failed to prepare Slurm batch file: ${error}`
    const status: IStepStatus = {
      status: 'Error',
      message: errorMessage
    }
    await updateStepStatus(DBjob, 'nersc_prepare_slurm_batch', status)
    logger.error(`Error during preparation of Slurm batch: ${errorMessage}`)
  }
}

const submitBilboMDSlurm = async (MQjob: BullMQJob, DBjob: IJob) => {
  try {
    await MQjob.log('start nersc submit slurm batch')
    let status: IStepStatus = {
      status: 'Running',
      message: 'Submitting Slurm batch file'
    }
    await updateStepStatus(DBjob, 'nersc_submit_slurm_batch', status)
    const submitTaskID = await submitJobToNersc(DBjob)
    const submitResult = await monitorTaskAtNERSC(submitTaskID)
    logger.info(`submitResult: ${JSON.stringify(submitResult)}`)
    const submitResultObject = JSON.parse(submitResult.result)
    const jobID = submitResultObject.jobid
    logger.info(`JOBID: ${jobID}`)
    status = {
      status: 'Success',
      message: `NERSC JobID ${jobID}`
    }
    await updateStepStatus(DBjob, 'nersc_submit_slurm_batch', status)
    await MQjob.log('end nersc submit slurm batch')
    return jobID
  } catch (error) {
    const status: IStepStatus = {
      status: 'Error',
      message: `Failed to submit Slurm batch file: ${error}`
    }
    await updateStepStatus(DBjob, 'nersc_submit_slurm_batch', status)
    logger.error(`Error during submission of Slurm batch: ${error}`)
  }
}

const monitorBilboMDJob = async (MQjob: BullMQJob, DBjob: IJob, Pjob: string) => {
  try {
    await MQjob.log('start nersc watch job')
    let status: IStepStatus = {
      status: 'Running',
      message: 'Watching BilboMD Job'
    }
    await updateStepStatus(DBjob, 'nersc_job_status', status)
    const jobResult = await monitorJobAtNERSC(DBjob, Pjob)
    logger.info(`jobResult: ${JSON.stringify(jobResult)}`)
    status = {
      status: 'Success',
      message: 'BilboMD job on Perlmutter has finished successfully.'
    }
    await updateStepStatus(DBjob, 'nersc_job_status', status)
    await MQjob.log('end nersc watch job')
  } catch (error) {
    const status: IStepStatus = {
      status: 'Error',
      message: `Failed to monitor BilboMD job: ${error}`
    }
    await updateStepStatus(DBjob, 'nersc_job_status', status)
    logger.error(`Error during monitoring of BilboMD job: ${error}`)
  }
}

const prepareBilboMDResults = async (MQjob: BullMQJob, DBjob: IJob) => {
  try {
    // await MQjob.log('start results')
    let status: IStepStatus = {
      status: 'Running',
      message: 'Gathering BilboMD job results has started.'
    }
    await updateStepStatus(DBjob, 'results', status)
    // Ensure DBjob is one of the acceptable types before calling prepareResults
    if (isBilboMDCRDJob(DBjob) || isBilboMDPDBJob(DBjob) || isBilboMDAutoJob(DBjob)) {
      await prepareResults(MQjob, DBjob)
      status = {
        status: 'Success',
        message: 'BilboMD job results gathered successfully.'
      }
      await updateStepStatus(DBjob, 'results', status)
      // await MQjob.log('end results')
    } else {
      throw new Error('Invalid job type')
    }
  } catch (error) {
    const status: IStepStatus = {
      status: 'Error',
      message: `Failed to gather BilboMD results: ${error}`
    }
    await updateStepStatus(DBjob, 'nersc_job_status', status)
    logger.error(`Error during monitoring of BilboMD job: ${error}`)
  }
}

const copyBilboMDResults = async (MQjob: BullMQJob, DBjob: IJob) => {
  try {
    await MQjob.log('start copy from pscratch to cfs')
    const copyID = await executeNerscScript(
      config.scripts.copyFromScratchToCFSScript,
      DBjob.uuid
    )
    const copyResult = await monitorTaskAtNERSC(copyID)
    logger.info(`copyResult: ${JSON.stringify(copyResult)}`)
    // status = {
    //   status: 'Success',
    //   message: 'BilboMD Results copied back to CFS successfully.'
    // }
    await MQjob.log('end copy from pscratch to cfs')
  } catch (error) {
    logger.error(`Error during monitoring of BilboMD job: ${error}`)
  }
}

const sendBilboMDEmail = async (MQjob: BullMQJob, DBjob: IJob) => {
  try {
    let status: IStepStatus = {
      status: 'Running',
      message: 'Cleaning up & sending email has started.'
    }
    await updateStepStatus(DBjob, 'email', status)
    await cleanupJob(MQjob, DBjob)
    status = {
      status: 'Success',
      message: 'Cleaning up & sending email successful.'
    }
    await updateStepStatus(DBjob, 'email', status)
  } catch (error) {
    const status: IStepStatus = {
      status: 'Error',
      message: `Failed to send email: ${error}`
    }
    await updateStepStatus(DBjob, 'nersc_job_status', status)
    logger.error(`Error during monitoring of BilboMD job: ${error}`)
  }
}

export {
  makeBilboMDSlurm,
  submitBilboMDSlurm,
  monitorBilboMDJob,
  copyBilboMDResults,
  prepareBilboMDResults,
  sendBilboMDEmail
}
