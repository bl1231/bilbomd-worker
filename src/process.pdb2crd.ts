import { Job as BullMQJob } from 'bullmq'
import { BilboMdAutoJob, IBilboMDAutoJob } from './model/Job'
import { logger } from './loggers'
import fs from 'fs-extra'
import path from 'path'
import { spawn, ChildProcess } from 'node:child_process'

const uploadFolder = process.env.DATA_VOL ?? '/bilbomd/uploads'
// const af2paeUploads = path.join(uploadFolder, 'af2pae_uploads')
const CHARMM_BIN = process.env.CHARMM ?? '/usr/local/bin/charmm'
// const TOPO_FILES = process.env.CHARM_TOPOLOGY ?? 'bilbomd_top_par_files.str'

const initializeJob = async (MQJob: BullMQJob) => {
  // logger.info('init job')
  logger.info('-------------------------------------')
  // Clear the BullMQ Job logs
  await MQJob.clearLogs()
  await MQJob.log('Init!')
}

const cleanupJob = async (MQjob: BullMQJob) => {
  // logger.info('cleanup job')
  logger.info('-------------------------------------')
  await MQjob.log('Done!')
}

const processPdb2CrdJob = async (MQJob: BullMQJob) => {
  await MQJob.updateProgress(1)

  const foundJob = await BilboMdAutoJob.findOne({ uuid: MQJob.data.uuid })
    .populate({
      path: 'user',
      select: 'email'
    })
    .exec()
  if (!foundJob) {
    throw new Error(`No job found for: ${MQJob.data.jobid}`)
  }
  logger.info(foundJob)
  // Initialize
  await initializeJob(MQJob)

  // Create pdb_2_crd.inp file
  await MQJob.log('start pdb_2_crd')
  await createCharmmInpFile(foundJob)
  await MQJob.log('end pdb_2_crd')
  await MQJob.updateProgress(15)

  // Run CHARMM to create crd and psf files
  await MQJob.log('start pdb_2_crd charmm')
  await spawnCharmm(MQJob)
  await MQJob.log('end pdb_2_crd charmm')
  await MQJob.updateProgress(35)

  // Cleanup
  await cleanupJob(MQJob)
  await MQJob.updateProgress(100)
}

const createCharmmInpFile = (DBJob: IBilboMDAutoJob) => {
  logger.info('in createCharmmInpFile')
  const workingDir = path.join(uploadFolder, DBJob.uuid)
  const inputPDB = path.join(workingDir, DBJob.pdb_file)
  const logFile = path.join(workingDir, 'pdb2crd.log')
  const errorFile = path.join(workingDir, 'pdb2crd_error.log')
  const logStream = fs.createWriteStream(logFile)
  const errorStream = fs.createWriteStream(errorFile)
  const pdb2crd_script = '/app/scripts/pdb2crd.py'
  const args = [pdb2crd_script, inputPDB, '.']
  logger.info(`args for pdb2crd_script: ${args}`)

  return new Promise((resolve, reject) => {
    const pdb2crd: ChildProcess = spawn('python', args, { cwd: workingDir })
    pdb2crd.stdout?.on('data', (data: Buffer) => {
      const dataString = data.toString().trim()
      logger.info(`createCharmmInpFile stdout ${dataString}`)
      logStream.write(dataString)
    })
    pdb2crd.stderr?.on('data', (data: Buffer) => {
      logger.error('createCharmmInpFile stderr', data.toString())
      console.log(data)
      errorStream.write(data.toString())
    })
    pdb2crd.on('error', (error) => {
      logger.error('createCharmmInpFile error:', error)
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
            logger.info(`createCharmmInpFile success with exit code: ${code}`)
            resolve(code.toString())
          } else {
            logger.error(`createCharmmInpFile error with exit code: ${code}`)
            reject(new Error(`createCharmmInpFile error with exit code: ${code}`))
          }
        })
        .catch((streamError) => {
          logger.error(`Error closing file streams: ${streamError}`)
          reject(streamError)
        })
    })
  })
}

const spawnCharmm = (MQJob: BullMQJob): Promise<string> => {
  const workingDir = path.join(uploadFolder, MQJob.data.uuid)
  const outputFile = 'pdb2crd_charmm.log'
  const inputFile = 'pdb_2_crd.inp'
  const charmmArgs = ['-o', outputFile, '-i', inputFile]
  const charmmOpts = { cwd: workingDir }

  return new Promise((resolve, reject) => {
    const charmm = spawn(CHARMM_BIN, charmmArgs, charmmOpts)
    let charmmOutput = '' // Accumulates stdout and stderr

    // Collect output from stdout
    charmm.stdout.on('data', (data) => {
      charmmOutput += data.toString()
    })

    // Optionally, capture stderr if you want to log errors or failed execution details
    charmm.stderr.on('data', (data) => {
      charmmOutput += data.toString()
    })

    charmm.on('error', (error) => {
      logger.error(`CHARMM process encountered an error: ${error.message}`)
      reject(new Error(`CHARMM process encountered an error: ${error.message}`))
    })

    charmm.on('close', (code) => {
      if (code === 0) {
        logger.info(`CHARMM execution succeeded: ${inputFile}, exit code: ${code}`)
        resolve(charmmOutput) // Resolve with charmmOutput to provide execution details
      } else {
        logger.error(
          `CHARMM execution failed: ${inputFile}, exit code: ${code}, error: ${charmmOutput}`
        )
        reject(
          new Error(
            `CHARMM execution failed: ${inputFile}, exit code: ${code}, error: ${charmmOutput}`
          )
        )
      }
    })
  })
}

export { processPdb2CrdJob }
