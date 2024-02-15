import * as dotenv from 'dotenv'
import { connectDB } from './db'
import { Job, Worker, WorkerOptions } from 'bullmq'
import { WorkerJob } from 'bullmq.jobs'
import { processBilboMDJob } from './process.bilbomd'
import { processBilboMDAutoJob } from './process.bilbomdauto'
import { processPdb2CrdJob } from './process.pdb2crd'
import { logger } from './loggers'

dotenv.config()

connectDB()

const workerHandler = async (job: Job<WorkerJob>) => {
  logger.info(`workerHandler: ${JSON.stringify(job.data)}`)
  switch (job.data.type) {
    case 'BilboMD': {
      logger.info(`Start BilboMD job: ${job.name}`)
      await processBilboMDJob(job)
      logger.info(`Finish job: ${job.name}`)
      return
    }
    case 'BilboMDAuto': {
      logger.info(`Start BilboMDAuto job: ${job.name}`)
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
