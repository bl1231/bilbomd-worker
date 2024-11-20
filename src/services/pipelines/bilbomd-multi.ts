import { Job as BullMQJob } from 'bullmq'
import { MultiJob } from '@bl1231/bilbomd-mongodb-schema'
import { logger } from '../../helpers/loggers.js'
import { prepareMultiMDdatFileList } from '../functions/bilbomd-multi-functions.js'

const processMultiMDJob = async (MQjob: BullMQJob) => {
  await MQjob.updateProgress(1)
  const foundJob = await MultiJob.findOne({ _id: MQjob.data.jobid })
    .populate('user')
    .exec()
  if (!foundJob) {
    throw new Error(`No job found for: ${MQjob.data.jobid}`)
  }
  logger.info(`Processing MultiJob: ${foundJob.uuid}`)

  // Initialize
  foundJob.progress = 5
  await foundJob.save()
  // Check to make sure all jobs exist
  foundJob.progress = 10
  await foundJob.save()
  // Check to make sure all jobs have a foxs directory with rg#_run# subdirectories
  foundJob.progress = 20
  await foundJob.save()

  // create a file that references all .dat files
  await prepareMultiMDdatFileList(foundJob)
  foundJob.progress = 30
  await foundJob.save()

  // Run MultiFoXS
  foundJob.progress = 40
  await foundJob.save()
  // Gather results
  foundJob.progress = 50
  await foundJob.save()
  // Send results to user
  foundJob.progress = 60
  await foundJob.save()

  foundJob.progress = 100
  await foundJob.save()
  await MQjob.updateProgress(100)
}

export { processMultiMDJob }
