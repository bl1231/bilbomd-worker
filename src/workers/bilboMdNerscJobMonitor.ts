import { Job as DBJob } from '@bl1231/bilbomd-mongodb-schema'
import { logger } from '../helpers/loggers.js'
import { config } from '../config/config.js'
import axios from 'axios'
import { ensureValidToken } from '../services/functions/nersc-api-token-functions.js'

const monitorAndCleanupJobs = async () => {
  try {
    // Get all jobs with a defined NERSC state
    const jobs = await DBJob.find({ 'nersc.state': { $ne: null } }).exec()

    for (const job of jobs) {
      try {
        logger.info(
          `Checking NERSC job ${job.nersc.jobid}, current state: ${job.nersc.state}`
        )

        // Fetch the current state of the NERSC job
        const nerscState = await fetchNERSCJobState(job.nersc.jobid)

        if (nerscState) {
          // Update the job's state in MongoDB
          job.nersc.state = nerscState.state
          job.nersc.qos = nerscState.qos
          job.nersc.time_started = nerscState.time_started
          job.nersc.time_completed = nerscState.time_completed

          logger.info(`Updated job ${job.nersc.jobid} with state: ${nerscState.state}`)

          // Save the updated job document
          await job.save()

          // If job is no longer pending or running, perform cleanup
          if (!['PENDING', 'RUNNING'].includes(nerscState.state)) {
            logger.info(
              `Job ${job.nersc.jobid} is ${nerscState.state}. Initiating cleanup...`
            )
            // await performJobCleanup(job) // Cleanup logic
            logger.info(`Cleanup complete for job ${job.nersc.jobid}.`)
          }
        } else {
          logger.warn(`Failed to fetch state for job ${job.nersc.jobid}.`)
        }
      } catch (error) {
        logger.error(`Error monitoring job ${job.nersc.jobid}: ${error.message}`)
        job.status = 'Error'
        await job.save()
      }
    }
  } catch (error) {
    logger.error(`Error during job monitoring: ${error.message}`)
  }
}

const fetchNERSCJobState = async (jobID: string) => {
  const url = `${config.nerscBaseAPI}/compute/jobs/perlmutter/${jobID}?sacct=true`
  logger.info(`Fetching state for NERSC job: ${jobID} from URL: ${url}`)

  const token = await ensureValidToken() // Fetch or refresh the token
  const headers = {
    accept: 'application/json',
    Authorization: `Bearer ${token}`
  }

  try {
    const response = await axios.get(url, { headers })

    if (response.data.output && response.data.output.length > 0) {
      const jobDetails = response.data.output[0]

      // Log the entire jobDetails object for debugging
      logger.info(`Job Details for ${jobID}: ${JSON.stringify(jobDetails, null, 2)}`)

      return {
        state: jobDetails.state || null,
        qos: jobDetails.qos || null,
        time_submitted: jobDetails.submit ? new Date(jobDetails.submit) : null,
        time_started: jobDetails.start ? new Date(jobDetails.start) : null,
        time_completed: jobDetails.end ? new Date(jobDetails.end) : null
      }
    } else {
      logger.warn(`No output received for NERSC job: ${jobID}`)
      return null
    }
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 403) {
      logger.error(`Authorization error for job ${jobID}. Check your token.`)
      throw new Error('Authorization failed. Token might need refresh.')
    } else {
      logger.error(`Error fetching state for NERSC job ${jobID}: ${error.message}`)
      throw error
    }
  }
}

export { monitorAndCleanupJobs }
