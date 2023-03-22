import { Job, IBilboMDJob } from './model/Job'
import { User } from './model/User'
// const { sendJobCompleteEmail } = require('./nodemailerConfig')

import {
  runMinimize,
  runHeat,
  runMolecularDynamics,
  runFoxs,
  runMultiFoxs,
  gatherResults
} from './bilbomd'

// import { BilboMDJob } from './bullmq.jobs'
import { Job as BullMQJob } from 'bullmq'

const updateJobStatus = async (job: IBilboMDJob, status: string) => {
  console.log('in updateJobStatus')
  job.status = status
  // console.log(job)
  job.save().then((doc) => {
    console.log('saved:', doc)
  })
}

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
  await job.log(`MongoDB job status set to ${resultRunning.status}`)

  // CHARMM minimization
  await job.log('start minimization')
  await runMinimize(job, foundJob).catch((error) => {
    console.log('runMinimize error:', error)
    job.log('failed in runMinimize')
    foundJob.status = 'Error'
    foundJob.save().then((doc: IBilboMDJob) => {
      console.log('saved:', doc)
    })
    // Maybe try an async/await strategy?
    //updateJobStatus(foundJob, 'Error')
    console.log('set Error status in MongoDB?')
    throw new Error('CHARMM minimize step failed')
  })
  await job.updateProgress(25)

  // CHARMM heating
  await job.log('start heating')
  await runHeat(job, foundJob).catch((error) => {
    console.log('runHeat error:', error)
    job.log('failed in runHeat')
    updateJobStatus(foundJob, 'Error')
    throw new Error('CHARMM heating step failed')
  })
  await job.updateProgress(40)

  // CHARMM molecular dynamics
  await job.log('start molecular dynamics')
  await runMolecularDynamics(job, foundJob)
    .catch((error) => {
      console.log('runMolecularDynamics error:', error)
      job.log('failed in runMolecularDynamics')
      updateJobStatus(foundJob, 'Error')
      throw new Error('CHARMM MD step failed')
    })
    .then(() => {
      job.log('finished molecular dynamics')
    })
  await job.updateProgress(60)

  // Calculate FoXS profiles
  await job.log('start FoXS')
  await runFoxs(job, foundJob)
    .catch((error) => {
      console.log('runFoxs error:', error)
      job.log('failed in runFoxs')
      updateJobStatus(foundJob, 'Error')
      throw new Error('FoXS step failed')
    })
    .then(() => {
      job.log('finished FoXS')
    })
  await job.updateProgress(80)

  // MultiFoXS
  await job.log('start MultiFoXS')
  await runMultiFoxs(job, foundJob)
    .catch((error) => {
      console.log('runMultiFoxs error:', error)
      job.log('failed in runMultiFoxs')
      updateJobStatus(foundJob, 'Error')
      throw new Error('Multi-FoXS step failed')
    })
    .then(() => {
      job.log('finished MultiFoXS')
    })
  await job.updateProgress(95)

  // Prepare results for user
  await gatherResults(job, foundJob)
    .catch((error) => {
      console.log('gatherResults error:', error)
      job.log('failed in gatherResults')
      updateJobStatus(foundJob, 'Error')
      throw new Error('Gather results step failed')
    })
    .then(() => {
      job.log('finished Gathering Results')
    })

  await job.updateProgress(99)

  // Set job status to Completed
  foundJob.status = 'Completed'
  foundJob.time_completed = new Date()
  await foundJob.save().then((job) => {
    console.log(`Job status set to: ${job.status}`)
  })

  // send mail to user

  console.log('send email to user', foundUser?.username)
  // sendJobCompleteEmail(foundUser?.email, process.env.BILBOMD_URL, foundJob.id)
  await job.log(`email notification sent to ${foundUser?.email}`)
  await job.updateProgress(100)
  return 'ok'
}

export { processBilboMDJob }
