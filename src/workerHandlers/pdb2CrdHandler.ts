import { Job } from 'bullmq'
import { logger } from '../helpers/loggers'
import { config } from '../config/config'
import { processPdb2CrdJob } from 'services/process/pdb-to-crd'
import { processPdb2CrdJobNersc } from 'services/process/pdb-to-crd-nersc'
import { WorkerJob } from 'types/jobtypes'

export const pdb2CrdHandler = async (job: Job<WorkerJob>) => {
  logger.info(`pdb2CrdHandler: ${JSON.stringify(job.data)}`)
  try {
    logger.info(`Start Pdb2Crd job: ${job.name}`)
    await (config.runOnNERSC ? processPdb2CrdJobNersc(job) : processPdb2CrdJob(job))
    logger.info(`Finished job: ${job.name}`)
  } catch (error) {
    logger.error(`Error processing job ${job.id}: ${error}`)
  }
}
