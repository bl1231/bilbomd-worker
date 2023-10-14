import { Job as BullMQJob } from 'bullmq'
import { BilboMDJob } from './model/Job'
// import { User } from './model/User'
// import { sendJobCompleteEmail } from './mailer'
import {
  initializeJob,
  runMinimize,
  runHeat,
  runMolecularDynamics,
  runFoxs,
  runMultiFoxs,
  gatherResults,
  cleanupJob
} from './bilbomd.functions'

const processBilboMDJobTest = async (MQjob: BullMQJob) => {
  const foundJob = await BilboMDJob.findOne({ _id: MQjob.data.jobid })
    .populate({
      path: 'user',
      select: 'email'
    })
    .exec()
  if (!foundJob) {
    throw new Error(`No job found for: ${MQjob.data.jobid}`)
  }

  await initializeJob(MQjob, foundJob)
  await cleanupJob(MQjob, foundJob)
}

const processBilboMDJob = async (MQjob: BullMQJob) => {
  await MQjob.updateProgress(1)

  const foundJob = await BilboMDJob.findOne({ _id: MQjob.data.jobid })
    .populate({
      path: 'user',
      select: 'email'
    })
    .exec()
  if (!foundJob) {
    throw new Error(`No job found for: ${MQjob.data.jobid}`)
  }
  await MQjob.updateProgress(5)

  // Initialize
  await initializeJob(MQjob, foundJob)
  await MQjob.updateProgress(10)

  // CHARMM minimization
  await MQjob.log('start minimization')
  await runMinimize(MQjob, foundJob)
  await MQjob.log('end minimization')
  await MQjob.updateProgress(25)

  // CHARMM heating
  await MQjob.log('start heating')
  await runHeat(MQjob, foundJob)
  await MQjob.log('end heating')
  await MQjob.updateProgress(40)

  // CHARMM molecular dynamics
  await MQjob.log('start molecular dynamics')
  await runMolecularDynamics(MQjob, foundJob)
  await MQjob.log('end molecular dynamics')
  await MQjob.updateProgress(60)

  // Calculate FoXS profiles
  await MQjob.log('start FoXS')
  await runFoxs(MQjob, foundJob)
  await MQjob.log('end FoXS')
  await MQjob.updateProgress(80)

  // MultiFoXS
  await MQjob.log('start MultiFoXS')
  await runMultiFoxs(MQjob, foundJob)
  await MQjob.log('end MultiFoXS')
  await MQjob.updateProgress(95)

  // Prepare results
  await MQjob.log('start gather results')
  await gatherResults(MQjob, foundJob)
  await MQjob.log('end gather results')
  await MQjob.updateProgress(99)

  // Cleanup & send email
  await cleanupJob(MQjob, foundJob)
  await MQjob.updateProgress(100)
}

export { processBilboMDJob, processBilboMDJobTest }
