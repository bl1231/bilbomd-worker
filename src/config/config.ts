import dotenv from 'dotenv'
dotenv.config()

export const config = {
  sendEmailNotifications: process.env.SEND_EMAIL_NOTIFICATIONS === 'true',
  runOnNERSC: process.env.USE_NERSC === 'true'
  // other configurations...
}
