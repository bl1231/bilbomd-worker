import axios from 'axios'
import qs from 'qs'
import { logger } from '../../helpers/loggers'

const submitJobToNersc = async (token: string, UUID: string) => {
  const url = 'https://api.nersc.gov/api/v1.2/compute/jobs/perlmutter'
  const headers = {
    accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
    Authorization: `Bearer ${token}`
  }

  const data = qs.stringify({
    isPath: 'true',
    job: '/path/to/script',
    args: UUID
  })

  try {
    const response = await axios.post(url, data, { headers })
    console.log('Job submitted successfully:', response.data)
    return response.data
  } catch (error) {
    console.error('Failed to submit job:', error)
    throw error // Handle the error based on your application's needs
  }
}

const monitorJobAtNERSC = async (token: string, taskID: number): Promise<string> => {
  let status = 'pending'
  // How to add query params? ?sacct=true
  const url = `https://api.nersc.gov/api/v1.2/compute/jobs/perlmutter/${taskID}?sacct=true`
  const headers = {
    accept: 'application/json',
    Authorization: `Bearer ${token}`
  }
  do {
    const statusResponse = await axios.get(url, { headers })
    // 200 will look like this:
    // {
    //   "status": "OK",
    //   "output": [
    //     {
    //       "additionalProp1": "string",
    //       "additionalProp2": "string",
    //       "additionalProp3": "string"
    //     }
    //   ],
    //   "error": "string"
    // }
    logger.info(statusResponse)
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

export { submitJobToNersc, monitorJobAtNERSC }
