import axios from 'axios'
import qs from 'qs'
import { logger } from '../../helpers/loggers'
import { config } from '../../config/config'
import { TaskStatusResponse, JobStatusResponse } from '../../types/nersc'

const prepareBilboMDSlurmScript = async (
  token: string,
  UUID: string
): Promise<string> => {
  const url = `${config.baseNerscApi}/utilities/command/perlmutter`
  logger.info(`url: ${url}`)
  const headers = {
    accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
    Authorization: `Bearer ${token}`
  }
  const cmd = `cd /global/cfs/cdirs/m4659/bilbomd-scripts/ && ./make-bilbomd.sh ${UUID}`
  logger.info(`cmd: ${cmd}`)
  const data = qs.stringify({
    executable: `bash -c "${cmd}"`
  })
  logger.info(`data: ${data}`)
  try {
    const response = await axios.post(url, data, { headers })
    logger.info(
      `Prepared BilboMD Slurm batch file successfully: ${JSON.stringify(response.data)}`
    )
    return response.data.task_id
  } catch (error) {
    logger.error(`Prepared BilboMD Slurm batch file: ${error}`)
    throw error
  }
}

const submitJobToNersc = async (token: string, UUID: string): Promise<string> => {
  const url = `${config.baseNerscApi}/compute/jobs/perlmutter`
  const headers = {
    accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
    Authorization: `Bearer ${token}`
  }
  // const slurmFile = `/global/cfs/cdirs/m4659/bilbomd-scripts/${UUID}/bilbomd.slurm`
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

const monitorTaskAtNERSC = async (
  token: string,
  taskID: string
): Promise<TaskStatusResponse> => {
  let status = 'pending'
  const url = `${config.baseNerscApi}/tasks/${taskID}`
  const headers = {
    accept: 'application/json',
    Authorization: `Bearer ${token}`
  }
  let statusResponse: TaskStatusResponse
  do {
    try {
      const response = await axios.get(url, { headers })
      logger.info(`monitorTask: ${JSON.stringify(response.data)}`)
      statusResponse = {
        id: response.data.id,
        status: response.data.status,
        result: response.data.result
      }
      status = statusResponse.status
    } catch (error) {
      logger.error(`Error monitoring task: ${error}`)
      // Handle errors such as network issues, token expiration, etc.
      throw error // Optionally retry or handle differently based on the error type
    }
    await new Promise((resolve) => setTimeout(resolve, 2000)) // Wait 2 seconds
  } while (status !== 'completed' && status !== 'failed')

  return statusResponse
}

const monitorJobAtNERSC = async (
  token: string,
  jobID: string
): Promise<JobStatusResponse> => {
  let job_status = 'pending'
  const url = `${config.baseNerscApi}/compute/jobs/perlmutter/${jobID}?sacct=true`
  logger.info(`monitorJobAtNERSC url: ${url}`)
  const headers = {
    accept: 'application/json',
    Authorization: `Bearer ${token}`
  }

  let continueMonitoring = true // Control variable for the loop
  let statusResponse: JobStatusResponse = {
    status: 'pending',
    error: ''
  }

  while (continueMonitoring) {
    try {
      const response = await axios.get(url, { headers })
      if (response.data.output && response.data.output.length > 0) {
        const jobDetails = response.data.output[0]
        statusResponse = {
          status: response.data.status,
          error: response.data.error,
          sacct_jobid: jobDetails.jobid,
          sacct_state: jobDetails.state,
          sacct_submit: jobDetails.submit,
          sacct_start: jobDetails.start,
          sacct_end: jobDetails.end
        }
        job_status = jobDetails.state
      } else {
        logger.warning('No job details found or output array is empty.')
        // job_status = 'FAILED' // Assume failure if no details are found
      }
      logger.info(`Current job status: ${job_status}`)
    } catch (error) {
      logger.error(`Error monitoring job at NERSC: ${error}`)
      throw error
    }

    switch (job_status) {
      case 'COMPLETED':
      case 'FAILED':
      case 'TIMEOUT':
      case 'CANCELLED':
      case 'NODE_FAIL':
      case 'OUT_OF_MEMORY':
        continueMonitoring = false // Stop monitoring if any of these statuses are met
        break
      default:
        await new Promise((resolve) => setTimeout(resolve, 3000)) // Continue polling otherwise
        break
    }
  }

  return statusResponse // Return the final status
}

export {
  prepareBilboMDSlurmScript,
  submitJobToNersc,
  monitorTaskAtNERSC,
  monitorJobAtNERSC
}
