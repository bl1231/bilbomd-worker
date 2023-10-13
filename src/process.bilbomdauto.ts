import { Job as BullMQJob } from 'bullmq'
import { IBilboMDAutoJob, BilboMDAutoJob } from './model/Job'
import { User } from './model/User'
import { sendJobCompleteEmail } from './mailer'
import {
  runMinimize,
  runHeat,
  runMolecularDynamics,
  runFoxs,
  runMultiFoxs,
  gatherResults
} from './bilbomd'

const bilbomdUrl: string = process.env.BILBOMD_URL ?? 'https://bilbomd.bl1231.als.lbl.gov'

const initializeJob = async (job: IBilboMDAutoJob) => {
  // Make sure the user exists
  const foundUser = await User.findById(job.user).lean().exec()
  if (!foundUser) {
    throw new Error(`No user found for: ${job.uuid}`)
  }
  // Set job status to Running
  job.status = 'Running'
  // await job.updateProgress(10)
  const now = new Date()
  job.time_started = now
  await job.save()
}

const cleanupJob = async (job: BullMQJob, DBJob: IBilboMDAutoJob) => {
  DBJob.status = 'Completed'
  DBJob.time_completed = new Date()
  await DBJob.save()
  // Send email to user
  sendJobCompleteEmail(DBJob.user.email, bilbomdUrl, DBJob.id, DBJob.title)
  console.log(`email notification sent to ${DBJob.user.email}`)
  await job.log(`email notification sent to ${DBJob.user.email}`)
}

const processBilboMDAutoJob = async (job: BullMQJob) => {
  // console.log('BullMQ job:', job.data)
  // console.log('BullMQ ID:', job.id)
  await job.updateProgress(5)

  const foundJob = await BilboMDAutoJob.findOne({ _id: job.data.jobid }).exec()
  if (!foundJob) {
    throw new Error(`No job found for: ${job.data.jobid}`)
  }

  await initializeJob(foundJob)
  await job.updateProgress(10)

  // CHARMM minimization
  await job.log('start minimization')
  await runMinimize(job, foundJob)
  await job.log('end minimization')
  await job.updateProgress(25)

  // CHARMM heating
  await job.log('start heating')
  console.log('HEATING foundJob: ', foundJob)
  await runHeat(job, foundJob)
  await job.log('end heating')
  await job.updateProgress(40)

  // CHARMM molecular dynamics
  await job.log('start molecular dynamics')
  console.log('MD foundJob: ', foundJob)
  await runMolecularDynamics(job, foundJob)
  await job.log('end molecular dynamics')
  await job.updateProgress(60)

  // Calculate FoXS profiles
  await job.log('start FoXS')
  await runFoxs(job, foundJob)
  await job.log('end FoXS')
  await job.updateProgress(80)

  // MultiFoXS
  await job.log('start MultiFoXS')
  await runMultiFoxs(job, foundJob)
  await job.log('end MultiFoXS')
  await job.updateProgress(95)

  // Prepare results for user
  await job.log('start gather results')
  await gatherResults(job, foundJob)
  await job.log('end gather results')
  await job.updateProgress(99)

  await cleanupJob(job, foundJob)
  await job.updateProgress(100)
  return 'ok'
}

export { processBilboMDAutoJob }
