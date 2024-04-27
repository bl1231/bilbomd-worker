import * as dotenv from 'dotenv'
import { connectDB } from './helpers/db'
import { Job, Worker, WorkerOptions } from 'bullmq'
import { WorkerJob } from 'types/jobtypes'
import { processBilboMDCRDJob } from './services/process.bilbomdcrd'
import { processBilboMDPDBJob } from './services/process.bilbomdpdb'
import { processBilboMDAutoJob } from './services/process.bilbomdauto'
import { processPdb2CrdJob } from './services/process.pdb2crd'
import { logger } from './helpers/loggers'
import { config } from './config/config'

dotenv.config()

connectDB()

const workerHandler = async (job: Job<WorkerJob>) => {
  logger.info(`workerHandler: ${JSON.stringify(job.data)}`)
  switch (job.data.type) {
    case 'pdb': {
      logger.info(`runOnNERSC is ${config.runOnNERSC}`)
      if (config.runOnNERSC) {
        logger.info(`Start BilboMD PDB job on NERSC: ${job.name}`)
        // await processBilboMDPDBJobAtNERSC(job)
        logger.info(`Finish job: ${job.name}`)
        return
      } else {
        logger.info(`Start BilboMD PDB job: ${job.name}`)
        await processBilboMDPDBJob(job)
        logger.info(`Finish job: ${job.name}`)
        return
      }
    }
    case 'crd_psf': {
      logger.info(`Start BilboMD CRD job: ${job.name}`)
      await processBilboMDCRDJob(job)
      logger.info(`Finish job: ${job.name}`)
      return
    }
    case 'auto': {
      logger.info(`Start BilboMD Auto job: ${job.name}`)
      await processBilboMDAutoJob(job)
      logger.info(`Finished job: ${job.name}`)
      return
    }
    case 'Pdb2Crd': {
      logger.info(`Start Pdb2Crd job: ${job.name}`)
      await processPdb2CrdJob(job)
      logger.info(`Finished job: ${job.name}`)
      return
    }
  }
}

const workerOptions: WorkerOptions = {
  connection: {
    host: 'redis',
    port: 6379
  },
  concurrency: 1,
  lockDuration: 90000
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const worker = new Worker('bilbomd', workerHandler, workerOptions)
logger.info('BilboMD Worker started!')
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const pdb2crdWorker = new Worker('pdb2crd', workerHandler, {
  connection: {
    host: 'redis',
    port: 6379
  },
  concurrency: 5 // Adjust based on your resource capacity
})
logger.info('PDB2CRD Worker started!')
