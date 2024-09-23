import { Job as BullMQJob } from 'bullmq'
import { BilboMdSANSJob } from '@bl1231/bilbomd-mongodb-schema'
import {
  runPdb2Crd,
  runMinimize,
  runHeat,
  runMolecularDynamics
} from '../functions/bilbomd-step-functions'
import { runPepsiSANS } from '../functions/bilbomd-sans-functions'
import { prepareBilboMDResults } from '../functions/bilbomd-step-functions-nersc'
import { initializeJob, cleanupJob } from '../functions/job-utils'

const processBilboMDSANSJob = async (MQjob: BullMQJob) => {
  await MQjob.updateProgress(1)

  const foundJob = await BilboMdSANSJob.findOne({ _id: MQjob.data.jobid })
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
  await MQjob.log('start pdb2crd')
  await runPdb2Crd(MQjob, foundJob)
  await MQjob.log('end pdb2crd')
  await MQjob.updateProgress(15)

  // CHARMM minimization
  await MQjob.log('start minimize')
  await runMinimize(MQjob, foundJob)
  await MQjob.log('end minimize')
  await MQjob.updateProgress(25)

  // FoXS calculations on minimization_output.pdb
  // await MQjob.log('start initfoxs')
  // await runSingleFoXS(foundJob)
  // await MQjob.log('end initfoxs')
  // await MQjob.updateProgress(30)

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

  // Calculate Pepsi-SANS profiles
  await MQjob.log('start pepsi-sans')
  await runPepsiSANS(MQjob, foundJob)
  await MQjob.log('end pepsi-sans')
  await MQjob.updateProgress(80)

  // GA-SAS analysis
  await MQjob.log('start ga-sas')
  // await runMultiFoxs(MQjob, foundJob)
  await MQjob.log('end ga-sas')
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

export { processBilboMDSANSJob }
