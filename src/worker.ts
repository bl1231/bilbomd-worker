import * as dotenv from 'dotenv'
import { connectDB } from './helpers/db'
import { Job, Worker, WorkerOptions } from 'bullmq'
import { WorkerJob } from 'types/jobtypes'
import { logger } from './helpers/loggers'
import { config } from './config/config'
import { processBilboMDCRDJob } from './services/process/bilbomd-crd'
import { processBilboMDPDBJob } from './services/process/bilbomd-pdb'
import { processBilboMDAutoJob } from './services/process/bilbomd-auto'
import { processPdb2CrdJob } from './services/process/pdb-to-crd'
import { processBilboMDPDBJobNersc } from './services/process/bilbomd-pdb-nersc'
import { processBilboMDCRDJobNersc } from './services/process/bilbomd-crd-nersc'
import { processBilboMDAutoJobNersc } from './services/process/bilbomd-auto-nersc'
import { processPdb2CrdJobNersc } from './services/process/pdb-to-crd-nersc'

dotenv.config()

connectDB()

const workerHandler = async (job: Job<WorkerJob>) => {
  logger.info(`workerHandler: ${JSON.stringify(job.data)}`)
  switch (job.data.type) {
    case 'pdb':
      logger.info(`Start BilboMD PDB job: ${job.name}`)
      await (config.runOnNERSC
        ? processBilboMDPDBJobNersc(job)
        : processBilboMDPDBJob(job))
      logger.info(`Finish job: ${job.name}`)
      break
    case 'crd_psf':
      logger.info(`Start BilboMD CRD job: ${job.name}`)
      await (config.runOnNERSC
        ? processBilboMDCRDJobNersc(job)
        : processBilboMDCRDJob(job))
      logger.info(`Finish job: ${job.name}`)
      break
    case 'auto':
      logger.info(`Start BilboMD Auto job: ${job.name}`)
      await (config.runOnNERSC
        ? processBilboMDAutoJobNersc(job)
        : processBilboMDAutoJob(job))
      logger.info(`Finished job: ${job.name}`)
      break
    case 'Pdb2Crd':
      logger.info(`Start Pdb2Crd job: ${job.name}`)
      await (config.runOnNERSC ? processPdb2CrdJobNersc(job) : processPdb2CrdJob(job))
      logger.info(`Finished job: ${job.name}`)
      break
  }
}

const workerOptions: WorkerOptions = {
  connection: {
    host: 'redis',
    port: 6379
  },
  concurrency: config.runOnNERSC ? 50 : 1,
  lockDuration: config.runOnNERSC ? 9000000 : 90000
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const worker = new Worker('bilbomd', workerHandler, workerOptions)
logger.info(`BilboMD Worker started on ${config.runOnNERSC ? 'NERSC' : 'Hyperion'}`)

const pdb2crdWorkerOptions: WorkerOptions = {
  connection: {
    host: 'redis',
    port: 6379
  },
  concurrency: 20
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const pdb2crdWorker = new Worker('pdb2crd', workerHandler, pdb2crdWorkerOptions)

logger.info(`PDB2CRD Worker started on ${config.runOnNERSC ? 'NERSC' : 'Hyperion'}`)
