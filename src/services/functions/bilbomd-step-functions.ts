import Handlebars from 'handlebars'
import { logger } from '../../helpers/loggers'
import { config } from '../../config/config'
import { spawn, ChildProcess } from 'node:child_process'
import { promisify } from 'util'
import fs from 'fs-extra'
import readline from 'node:readline'
import path from 'path'
import { Job as BullMQJob } from 'bullmq'
import { IBilboMDSteps, IStepStatus, IUser } from '@bl1231/bilbomd-mongodb-schema'
import {
  IJob,
  IBilboMDPDBJob,
  IBilboMDCRDJob,
  IBilboMDAutoJob
} from '@bl1231/bilbomd-mongodb-schema'
import { sendJobCompleteEmail } from '../../helpers/mailer'
import { exec } from 'node:child_process'
import { createPdb2CrdCharmmInpFiles, spawnPdb2CrdCharmm } from '../process/pdb-to-crd'
import {
  CharmmParams,
  CharmmDCD2PDBParams,
  MultiFoxsParams,
  PaeParams,
  CharmmHeatParams,
  CharmmMDParams,
  FoxsParams,
  FileCopyParams
} from '../../types/index'
import { updateStepStatus } from './mongo-utils'

const execPromise = promisify(exec)
const TEMPLATES = path.resolve(__dirname, '../../templates/bilbomd')

const TOPO_FILES = process.env.CHARM_TOPOLOGY ?? 'bilbomd_top_par_files.str'
const FOXS_BIN = process.env.FOXS ?? '/usr/bin/foxs'
const MULTIFOXS_BIN = process.env.MULTIFOXS ?? '/usr/bin/multi_foxs'
const CHARMM_BIN = process.env.CHARMM ?? '/usr/local/bin/charmm'
const DATA_VOL = process.env.DATA_VOL ?? '/bilbomd/uploads'
const BILBOMD_URL = process.env.BILBOMD_URL ?? 'https://bilbomd.bl1231.als.lbl.gov'

const handleError = async (
  error: Error | unknown,
  MQjob: BullMQJob,
  DBjob: IJob,
  step?: keyof IBilboMDSteps
) => {
  const errorMsg = step || (error instanceof Error ? error.message : String(error))

  // Updates primay status in MongoDB
  await updateJobStatus(DBjob, 'Error')
  // Update the specific step status
  if (step) {
    const status: IStepStatus = {
      status: 'Error',
      message: `Error in step ${step}: ${errorMsg}`
    }
    await updateStepStatus(DBjob, step, status)
  } else {
    logger.error(`Step not provided or invalid when handling error: ${errorMsg}`)
  }

  MQjob.log(`error ${errorMsg}`)

  logger.error(`handleError errorMsg: ${errorMsg}`)

  MQjob.log(error instanceof Error ? error.message : String(error))

  // Send job completion email and log the notification
  logger.info(`Failed Attempts --> ${MQjob.attemptsMade}`)

  const recipientEmail = (DBjob.user as IUser).email
  if (MQjob.attemptsMade >= 3) {
    if (config.sendEmailNotifications) {
      sendJobCompleteEmail(recipientEmail, BILBOMD_URL, DBjob.id, DBjob.title, true)
      logger.warn(`email notification sent to ${recipientEmail}`)
      await MQjob.log(`email notification sent to ${recipientEmail}`)
    }
  }
  throw new Error('BilboMD failed')
}

const updateJobStatus = async (job: IJob, status: string): Promise<void> => {
  job.status = status
  await job.save()
}

const writeToFile = async (template: string, params: CharmmParams): Promise<void> => {
  try {
    const outFile = path.join(params.out_dir, params.charmm_inp_file)
    const templ = Handlebars.compile(template)
    const content = templ(params)

    logger.info(`Write File: ${outFile}`)
    await fs.promises.writeFile(outFile, content)
  } catch (error) {
    logger.error(`Error in writeToFile: ${error}`)
    throw error
  }
}

const readTemplate = async (templateName: string): Promise<string> => {
  const templateFile = path.join(TEMPLATES, `${templateName}.handlebars`)
  return fs.readFile(templateFile, 'utf8')
}

const generateInputFile = async (params: CharmmParams): Promise<void> => {
  const templateString = await readTemplate(params.charmm_template)
  await writeToFile(templateString, params)
}

const generateDCD2PDBInpFile = async (
  params: CharmmDCD2PDBParams,
  rg: number,
  run: number
) => {
  params.charmm_template = 'dcd2pdb'
  // params.in_pdb = 'heat_output.pdb'
  params.in_dcd = `dynamics_rg${rg}_run${run}.dcd`
  await generateInputFile(params)
}

const makeFile = async (file: string) => {
  await fs.ensureFile(file)
}

const makeDir = async (directory: string) => {
  await fs.ensureDir(directory)
  logger.info(`Create Dir: ${directory}`)
}

const makeFoxsDatFileList = async (dir: string) => {
  const stdOut = path.join(dir, 'foxs_dat_files.txt')
  const stdErr = path.join(dir, 'foxs_dat_files_errors.txt')
  const stdoutStream = fs.createWriteStream(stdOut)
  const errorStream = fs.createWriteStream(stdErr)

  try {
    const { stdout, stderr } = await execPromise('ls -1 ../foxs/*/*.pdb.dat', {
      cwd: dir
    })

    // Use 'end' to ensure the stream is closed after writing
    stdoutStream.end(stdout)
    errorStream.end(stderr)

    // Wait for both streams to finish writing and closing
    await Promise.all([
      new Promise((resolve, reject) =>
        stdoutStream.on('finish', resolve).on('error', reject)
      ),
      new Promise((resolve, reject) =>
        errorStream.on('finish', resolve).on('error', reject)
      )
    ])
  } catch (error) {
    logger.error(`Error generating foxs_dat_files list ${error}`)
    // It's important to close the streams even in case of an error to free up the resources
    stdoutStream.end()
    errorStream.end()
  }
}

const getNumEnsembles = async (logFile: string): Promise<number> => {
  const rl = readline.createInterface({
    input: fs.createReadStream(logFile),
    crlfDelay: Infinity
  })
  const regex = /(?:number_of_states[ ])([\d]+)/
  const ensembleCount = ['0']
  for await (const line of rl) {
    const found = line.match(regex)
    if (found !== null) {
      ensembleCount.push(found[1])
    }
  }
  return Number(ensembleCount.pop())
}

const extractPdbPaths = (content: string): string[] => {
  const lines = content.split('\n')
  const pdbPaths = lines
    .filter((line) => line.includes('.pdb.dat'))
    .map((line) => {
      const match = line.match(/(\/[^|]+\.pdb.dat)/)
      if (match) {
        const fullPath = match[1]
        // Remove the .dat extension from the filename
        const filename = fullPath.replace(/\.dat$/, '')
        return filename
      }
      return ''
    })
  // Extracts all PDBs
  //
  // logger.info(`extractPdbPaths pdbPaths: ${pdbPaths}`)
  return pdbPaths
}

const concatenateAndSaveAsEnsemble = async (
  pdbFiles: string[],
  ensembleSize: number,
  resultsDir: string
) => {
  try {
    const concatenatedContent: string[] = []
    for (let i = 0; i < pdbFiles.length; i++) {
      // Read the content of each PDB file
      let content = await fs.readFile(pdbFiles[i], 'utf8')

      // Replace the word "END" with "ENDMDL"
      content = content.replace(/\bEND\n?$/, 'ENDMDL')

      // Concatenate the content with MODEL....N
      concatenatedContent.push(`MODEL       ${i + 1}`)
      concatenatedContent.push(content)
    }

    // Save the concatenated content to the ensemble file
    const ensembleFileName = `ensemble_size_${ensembleSize}_model.pdb`
    const ensembleFile = path.join(resultsDir, ensembleFileName)
    await fs.writeFile(ensembleFile, concatenatedContent.join('\n'))

    logger.info(`Ensemble file saved: ${ensembleFile}`)
  } catch (error) {
    logger.error(`Error: ${error}`)
  }
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
          const foxs: ChildProcess = spawn(FOXS_BIN, foxsArgs, foxsOpts)
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

const spawnMultiFoxs = (params: MultiFoxsParams): Promise<void> => {
  const multiFoxsDir = path.join(params.out_dir, 'multifoxs')
  const logFile = path.join(multiFoxsDir, 'multi_foxs.log')
  const errorFile = path.join(multiFoxsDir, 'multi_foxs_error.log')
  const logStream = fs.createWriteStream(logFile)
  const errorStream = fs.createWriteStream(errorFile)
  const saxsData = path.join(params.out_dir, params.data_file)
  const multiFoxArgs = ['-o', saxsData, 'foxs_dat_files.txt']
  const multiFoxOpts = { cwd: multiFoxsDir }

  return new Promise((resolve, reject) => {
    const multiFoxs: ChildProcess = spawn(MULTIFOXS_BIN, multiFoxArgs, multiFoxOpts)
    multiFoxs.stdout?.on('data', (data) => {
      logStream.write(data.toString())
    })
    multiFoxs.stderr?.on('data', (data) => {
      errorStream.write(data.toString())
    })
    multiFoxs.on('error', (error) => {
      logger.error(`spawnMultiFoxs error: ${error}`)
      reject(error)
    })
    multiFoxs.on('exit', (code: number) => {
      const closeStreamsPromises = [
        new Promise((resolveStream) => logStream.end(resolveStream)),
        new Promise((resolveStream) => errorStream.end(resolveStream))
      ]
      Promise.all(closeStreamsPromises)
        .then(() => {
          if (code === 0) {
            logger.info(`spawnMultiFoxs close success exit code: ${code}`)
            resolve()
          } else {
            logger.info(`spawnMultiFoxs close error exit code: ${code}`)
            reject(`spawnMultiFoxs on close reject`)
          }
        })
        .catch((streamError) => {
          logger.error(`Error closing file streams: ${streamError}`)
          reject(streamError)
        })
    })
  })
}

const spawnCharmm = (params: CharmmParams): Promise<string> => {
  const { charmm_inp_file: inputFile, charmm_out_file: outputFile, out_dir } = params
  const charmmArgs = ['-o', outputFile, '-i', inputFile]
  const charmmOpts = { cwd: out_dir }

  return new Promise<string>((resolve, reject) => {
    const charmm: ChildProcess = spawn(CHARMM_BIN, charmmArgs, charmmOpts)
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
        resolve('CHARMM execution succeeded')
      } else {
        logger.info(`CHARMM error: ${inputFile} exit code: ${code}`)
        reject(new Error(charmmOutput))
      }
    })
  })
}

const spawnPaeToConst = async (params: PaeParams): Promise<string> => {
  const logFile = path.join(params.out_dir, 'af2pae.log')
  const errorFile = path.join(params.out_dir, 'af2pae_error.log')
  const logStream = fs.createWriteStream(logFile)
  const errorStream = fs.createWriteStream(errorFile)
  const paeFile = params.in_pae
  const crdFile = params.in_crd
  const af2pae_script = '/app/scripts/pae_ratios.py'
  const args = [af2pae_script, paeFile, crdFile]
  const opts = { cwd: params.out_dir }

  return new Promise((resolve, reject) => {
    const runPaeToConst: ChildProcess = spawn('python', args, opts)
    runPaeToConst.stdout?.on('data', (data) => {
      logger.info(`runPaeToConst stdout:  ${data.toString()}`)
      logStream.write(data.toString())
    })
    runPaeToConst.stderr?.on('data', (data) => {
      logger.error(`runPaeToConst stderr:  ${data.toString()}`)
      errorStream.write(data.toString())
    })
    runPaeToConst.on('error', (error) => {
      logger.error(`runPaeToConst error: ${error}`)
      reject(error)
    })
    runPaeToConst.on('exit', (code: number) => {
      const closeStreamsPromises = [
        new Promise((resolveStream) => logStream.end(resolveStream)),
        new Promise((resolveStream) => errorStream.end(resolveStream))
      ]
      Promise.all(closeStreamsPromises)
        .then(() => {
          if (code === 0) {
            logger.info(`runPaeToConst close success exit code: ${code}`)
            resolve(code.toString())
          } else {
            logger.error(`runPaeToConst close error exit code: ${code}`)
            reject(new Error('runPaeToConst failed. Please see the error log file'))
          }
        })
        .catch((streamError) => {
          logger.error(`Error closing file streams: ${streamError}`)
          reject(streamError)
        })
    })
  })
}

const runPdb2Crd = async (MQjob: BullMQJob, DBjob: IBilboMDPDBJob): Promise<void> => {
  try {
    let status: IStepStatus = {
      status: 'Running',
      message: 'PDB2CRD has started.'
    }
    await updateStepStatus(DBjob, 'pdb2crd', status)

    let charmmInpFiles: string[] = []

    charmmInpFiles = await createPdb2CrdCharmmInpFiles({
      uuid: DBjob.uuid,
      pdb_file: DBjob.pdb_file
    })
    // logger.info(`runPdb2Crd: ${charmmInpFiles}`)
    // CHARMM pdb2crd convert individual chains
    await spawnPdb2CrdCharmm(MQjob, charmmInpFiles)
    // CHARMM pdb2crd meld individual crd files
    charmmInpFiles = ['pdb2crd_charmm_meld.inp']
    await spawnPdb2CrdCharmm(MQjob, charmmInpFiles)
    // Update MongoDB
    DBjob.psf_file = 'bilbomd_pdb2crd.psf'
    DBjob.crd_file = 'bilbomd_pdb2crd.crd'
    status = {
      status: 'Success',
      message: 'PDB2CRD has completed.'
    }
    await updateStepStatus(DBjob, 'pdb2crd', status)
  } catch (error) {
    await handleError(error, MQjob, DBjob, 'pdb2crd')
  }
}

const runPaeToConstInp = async (
  MQjob: BullMQJob,
  DBjob: IBilboMDAutoJob
): Promise<void> => {
  const outputDir = path.join(DATA_VOL, DBjob.uuid)
  // I'm struggling with Typescript here. Since a BilboMDAutoJob will not
  // have a CRD file when it is first created. I know it's not considered
  // safe, but I'm going to use type assertion for now.
  const params: PaeParams = {
    in_crd: DBjob.crd_file as string,
    in_pae: DBjob.pae_file,
    out_dir: outputDir
  }
  try {
    let status: IStepStatus = {
      status: 'Running',
      message: 'Generate const.inp from PAE matrix has started.'
    }
    await updateStepStatus(DBjob, 'pae', status)
    await spawnPaeToConst(params)
    DBjob.const_inp_file = 'const.inp'
    await DBjob.save()
    status = {
      status: 'Success',
      message: 'Generate const.inp from PAE matrix has completed.'
    }
    await updateStepStatus(DBjob, 'pae', status)
  } catch (error) {
    await handleError(error, MQjob, DBjob, 'pae')
  }
}

const runAutoRg = async (DBjob: IBilboMDAutoJob): Promise<void> => {
  const outputDir = path.join(DATA_VOL, DBjob.uuid)
  const logFile = path.join(outputDir, 'autoRg.log')
  const errorFile = path.join(outputDir, 'autoRg_error.log')
  const autoRg_script = '/app/scripts/autorg.py'
  const args = [autoRg_script, DBjob.data_file]

  const logStream = fs.createWriteStream(logFile)
  const errorStream = fs.createWriteStream(errorFile)

  let status: IStepStatus = {
    status: 'Running',
    message: 'Calculate Rg has started.'
  }
  await updateStepStatus(DBjob, 'autorg', status)

  return new Promise<void>((resolve, reject) => {
    const autoRg = spawn('python', args, { cwd: outputDir })
    let autoRg_json = ''

    autoRg.stdout?.on('data', (data) => {
      logStream.write(data.toString())
      autoRg_json += data.toString()
    })

    autoRg.stderr?.on('data', (data) => {
      errorStream.write(data.toString())
    })

    autoRg.on('error', (error) => {
      logger.error(`spawnMultiFoxs error: ${error}`)
      errorStream.end() // Ensure error stream is closed on process error
      logStream.end() // Ensure log stream is closed on process error
      reject(error)
    })

    autoRg.on('exit', (code) => {
      Promise.all([
        new Promise((resolveStream) => logStream.end(resolveStream)),
        new Promise((resolveStream) => errorStream.end(resolveStream))
      ])
        .then(() => {
          if (code === 0) {
            try {
              const analysisResults = JSON.parse(autoRg_json)
              DBjob.rg_min = analysisResults.rg_min
              DBjob.rg_max = analysisResults.rg_max
              DBjob.save()
                .then(() => {
                  status = {
                    status: 'Success',
                    message: 'Calculate Rg completed successfully.'
                  }
                  updateStepStatus(DBjob, 'autorg', status)
                    .then(() => resolve())
                    .catch(reject)
                })
                .catch(reject)
            } catch (parseError) {
              reject(parseError)
            }
          } else {
            status = {
              status: 'Error',
              message: `AutoRg process exited with code ${code}.`
            }
            updateStepStatus(DBjob, 'autorg', status)
              .then(() => reject(new Error(status.message)))
              .catch(reject)
          }
        })
        .catch((streamError) => {
          logger.error(`Error closing file streams: ${streamError}`)
          reject(streamError)
        })
    })
  })
}

const runMinimize = async (MQjob: BullMQJob, DBjob: IBilboMDCRDJob): Promise<void> => {
  const outputDir = path.join(DATA_VOL, DBjob.uuid)
  const params: CharmmParams = {
    out_dir: outputDir,
    charmm_template: 'minimize',
    charmm_topo_dir: TOPO_FILES,
    charmm_inp_file: 'minimize.inp',
    charmm_out_file: 'minimize.out',
    in_psf_file: DBjob.psf_file,
    in_crd_file: DBjob.crd_file
  }
  try {
    let status: IStepStatus = {
      status: 'Running',
      message: 'CHARMM Minimization has started.'
    }
    await updateStepStatus(DBjob, 'minimize', status)
    await generateInputFile(params)
    await spawnCharmm(params)
    status = {
      status: 'Success',
      message: 'CHARMM Minimization has completed.'
    }
    await updateStepStatus(DBjob, 'minimize', status)
  } catch (error: unknown) {
    await handleError(error, MQjob, DBjob, 'minimize')
  }
}

const runHeat = async (MQjob: BullMQJob, DBjob: IBilboMDCRDJob): Promise<void> => {
  const outputDir = path.join(DATA_VOL, DBjob.uuid)
  const params: CharmmHeatParams = {
    out_dir: outputDir,
    charmm_template: 'heat',
    charmm_topo_dir: TOPO_FILES,
    charmm_inp_file: 'heat.inp',
    charmm_out_file: 'heat.out',
    in_psf_file: DBjob.psf_file,
    in_crd_file: 'minimization_output.crd',
    constinp: DBjob.const_inp_file
  }
  try {
    let status: IStepStatus = {
      status: 'Running',
      message: 'CHARMM Heating has started.'
    }
    await updateStepStatus(DBjob, 'heat', status)
    await generateInputFile(params)
    await spawnCharmm(params)
    status = {
      status: 'Success',
      message: 'CHARMM Heating has completed.'
    }
    await updateStepStatus(DBjob, 'heat', status)
  } catch (error) {
    await handleError(error, MQjob, DBjob, 'heat')
  }
}

const runMolecularDynamics = async (
  MQjob: BullMQJob,
  DBjob: IBilboMDCRDJob
): Promise<void> => {
  const outputDir = path.join(DATA_VOL, DBjob.uuid)
  const params: CharmmMDParams = {
    out_dir: outputDir,
    charmm_template: 'dynamics',
    charmm_topo_dir: TOPO_FILES,
    charmm_inp_file: '',
    charmm_out_file: '',
    in_psf_file: DBjob.psf_file,
    in_crd_file: '',
    constinp: DBjob.const_inp_file,
    rg_min: DBjob.rg_min,
    rg_max: DBjob.rg_max,
    conf_sample: DBjob.conformational_sampling,
    timestep: 0.001,
    inp_basename: '',
    rg: 0
  }

  try {
    let status: IStepStatus = {
      status: 'Running',
      message: 'CHARMM Molecular Dynamics has started.'
    }
    await updateStepStatus(DBjob, 'md', status)
    const molecularDynamicsTasks = []
    const step = Math.max(Math.round((params.rg_max - params.rg_min) / 5), 1)
    for (let rg = params.rg_min; rg <= params.rg_max; rg += step) {
      params.charmm_inp_file = `${params.charmm_template}_rg${rg}.inp`
      params.charmm_out_file = `${params.charmm_template}_rg${rg}.out`
      params.inp_basename = `${params.charmm_template}_rg${rg}`
      params.rg = rg
      await generateInputFile(params)
      molecularDynamicsTasks.push(spawnCharmm(params))
    }
    await Promise.all(molecularDynamicsTasks)
    status = {
      status: 'Success',
      message: 'CHARMM Molecular Dynamics has completed.'
    }
    await updateStepStatus(DBjob, 'md', status)
  } catch (error) {
    await handleError(error, MQjob, DBjob, 'md')
  }
}

const runFoxs = async (MQjob: BullMQJob, DBjob: IBilboMDCRDJob): Promise<void> => {
  const outputDir = path.join(DATA_VOL, DBjob.uuid)

  const foxsParams: FoxsParams = {
    out_dir: outputDir,
    rg_min: DBjob.rg_min,
    rg_max: DBjob.rg_max,
    foxs_rg: 'foxs_rg.out',
    conf_sample: DBjob.conformational_sampling
  }

  const DCD2PDBParams: CharmmDCD2PDBParams = {
    out_dir: outputDir,
    charmm_template: 'dcd2pdb',
    charmm_topo_dir: TOPO_FILES,
    charmm_inp_file: '',
    charmm_out_file: '',
    in_psf_file: DBjob.psf_file,
    in_crd_file: '',
    inp_basename: '',
    foxs_rg: 'foxs_rg.out',
    in_dcd: '',
    run: ''
  }

  try {
    let status: IStepStatus = {
      status: 'Running',
      message: 'FoXS Calculations have started.'
    }
    await updateStepStatus(DBjob, 'foxs', status)
    const foxsDir = path.join(foxsParams.out_dir, 'foxs')
    await makeDir(foxsDir)
    const foxsRgFile = path.join(foxsParams.out_dir, foxsParams.foxs_rg)
    await makeFile(foxsRgFile)

    const step = Math.max(Math.round((foxsParams.rg_max - foxsParams.rg_min) / 5), 1)

    for (let rg = foxsParams.rg_min; rg <= foxsParams.rg_max; rg += step) {
      for (let run = 1; run <= foxsParams.conf_sample; run += 1) {
        const runAllCharmm = []
        const runAllFoxs = []
        const foxsRunDir = path.join(foxsDir, `rg${rg}_run${run}`)

        await makeDir(foxsRunDir)

        DCD2PDBParams.charmm_inp_file = `${DCD2PDBParams.charmm_template}_rg${rg}_run${run}.inp`
        DCD2PDBParams.charmm_out_file = `${DCD2PDBParams.charmm_template}_rg${rg}_run${run}.out`
        DCD2PDBParams.inp_basename = `${DCD2PDBParams.charmm_template}_rg${rg}_run${run}`
        DCD2PDBParams.run = `rg${rg}_run${run}`

        await generateDCD2PDBInpFile(DCD2PDBParams, rg, run)
        runAllCharmm.push(spawnCharmm(DCD2PDBParams))
        await Promise.all(runAllCharmm)

        // then run FoXS on every PDB in foxsRunDir
        runAllFoxs.push(spawnFoXS(foxsRunDir))
        await Promise.all(runAllFoxs)
      }
    }
    status = {
      status: 'Success',
      message: 'FoXS Calculations have completed.'
    }
    await updateStepStatus(DBjob, 'foxs', status)
  } catch (error) {
    await handleError(error, MQjob, DBjob, 'foxs')
  }
}

const runMultiFoxs = async (MQjob: BullMQJob, DBjob: IBilboMDPDBJob): Promise<void> => {
  const outputDir = path.join(DATA_VOL, DBjob.uuid)
  const multifoxsParams: MultiFoxsParams = {
    out_dir: outputDir,
    data_file: DBjob.data_file
  }
  try {
    let status: IStepStatus = {
      status: 'Running',
      message: 'MultiFoXS Calculations have started.'
    }
    await updateStepStatus(DBjob, 'multifoxs', status)
    const multiFoxsDir = path.join(multifoxsParams.out_dir, 'multifoxs')
    await makeDir(multiFoxsDir)
    await makeFoxsDatFileList(multiFoxsDir)
    await spawnMultiFoxs(multifoxsParams)
    status = {
      status: 'Success',
      message: 'MultiFoXS Calculations have completed.'
    }
    await updateStepStatus(DBjob, 'multifoxs', status)
  } catch (error) {
    await handleError(error, MQjob, DBjob, 'multifoxs')
  }
}

const copyFiles = async ({
  source,
  destination,
  filename,
  MQjob,
  isCritical
}: FileCopyParams): Promise<void> => {
  try {
    await execPromise(`cp ${source} ${destination}`)
    MQjob.log(`Gathered ${filename}`)
  } catch (error) {
    logger.error(`Error copying ${filename}: ${error}`)
    if (isCritical) {
      throw new Error(`Critical error copying ${filename}: ${error}`)
    }
  }
}

const prepareResults = async (
  MQjob: BullMQJob,
  DBjob: IBilboMDCRDJob | IBilboMDPDBJob | IBilboMDAutoJob
): Promise<void> => {
  try {
    const outputDir = path.join(DATA_VOL, DBjob.uuid)
    const multiFoxsDir = path.join(outputDir, 'multifoxs')
    const logFile = path.join(multiFoxsDir, 'multi_foxs.log')
    const resultsDir = path.join(outputDir, 'results')

    // Create new empty results directory
    try {
      await makeDir(resultsDir)
      MQjob.log('Create results directory')
    } catch (error) {
      logger.error(`Error creating results directory: ${error}`)
      // Decide whether to continue or throw based on your application's requirements
    }

    // Copy the minimized PDB
    await copyFiles({
      source: `${outputDir}/minimization_output.pdb`,
      destination: resultsDir,
      filename: 'minimization_output.pdb',
      MQjob,
      isCritical: false
    })

    // Copy the DAT file for the minimized PDB
    await copyFiles({
      source: `${outputDir}/minimization_output.pdb.dat`,
      destination: resultsDir,
      filename: 'minimization_output.pdb.dat',
      MQjob,
      isCritical: false
    })

    // Copy ensemble_size_*.txt files
    await copyFiles({
      source: `${multiFoxsDir}/ensembles_size*.txt`,
      destination: resultsDir,
      filename: 'ensembles_size*.txt',
      MQjob,
      isCritical: false
    })

    // Copy multi_state_model_*_1_1.dat files
    await copyFiles({
      source: `${multiFoxsDir}/multi_state_model_*_1_1.dat`,
      destination: resultsDir,
      filename: 'multi_state_model_*_1_1.dat',
      MQjob,
      isCritical: false
    })

    // Gather original uploaded files
    const filesToCopy = [
      { file: DBjob.data_file, label: 'data_file' } // Assuming pdb_file is common
    ]

    if ('pdb_file' in DBjob && DBjob.pdb_file) {
      filesToCopy.push({ file: DBjob.pdb_file, label: 'pdb_file' })
    }

    if ('crd_file' in DBjob && DBjob.crd_file) {
      filesToCopy.push({ file: DBjob.crd_file, label: 'crd_file' })
    }

    if ('psf_file' in DBjob && DBjob.psf_file) {
      filesToCopy.push({ file: DBjob.psf_file, label: 'psf_file' })
    }

    if ('pae_file' in DBjob && DBjob.pae_file) {
      filesToCopy.push({ file: DBjob.pae_file, label: 'pae_file' })
    }

    if ('const_inp_file' in DBjob && DBjob.const_inp_file) {
      filesToCopy.push({ file: DBjob.const_inp_file, label: 'const_inp_file' })
    }

    for (const { file, label } of filesToCopy) {
      if (file) {
        await copyFiles({
          source: path.join(outputDir, file),
          destination: resultsDir,
          filename: label,
          MQjob,
          isCritical: false
        })
      } else {
        logger.warn(`Expected file for '${label}' is undefined.`)
      }
    }

    // Only want to add N best PDBs equal to number_of_states N in logfile.
    const numEnsembles = await getNumEnsembles(logFile)
    logger.info(`prepareResults numEnsembles: ${numEnsembles}`)
    MQjob.log(`Gather ${numEnsembles} best ensembles`)

    if (numEnsembles) {
      // Iterate through each ensembles_siz_*.txt file
      for (let i = 1; i <= numEnsembles; i++) {
        const ensembleFile = path.join(multiFoxsDir, `ensembles_size_${i}.txt`)
        logger.info(`prepareResults ensembleFile: ${ensembleFile}`)
        const ensembleFileContent = await fs.readFile(ensembleFile, 'utf8')
        const pdbFilesRelative = extractPdbPaths(ensembleFileContent)

        const pdbFilesFullPath = pdbFilesRelative.map((item) =>
          path.join(outputDir, item)
        )
        // Extract the first N PDB files to string[]
        const numToCopy = Math.min(pdbFilesFullPath.length, i)
        const ensembleModelFiles = pdbFilesFullPath.slice(0, numToCopy)
        const ensembleSize = ensembleModelFiles.length
        await concatenateAndSaveAsEnsemble(ensembleModelFiles, ensembleSize, resultsDir)

        MQjob.log(
          `Gathered ${pdbFilesFullPath.length} PDB files from ensembles_size_${i}.txt`
        )
      }
    }

    // Create Job-specific README file.
    try {
      await createReadmeFile(DBjob, numEnsembles, resultsDir)
      MQjob.log(`wrote README.md file`)
    } catch (error) {
      logger.error(`Error creating README file: ${error}`)
    }

    // Create the results tar.gz file
    try {
      const uuidPrefix = DBjob.uuid.split('-')[0]
      const archiveName = `results-${uuidPrefix}.tar.gz`
      await execPromise(`tar czvf ${archiveName} results`, { cwd: outputDir })
      MQjob.log(`created ${archiveName} file`)
    } catch (error) {
      logger.error(`Error creating tar file: ${error}`)
      throw error // Critical error, rethrow or handle specifically if necessary
    }
  } catch (error) {
    await handleError(error, MQjob, DBjob, 'results')
  }
}

const createReadmeFile = async (
  DBjob: IBilboMDCRDJob | IBilboMDPDBJob | IBilboMDAutoJob,
  numEnsembles: number,
  resultsDir: string
): Promise<void> => {
  let originalFiles = ``
  switch (DBjob.__t) {
    case 'BilboMdCRD': {
      const crdJob = DBjob as IBilboMDCRDJob
      originalFiles = `
- Original CRD file: ${crdJob.crd_file}
- Original PSF file: ${crdJob.psf_file}
- Original experimental SAXS data file: ${crdJob.data_file}
- Original const.inp file: ${crdJob.const_inp_file}
- Generated minimized PDB file: minimized_output.pdb
- Generated minimized PDB DAT file: minimized_output.pdb.dat
`
      break
    }
    case 'BilboMdPDB': {
      const pdbJob = DBjob as IBilboMDPDBJob
      originalFiles = `
- Original PDB file: ${pdbJob.pdb_file}
- Generated CRD file: ${pdbJob.crd_file}
- Generated PSF file: ${pdbJob.psf_file}
- Original experimental SAXS data file: ${pdbJob.data_file}
- Original const.inp file: ${pdbJob.const_inp_file}
- Generated minimized PDB file: minimized_output.pdb
- Generated minimized PDB DAT file: minimized_output.pdb.dat
`
      break
    }
    case 'BilboMdAuto': {
      const autoJob = DBjob as IBilboMDAutoJob
      originalFiles = `
- Original PDB file: ${autoJob.pdb_file}
- Original PAE file: ${autoJob.pae_file}
- Generated CRD file: ${autoJob.crd_file}
- Generated PSF file: ${autoJob.psf_file}
- Original experimental SAXS data file: ${autoJob.data_file}
- Generated const.inp file: ${autoJob.const_inp_file}
- Generated minimized PDB file: minimized_output.pdb
- Generated minimized PDB DAT file: minimized_output.pdb.dat
`
      break
    }
  }
  const readmeContent = `
# BilboMD Job Results

This directory contains the results for your ${DBjob.title} BilboMD job.

- Job Title:  ${DBjob.title}
- Job ID:  ${DBjob._id}
- UUID:  ${DBjob.uuid}
- Submitted:  ${DBjob.time_submitted}
- Completed:  ${new Date().toString()}

## Contents
${originalFiles}
The Ensemble files will be present in multiple copies. There is one file for each ensemble size.

- Number of ensembles for this BilboMD run: ${numEnsembles}

- Ensemble PDB file(s):  ensemble_size_N_model.pdb
- Ensemble TXT file(s):  ensemble_size_N.txt
- Ensemble DAT file(s):  multi_state_model_N_1_1.dat

## The ensemble_size_N.txt files

Here is an example from a hypothetical ensemble_size_3.txt file:

1 |  2.89 | x1 2.89 (0.99, -0.50)
   70   | 0.418 (0.414, 0.011) | ../foxs/rg25_run3/dcd2pdb_rg25_run3_271500.pdb.dat (0.138)
   87   | 0.508 (0.422, 0.101) | ../foxs/rg41_run1/dcd2pdb_rg41_run1_35500.pdb.dat (0.273)
  184   | 0.074 (0.125, 0.024) | ../foxs/rg45_run1/dcd2pdb_rg45_run1_23000.pdb.dat (0.025)

In this example we show only the "best" 3-state ensemble. Each ensemble_size_N.txt file will
actually contain many possible N-state ensembles.

The first line is a summary of scores and fit parameters for a particular multi-state model:
    - The first column is a number/rank of the multi-state model (sorted by score)
    - The second column is a Chi^2 value for the fit to SAXS profile (2.89)
    - The third column repeats the Chi^2 value and also displays a pair of c1 (0.99) and c2 (-0.50)
      values (in brackets) from the MultiFoXS optimized fit to data.

After the model summary line the file contains information about the states (one line per state).
In this example the best scoring 3-state model consists of conformation numbers 70, 87, and 184
with weights of 0.418, 0.508, and 0.074 respectively. The numbers in brackets after the
conformation weight are an average and a standard	deviation of the weight calculated for this
conformation across all good scoring multi-state models of this size. The number in brackets
after the filename is the fraction of good scoring multi-state models that contain this conformation.

## The ensemble_size_N_model.pdb files

In the case of N>2 These will be multi-model PDB files. For N=1 it will just be the best single conformer
to fit your SAXS data.

ensemble_size_1_model.pdb  - will contain the coordinates for the best 1-state model
ensemble_size_2_model.pdb  - will contain the coordinates for the best 2-state model
ensemble_size_3_model.pdb  - will contain the coordinates for the best 3-state model
etc.

## The multi_state_model_N_1_1.dat files

These are the theoretical SAXS curves from MultiFoXS calculated for each of the ensemble_size_N_model.pdb models.

If you use BilboMD in your research, please cite:

Pelikan M, Hura GL, Hammel M. Structure and flexibility within proteins as identified through small angle X-ray scattering. Gen Physiol Biophys. 2009 Jun;28(2):174-89. doi: 10.4149/gpb_2009_02_174. PMID: ,19592714; PMCID: PMC3773563.

Thank you for using BilboMD
`
  const readmePath = path.join(resultsDir, 'README.md')
  try {
    await fs.writeFile(readmePath, readmeContent)
    logger.info('README file created successfully.')
  } catch (error) {
    logger.error('Failed to create README file:', error)
    throw new Error('Failed to create README file')
  }
}

export {
  runPdb2Crd,
  runPaeToConstInp,
  runAutoRg,
  runMinimize,
  runHeat,
  runMolecularDynamics,
  runFoxs,
  runMultiFoxs,
  prepareResults
}