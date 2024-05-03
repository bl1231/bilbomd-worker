import { Job as BullMQJob } from 'bullmq'
import { BilboMdPDBJob } from '../../models/Job'
import { logger } from '../../helpers/loggers'
import { ensureValidToken } from '../../services/functions/nersc-sf-api-tokens'
import { initializeJob, prepareResults, cleanupJob } from '../bilbomd.functions'
import {
  prepareBilboMDSlurmScript,
  submitJobToNersc,
  monitorTaskAtNERSC
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

    // Run make-bilbomd.sh script on a login node
    const prepTaskID = await prepareBilboMDSlurmScript(token, foundJob.uuid)
    await monitorTaskAtNERSC(token, prepTaskID)

    // Submit bilbomd.slurm
    const jobTaskID = await submitJobToNersc(token, foundJob.uuid)
    await monitorTaskAtNERSC(token, jobTaskID)

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
