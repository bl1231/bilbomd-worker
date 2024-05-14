import { Job as BullMQJob } from 'bullmq'
import { BilboMdAutoJob } from '@bl1231/bilbomd-mongodb-schema'
// import { User } from '@bl1231/bilbomd-mongodb-schema'
// import { sendJobCompleteEmail } from '../../helpers/mailer'
import { prepareResults, runPaeToConstInp, runAutoRg } from '../bilbomd.functions'
import { initializeJob, cleanupJob } from '../functions/job-utils'
import {
  prepareBilboMDSlurmScript,
  submitJobToNersc,
  monitorTaskAtNERSC,
  monitorJobAtNERSC
} from '../functions/nersc-jobs'
import { logger } from '../../helpers/loggers'
// import { config } from '../../config/config'

// const bilbomdUrl: string = process.env.BILBOMD_URL ?? 'https://bilbomd.bl1231.als.lbl.gov'

// const initializeJob = async (MQJob: BullMQJob, DBjob: IBilboMDAutoJob) => {
//   // Make sure the user exists in MongoDB
//   const foundUser = await User.findById(DBjob.user).lean().exec()
//   if (!foundUser) {
//     throw new Error(`No user found for: ${DBjob.uuid}`)
//   }
//   // Clear the BullMQ Job logs
//   await MQJob.clearLogs()
//   // Set MongoDB status to Running
//   DBjob.status = 'Running'
//   const now = new Date()
//   DBjob.time_started = now
//   await DBjob.save()
// }

// const cleanupJob = async (MQjob: BullMQJob, DBJob: IBilboMDAutoJob) => {
//   DBJob.status = 'Completed'
//   DBJob.time_completed = new Date()
//   await DBJob.save()
//   if (config.sendEmailNotifications) {
//     sendJobCompleteEmail(DBJob.user.email, bilbomdUrl, DBJob.id, DBJob.title, false)
//     logger.info(`email notification sent to ${DBJob.user.email}`)
//     await MQjob.log(`email notification sent to ${DBJob.user.email}`)
//   }
// }

const processBilboMDAutoNerscJobTest = async (MQjob: BullMQJob) => {
  await MQjob.updateProgress(1)

  const foundJob = await BilboMdAutoJob.findOne({ _id: MQjob.data.jobid })
    .populate('user')
    .exec()
  if (!foundJob) {
    throw new Error(`No job found for: ${MQjob.data.jobid}`)
  }
  await MQjob.updateProgress(5)

  // Initialize
  await initializeJob(MQjob, foundJob)

  // Use PAE to construct const.inp file
  await runPaeToConstInp(foundJob)

  // Use BioXTAS to calculate Rg_min and Rg_max
  await runAutoRg(foundJob)

  // More steps that require foundJob or updatedJob

  await cleanupJob(MQjob, foundJob)
  await MQjob.updateProgress(100)
}

const processBilboMDAutoJobNersc = async (MQjob: BullMQJob) => {
  await MQjob.updateProgress(1)

  const foundJob = await BilboMdAutoJob.findOne({ _id: MQjob.data.jobid })
    .populate('user')
    .exec()
  if (!foundJob) {
    throw new Error(`No job found for: ${MQjob.data.jobid}`)
  }
  await MQjob.updateProgress(5)

  // Initialize
  await initializeJob(MQjob, foundJob)
  await MQjob.updateProgress(10)

  // Run make-bilbomd.sh to prepare bilbomd.slurm
  const prepTaskID = await prepareBilboMDSlurmScript(foundJob)
  const prepResult = await monitorTaskAtNERSC(prepTaskID)
  logger.info(`prepResult: ${JSON.stringify(prepResult)}`)
  await MQjob.updateProgress(20)

  // Submit bilbomd.slurm to the queueing system
  const submitTaskID = await submitJobToNersc(foundJob)
  const submitResult = await monitorTaskAtNERSC(submitTaskID)
  logger.info(`submitResult: ${JSON.stringify(submitResult)}`)
  const submitResultObject = JSON.parse(submitResult.result)
  const jobID = submitResultObject.jobid
  logger.info(`JOBID: ${jobID}`)
  await MQjob.updateProgress(30)

  // Watch the job
  const jobResult = await monitorJobAtNERSC(jobID)
  logger.info(`jobResult: ${JSON.stringify(jobResult)}`)
  await MQjob.updateProgress(90)

  // Prepare results
  await MQjob.log('start gather results')
  await prepareResults(MQjob, foundJob)
  await MQjob.log('end gather results')
  await MQjob.updateProgress(99)

  // Cleanup & send email
  await cleanupJob(MQjob, foundJob)
  await MQjob.updateProgress(100)
}

export { processBilboMDAutoJobNersc, processBilboMDAutoNerscJobTest }
