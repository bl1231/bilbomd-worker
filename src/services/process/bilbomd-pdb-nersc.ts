import { Job as BullMQJob } from 'bullmq'
import { BilboMdPDBJob } from '@bl1231/bilbomd-mongodb-schema'
import { logger } from '../../helpers/loggers'
import { prepareResults } from '../bilbomd.functions'
import { initializeJob, cleanupJob } from '../functions/job-utils'
import {
  prepareBilboMDSlurmScript,
  submitJobToNersc,
  monitorTaskAtNERSC,
  monitorJobAtNERSC
} from '../functions/nersc-jobs'
import { handleStepError, updateStepStatus } from '../functions/mongo-utils'

const processBilboMDJobNerscTest = async (MQjob: BullMQJob) => {
  const foundJob = await BilboMdPDBJob.findOne({ _id: MQjob.data.jobid })
    .populate('user')
    .exec()
  if (!foundJob) {
    throw new Error(`No job found for: ${MQjob.data.jobid}`)
  }

  await initializeJob(MQjob, foundJob)
  await cleanupJob(MQjob, foundJob)
}

const processBilboMDPDBJobNersc = async (MQjob: BullMQJob) => {
  try {
    await MQjob.updateProgress(1)

    const foundJob = await BilboMdPDBJob.findOne({ _id: MQjob.data.jobid })
      .populate('user')
      .exec()

    if (!foundJob) {
      throw new Error(`No job found for: ${MQjob.data.jobid}`)
    }
    await MQjob.updateProgress(5)

    // Initialize
    await initializeJob(MQjob, foundJob)
    await MQjob.updateProgress(10)

    // Run make-bilbomd.sh to prepare bilbomd.slurm
    const prepTaskID = await prepareBilboMDSlurmScript(foundJob)
    const prepResult = await monitorTaskAtNERSC(prepTaskID)
    logger.info(`prepResult: ${JSON.stringify(prepResult)}`)

    // Submit bilbomd.slurm to the queueing system
    const submitTaskID = await submitJobToNersc(foundJob)
    const submitResult = await monitorTaskAtNERSC(submitTaskID)
    logger.info(`submitResult: ${JSON.stringify(submitResult)}`)
    const submitResultObject = JSON.parse(submitResult.result)
    const jobID = submitResultObject.jobid
    logger.info(`JOBID: ${jobID}`)

    // Watch the job
    const jobResult = await monitorJobAtNERSC(jobID)
    logger.info(`jobResult: ${JSON.stringify(jobResult)}`)
    // {
    //   "api_status":"OK",
    //   "api_error":null,
    //   "sacct_jobid":"25407217",
    //   "sacct_state":"TIMEOUT",
    //   "sacct_submit":"2024-05-09T17:45:32",
    //   "sacct_start":"2024-05-09T17:46:48",
    //   "sacct_end":"2024-05-09T18:16:52"
    // }
    //
    // NERSC Jobs can fail for any number of reasons
    // I think the thing to do here is just mark teh job as failed
    // and send an email to the user asking them to resubmit?

    // Prepare results
    try {
      await MQjob.log('start gather results')
      await updateStepStatus(foundJob._id, 'results', 'Running')
      await prepareResults(MQjob, foundJob)
      await updateStepStatus(foundJob._id, 'results', 'Success')
      await MQjob.log('end gather results')
    } catch (error) {
      await handleStepError(foundJob._id, 'results', error)
    }
    await MQjob.updateProgress(99)

    // Cleanup & send email
    await updateStepStatus(foundJob._id, 'email', 'Running')
    await cleanupJob(MQjob, foundJob)
    await updateStepStatus(foundJob._id, 'email', 'Success')
    await MQjob.updateProgress(100)
  } catch (error) {
    logger.error(`Failed to process job: ${MQjob.data.uuid}`)
    throw error
  }
}

export { processBilboMDPDBJobNersc, processBilboMDJobNerscTest }
