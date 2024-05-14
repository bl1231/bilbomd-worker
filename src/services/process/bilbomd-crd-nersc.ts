import { Job as BullMQJob } from 'bullmq'
import { BilboMdCRDJob } from '@bl1231/bilbomd-mongodb-schema'
import { logger } from '../../helpers/loggers'
import { prepareResults } from '../bilbomd.functions'
import { initializeJob, cleanupJob } from '../functions/job-utils'
import {
  prepareBilboMDSlurmScript,
  submitJobToNersc,
  monitorTaskAtNERSC,
  monitorJobAtNERSC
} from '../functions/nersc-jobs'

const processBilboMDCRDJobNerscTest = async (MQjob: BullMQJob) => {
  const foundJob = await BilboMdCRDJob.findOne({ _id: MQjob.data.jobid })
    .populate('user')
    .exec()
  if (!foundJob) {
    throw new Error(`No job found for: ${MQjob.data.jobid}`)
  }

  await initializeJob(MQjob, foundJob)
  await cleanupJob(MQjob, foundJob)
}

const processBilboMDCRDJobNersc = async (MQjob: BullMQJob) => {
  try {
    await MQjob.updateProgress(1)
    logger.info('here1')

    const foundJob = await BilboMdCRDJob.findOne({ _id: MQjob.data.jobid })
      .populate('user')
      .exec()
    logger.info('here2')
    if (!foundJob) {
      throw new Error(`No job found for: ${MQjob.data.jobid}`)
    }
    logger.info('here3')
    await MQjob.updateProgress(5)
    logger.info('here4')
    // Initialize
    await initializeJob(MQjob, foundJob)
    await MQjob.updateProgress(10)
    logger.info('here5')
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

    // Prepare results
    await MQjob.log('start gather results')
    await prepareResults(MQjob, foundJob)
    await MQjob.log('end gather results')
    await MQjob.updateProgress(99)

    // Cleanup & send email
    await cleanupJob(MQjob, foundJob)
    await MQjob.updateProgress(100)
  } catch (error) {
    logger.error(`Failed to process job: ${MQjob.data.uuid}`)
    logger.error(error)
    throw error
  }
}

export { processBilboMDCRDJobNersc, processBilboMDCRDJobNerscTest }
