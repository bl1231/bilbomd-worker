import axios from 'axios'
import qs from 'qs'

async function submitJobToNersc(token: string, UUID: string) {
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

export { submitJobToNersc }
