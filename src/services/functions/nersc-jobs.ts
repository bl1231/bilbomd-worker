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
  let statusResponse
  do {
    try {
      statusResponse = await axios.get(url, { headers })
      logger.info(`monitorTask: ${JSON.stringify(statusResponse.data)}`)
      status = statusResponse.data.status
    } catch (error) {
      logger.error(`Error monitoring task: ${error}`)
      // Handle errors such as network issues, token expiration, etc.
      throw error // Optionally retry or handle differently based on the error type
    }
    await new Promise((resolve) => setTimeout(resolve, 2000)) // Wait 2 seconds
  } while (status !== 'completed' && status !== 'failed')

  return statusResponse.data
}

const monitorJobAtNERSC = async (
  token: string,
  jobID: string
): Promise<JobStatusResponse> => {
  let status = 'pending'
  const url = `${config.baseNerscApi}/compute/jobs/perlmutter/${jobID}?sacct=true`
  logger.info(`url: ${url}`)
  const headers = {
    accept: 'application/json',
    Authorization: `Bearer ${token}`
  }

  let statusResponse: JobStatusResponse
  do {
    try {
      const response = await axios.get(url, { headers })
      const sacctResultObject = JSON.parse(response.data.output)
      statusResponse = {
        status: response.data.status,
        error: response.data.error,
        sacct_state: sacctResultObject.state
      }
      // logger.info(`monitorJob: ${JSON.stringify(statusResponse.data)}`)
      status = statusResponse.status
      logger.info(`monitorJob status: ${status}`)
    } catch (error) {
      logger.error(`Error monitoring job: ${error}`)
      // Handle errors such as network issues, token expiration, etc.
      throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 2000)) // Wait 2 seconds
  } while (status !== 'completed' && status !== 'failed')

  return statusResponse
}

export {
  prepareBilboMDSlurmScript,
  submitJobToNersc,
  monitorTaskAtNERSC,
  monitorJobAtNERSC
}
