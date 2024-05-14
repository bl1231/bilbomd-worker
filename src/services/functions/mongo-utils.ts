import { Job } from '@bl1231/bilbomd-mongodb-schema'
import { logger } from '../../helpers/loggers'
import mongoose from 'mongoose'

const updateStepStatus = async (jobId: string, stepName: string, status: string) => {
  try {
    // Not sure this is strictly necessary
    const objectId = new mongoose.Types.ObjectId(jobId)
    const updatedJob = await Job.findByIdAndUpdate(
      objectId,
      { [`steps.${stepName}.status`]: status },
      { new: true } // Return the updated document
    )
    if (!updatedJob) {
      logger.error(
        `Failed to update step ${stepName} status for job ${jobId}. Job not found.`
      )
    } else {
      logger.info(`updateStepStatus ${jobId} ${stepName} ${status}`)
      // logger.info(`----------------------------------------------------`)
      // logger.info(`Updated job step status: ${JSON.stringify(updatedJob.steps, null, 2)}`)
    }
  } catch (error) {
    logger.error(
      `Error updating step status for job ${jobId} in step ${stepName}:`,
      error
    )
  }
}

const handleStepError = async (jobId: string, stepName: string, error: unknown) => {
  // Convert error to string if it's not an Error object
  const errorMessage = error instanceof Error ? error.message : String(error)
  // Update the step status to 'Error'
  await Job.findByIdAndUpdate(
    jobId,
    { [`steps.${stepName}.status`]: 'Error' },
    { new: true }
  )
  // Log the error
  logger.error(`Error in ${stepName}: ${errorMessage}`)
}

export { updateStepStatus, handleStepError }
