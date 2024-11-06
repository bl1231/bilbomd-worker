import { Job as DBJob } from '@bl1231/bilbomd-mongodb-schema'
import { logger } from '../helpers/loggers.js'

const monitorAndCleanupJobs = async () => {
  const jobs = await DBJob.find({
    $and: [{ 'nersc.state': { $ne: 'COMPLETE' } }, { 'nersc.state': { $ne: null } }]
  }).exec()

  for (const job of jobs) {
    try {
      logger.info(`Job ${job.nersc.jobid} has state: ${job.nersc.state}`)
    } catch (error) {
      logger.error(`Error monitoring or cleaning up job ${job.nersc.jobid}: ${error}`)
      job.status = 'Error'
      await job.save()
    }
  }
}

export { monitorAndCleanupJobs }
