import { spawn, ChildProcess } from 'node:child_process'
import { IJob, IBilboMDAutoJob } from '../../models/Job'
import fs from 'fs-extra'
import path from 'node:path'
import { logger } from '../../helpers/loggers'
import { createInterface } from 'readline'
const DATA_VOL = process.env.DATA_VOL ?? '/bilbomd/uploads'
const FOXS_BIN = process.env.FOXS ?? '/usr/bin/foxs'

const countDataPoints = async (filePath: string): Promise<number> => {
  const fileStream = fs.createReadStream(filePath)
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity
  })
  let count = 0
  for await (const line of rl) {
    // Check that the line is not empty and does not start with a '#'
    if (line.trim() !== '' && !line.trim().startsWith('#')) {
      count++
    }
  }
  rl.close() // Explicitly close the readline interface
  logger.info(`countDataPoints original dat file has: ${count} points`)
  logger.info(`countDataPoints adjusting counts to: ${count - 1} points`)
  return count - 1
}

const runSingleFoXS = async (DBjob: IJob | IBilboMDAutoJob): Promise<void> => {
  try {
    const jobDir = path.join(DATA_VOL, DBjob.uuid)
    const logFile = path.join(jobDir, 'initial_foxs_analysis.log')
    const errorFile = path.join(jobDir, 'initial_foxs_analysis_error.log')
    const logStream = fs.createWriteStream(logFile)
    const errorStream = fs.createWriteStream(errorFile)
    const inputPDB = 'minimization_output.pdb'
    const inputDAT = DBjob.data_file
    const profileSize = await countDataPoints(path.join(jobDir, inputDAT))
    const foxsOpts = { cwd: jobDir }
    const foxsArgs = [
      '-o',
      '--min_c1=0.99',
      '--max_c1=1.05',
      '--min_c2=-0.50',
      '--max_c2=2.00',
      '--profile_size=' + profileSize,
      inputPDB,
      inputDAT
    ]
    logger.info(`runSingleFoXS foxsArgs: ${foxsArgs}`)
    new Promise<void>((resolve, reject) => {
      const foxs: ChildProcess = spawn(FOXS_BIN, foxsArgs, foxsOpts)
      foxs.stdout?.on('data', (data) => {
        logStream.write(data.toString())
      })
      foxs.stderr?.on('data', (data) => {
        errorStream.write(data.toString())
      })
      foxs.on('error', (error) => {
        logger.error(`FoXS analysis error: ${error}`)
        errorStream.end()
        reject(error)
      })
      foxs.on('exit', (code) => {
        // Close streams explicitly once the process exits
        const closeStreamsPromises = [
          new Promise((resolveStream) => logStream.end(resolveStream)),
          new Promise((resolveStream) => errorStream.end(resolveStream))
        ]
        Promise.all(closeStreamsPromises)
          .then(() => {
            // Only proceed once all streams are closed
            if (code === 0) {
              logger.info(`FoXS analysis success with exit code: ${code}`)
              resolve()
            } else {
              logger.error(`FoXS analysis error with exit code: ${code}`)
              reject(new Error(`FoXS analysis error with exit code: ${code}`))
            }
          })
          .catch((streamError) => {
            logger.error(`Error closing file streams: ${streamError}`)
            reject(streamError)
          })
      })
    })
  } catch (error) {
    logger.error(error)
  }
}

export { runSingleFoXS }