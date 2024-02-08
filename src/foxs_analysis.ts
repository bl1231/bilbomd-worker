import { spawn, ChildProcess } from 'node:child_process'
import { IBilboMDJob, IBilboMDAutoJob } from './model/Job'
import fs from 'fs-extra'
import path from 'node:path'

const DATA_VOL = process.env.DATA_VOL ?? '/bilbomd/uploads'
const FOXS_BIN = process.env.FOXS ?? '/usr/bin/foxs'

const runSingleFoXS = async (DBjob: IBilboMDJob | IBilboMDAutoJob): Promise<void> => {
  try {
    const jobDir = path.join(DATA_VOL, DBjob.uuid)
    const logFile = path.join(jobDir, 'initial_foxs_analysis.log')
    const errorFile = path.join(jobDir, 'initial_foxs_analysis_error.log')
    const logStream = fs.createWriteStream(logFile)
    const errorStream = fs.createWriteStream(errorFile)
    const inputPDB = 'minimization_output.pdb'
    const inputDAT = DBjob.data_file
    const foxsOpts = { cwd: jobDir }
    const foxsArgs = [
      '-o',
      '--min_c1=0.99',
      '--max_c1=1.05',
      '--min_c2=-0.50',
      '--max_c2=2.00',
      inputPDB,
      inputDAT
    ]
    new Promise<void>((resolve, reject) => {
      const foxs: ChildProcess = spawn(FOXS_BIN, foxsArgs, foxsOpts)
      foxs.stdout?.on('data', (data) => {
        logStream.write(data.toString())
      })

      foxs.stderr?.on('data', (data) => {
        errorStream.write(data.toString())
      })
      foxs.on('error', (error) => {
        errorStream.end()
        reject(error)
      })
      foxs.on('exit', (code) => {
        logStream.end()
        errorStream.end()
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`FoXS process exited with code ${code}`))
        }
      })
    })
  } catch (error) {
    console.error(error)
  }
}

export { runSingleFoXS }
