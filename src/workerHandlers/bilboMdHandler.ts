import { Job } from 'bullmq'
import { logger } from '../helpers/loggers'
import { config } from '../config/config'
import { processBilboMDAutoJob } from '../services/process/bilbomd-auto'
import { processBilboMDCRDJob } from '../services/process/bilbomd-crd'
import { processBilboMDJobNersc } from '../services/process/bilbomd-nersc'
import { processBilboMDPDBJob } from '../services/process/bilbomd-pdb'
import { processBilboMDSANSJob } from '../services/process/bilbomd-sans'
import { WorkerJob } from 'types/jobtypes'

export const bilboMdHandler = async (job: Job<WorkerJob>) => {
  logger.info(`bilboMdHandler: ${JSON.stringify(job.data)}`)
  try {
    switch (job.data.type) {
      case 'pdb':
        logger.info(`Start BilboMD PDB job: ${job.name}`)
        await (config.runOnNERSC
          ? processBilboMDJobNersc(job)
          : processBilboMDPDBJob(job))
        logger.info(`Finish job: ${job.name}`)
        break
      case 'crd_psf':
        logger.info(`Start BilboMD CRD job: ${job.name}`)
        await (config.runOnNERSC
          ? processBilboMDJobNersc(job)
          : processBilboMDCRDJob(job))
        logger.info(`Finish job: ${job.name}`)
        break
      case 'auto':
        logger.info(`Start BilboMD Auto job: ${job.name}`)
        await (config.runOnNERSC
          ? processBilboMDJobNersc(job)
          : processBilboMDAutoJob(job))
        logger.info(`Finished job: ${job.name}`)
        break
      case 'alphafold':
        logger.info(`Start BilboMD AlphaFold job: ${job.name}`)

        // Ensure AlphaFold jobs only run on NERSC
        if (!config.runOnNERSC) {
          const errorMsg = `AlphaFold jobs can only be run on NERSC. Job: ${job.name}`
          logger.error(errorMsg)
          throw new Error(errorMsg) // Or handle gracefully?
        }
        await processBilboMDJobNersc(job) // AlphaFold job processing on NERSC
        logger.info(`Finished job: ${job.name}`)
        break
      case 'sans':
        logger.info(`Start BilboMD SANS job: ${job.name}`)
        await (config.runOnNERSC
          ? processBilboMDJobNersc(job)
          : processBilboMDSANSJob(job))
        logger.info(`Finished job: ${job.name}`)
        break
    }
  } catch (error) {
    logger.error(`Error processing job ${job.id}: ${error}`)
  }
}
