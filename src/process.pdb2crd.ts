import { Job as BullMQJob } from 'bullmq'
import { logger } from './loggers'
import fs from 'fs-extra'
import path from 'path'
import { spawn, ChildProcess } from 'node:child_process'

const uploadFolder = process.env.DATA_VOL ?? '/bilbomd/uploads'
const af2paeUploads = path.join(uploadFolder, 'af2pae_uploads')
// const TOPO_FILES = process.env.CHARM_TOPOLOGY ?? 'bilbomd_top_par_files.str'

const initializeJob = async (MQJob: BullMQJob) => {
  logger.info('init job')
  // Clear the BullMQ Job logs
  await MQJob.clearLogs()
  await MQJob.log('Init!')
}

const cleanupJob = async (MQjob: BullMQJob) => {
  logger.info('cleanup job')
  await MQjob.log('Done!')
}

const processPdb2CrdJob = async (MQJob: BullMQJob) => {
  await MQJob.updateProgress(1)
  // Initialize
  await initializeJob(MQJob)

  // Create pdb_2_crd.inp file
  await MQJob.log('start pdb_2_crd')
  await runPdb2CrdInpFileMaker(MQJob.data.uuid)
  await MQJob.log('end pdb_2_crd')
  await MQJob.updateProgress(15)

  // Run CHARMM to create crd and psf files

  // Cleanup
  await cleanupJob(MQJob)
  await MQJob.updateProgress(100)
}

const runPdb2CrdInpFileMaker = (uuid: string) => {
  const workingDir = path.join(af2paeUploads, uuid)
  const logFile = path.join(workingDir, 'pdb2crd.log')
  const errorFile = path.join(workingDir, 'pdb2crd_error.log')
  const logStream = fs.createWriteStream(logFile)
  const errorStream = fs.createWriteStream(errorFile)
  const pdb2crd_script = '/app/scripts/pdb_2_crd.py'
  const args = [pdb2crd_script, 'pdb_file.pdb']

  return new Promise((resolve, reject) => {
    const pdb2crd: ChildProcess = spawn('python', args, { cwd: workingDir })
    pdb2crd.stdout?.on('data', (data: Buffer) => {
      const dataString = data.toString().trim()
      logger.info(`runPdb2CrdInpFileMaker stdout ${dataString}`)
      logStream.write(dataString)
    })
    pdb2crd.stderr?.on('data', (data: Buffer) => {
      logger.error('runPdb2CrdInpFileMaker stderr', data.toString())
      console.log(data)
      errorStream.write(data.toString())
    })
    pdb2crd.on('error', (error) => {
      logger.error('runPdb2CrdInpFileMaker error:', error)
      reject(error)
    })
    pdb2crd.on('exit', (code) => {
      // Close streams explicitly once the process exits
      const closeStreamsPromises = [
        new Promise((resolveStream) => logStream.end(resolveStream)),
        new Promise((resolveStream) => errorStream.end(resolveStream))
      ]
      Promise.all(closeStreamsPromises)
        .then(() => {
          // Only proceed once all streams are closed
          if (code === 0) {
            logger.info(`runPdb2CrdInpFileMaker success with exit code: ${code}`)
            resolve(code.toString())
          } else {
            logger.error(`runPdb2CrdInpFileMaker error with exit code: ${code}`)
            reject(new Error(`runPdb2CrdInpFileMaker error with exit code: ${code}`))
          }
        })
        .catch((streamError) => {
          logger.error(`Error closing file streams: ${streamError}`)
          reject(streamError)
        })
    })
  })
}

export { processPdb2CrdJob }
