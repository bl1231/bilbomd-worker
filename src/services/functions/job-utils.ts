import { User, IJob } from '@bl1231/bilbomd-mongodb-schema'
import { Job as BullMQJob } from 'bullmq'
import { logger } from '../../helpers/loggers'
import { sendJobCompleteEmail } from '../../helpers/mailer'
import { config } from '../../config/config'

const BILBOMD_URL = process.env.BILBOMD_URL ?? 'https://bilbomd.bl1231.als.lbl.gov'

const initializeJob = async (MQJob: BullMQJob, DBjob: IJob): Promise<void> => {
  try {
    // Make sure the user exists in MongoDB
    const foundUser = await User.findById(DBjob.user).lean().exec()
    if (!foundUser) {
      throw new Error(`No user found for: ${DBjob.uuid}`)
    }

    // Clear the BullMQ Job logs in the case this job is being re-run
    await MQJob.clearLogs()

    // Set MongoDB status to Running and update the start time
    DBjob.status = 'Running'
    DBjob.time_started = new Date()
    await DBjob.save()
  } catch (error) {
    // Handle and log the error
    logger.error(`Error in initializeJob: ${error}`)
    throw error
  }
}

const cleanupJob = async (MQjob: BullMQJob, DBjob: IJob): Promise<void> => {
  try {
    // Update MongoDB job status and completion time
    DBjob.status = 'Completed'
    DBjob.time_completed = new Date()
    await DBjob.save()

    // Retrieve the user email from the associated User model
    const user = await User.findById(DBjob.user).lean().exec()
    if (!user) {
      logger.error(`No user found for: ${DBjob.uuid}`)
      return
    }

    // Send job completion email and log the notification
    if (config.sendEmailNotifications) {
      sendJobCompleteEmail(user.email, BILBOMD_URL, DBjob.id, DBjob.title, false)
      logger.info(`email notification sent to ${user.email}`)
      await MQjob.log(`email notification sent to ${user.email}`)
    }
  } catch (error) {
    logger.error(`Error in cleanupJob: ${error}`)
    throw error
  }
}

export { initializeJob, cleanupJob }
