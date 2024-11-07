import { Job as BullMQJob } from 'bullmq'
import { Job } from '@bl1231/bilbomd-mongodb-schema'
import { logger } from '../../helpers/loggers.js'
import { initializeJob } from '../functions/job-utils.js'
import {
  makeBilboMDSlurm,
  submitBilboMDSlurm,
  monitorBilboMDJob,
  prepareBilboMDResults,
  sendBilboMDEmail,
  copyBilboMDResults
} from '../functions/bilbomd-step-functions-nersc.js'

const processBilboMDJobNersc = async (MQjob: BullMQJob) => {
  try {
    await MQjob.updateProgress(1)

    const foundJob = await Job.findOne({ _id: MQjob.data.jobid }).populate('user').exec()
    if (!foundJob) {
      throw new Error(`No job found for: ${MQjob.data.jobid}`)
    }
    await MQjob.updateProgress(5)

    // Initialize
    try {
      await initializeJob(MQjob, foundJob)
      await MQjob.updateProgress(10)
    } catch (error) {
      logger.error(`Failed to initialize job: ${MQjob.data.uuid}`)
      throw error
    }

    // Prepare bilbomd.slurm file
    try {
      await makeBilboMDSlurm(MQjob, foundJob)
      await MQjob.updateProgress(15)
    } catch (error) {
      logger.error(`Failed to prepare bilbomd.slurm file: ${MQjob.data.uuid}`)
      throw error
    }

    // Submit bilbomd.slurm to the queueing system
    let jobID: string
    try {
      jobID = await submitBilboMDSlurm(MQjob, foundJob)
      await MQjob.updateProgress(20)
    } catch (error) {
      logger.error(`Failed to submit bilbomd.slurm: ${MQjob.data.uuid}`)
      throw error
    }

    // Watch the job
    try {
      await monitorBilboMDJob(MQjob, foundJob, jobID)
      await MQjob.updateProgress(90)
    } catch (error) {
      logger.error(`Failed to monitor BilboMD job: ${MQjob.data.uuid}`)
      throw error
    }

    // Copy files from PSCRATCH to CFS
    try {
      await copyBilboMDResults(MQjob, foundJob)
      await MQjob.updateProgress(95)
    } catch (error) {
      logger.error(`Failed to copy BilboMD results: ${MQjob.data.uuid}`)
      throw error
    }

    // Prepare results
    try {
      await prepareBilboMDResults(MQjob, foundJob)
      await MQjob.updateProgress(99)
    } catch (error) {
      logger.error(`Failed to prepare BilboMD results: ${MQjob.data.uuid}`)
      throw error
    }

    // Cleanup & send email
    try {
      await sendBilboMDEmail(MQjob, foundJob)
      await MQjob.updateProgress(100)
    } catch (error) {
      logger.error(`Failed to cleanup and send email: ${MQjob.data.uuid}`)
      throw error
    }
  } catch (error) {
    logger.error(`Failed to process job: ${MQjob.data.uuid}`)
    throw error
  }
}

export { processBilboMDJobNersc }
