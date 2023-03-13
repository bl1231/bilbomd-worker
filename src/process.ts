import { Job, IBilboMDJob } from './model/Job'
import { User } from './model/User'
// const { sendJobCompleteEmail } = require('./nodemailerConfig')

import { runMinimize, runHeat, runMolecularDynamics, runFoxs, runMultiFoxs, gatherResults } from './bilbomd'

// import { BilboMDJob } from './bullmq.jobs'
import { Job as BullMQJob } from 'bullmq'

const processBilboMDJob = async (job: BullMQJob) => {
  console.log('BullMQ job:', job.data)
  console.log('BullMQ ID:', job.id)
  await job.log(`Start job ${job.data.uuid}`)
  await job.log(`MongoDB jobid ${job.data.jobid}`)

  // Make sure job exists in MongoDB
  const foundJob = await Job.findOne({ _id: job.data.jobid }).exec()
  if (!foundJob) {
    console.log('no job found for:', job.data.jobid)
    job.log(`no job found for ${job.data.jobid}`)
    return 'no job found'
  }
  //await job.log(foundJob.toString())

  // Make sure the user exists
  const foundUser = await User.findById(foundJob.user).lean().exec()
  if (!foundUser) {
    console.log('no user found for job:', job.data.jobid)
    job.log(`no user found for job: ${job.data.jobid}`)
    return 'no user found'
  }

  // Set job status to Running
  foundJob.status = 'Running'
  const now = new Date()
  foundJob.time_started = now
  const resultRunning = await foundJob.save()
  console.log(`Job status set to: ${resultRunning.status}`)
  job.log(`MongoDB job status set to ${resultRunning.status}`)

  // CHARMM minimization
  await job.log('start minimization')
  await runMinimize(job, foundJob)
  await job.updateProgress(25)

  // CHARMM heating
  await job.log('start heating')
  await runHeat(job, foundJob)
  await job.updateProgress(40)

  // CHARMM dynamics and FoXS profiles
  try {
    await job.log('start molecular dynamics')
    await runMolecularDynamics(job, foundJob)
    await job.updateProgress(60)
    await job.log('start FoXS')
    await runFoxs(job, foundJob)
    await job.updateProgress(80)
  } catch (error) {
    console.error(error)
  }

  // MultiFoXS
  try {
    await job.log('start MultiFoXS')
    const foo = await runMultiFoxs(job, foundJob)
    await job.log(foo)
    await job.updateProgress(95)
  } catch (error) {
    console.error(error)
  }

  // Prepare results for user
  try {
    const results = await gatherResults(job, foundJob)
    await job.log(results)
    await job.updateProgress(99)
  } catch (error) {
    console.error(error)
  }

  // Set job status to Completed
  foundJob.status = 'Completed'

  foundJob.time_completed = new Date()
  const resultCompleted = await foundJob.save()
  console.log(`Job status set to: ${resultCompleted.status}`)
  job.log(`MongoDB job status set to ${resultCompleted.status}`)
  // send mail to user

  console.log('send email to user', foundUser?.username)
  // sendJobCompleteEmail(foundUser?.email, process.env.BILBOMD_URL, foundJob.id)
  await job.log(`email notification sent to ${foundUser?.email}`)
  await job.updateProgress(100)
  return 'ok'
}

export { processBilboMDJob }