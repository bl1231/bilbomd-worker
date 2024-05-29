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
  prepareBilboMDSlurmScript,
  submitJobToNersc,
  monitorTaskAtNERSC,
  monitorJobAtNERSC
} from './nersc-api-functions'
import { prepareResults } from './bilbomd-step-functions'
import { cleanupJob } from './job-utils'

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
    const prepTaskID = await prepareBilboMDSlurmScript(DBjob)
    const prepResult = await monitorTaskAtNERSC(prepTaskID)
    logger.info(`prepResult: ${JSON.stringify(prepResult)}`)
    status = {
      status: 'Success',
      message: 'Slurm batch file prepared successfully.'
    }
    await updateStepStatus(DBjob, 'nersc_prepare_slurm_batch', status)
    await MQjob.log('end nersc prepare slurm batch')
  } catch (error) {
    const status: IStepStatus = {
      status: 'Error',
      message: `Failed to prepare Slurm batch file: ${error}`
    }
    await updateStepStatus(DBjob, 'nersc_prepare_slurm_batch', status)
    logger.error(`Error during preparation of Slurm batch: ${error}`)
  }
}

const submitBilboMDSlurm = async (MQjob: BullMQJob, DBjob: IJob) => {
  try {
    await MQjob.log('start nersc submit slurm batch')
    let status: IStepStatus = {
      status: 'Running',
      message: 'Submitting Slurm batch file has started.'
    }
    await updateStepStatus(DBjob, 'nersc_prepare_slurm_batch', status)
    const submitTaskID = await submitJobToNersc(DBjob)
    const submitResult = await monitorTaskAtNERSC(submitTaskID)
    logger.info(`submitResult: ${JSON.stringify(submitResult)}`)
    const submitResultObject = JSON.parse(submitResult.result)
    const jobID = submitResultObject.jobid
    logger.info(`JOBID: ${jobID}`)
    status = {
      status: 'Success',
      message: 'Slurm batch file submitted successfully.'
    }
    await updateStepStatus(DBjob, 'nersc_prepare_slurm_batch', status)
    await MQjob.log('end nersc submit slurm batch')
    return jobID
  } catch (error) {
    const status: IStepStatus = {
      status: 'Error',
      message: `Failed to prepare Slurm batch file: ${error}`
    }
    await updateStepStatus(DBjob, 'nersc_prepare_slurm_batch', status)
    logger.error(`Error during preparation of Slurm batch: ${error}`)
  }
}

const monitorBilboMDJob = async (MQjob: BullMQJob, DBjob: IJob, Pjob: string) => {
  try {
    await MQjob.log('start nersc watch job')
    let status: IStepStatus = {
      status: 'Running',
      message: 'Watching BilboMD job started.'
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
    await MQjob.log('start results')
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
      await MQjob.log('end results')
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
  prepareBilboMDResults,
  sendBilboMDEmail
}
