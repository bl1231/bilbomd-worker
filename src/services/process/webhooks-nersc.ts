import { Job as BullMQJob } from 'bullmq'
import { logger } from '../../helpers/loggers'

const processDockerBuildJob = async (MQjob: BullMQJob) => {
  logger.info(`Processing Docker Build Job: ${MQjob.data.uuid}`)
  try {
    await MQjob.log('Starting Docker Build Job')
    await MQjob.updateProgress(1)
    // Do something with the job
    await MQjob.log('Finishing Docker Build Job')
    await MQjob.updateProgress(100)
  } catch (error) {
    logger.error(`Failed to process Docker Build Job: ${MQjob.data.uuid}`)
    throw error
  }
}

export { processDockerBuildJob }
