import { Job as BullMQJob } from 'bullmq'
import { BilboMDAutoJob, IBilboMDAutoJob } from './model/Job'
import { User } from './model/User'
import { sendJobCompleteEmail } from './mailer'
import {
  runMinimize,
  runHeat,
  runMolecularDynamics,
  runFoxs,
  runMultiFoxs,
  gatherResults,
  runPaeToConst,
  runAutoRg
} from './bilbomd.functions'

const bilbomdUrl: string = process.env.BILBOMD_URL ?? 'https://bilbomd.bl1231.als.lbl.gov'

const initializeJob = async (MQJob: BullMQJob, DBjob: IBilboMDAutoJob) => {
  // Make sure the user exists in MongoDB
  const foundUser = await User.findById(DBjob.user).lean().exec()
  if (!foundUser) {
    throw new Error(`No user found for: ${DBjob.uuid}`)
  }
  // Clear the BullMQ Job logs
  await MQJob.clearLogs()
  // Set MongoDB status to Running
  DBjob.status = 'Running'
  const now = new Date()
  DBjob.time_started = now
  await DBjob.save()
}

const cleanupJob = async (MQjob: BullMQJob, DBJob: IBilboMDAutoJob) => {
  DBJob.status = 'Completed'
  DBJob.time_completed = new Date()
  await DBJob.save()
  sendJobCompleteEmail(DBJob.user.email, bilbomdUrl, DBJob.id, DBJob.title, false)
  console.log(`email notification sent to ${DBJob.user.email}`)
  await MQjob.log(`email notification sent to ${DBJob.user.email}`)
}

const processBilboMDAutoJobTest = async (MQjob: BullMQJob) => {
  await MQjob.updateProgress(1)

  const foundJob = await BilboMDAutoJob.findOne({ _id: MQjob.data.jobid })
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

  // Use PAE to construct const.inp file
  await runPaeToConst(foundJob)

  // Use BioXTAS to calculate Rg_min and Rg_max
  await runAutoRg(foundJob)

  // More steps that require foundJob or updatedJob

  await cleanupJob(MQjob, foundJob)
  await MQjob.updateProgress(100)
}

const processBilboMDAutoJob = async (MQjob: BullMQJob) => {
  await MQjob.updateProgress(1)

  const foundJob = await BilboMDAutoJob.findOne({ _id: MQjob.data.jobid })
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

  // Use PAE to construct const.inp file
  await MQjob.log('start pae to const')
  await runPaeToConst(foundJob)
  await MQjob.log('end pae to const')
  await MQjob.updateProgress(15)

  // Use BioXTAS to calculate Rg_min and Rg_max
  await MQjob.log('start autorg')
  await runAutoRg(foundJob)
  await MQjob.log('end autorg')
  await MQjob.updateProgress(20)

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

export { processBilboMDAutoJob, processBilboMDAutoJobTest }
