import * as dotenv from 'dotenv'
// import 'module-alias/register'
import { connectDB } from './helpers/db'
import { Job, Worker, WorkerOptions } from 'bullmq'
import { WorkerJob } from './types/jobtypes'
import { logger } from './helpers/loggers'
import { config } from './config/config'
import { ensureValidToken } from './services/functions/nersc-api-token-functions'
import { processBilboMDCRDJob } from './services/process/bilbomd-crd'
import { processBilboMDPDBJob } from './services/process/bilbomd-pdb'
import { processBilboMDAutoJob } from './services/process/bilbomd-auto'
import { processPdb2CrdJob } from './services/process/pdb-to-crd'
import { processPdb2CrdJobNersc } from './services/process/pdb-to-crd-nersc'
import { processBilboMDJobNersc } from './services/process/bilbomd-nersc'

dotenv.config()

const environment: string = process.env.NODE_ENV || 'development'

if (environment === 'production') {
  logger.info('Running in production mode')
} else {
  logger.info('Running in development mode')
}

connectDB()

let bilboMdWorker: Worker
let pdb2CrdWorker: Worker
let webhooksWorker: Worker

const checkNERSC = async () => {
  try {
    // Eventually could have various checks here

    // Perlmutter status
    // const response = await someAPI.healthCheck()
    // if (response.status !== 'ok') {
    //   throw new Error('API is not healthy')
    // }

    // Valid client

    // Able to get access token
    const token: string = await ensureValidToken()
    if (typeof token === 'string' && token.length > 10) {
      logger.info(`Successfully obtained NERSC token: ${token.slice(0, 10)}...`)
      return true
    } else {
      logger.warn(`Did not successfully obtain NERSC token: ${token}`)
      return false
    }
  } catch (error) {
    logger.error(`Failed to obtain NERSC token: ${error}`)
    return false
  }
}

const pauseProcessing = async () => {
  if (bilboMdWorker) {
    await bilboMdWorker.pause()
    logger.info('BilboMD Worker paused due to invalid NERSC tokens')
  }
  if (pdb2CrdWorker) {
    await pdb2CrdWorker.pause()
    logger.info('PDB2CRD Worker paused due to invalid NERSC tokens')
  }
  if (webhooksWorker) {
    await webhooksWorker.pause()
    logger.info('PDB2CRD Worker paused due to invalid NERSC tokens')
  }
}

const resumeProcessing = async () => {
  if (bilboMdWorker) {
    bilboMdWorker.resume()
    logger.info('BilboMD Worker resumed')
  }
  if (pdb2CrdWorker) {
    pdb2CrdWorker.resume()
    logger.info('PDB2CRD Worker resumed')
  }
  if (webhooksWorker) {
    webhooksWorker.resume()
    logger.info('PDB2CRD Worker resumed')
  }
}

const workerHandler = async (job: Job<WorkerJob>) => {
  logger.info(`workerHandler: ${JSON.stringify(job.data)}`)
  // NERSC check
  if (config.runOnNERSC && !(await checkNERSC())) {
    logger.error('NERSC token invalid. Pausing job processing.')
    await pauseProcessing()
    setTimeout(startWorkers, 10000) // Attempt to restart workers after a delay
    return
  }
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
      case 'Pdb2Crd':
        logger.info(`Start Pdb2Crd job: ${job.name}`)
        await (config.runOnNERSC ? processPdb2CrdJobNersc(job) : processPdb2CrdJob(job))
        logger.info(`Finished job: ${job.name}`)
        break
    }
  } catch (error) {
    logger.error(`Error processing job ${job.id}: ${error}`)
  }
}

const webhooksWorkerHandler = async (job: Job<WorkerJob>) => {
  // NERSC check
  if (config.runOnNERSC && !(await checkNERSC())) {
    logger.error('NERSC token invalid. Pausing job processing.')
    await pauseProcessing()
    setTimeout(startWorkers, 10000)
    return
  }
  try {
    switch (job.data.type) {
      case 'webhooks':
        logger.info(`Start Webhooks job: ${job.name}`)
        // Add logic to handle different event types
        switch (job.data.data.title) {
          case 'docker-build':
            // Call a function to handle the Docker build event
            // handleDockerBuild(job.data)
            break
          case 'deploy':
            // Call a function to handle the deploy event
            // handleDeploy(job.data)
            break
          // Add more cases as needed for different events
          default:
            logger.warn(`Unhandled event type: ${job.data.data.title}`)
            // res.status(400).json({ message: `Unhandled event type: ${job.data.title}` })
            return
        }
        logger.info(`Finished job: ${job.name}`)
        break
    }
  } catch (error) {
    logger.error(`Error processing job ${job.id}: ${error}`)
  }
}

const redisConn = {
  host: 'redis',
  port: 6379
}

const workerOptions: WorkerOptions = {
  connection: redisConn,
  concurrency: config.runOnNERSC ? 50 : 1,
  lockDuration: config.runOnNERSC ? 9000000 : 90000
}

const pdb2crdWorkerOptions: WorkerOptions = {
  connection: redisConn,
  concurrency: 20
}

const webhooksWorkerOptions: WorkerOptions = {
  connection: redisConn,
  concurrency: 1
}

const startWorkers = async () => {
  const systemName = config.runOnNERSC ? 'NERSC' : 'Hyperion' // Set system name based on the config
  logger.info(`Attempting to start workers on ${systemName}...`)
  // Setup periodic NERSC token validation
  setInterval(async () => {
    if (await checkNERSC()) {
      if (
        (bilboMdWorker && bilboMdWorker.isPaused()) ||
        (pdb2CrdWorker && pdb2CrdWorker.isPaused()) ||
        (webhooksWorker && webhooksWorker.isPaused())
      ) {
        await resumeProcessing()
      }
    }
  }, 300000) // Check every 5 minutes
  // If running on NERSC, check credentials before starting workers
  if (config.runOnNERSC) {
    logger.info('Checking NERSC credentials...')
    if (!(await checkNERSC())) {
      logger.info('NERSC is not ready, delaying worker start')
      setTimeout(startWorkers, 10000) // Check again in 10 seconds
      return // Exit if credentials are not valid
    }
  }

  // Create workers
  bilboMdWorker = new Worker('bilbomd', workerHandler, workerOptions)
  logger.info(`BilboMD Worker started on ${systemName}`)

  pdb2CrdWorker = new Worker('pdb2crd', workerHandler, pdb2crdWorkerOptions)
  logger.info(`PDB2CRD Worker started on ${systemName}`)

  webhooksWorker = new Worker('webhooks', webhooksWorkerHandler, webhooksWorkerOptions)
  logger.info(`Webhooks Worker started on ${systemName}`)
}

startWorkers()
