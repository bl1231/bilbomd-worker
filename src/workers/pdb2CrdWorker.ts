import { bilboMdHandler } from '../workerHandlers/bilboMdHandler'
import { Worker, WorkerOptions } from 'bullmq'
import { logger } from '../helpers/loggers'

let pdb2CrdActiveJobsCount = 0

export const createPdb2CrdWorker = (options: WorkerOptions): Worker => {
  const pdb2CrdWorker = new Worker('pdb2crd', bilboMdHandler, options)
  logger.info(`PDB2CRD Worker started`)

  pdb2CrdWorker.on('active', () => {
    pdb2CrdActiveJobsCount++
    logger.info(`PDB2CRD Worker Active Jobs: ${pdb2CrdActiveJobsCount}`)
  })

  pdb2CrdWorker.on('completed', () => {
    pdb2CrdActiveJobsCount--
    logger.info(`PDB2CRD Worker Active Jobs after completion: ${pdb2CrdActiveJobsCount}`)
  })

  pdb2CrdWorker.on('failed', () => {
    pdb2CrdActiveJobsCount--
    logger.info(`PDB2CRD Worker Active Jobs after failure: ${pdb2CrdActiveJobsCount}`)
  })

  return pdb2CrdWorker
}