import { config } from 'config/config'
import { Job as BullMQJob } from 'bullmq'
import { logger } from '../../helpers/loggers'
import {
  executeNerscScript,
  monitorTaskAtNERSC
} from 'services/functions/nersc-api-functions'

const processDockerBuildJob = async (MQjob: BullMQJob) => {
  logger.info(`Processing Docker Build Job: ${MQjob.data.uuid}`)
  try {
    await MQjob.log('Starting Docker Build Job')
    await MQjob.updateProgress(1)
    const buildTaskID = await executeNerscScript(
      config.scripts.dockerBuildScript,
      MQjob.data.uuid
    )
    const buildResult = await monitorTaskAtNERSC(buildTaskID)
    logger.info(`buildResult: ${JSON.stringify(buildResult)}`)
    await MQjob.log(`Docker Build Job Result: ${JSON.stringify(buildResult)}`)
    await MQjob.log('Finishing Docker Build Job')
    await MQjob.updateProgress(100)
  } catch (error) {
    logger.error(`Failed to process Docker Build Job: ${MQjob.data.uuid}`)
    throw error
  }
}

export { processDockerBuildJob }
