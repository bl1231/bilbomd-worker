import { User, IJob } from '@bl1231/bilbomd-mongodb-schema'
import { Job as BullMQJob } from 'bullmq'
import { logger } from '../../helpers/loggers.js'
import { sendJobCompleteEmail } from '../../helpers/mailer.js'
import { config } from '../../config/config.js'
import fs from 'fs-extra'
import { CharmmDCD2PDBParams, CharmmParams } from 'types/index.js'
import path from 'path'
import { spawn, ChildProcess } from 'node:child_process'

const BILBOMD_URL = process.env.BILBOMD_URL ?? 'https://bilbomd.bl1231.als.lbl.gov'

const initializeJob = async (MQJob: BullMQJob, DBjob: IJob): Promise<void> => {
  try {
    // Make sure the user exists in MongoDB
    const foundUser = await User.findById(DBjob.user).lean().exec()
    if (!foundUser) {
      throw new Error(`No user found for: ${DBjob.uuid}`)
    }

    // Clear the BullMQ Job logs in the case this job is being re-run
    await MQJob.clearLogs()

    // Set MongoDB status to Running and update the start time
    DBjob.status = 'Running'
    DBjob.time_started = new Date()
    await DBjob.save()
  } catch (error) {
    // Handle and log the error
    logger.error(`Error in initializeJob: ${error}`)
    throw error
  }
}

const cleanupJob = async (MQjob: BullMQJob, DBjob: IJob): Promise<void> => {
  try {
    // Update MongoDB job status and completion time
    DBjob.status = 'Completed'
    DBjob.time_completed = new Date()
    await DBjob.save()

    // Retrieve the user email from the associated User model
    const user = await User.findById(DBjob.user).lean().exec()
    if (!user) {
      logger.error(`No user found for: ${DBjob.uuid}`)
      return
    }

    // Send job completion email and log the notification
    if (config.sendEmailNotifications) {
      sendJobCompleteEmail(user.email, BILBOMD_URL, DBjob.id, DBjob.title, false)
      logger.info(`email notification sent to ${user.email}`)
      await MQjob.log(`email notification sent to ${user.email}`)
    }
  } catch (error) {
    logger.error(`Error in cleanupJob: ${error}`)
    throw error
  }
}

const makeDir = async (directory: string) => {
  await fs.ensureDir(directory)
  logger.info(`Create Dir: ${directory}`)
}

const makeFile = async (file: string) => {
  await fs.ensureFile(file)
}

const generateDCD2PDBInpFile = async (
  params: CharmmDCD2PDBParams,
  rg: number,
  run: number
) => {
  params.in_dcd = `dynamics_rg${rg}_run${run}.dcd`
  await generateInputFile(params)
}

const writeInputFile = async (template: string, params: CharmmParams): Promise<void> => {
  try {
    const outFile = path.join(params.out_dir, params.charmm_inp_file)
    const templ = Handlebars.compile(template)
    const content = templ(params)

    logger.info(`Write Input File: ${outFile}`)
    await fs.promises.writeFile(outFile, content)
  } catch (error) {
    logger.error(`Error in writeInputFile: ${error}`)
    throw error
  }
}

const readTemplate = async (templateName: string): Promise<string> => {
  const templateFile = path.join(config.charmmTemplateDir, `${templateName}.handlebars`)
  return fs.readFile(templateFile, 'utf8')
}

const generateInputFile = async (params: CharmmParams): Promise<void> => {
  const templateString = await readTemplate(params.charmm_template)
  await writeInputFile(templateString, params)
}

const spawnCharmm = (params: CharmmParams): Promise<void> => {
  const { charmm_inp_file: inputFile, charmm_out_file: outputFile, out_dir } = params
  const charmmArgs = ['-o', outputFile, '-i', inputFile]
  const charmmOpts = { cwd: out_dir }

  return new Promise<void>((resolve, reject) => {
    const charmm: ChildProcess = spawn(config.charmmBin, charmmArgs, charmmOpts)
    let charmmOutput = '' // Create an empty string to capture stdout

    charmm.stdout?.on('data', (data) => {
      charmmOutput += data.toString()
    })

    charmm.on('error', (error) => {
      reject(new Error(`CHARMM process encountered an error: ${error.message}`))
    })

    charmm.on('close', (code: number) => {
      if (code === 0) {
        logger.info(`CHARMM success: ${inputFile} exit code: ${code}`)
        resolve()
      } else {
        logger.info(`CHARMM error: ${inputFile} exit code: ${code}`)
        reject(new Error(charmmOutput))
      }
    })
  })
}

const spawnFoXS = async (foxsRunDir: string) => {
  try {
    const files = await fs.readdir(foxsRunDir)
    logger.info(`Spawn FoXS jobs: ${foxsRunDir}`)
    const foxsOpts = { cwd: foxsRunDir }

    const spawnPromises = files.map(
      (file) =>
        new Promise<void>((resolve, reject) => {
          const foxsArgs = ['-p', file]
          const foxs: ChildProcess = spawn(config.foxBin, foxsArgs, foxsOpts)
          foxs.on('exit', (code) => {
            if (code === 0) {
              resolve()
            } else {
              reject(new Error(`FoXS process exited with code ${code}`))
            }
          })
        })
    )
    await Promise.all(spawnPromises)
  } catch (error) {
    logger.error(error)
  }
}

export {
  initializeJob,
  cleanupJob,
  makeDir,
  makeFile,
  generateDCD2PDBInpFile,
  generateInputFile,
  spawnCharmm,
  spawnFoXS
}
