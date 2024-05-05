import dotenv from 'dotenv'
dotenv.config()

export const config = {
  sendEmailNotifications: process.env.SEND_EMAIL_NOTIFICATIONS === 'true',
  runOnNERSC: process.env.USE_NERSC === 'true',
  nerscBaseAPI: process.env.SFAPI_URL || 'https://api.nersc.gov/api/v1.2',
  nerscScriptDir: process.env.SFAPI_URL || '/global/cfs/cdirs/m4659/bilbomd-scripts'
}
