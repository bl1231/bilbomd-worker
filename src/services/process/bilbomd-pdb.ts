import { Job as BullMQJob } from 'bullmq'
import { BilboMdPDBJob } from '@bl1231/bilbomd-mongodb-schema'
import {
  runPdb2Crd,
  runMinimize,
  runHeat,
  runMolecularDynamics,
  runFoxs,
  runMultiFoxs,
  prepareResults
} from '../bilbomd.functions'
import { initializeJob, cleanupJob } from '../functions/job-utils'
import { handleStepError, updateStepStatus } from '../functions/mongo-utils'
import { runSingleFoXS } from '../functions/foxs-analysis'

const processBilboMDJobTest = async (MQjob: BullMQJob) => {
  const foundJob = await BilboMdPDBJob.findOne({ _id: MQjob.data.jobid })
    .populate('user')
    .exec()
  if (!foundJob) {
    throw new Error(`No job found for: ${MQjob.data.jobid}`)
  }

  await initializeJob(MQjob, foundJob)
  await cleanupJob(MQjob, foundJob)
}

const processBilboMDPDBJob = async (MQjob: BullMQJob) => {
  await MQjob.updateProgress(1)

  const foundJob = await BilboMdPDBJob.findOne({ _id: MQjob.data.jobid })
    .populate('user')
    .exec()
  if (!foundJob) {
    throw new Error(`No job found for: ${MQjob.data.jobid}`)
  }
  await MQjob.updateProgress(5)

  // Initialize
  await initializeJob(MQjob, foundJob)
  await MQjob.updateProgress(10)

  // PDB to CRD/PSF for 'pdb' mode
  try {
    await MQjob.log('start PDB to CRD/PSF conversion')
    await updateStepStatus(foundJob._id, 'pdb2crd', 'Running')
    await runPdb2Crd(MQjob, foundJob)
    await updateStepStatus(foundJob._id, 'pdb2crd', 'Success')
    await MQjob.log('end PDB to CRD/PSF conversion')
  } catch (error) {
    await handleStepError(foundJob._id, 'pdb2crd', error)
  }

  await MQjob.updateProgress(25)

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

export { processBilboMDPDBJob, processBilboMDJobTest }
