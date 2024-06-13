import { Job as BullMQJob } from 'bullmq'
import { Job } from '@bl1231/bilbomd-mongodb-schema'
import { logger } from '../../helpers/loggers'
import { initializeJob } from '../functions/job-utils'
import {
  makeBilboMDSlurm,
  submitBilboMDSlurm,
  monitorBilboMDJob,
  prepareBilboMDResults,
  sendBilboMDEmail,
  copyBilboMDResults
} from '../functions/bilbomd-step-functions-nersc'

const processBilboMDJobNersc = async (MQjob: BullMQJob) => {
  try {
    await MQjob.updateProgress(1)

    const foundJob = await Job.findOne({ _id: MQjob.data.jobid }).populate('user').exec()

    if (!foundJob) {
      throw new Error(`No job found for: ${MQjob.data.jobid}`)
    }
    await MQjob.updateProgress(5)

    // Initialize
    await initializeJob(MQjob, foundJob)
    await MQjob.updateProgress(10)

    // Prepare bilbomd.slurm file
    await makeBilboMDSlurm(MQjob, foundJob)
    await MQjob.updateProgress(15)

    // Submit bilbomd.slurm to the queueing system
    const jobID = await submitBilboMDSlurm(MQjob, foundJob)
    await MQjob.updateProgress(20)

    // Watch the job
    await monitorBilboMDJob(MQjob, foundJob, jobID)
    await MQjob.updateProgress(90)

    // Copy files from PSCRATCH to CFS
    // Better to do this here? because it can take quite some time.
    // PSCRATCH is not available from SPIN so will need to run a script.
    await copyBilboMDResults(MQjob, foundJob)
    await MQjob.updateProgress(95)

    // Prepare results
    await prepareBilboMDResults(MQjob, foundJob)
    await MQjob.updateProgress(99)

    // Cleanup & send email
    await sendBilboMDEmail(MQjob, foundJob)
    await MQjob.updateProgress(100)
  } catch (error) {
    logger.error(`Failed to process job: ${MQjob.data.uuid}`)
    throw error
  }
}

export { processBilboMDJobNersc }
