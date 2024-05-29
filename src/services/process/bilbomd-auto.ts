import { Job as BullMQJob } from 'bullmq'
import { BilboMdAutoJob } from '@bl1231/bilbomd-mongodb-schema'
import {
  runMinimize,
  runHeat,
  runMolecularDynamics,
  runFoxs,
  runMultiFoxs,
  runPaeToConstInp,
  runAutoRg
} from '../functions/bilbomd-step-functions'
import { prepareBilboMDResults } from '../functions/bilbomd-step-functions-nersc'
import { initializeJob, cleanupJob } from '../functions/job-utils'
import { runSingleFoXS } from '../functions/foxs-analysis'

const processBilboMDAutoJobTest = async (MQjob: BullMQJob) => {
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
  await runPaeToConstInp(MQjob, foundJob)

  // Use BioXTAS to calculate Rg_min and Rg_max
  await runAutoRg(foundJob)

  // More steps that require foundJob or updatedJob

  await cleanupJob(MQjob, foundJob)
  await MQjob.updateProgress(100)
}

const processBilboMDAutoJob = async (MQjob: BullMQJob) => {
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

  // Use PAE to construct const.inp file
  await MQjob.log('start pae')
  await runPaeToConstInp(MQjob, foundJob)
  await MQjob.log('end pae')
  await MQjob.updateProgress(15)

  // Use BioXTAS to calculate Rg_min and Rg_max
  await MQjob.log('start autorg')
  await runAutoRg(foundJob)
  await MQjob.log('end autorg')
  await MQjob.updateProgress(20)

  // CHARMM minimization
  await MQjob.log('start minimize')
  await runMinimize(MQjob, foundJob)
  await MQjob.log('end minimize')
  await MQjob.updateProgress(25)

  // FoXS calculations on minimization_output.pdb
  await MQjob.log('start initfoxs')
  await runSingleFoXS(foundJob)
  await MQjob.log('end initfoxs')
  await MQjob.updateProgress(30)

  // CHARMM heating
  await MQjob.log('start heat')
  await runHeat(MQjob, foundJob)
  await MQjob.log('end heat')
  await MQjob.updateProgress(40)

  // CHARMM molecular dynamics
  await MQjob.log('start md')
  await runMolecularDynamics(MQjob, foundJob)
  await MQjob.log('end md')
  await MQjob.updateProgress(60)

  // Calculate FoXS profiles
  await MQjob.log('start foxs')
  await runFoxs(MQjob, foundJob)
  await MQjob.log('end foxs')
  await MQjob.updateProgress(80)

  // MultiFoXS
  await MQjob.log('start multifoxs')
  await runMultiFoxs(MQjob, foundJob)
  await MQjob.log('end multifoxs')
  await MQjob.updateProgress(95)

  // Prepare results
  await MQjob.log('start results')
  await prepareBilboMDResults(MQjob, foundJob)
  await MQjob.log('end results')
  await MQjob.updateProgress(99)

  // Cleanup & send email
  await cleanupJob(MQjob, foundJob)
  await MQjob.updateProgress(100)
}

export { processBilboMDAutoJob, processBilboMDAutoJobTest }
