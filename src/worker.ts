import * as dotenv from 'dotenv'
import express from 'express'
import { connectDB } from './helpers/db'
import { Worker, WorkerOptions } from 'bullmq'
import { logger } from './helpers/loggers'
import { config } from './config/config'
import { createBilboMdWorker } from './workers/bilboMdWorker'
import { createPdb2CrdWorker } from './workers/pdb2CrdWorker'
import { createWebhooksWorker } from './workers/webhooksWorker'
import { checkNERSC } from './workers/workerControl'

dotenv.config()

const environment: string = process.env.NODE_ENV || 'development'
const version: string = process.env.BILBOMD_WORKER_VERSION || '0.0.0'
const gitHash: string = process.env.BILBOMD_WORKER_GIT_HASH || '321cba'

if (environment === 'production') {
  logger.info('Running in production mode')
} else {
  logger.info('Running in development mode')
}

connectDB()

let bilboMdWorker: Worker | null = null
let pdb2CrdWorker: Worker | null = null
let webhooksWorker: Worker | null = null

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

  // Create workers only if they are not already initialized
  if (!bilboMdWorker || !pdb2CrdWorker || !webhooksWorker) {
    // If running on NERSC, check credentials before starting workers
    if (config.runOnNERSC) {
      logger.info('Checking NERSC credentials...')
      if (!(await checkNERSC())) {
        logger.info(
          'NERSC is not ready; workers will be started when credentials are valid'
        )
        return // Exit if credentials are not valid
      }
    }

    // Create workers
    bilboMdWorker = createBilboMdWorker(workerOptions)
    logger.info(`BilboMD Worker started on ${systemName}`)

    pdb2CrdWorker = createPdb2CrdWorker(pdb2crdWorkerOptions)
    logger.info(`PDB2CRD Worker started on ${systemName}`)

    webhooksWorker = createWebhooksWorker(webhooksWorkerOptions)
    logger.info(`Webhooks Worker started on ${systemName}`)
  } else {
    logger.info('Workers are already initialized')
  }
}

// Define the workers array
const workers = [
  { getWorker: () => bilboMdWorker, name: 'BilboMD Worker' },
  { getWorker: () => pdb2CrdWorker, name: 'PDB2CRD Worker' },
  { getWorker: () => webhooksWorker, name: 'Webhooks Worker' }
]

// Setup periodic NERSC token validation
setInterval(async () => {
  if (await checkNERSC()) {
    // Start workers if they are not initialized
    if (!bilboMdWorker || !pdb2CrdWorker || !webhooksWorker) {
      await startWorkers()
    } else {
      // Resume workers if they are paused
      for (const { getWorker, name } of workers) {
        const workerInstance = getWorker()
        if (workerInstance && (await workerInstance.isPaused())) {
          await workerInstance.resume()
          logger.info(`${name} resumed`)
        }
      }
    }
  } else {
    // If NERSC token is invalid, pause the workers
    for (const { getWorker, name } of workers) {
      const workerInstance = getWorker()
      if (workerInstance && !(await workerInstance.isPaused())) {
        await workerInstance.pause()
        logger.info(`${name} paused due to invalid NERSC tokens`)
      }
    }
  }
}, 300000) // Check every 5 minutes

// Start the workers initially
startWorkers()

const app = express()

// Endpoint to return configuration info
app.get('/config', (req, res) => {
  const configs = {
    gitHash: gitHash || '',
    version: version || ''
  }
  res.json(configs)
})

// Start the Express server
const PORT = 3000
logger.info('Starting the Express server...')
app.listen(PORT, () => {
  logger.info(`Worker configuration server running on port ${PORT}`)
})
