import { Job as BullMQJob } from 'bullmq'
import { Job, IJob, IStepStatus } from '@bl1231/bilbomd-mongodb-schema'
import { logger } from '../../helpers/loggers.js'
import fs from 'fs-extra'
import path from 'path'
import { spawn } from 'node:child_process'
import { updateStepStatus } from '../functions/mongo-utils.js'

const uploadFolder = process.env.DATA_VOL ?? '/bilbomd/uploads'
const CHARMM_BIN = process.env.CHARMM ?? '/usr/local/bin/charmm'

interface Pdb2CrdCharmmInputData {
  uuid: string
  pdb_file: string
}

const initializeJob = async (MQJob: BullMQJob) => {
  logger.info('---------------------initializeJob---------------------')
  // Clear the BullMQ Job logs
  await MQJob.clearLogs()
  await MQJob.log('Init!')
}

const cleanupJob = async (MQJob: BullMQJob) => {
  logger.info('----------------------cleanupJob-----------------------')
  await MQJob.log('Done!')
}

const processPdb2CrdJob = async (MQJob: BullMQJob) => {
  let status: IStepStatus = {
    status: 'Running',
    message: 'Convert PDB to CRD/PSF has started.'
  }
  let foundJob: IJob | null = null

  try {
    await MQJob.updateProgress(1)

    logger.info(`UUID: ${MQJob.data.uuid}`)
    foundJob = await Job.findOne({ uuid: MQJob.data.uuid }).populate('user').exec()

    if (!foundJob) {
      logger.warn(
        `No MongoDB entry found for: ${MQJob.data.uuid}. Must be from PAE Jiffy.`
      )
    } else {
      logger.info(`MongoDB entry for ${MQJob.data.type} Job found: ${foundJob.uuid}`)
    }
    if (foundJob) {
      await updateStepStatus(foundJob, 'pdb2crd', status)
    } else {
      logger.warn('no mongodb entry found for job. processing pae jiffy job')
    }

    // Initialize
    await initializeJob(MQJob)
    await MQJob.log('start pdb2crd')

    let charmmInpFiles: string[] = []

    charmmInpFiles = await createPdb2CrdCharmmInpFiles({
      uuid: MQJob.data.uuid,
      pdb_file: MQJob.data.pdb_file
    })
    logger.info(`charmmInpFiles: ${charmmInpFiles}`)
    await MQJob.log('end pdb2crd')
    await MQJob.updateProgress(15)

    // Run CHARMM to create individual crd and psf files
    await MQJob.log('start pdb2crd charmm for individual chains')
    await spawnPdb2CrdCharmm(MQJob, charmmInpFiles)
    await MQJob.log('end pdb2crd charmm for individual chains')
    await MQJob.updateProgress(35)

    // Run CHARMM to meld all CRD files into bilbomd_pdb2crd.crd
    await MQJob.log('start pdb2crd charmm meld')
    charmmInpFiles = ['pdb2crd_charmm_meld.inp']
    await spawnPdb2CrdCharmm(MQJob, charmmInpFiles)
    await MQJob.log('end pdb2crd charmm meld')
    await MQJob.updateProgress(65)
    status = {
      status: 'Success',
      message: 'Convert PDB to CRD/PSF has completed.'
    }
    if (foundJob) {
      await updateStepStatus(foundJob, 'pdb2crd', status)
    } else {
      logger.warn('no mongodb entry found for job. processing pae jiffy job')
    }
  } catch (error) {
    status = {
      status: 'Error',
      message: `Error during conversion PDB to CRD/PSF ${error.message}`
    }

    if (foundJob) {
      await updateStepStatus(foundJob, 'pdb2crd', status)
    } else {
      logger.warn('no mongodb entry found for job. processing pae jiffy job')
    }

    logger.error(`Failed processing PDB2CRD Job: ${error}`)
    await MQJob.log(`Error processing job: ${error}`)
  } finally {
    // Cleanup
    await cleanupJob(MQJob)
    await MQJob.updateProgress(100)
  }
}

const createPdb2CrdCharmmInpFiles = async (
  data: Pdb2CrdCharmmInputData
): Promise<string[]> => {
  logger.info(`in createCharmmInpFile: ${JSON.stringify(data)}`)
  const workingDir = path.join(uploadFolder, data.uuid)
  const inputPDB = path.join(workingDir, data.pdb_file)
  const logFile = path.join(workingDir, 'pdb2crd-python.log')
  const errorFile = path.join(workingDir, 'pdb2crd-python_error.log')
  const logStream = fs.createWriteStream(logFile)
  const errorStream = fs.createWriteStream(errorFile)
  const pdb2crd_script = '/app/scripts/pdb2crd.py'
  const args = [pdb2crd_script, inputPDB, '.']

  return new Promise<string[]>((resolve, reject) => {
    const pdb2crd = spawn('python', args, { cwd: workingDir })

    pdb2crd.stdout.on('data', (data: Buffer) => {
      logStream.write(data.toString())
    })

    pdb2crd.stderr.on('data', (data: Buffer) => {
      const errorString = data.toString().trim()
      logger.error('createCharmmInpFile stderr:', errorString)
      errorStream.write(errorString + '\n')
    })

    pdb2crd.on('error', (error) => {
      logger.error('createCharmmInpFile error:', error)
      reject(error)
    })

    pdb2crd.on('close', (code) => {
      // Close streams explicitly once the process closes
      const closeStreamsPromises = [
        new Promise((resolveStream) => logStream.end(resolveStream)),
        new Promise((resolveStream) => errorStream.end(resolveStream))
      ]

      Promise.all(closeStreamsPromises)
        .then(() => {
          if (code === 0) {
            // Read the log file to extract the output filenames
            fs.readFile(logFile, 'utf8', (err, data) => {
              if (err) {
                logger.error('Failed to read log file:', err)
                reject(new Error('Failed to read log file'))
                return
              }

              const outputFiles: string[] = []
              const lines = data.split('\n')
              lines.forEach((line) => {
                line = line.trim()
                if (line) {
                  // Only process non-empty lines
                  logger.info(`inpFile: ${line}`)
                  outputFiles.push(line)
                }
              })

              logger.info(`Successfully parsed output files: ${outputFiles.join(', ')}`)
              resolve(outputFiles)
            })
          } else {
            logger.error(`createCharmmInpFile error with exit code: ${code}`)
            reject(new Error(`createCharmmInpFile error with exit code: ${code}`))
          }
        })
        .catch((streamError) => {
          logger.error(`Error closing file streams: ${streamError}`)
          reject(new Error(`Error closing file streams: ${streamError}`))
        })
    })
  })
}

const spawnPdb2CrdCharmm = (
  MQJob: BullMQJob,
  inputFiles: string[]
): Promise<string[]> => {
  const workingDir = path.join(uploadFolder, MQJob.data.uuid)
  logger.info(`inputFiles for job ${MQJob.data.uuid}: ${inputFiles.join('\n')}`)

  // Create an array of promises, each promise corresponds to one charmm job
  const promises = inputFiles.map((inputFile) => {
    const outputFile = `${inputFile.split('.')[0]}.log`
    // logger.info(`in: ${inputFile} out: ${outputFile}`)
    const charmmArgs = ['-o', outputFile, '-i', inputFile]
    logger.info(`charmmArgs: ${charmmArgs}`)
    const charmmOpts = { cwd: workingDir }

    return new Promise<string>((resolve, reject) => {
      const charmm = spawn(CHARMM_BIN, charmmArgs, charmmOpts)
      let charmmOutput = ''

      charmm.stdout.on('data', (data) => {
        charmmOutput += data.toString()
      })

      charmm.stderr.on('data', (data) => {
        charmmOutput += data.toString()
      })

      charmm.on('error', (error) => {
        logger.error(
          `CHARMM process for file ${inputFile} encountered an error: ${error.message}`
        )
        reject(
          new Error(
            `CHARMM process for file ${inputFile} encountered an error: ${error.message}`
          )
        )
      })

      charmm.on('close', (code) => {
        if (code === 0) {
          MQJob.log(`pdb2crd done with ${inputFile}`)
          logger.info(`CHARMM execution succeeded: ${inputFile}, exit code: ${code}`)
          resolve(charmmOutput)
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
  })

  return Promise.all(promises)
}

export { processPdb2CrdJob, createPdb2CrdCharmmInpFiles, spawnPdb2CrdCharmm }
