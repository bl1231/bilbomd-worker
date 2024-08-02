import axios from 'axios'
import axiosRetry from 'axios-retry'
import qs from 'qs'
import { logger } from '../../helpers/loggers'
import { config } from '../../config/config'
import { IBilboMDSteps, IJob, IStepStatus } from '@bl1231/bilbomd-mongodb-schema'
import { ensureValidToken } from './nersc-api-token-functions'
import { TaskStatusResponse, JobStatusResponse } from '../../types/nersc'
import { updateStepStatus } from './mongo-utils'

const environment: string = process.env.NODE_ENV || 'development'

type StepKey = keyof IBilboMDSteps

// Configure axios to retry on failure
axiosRetry(axios, { retries: 3, retryDelay: axiosRetry.exponentialDelay })

const executeNerscScript = async (
  scriptName: string,
  scriptArgs: string
): Promise<string> => {
  const token = await ensureValidToken()

  const url = `${config.nerscBaseAPI}/utilities/command/perlmutter`

  const headers = {
    accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
    Authorization: `Bearer ${token}`
  }

  const logFile = `/global/homes/s/sclassen/script-logs/${scriptName}-${new Date().toISOString()}.log`
  const cmd = `ENVIRONMENT=${environment} ${config.nerscScriptDir}/${scriptName} ${scriptArgs} | tee ${logFile} 2>&1 &`
  logger.info(`Executing command: ${cmd}`)

  const data = qs.stringify({
    executable: `bash -c "${cmd}"`
  })

  try {
    const response = await axios.post(url, data, { headers })
    logger.info(`Script executed successfully: ${JSON.stringify(response.data)}`)
    return response.data.task_id
  } catch (error) {
    logger.error(`Error executing script on NERSC: ${error}`)
    throw error
  }
}

const submitJobToNersc = async (Job: IJob): Promise<string> => {
  const UUID = Job.uuid
  const token = await ensureValidToken()
  const url = `${config.nerscBaseAPI}/compute/jobs/perlmutter`
  const headers = {
    accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
    Authorization: `Bearer ${token}`
  }
  const slurmFile = `/pscratch/sd/s/sclassen/bilbmod/${UUID}/bilbomd.slurm`
  const data = qs.stringify({
    isPath: 'true',
    job: slurmFile,
    args: UUID
  })

  try {
    const response = await axios.post(url, data, { headers })
    logger.info(`Job submitted to Superfacility API: ${JSON.stringify(response.data)}`)
    return response.data.task_id
  } catch (error) {
    logger.error(`Failed to Submit BilboMD Job to Superfacility API: ${error}`)
    throw error
  }
}

const monitorTaskAtNERSC = async (taskID: string): Promise<TaskStatusResponse> => {
  let token = await ensureValidToken()
  const url = `${config.nerscBaseAPI}/tasks/${taskID}`
  // logger.info(`monitorTaskAtNERSC url: ${url}`)

  let status = 'pending'
  let statusResponse: TaskStatusResponse | undefined

  const makeRequest = async () => {
    const headers = {
      accept: 'application/json',
      Authorization: `Bearer ${token}`
    }

    try {
      const response = await axios.get(url, { headers })
      // logger.info(`monitorTask: ${JSON.stringify(response.data)}`)
      statusResponse = {
        id: response.data.id,
        status: response.data.status,
        result: response.data.result
      }
      status = statusResponse.status
      const taskid = statusResponse.id
      logger.info(`monitorTaskAtNERSC taskid: ${taskid} status: ${status}`)
    } catch (error) {
      if (axios.isAxiosError(error)) {
        // Now we can assume error is an AxiosError and access specific properties like error.response
        if (error.response && error.response.status === 403) {
          logger.error(`monitorTaskAtNERSC error: ${error}`)
          // Check if the error is due to token expiration
          token = await ensureValidToken(true) // Refresh the token
          await makeRequest() // Retry the request with the new token
        } else {
          logger.error(`Axios error monitoring task: ${error.message}`)
          throw error
        }
      } else {
        logger.error(`Non-Axios error monitoring task: ${error}`)
        throw error // Re-throw if it's not an Axios error
      }
    }
  }

  do {
    await makeRequest()
    await new Promise((resolve) => setTimeout(resolve, 2000))
  } while (status !== 'completed' && status !== 'failed')

  if (!statusResponse) {
    throw new Error('Failed to get a response from the NERSC API')
  }

  return statusResponse
}

const monitorJobAtNERSC = async (
  Job: IJob,
  jobID: string
): Promise<JobStatusResponse> => {
  let jobStatus = 'pending'
  const url = `${config.nerscBaseAPI}/compute/jobs/perlmutter/${jobID}?sacct=true`
  logger.info(`monitorJobAtNERSC url: ${url}`)

  let continueMonitoring = true // Control variable for the loop
  let statusResponse: JobStatusResponse = {
    api_status: 'PENDING',
    api_error: ''
  }

  while (continueMonitoring) {
    const token = await ensureValidToken() // Fetch or refresh the token before each request
    const headers = {
      accept: 'application/json',
      Authorization: `Bearer ${token}`
    }

    try {
      const response = await axios.get(url, { headers })
      if (response.data.output && response.data.output.length > 0) {
        const jobDetails = response.data.output[0]
        jobStatus = jobDetails.state
        // Update the step status in MongoDB
        const status: IStepStatus = {
          status: 'Running',
          message: `Slurm Status: ${jobStatus}`
        }
        await updateStepStatus(Job, 'nersc_job_status', status)
        statusResponse = {
          api_status: response.data.status,
          api_error: response.data.error,
          sacct_jobid: jobDetails.jobid,
          sacct_state: jobStatus,
          sacct_submit: jobDetails.submit,
          sacct_start: jobDetails.start,
          sacct_end: jobDetails.end
        }
      } else {
        logger.warn('No job details found or output array is empty.')
      }
      // logger.info(`Current job ${jobID} status: ${jobStatus}`)

      if (jobStatus === 'RUNNING') {
        await updateStatus(Job)
      }
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 403) {
        logger.info('Token may have expired, refreshing token...')
        continue // Force token refresh on the next iteration if token has expired
      }
      logger.error(`Error monitoring job at NERSC: ${error}`)
      throw error
    }

    // monitoring will continue for:
    // PENDING
    // RUNNING
    // ...and presumably any other Slurm statuses of which I am unaware.
    switch (jobStatus) {
      case 'COMPLETED':
      case 'FAILED':
      case 'DEADLINE':
      case 'TIMEOUT':
      case 'CANCELLED':
      case 'NODE_FAIL':
      case 'OUT_OF_MEMORY':
      case 'PREEMPTED':
        continueMonitoring = false // Stop monitoring if any of these statuses are met
        // one final update of the status.txt file?
        await updateStatus(Job)
        break
      default:
        await new Promise((resolve) => setTimeout(resolve, 5000)) // Continue polling otherwise
        break
    }
  }

  return statusResponse
}

const getSlurmOutFile = async (UUID: string, jobID: string): Promise<string> => {
  const token = await ensureValidToken()
  // /pscratch/sd/s/sclassen/bilbmod/1b97dc5b-a139-4f21-8eb4-dba02bcbf186/slurm-25894425.out
  const path = `/pscratch/sd/s/sclassen/bilbmod/${UUID}/slurm-${jobID}.out`
  const url = `${config.nerscBaseAPI}/utilities/download/perlmutter/${encodeURIComponent(
    path
  )}`

  const headers = {
    accept: 'application/json',
    Authorization: `Bearer ${token}`
  }
  const params = {
    binary: 'false'
  }
  try {
    const response = await axios.get(url, { headers, params })
    // {
    //   "status": "OK",
    //   "file": "string",
    //   "is_binary": false,
    //   "error": "string"
    // }
    if (response.data.status !== 'OK') {
      logger.error(`Error retrieving file: ${response.data.error}`)
      throw new Error(`Error retrieving file: ${response.data.error}`)
    }
    // logger.info(`File retrieved successfully.`)
    return response.data.file // Return the content of the file as a string
  } catch (error) {
    logger.error(`Failed to download file: ${error}`)
    throw error
  }
}

const getSlurmStatusFile = async (UUID: string): Promise<string> => {
  const token = await ensureValidToken()
  const path = `pscratch/sd/s/sclassen/bilbmod/${UUID}/status.txt`
  const url = `${config.nerscBaseAPI}/utilities/download/perlmutter/${encodeURIComponent(
    path
  )}`

  const headers = {
    accept: 'application/json',
    Authorization: `Bearer ${token}`
  }
  const params = {
    binary: 'false'
  }
  try {
    const response = await axios.get(url, { headers, params })
    // {
    //   "status": "OK",
    //   "file": "string",
    //   "is_binary": false,
    //   "error": "string"
    // }
    if (response.data.status !== 'OK') {
      logger.error(`Error retrieving file: ${response.data.error}`)
      throw new Error(`Error retrieving file: ${response.data.error}`)
    }
    // logger.info(`File retrieved successfully.`)
    return response.data.file // Return the content of the file as a string
  } catch (error) {
    logger.error(`Failed to download file: ${error}`)
    throw new Error(`Failed to download file after 3 retries: ${error}`)
  }
}

const updateStatus = async (Job: IJob) => {
  // logger.info(`updating status ${Job.title}`)
  const UUID = Job.uuid
  const contents: string = await getSlurmStatusFile(UUID)

  const lines = contents.split('\n')

  lines.forEach((line) => {
    const [step, status] = line.split(':').map((part) => part.trim())
    if (step in Job.steps) {
      const key = step as StepKey // Assert that step is a valid key of IBilboMDSteps
      Job.steps[key] = {
        status: status,
        message: status
      }
    }
  })

  // Save the updated Job document
  try {
    await Job.save()
    // logger.info(
    //   `Job ${Job._id} status updated successfully with details: ${JSON.stringify(
    //     Job.steps
    //   )}`
    // )
  } catch (error) {
    logger.error(`Unable to save job status for ${Job._id}: ${error}`)
    throw error
  }
}

export {
  executeNerscScript,
  submitJobToNersc,
  monitorTaskAtNERSC,
  monitorJobAtNERSC,
  getSlurmOutFile
}
