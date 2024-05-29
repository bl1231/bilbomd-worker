import axios from 'axios'
import qs from 'qs'
import { logger } from '../../helpers/loggers'
import { config } from '../../config/config'
import { IJob } from '@bl1231/bilbomd-mongodb-schema'
import { ensureValidToken } from './nersc-api-token-functions'
import { TaskStatusResponse, JobStatusResponse } from '../../types/nersc'

const prepareBilboMDSlurmScript = async (Job: IJob): Promise<string> => {
  const UUID = Job.uuid
  // const jobType = Job.__t
  const token = await ensureValidToken()
  const url = `${config.nerscBaseAPI}/utilities/command/perlmutter`
  // logger.info(`url: ${url}`)
  const headers = {
    accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
    Authorization: `Bearer ${token}`
  }
  const cmd = `cd ${config.nerscScriptDir} && ./gen-bilbomd-slurm-file.sh ${UUID}`
  logger.info(`cmd: ${cmd}`)
  const data = qs.stringify({
    executable: `bash -c "${cmd}"`
  })
  // logger.info(`data: ${data}`)
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
  logger.info(`monitorTaskAtNERSC url: ${url}`)

  let status = 'pending'
  let statusResponse: TaskStatusResponse | undefined

  const makeRequest = async () => {
    const headers = {
      accept: 'application/json',
      Authorization: `Bearer ${token}`
    }

    try {
      const response = await axios.get(url, { headers })
      logger.info(`monitorTask: ${JSON.stringify(response.data)}`)
      statusResponse = {
        id: response.data.id,
        status: response.data.status,
        result: response.data.result
      }
      status = statusResponse.status
      logger.info(`monitorTaskAtNERSC status: ${status}`)
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
      logger.info(`Current job ${jobID} status: ${jobStatus}`)
      // if jobStatus is RUNNING then download slurm-######.out and update status
      if (jobStatus === 'RUNNING') {
        updateStatus(Job, jobID)
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
        break
      default:
        await new Promise((resolve) => setTimeout(resolve, 3000)) // Continue polling otherwise
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
    logger.info(`File retrieved successfully.`)
    return response.data.file // Return the content of the file as a string
  } catch (error) {
    logger.error(`Failed to download file: ${error}`)
    throw error
  }
}

const updateStatus = async (Job: IJob, jobID: string) => {
  logger.info('updating status')
  const UUID = Job.uuid
  const contents: string = await getSlurmOutFile(UUID, jobID)

  const lines = contents.split('\n')

  lines.forEach((line) => {
    if (line.includes('All Individual CRD files melded')) {
      Job.steps.pdb2crd = {
        status: 'Success',
        message: 'PDB to CRD/PSF conversion completed successfully.'
      }
    }
    if (line.includes('CHARMM Minimize complete')) {
      Job.steps.minimize = {
        status: 'Success',
        message: 'CHARMM minimization completed successfully.'
      }
    }
    if (line.includes('CHARMM Heating complete')) {
      Job.steps.heat = {
        status: 'Success',
        message: 'CHARMM heating completed successfully.'
      }
    }
    if (line.includes('CHARMM Molecular Dynamics complete')) {
      Job.steps.md = {
        status: 'Success',
        message: 'CHARMM molecular dynamics completed successfully.'
      }
    }
    if (line.includes('Initial FoXS Analysis complete')) {
      Job.steps.foxs = {
        status: 'Success',
        message: 'Initial FoXS analysis completed successfully.'
      }
    }
    if (line.includes('MultiFoXS analysis complete')) {
      Job.steps.multifoxs = {
        status: 'Success',
        message: 'MultiFoXS analysis completed successfully.'
      }
    }
    if (line.includes('Results preparation complete')) {
      Job.steps.results = {
        status: 'Success',
        message: 'Results preparation completed successfully.'
      }
    }
    if (line.includes('Email notification sent')) {
      Job.steps.email = {
        status: 'Success',
        message: 'Email notification sent successfully.'
      }
    }
  })

  // Save the updated Job document
  try {
    await Job.save()
    logger.info(
      `Job ${Job._id} status updated successfully with details: ${JSON.stringify(
        Job.steps
      )}`
    )
  } catch (error) {
    logger.error(`Unable to save job status for ${Job._id}: ${error}`)
    throw error
  }
}

export {
  prepareBilboMDSlurmScript,
  submitJobToNersc,
  monitorTaskAtNERSC,
  monitorJobAtNERSC,
  getSlurmOutFile
}
