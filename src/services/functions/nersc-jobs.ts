import axios from 'axios'
import qs from 'qs'
import { logger } from '../../helpers/loggers'
import { config } from '../../config/config'

const prepareBilboMDSlurmScript = async (
  token: string,
  UUID: string
): Promise<string> => {
  const url = `${config.baseNerscApi}/utilities/command/perlmutter`
  const headers = {
    accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
    Authorization: `Bearer ${token}`
  }
  const cmd = `/global/cfs/cdirs/m4659/bilbomd-scripts/make-bilbomd.sh ${UUID}`
  const data = qs.stringify({
    executable: `bash -c "${cmd}"`
  })
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
  const slurmFile = `/global/cfs/cdirs/m4659/bilbomd-scripts/${UUID}/bilbomd.slurm`
  const data = qs.stringify({
    isPath: 'true',
    job: slurmFile,
    args: UUID
  })

  try {
    const response = await axios.post(url, data, { headers })
    logger.info(`Job submitted successfully: ${JSON.stringify(response.data)}`)
    return response.data.task_id
  } catch (error) {
    logger.error(`Failed to Submit BilboMD Job: ${error}`)
    throw error
  }
}

const monitorTaskAtNERSC = async (token: string, taskID: string): Promise<string> => {
  let status = 'pending'
  const url = `${config.baseNerscApi}/tasks/${taskID}`
  const headers = {
    accept: 'application/json',
    Authorization: `Bearer ${token}`
  }
  do {
    const statusResponse = await axios.get(url, { headers })

    logger.info(`statusResponse: ${JSON.stringify(statusResponse.data, null, 2)}`)
    status = statusResponse.data.status
    // We will only get a limited set of statuses from /compute/jobs/perlmutter
    //
    // We will need a helper function to get more specific step info
    // The NERSC SF-API provides a way to:
    //  - run a command
    //  - download a small file
    //
    // There will be a file in $UUID directory named:
    //  slurm-$NERSC_JOB_ID.out
    // which we can parse for details about the progress of teh BilboMD job.

    await new Promise((resolve) => setTimeout(resolve, 10000)) // Wait 10 seconds
  } while (status !== 'completed' && status !== 'failed')

  return status // 'completed' or 'failed'
}

export { prepareBilboMDSlurmScript, submitJobToNersc, monitorTaskAtNERSC }
