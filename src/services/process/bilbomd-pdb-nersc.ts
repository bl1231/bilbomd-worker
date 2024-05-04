import { Job as BullMQJob } from 'bullmq'
import { BilboMdPDBJob } from '../../models/Job'
import { logger } from '../../helpers/loggers'
import { ensureValidToken } from '../../services/functions/nersc-sf-api-tokens'
import { initializeJob, prepareResults, cleanupJob } from '../bilbomd.functions'
import {
  prepareBilboMDSlurmScript,
  submitJobToNersc,
  monitorTaskAtNERSC,
  monitorJobAtNERSC
} from '../../services/functions/nersc-jobs'

const processBilboMDJobNerscTest = async (MQjob: BullMQJob) => {
  const foundJob = await BilboMdPDBJob.findOne({ _id: MQjob.data.jobid })
    .populate({
      path: 'user',
      select: 'email'
    })
    .exec()
  if (!foundJob) {
    throw new Error(`No job found for: ${MQjob.data.jobid}`)
  }

  await initializeJob(MQjob, foundJob)
  await cleanupJob(MQjob, foundJob)
}

const processBilboMDPDBJobNersc = async (MQjob: BullMQJob) => {
  try {
    const token = await ensureValidToken()
    await MQjob.updateProgress(1)

    const foundJob = await BilboMdPDBJob.findOne({ _id: MQjob.data.jobid })
      .populate({
        path: 'user',
        select: 'email'
      })
      .exec()

    if (!foundJob) {
      throw new Error(`No job found for: ${MQjob.data.jobid}`)
    }
    await MQjob.updateProgress(5)

    // Initialize
    await initializeJob(MQjob, foundJob)
    await MQjob.updateProgress(10)

    // Run make-bilbomd.sh to prepare bilbomd.slurm
    const prepTaskID = await prepareBilboMDSlurmScript(token, foundJob.uuid)
    const prepResult = await monitorTaskAtNERSC(token, prepTaskID)
    logger.info(`prepResult: ${JSON.stringify(prepResult)}`)

    // Submit bilbomd.slurm to the queueing system
    const taskID = await submitJobToNersc(token, foundJob.uuid)
    const submitResult = await monitorTaskAtNERSC(token, taskID)
    logger.info(`submitResult: ${JSON.stringify(submitResult)}`)
    const submitResultObject = JSON.parse(submitResult.result)
    const jobID = submitResultObject.jobid
    logger.info(`JOBID: ${jobID}`)

    // Watch the job
    const jobResult = await monitorJobAtNERSC(token, jobID)
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
    throw error
  }
}

export { processBilboMDPDBJobNersc, processBilboMDJobNerscTest }
