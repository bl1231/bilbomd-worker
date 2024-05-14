import { Job as BullMQJob } from 'bullmq'
import { BilboMdAutoJob } from '@bl1231/bilbomd-mongodb-schema'
import {
  runMinimize,
  runHeat,
  runMolecularDynamics,
  runFoxs,
  runMultiFoxs,
  prepareResults,
  runPaeToConstInp,
  runAutoRg
} from '../bilbomd.functions'
import { initializeJob, cleanupJob } from '../functions/job-utils'
import { handleStepError, updateStepStatus } from '../functions/mongo-utils'
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
  await runPaeToConstInp(foundJob)

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
  try {
    await MQjob.log('start pae to const')
    await updateStepStatus(foundJob._id, 'pae', 'Running')
    await runPaeToConstInp(foundJob)
    await updateStepStatus(foundJob._id, 'pae', 'Success')
    await MQjob.log('end pae to const')
  } catch (error) {
    await handleStepError(foundJob._id, 'pae', error)
  }
  await MQjob.updateProgress(15)

  // Use BioXTAS to calculate Rg_min and Rg_max
  try {
    await MQjob.log('start autorg')
    await updateStepStatus(foundJob._id, 'autorg', 'Running')
    await runAutoRg(foundJob)
    await updateStepStatus(foundJob._id, 'autorg', 'Success')
    await MQjob.log('end autorg')
  } catch (error) {
    await handleStepError(foundJob._id, 'autorg', error)
  }
  await MQjob.updateProgress(20)

  // CHARMM minimization
  try {
    await MQjob.log('start minimization')
    await updateStepStatus(foundJob._id, 'minimize', 'Running')
    await runMinimize(MQjob, foundJob)
    await updateStepStatus(foundJob._id, 'minimize', 'Success')
    await MQjob.log('end minimization')
  } catch (error) {
    await handleStepError(foundJob._id, 'minimize', error)
  }
  await MQjob.updateProgress(25)

  // FoXS calculations on minimization_output.pdb
  await runSingleFoXS(foundJob)

  // CHARMM heating
  try {
    await MQjob.log('start heating')
    await updateStepStatus(foundJob._id, 'heat', 'Running')
    await runHeat(MQjob, foundJob)
    await updateStepStatus(foundJob._id, 'heat', 'Success')
    await MQjob.log('end heating')
  } catch (error) {
    await handleStepError(foundJob._id, 'heat', error)
  }
  await MQjob.updateProgress(40)

  // CHARMM molecular dynamics
  try {
    await MQjob.log('start molecular dynamics')
    await updateStepStatus(foundJob._id, 'md', 'Running')
    await runMolecularDynamics(MQjob, foundJob)
    await updateStepStatus(foundJob._id, 'md', 'Success')
    await MQjob.log('end molecular dynamics')
  } catch (error) {
    await handleStepError(foundJob._id, 'md', error)
  }
  await MQjob.updateProgress(60)

  // Calculate FoXS profiles
  try {
    await MQjob.log('start FoXS')
    await updateStepStatus(foundJob._id, 'foxs', 'Running')
    await runFoxs(MQjob, foundJob)
    await updateStepStatus(foundJob._id, 'foxs', 'Success')
    await MQjob.log('end FoXS')
  } catch (error) {
    await handleStepError(foundJob._id, 'foxs', error)
  }
  await MQjob.updateProgress(80)

  // MultiFoXS
  try {
    await MQjob.log('start MultiFoXS')
    await updateStepStatus(foundJob._id, 'multifoxs', 'Running')
    await runMultiFoxs(MQjob, foundJob)
    await updateStepStatus(foundJob._id, 'multifoxs', 'Success')
    await MQjob.log('end MultiFoXS')
  } catch (error) {
    await handleStepError(foundJob._id, 'multifoxs', error)
  }
  await MQjob.updateProgress(95)

  // Prepare results
  try {
    await MQjob.log('start gather results')
    await updateStepStatus(foundJob._id, 'results', 'Running')
    await prepareResults(MQjob, foundJob)
    await updateStepStatus(foundJob._id, 'results', 'Success')
    await MQjob.log('end gather results')
  } catch (error) {
    await handleStepError(foundJob._id, 'results', error)
  }
  await MQjob.updateProgress(99)

  // Cleanup & send email
  await updateStepStatus(foundJob._id, 'email', 'Running')
  await cleanupJob(MQjob, foundJob)
  await updateStepStatus(foundJob._id, 'email', 'Success')
  await MQjob.updateProgress(100)
}

export { processBilboMDAutoJob, processBilboMDAutoJobTest }
