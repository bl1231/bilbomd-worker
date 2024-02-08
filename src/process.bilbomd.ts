import { Job as BullMQJob } from 'bullmq'
import { BilboMdJob } from './model/Job'
// import { User } from './model/User'
// import { sendJobCompleteEmail } from './mailer'
import {
  initializeJob,
  runMinimize,
  runHeat,
  runMolecularDynamics,
  runFoxs,
  runMultiFoxs,
  prepareResults,
  cleanupJob
} from './bilbomd.functions'
import { runSingleFoXS } from './foxs_analysis'

const processBilboMDJobTest = async (MQjob: BullMQJob) => {
  const foundJob = await BilboMdJob.findOne({ _id: MQjob.data.jobid })
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

  const foundJob = await BilboMdJob.findOne({ _id: MQjob.data.jobid })
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

  // FoXS calculations on minimization_output.pdb
  await runSingleFoXS(foundJob)

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
  await prepareResults(MQjob, foundJob)
  await MQjob.log('end gather results')
  await MQjob.updateProgress(99)

  // Cleanup & send email
  await cleanupJob(MQjob, foundJob)
  await MQjob.updateProgress(100)
}

export { processBilboMDJob, processBilboMDJobTest }
