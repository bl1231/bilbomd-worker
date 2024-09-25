import { Job as BullMQJob } from 'bullmq'
import { BilboMdSANSJob } from '@bl1231/bilbomd-mongodb-schema'
import {
  runPdb2Crd,
  runMinimize,
  runHeat,
  runMolecularDynamics
} from '../functions/bilbomd-step-functions'
import {
  extractPDBFilesFromDCD,
  remediatePDBFiles,
  runPepsiSANSOnPDBFiles
} from '../functions/bilbomd-sans-functions'
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

  // Extract PDBs from DCDs
  await MQjob.log('start dcd2pdb')
  await extractPDBFilesFromDCD(foundJob)
  await MQjob.log('end dcd2pdb')
  await MQjob.updateProgress(70)

  // Remediate PDB files
  await MQjob.log('start remediate')
  await remediatePDBFiles(foundJob)
  await MQjob.log('end remediate')
  await MQjob.updateProgress(80)

  // Calculate Pepsi-SANS profiles
  await MQjob.log('start pepsisans')
  await runPepsiSANSOnPDBFiles(foundJob)
  await MQjob.log('end pepsisans')
  await MQjob.updateProgress(80)

  // GA-SANS analysis
  await MQjob.log('start ga-sans')
  // await runMultiFoxs(MQjob, foundJob)
  await MQjob.log('end ga-sans')
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
