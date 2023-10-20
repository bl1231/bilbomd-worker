import Handlebars from 'handlebars'
import { readFile } from 'node:fs/promises'
import { spawn, ChildProcess } from 'node:child_process'
import { promisify } from 'util'
import fs from 'fs-extra'
import readline from 'node:readline'
import path from 'path'
import { Job as BullMQJob } from 'bullmq'
import { User } from './model/User'
import { IBilboMDJob, IBilboMDAutoJob } from './model/Job'
import { sendJobCompleteEmail } from './mailer'
import { exec } from 'node:child_process'

const execPromise = promisify(exec)
const templates = path.resolve(__dirname, './templates/bilbomd')

const topoFiles: string = process.env.CHARM_TOPOLOGY ?? 'bilbomd_top_par_files.str'
const foxsBin: string = process.env.FOXS ?? '/usr/bin/foxs'
const multiFoxsBin: string = process.env.MULTIFOXS ?? '/usr/bin/multi_foxs'
const charmmBin: string = process.env.CHARMM ?? '/usr/local/bin/charmm'
const dataVol: string = process.env.DATA_VOL ?? '/bilbomd/uploads'
const bilbomdUrl: string = process.env.BILBOMD_URL ?? 'https://bilbomd.bl1231.als.lbl.gov'

type Params = {
  out_dir: string
}

type PaeParams = Params & {
  in_crd: string
  in_pae: string
}

type FoxsParams = Params & {
  data_file: string
}

type CharmmParams = Params & {
  template: string
  topology_dir: string
  charmm_inp_file: string
  charmm_out_file: string
  in_psf?: string
  in_crd?: string
  in_pae?: string
  out_min_crd?: string
  out_min_pdb?: string
  in_pdb?: string
  in_dcd?: string
  foxs_rg?: string
  constinp?: string
  rg_min: number
  rg_max: number
  conf_sample: number
  timestep?: number
  run?: string
  inp_basename?: string
  out_heat_rst?: string
  out_heat_crd?: string
  out_heat_pdb?: string
  rg?: number
}

const initializeJob = async (MQJob: BullMQJob, DBjob: IBilboMDJob): Promise<void> => {
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
    console.error('Error in initializeJob:', error)
    throw error
  }
}

const cleanupJob = async (MQjob: BullMQJob, DBJob: IBilboMDJob): Promise<void> => {
  try {
    // Update MongoDB job status and completion time
    DBJob.status = 'Completed'
    DBJob.time_completed = new Date()
    await DBJob.save()

    // Retrieve the user email from the associated User model
    const user = await User.findById(DBJob.user).lean().exec()
    if (!user) {
      console.error(`No user found for: ${DBJob.uuid}`)
      return
    }

    // Send job completion email and log the notification
    sendJobCompleteEmail(user.email, bilbomdUrl, DBJob.id, DBJob.title)
    console.log(`Email notification sent to ${user.email}`)
    await MQjob.log(`Email notification sent to ${user.email}`)
  } catch (error) {
    console.error('Error in cleanupJob:', error)
    throw error
  }
}

const updateJobStatus = async (job: IBilboMDJob, status: string): Promise<void> => {
  job.status = status
  await job.save()
}

const writeToFile = async (template: string, params: CharmmParams): Promise<void> => {
  try {
    const outFile = path.join(params.out_dir, params.charmm_inp_file)
    const templ = Handlebars.compile(template)
    const content = templ(params)

    console.log('Write File:', outFile)
    await fs.promises.writeFile(outFile, content)
  } catch (error) {
    console.error('Error in writeToFile:', error)
    throw error
  }
}

const readTemplate = async (templateName: string): Promise<string> => {
  const templateFile = path.join(templates, `${templateName}.handlebars`)
  return readFile(templateFile, 'utf8')
}

const generateInputFile = async (params: CharmmParams): Promise<void> => {
  const templateString = await readTemplate(params.template)
  await writeToFile(templateString, params)
}

const generateDCD2PDBInpFile = async (params: CharmmParams, rg: number, run: number) => {
  params.template = 'dcd2pdb'
  params.in_pdb = 'heat_output.pdb'
  params.in_dcd = `dynamics_rg${rg}_run${run}.dcd`
  params.foxs_rg = 'foxs_rg.out'
  await generateInputFile(params)
}

const makeFile = async (file: string) => {
  await fs.ensureFile(file)
}

const makeDir = async (directory: string) => {
  await fs.ensureDir(directory)
  console.log('Create Dir: ', directory)
}

const makeFoxsDatFileList = async (multiFoxsDir: string) => {
  // ls -1 ../foxs/*/*.pdb.dat > foxs_dat_files.txt
  // need to use 'exec' in order to instantiate a shell so globbing will work.
  // const foxsDir = path.resolve(multiFoxsDir, '../foxs')
  // const lookHere = foxsDir + '/*/*.pdb.dat'
  const stdOut = path.join(multiFoxsDir, 'foxs_dat_files.txt')
  const stdErr = path.join(multiFoxsDir, 'foxs_dat_files_errors.txt')
  const stdoutStream = fs.createWriteStream(stdOut)
  const errorStream = fs.createWriteStream(stdErr)

  const { stdout, stderr } = await execPromise('ls -1 ../foxs/*/*.pdb.dat', {
    cwd: multiFoxsDir
  })
  stdoutStream.write(stdout)
  errorStream.write(stderr)
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

    console.log(`Ensemble file saved: ${ensembleFile}`)
  } catch (error) {
    console.error('Error:', error)
  }
}

const spawnFoXS = async (foxsRunDir: string) => {
  try {
    const files = await fs.readdir(foxsRunDir)
    console.log('Spawn FoXS jobs:', foxsRunDir)
    const foxsOpts = { cwd: foxsRunDir }

    const spawnPromises = files.map(
      (file) =>
        new Promise<void>((resolve, reject) => {
          const foxsArgs = ['-p', file]
          const foxs: ChildProcess = spawn(foxsBin, foxsArgs, foxsOpts)
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
    console.error(error)
  }
}

const spawnMultiFoxs = (multiFoxsDir: string, params: FoxsParams): Promise<string> => {
  const logFile = path.join(multiFoxsDir, 'multi_foxs.log')
  const errorFile = path.join(multiFoxsDir, 'multi_foxs_error.log')
  const logStream = fs.createWriteStream(logFile)
  const errorStream = fs.createWriteStream(errorFile)
  const saxsData = path.join(params.out_dir, params.data_file)
  const multiFoxArgs = [saxsData, 'foxs_dat_files.txt']
  const multiFoxOpts = { cwd: multiFoxsDir }

  return new Promise((resolve, reject) => {
    const multiFoxs: ChildProcess = spawn(multiFoxsBin, multiFoxArgs, multiFoxOpts)
    multiFoxs.stdout?.on('data', (data) => {
      console.log('spawnMultiFoxs stdout', data.toString())
      logStream.write(data.toString())
    })
    multiFoxs.stderr?.on('data', (data) => {
      console.log('spawnMultiFoxs stderr', data.toString())
      errorStream.write(data.toString())
    })
    multiFoxs.on('error', (error) => {
      console.log('spawnMultiFoxs error:', error)
      reject(error)
    })
    multiFoxs.on('exit', (code: number) => {
      if (code === 0) {
        console.log('spawnMultiFoxs close success exit code:', code)
        resolve(code.toString())
      } else {
        console.log('spawnMultiFoxs close error exit code:', code)
        reject(`spawnMultiFoxs on close reject`)
      }
    })
  })
}

const spawnCharmm = (params: CharmmParams): Promise<string> => {
  const { charmm_inp_file: inputFile, charmm_out_file: outputFile, out_dir } = params
  const charmmArgs = ['-o', outputFile, '-i', inputFile]
  const charmmOpts = { cwd: out_dir }

  return new Promise<string>((resolve, reject) => {
    const charmm: ChildProcess = spawn(charmmBin, charmmArgs, charmmOpts)
    let charmmOutput = '' // Create an empty string to capture stdout

    charmm.stdout?.on('data', (data) => {
      charmmOutput += data.toString()
    })

    charmm.on('error', (error) => {
      reject(new Error(`CHARMM process encountered an error: ${error.message}`))
    })

    charmm.on('close', (code: number, signal: string) => {
      if (code === 0) {
        console.log('CHARMM success:', inputFile, 'exit code:', code, 'signal:', signal)
        resolve('CHARMM execution succeeded')
      } else {
        console.log('CHARMM error:', inputFile, 'exit code:', code, 'signal:', signal)
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
      console.log('runPaeToConst stdout: ', data.toString())
      logStream.write(data.toString())
    })
    runPaeToConst.stderr?.on('data', (data) => {
      console.error('runPaeToConst stderr: ', data.toString())
      errorStream.write(data.toString())
    })
    runPaeToConst.on('error', (error) => {
      console.log('runPaeToConst error:', error)
      reject(error)
    })
    runPaeToConst.on('exit', (code: number) => {
      if (code === 0) {
        console.log('runPaeToConst close success:', 'exit code:', code)
        resolve(code.toString())
      } else {
        console.log('runPaeToConst close error:', 'exit code:', code)
        reject(new Error('runPaeToConst failed. Please see the error log file'))
      }
    })
  })
}

const runPaeToConst = async (DBjob: IBilboMDAutoJob): Promise<void> => {
  const outputDir = path.join(dataVol, DBjob.uuid)
  const params = {
    in_crd: DBjob.crd_file,
    in_pae: DBjob.pae_file,
    out_dir: outputDir
  }
  await spawnPaeToConst(params)
  DBjob.const_inp_file = 'const.inp'
  await DBjob.save()
}

const runAutoRg = async (DBjob: IBilboMDAutoJob): Promise<void> => {
  const outputDir = path.join(dataVol, DBjob.uuid)
  const logFile = path.join(outputDir, 'autoRg.log')
  const errorFile = path.join(outputDir, 'autoRg_error.log')
  const logStream = fs.createWriteStream(logFile)
  const errorStream = fs.createWriteStream(errorFile)
  const autoRg_script = '/app/scripts/autorg.py'
  const args = [autoRg_script, DBjob.data_file]

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
      errorStream.end()
      reject(error)
    })

    autoRg.on('exit', (code) => {
      logStream.end()
      errorStream.end()
      if (code === 0) {
        try {
          // Parse the stdout data as JSON
          const analysisResults = JSON.parse(autoRg_json)
          // Update rg_min and rg_max in DBjob
          DBjob.rg_min = analysisResults.rg_min
          DBjob.rg_max = analysisResults.rg_max
          DBjob.save().then(() => {
            resolve()
          })
        } catch (parseError) {
          reject(parseError)
        }
      } else {
        reject(`spawnAutoRgCalculator on close reject`)
      }
    })
  })
}

const runMinimize = async (MQjob: BullMQJob, DBjob: IBilboMDJob): Promise<void> => {
  const outputDir = path.join(dataVol, MQjob.data.uuid)
  const params = {
    template: 'minimize',
    topology_dir: topoFiles,
    out_dir: outputDir,
    charmm_inp_file: 'minimize.inp',
    charmm_out_file: 'minimize.out',
    in_psf: DBjob.psf_file,
    in_crd: DBjob.crd_file,
    out_min_crd: 'minimization_output.crd',
    out_min_pdb: 'minimization_output.pdb',
    rg_min: DBjob.rg_min,
    rg_max: DBjob.rg_max,
    conf_sample: DBjob.conformational_sampling
  }
  try {
    await generateInputFile(params)
    await spawnCharmm(params)
  } catch (error) {
    const errorMessage = error as string
    updateJobStatus(DBjob, 'Error')
    MQjob.log('error minimization')
    console.log(errorMessage)
    MQjob.log(errorMessage)
    throw new Error('CHARMM minimize step failed')
  }
}

const runHeat = async (MQjob: BullMQJob, DBjob: IBilboMDJob): Promise<void> => {
  const outputDir = path.join(dataVol, MQjob.data.uuid)
  const params = {
    template: 'heat',
    topology_dir: topoFiles,
    out_dir: outputDir,
    charmm_inp_file: 'heat.inp',
    charmm_out_file: 'heat.out',
    in_psf: DBjob.psf_file,
    in_crd: 'minimization_output.crd',
    rg_min: DBjob.rg_min,
    rg_max: DBjob.rg_max,
    conf_sample: DBjob.conformational_sampling,
    constinp: DBjob.const_inp_file,
    out_heat_rst: 'heat_output.rst',
    out_heat_crd: 'heat_output.crd',
    out_heat_pdb: 'heat_output.pdb'
  }
  try {
    await generateInputFile(params)
    await spawnCharmm(params)
  } catch (error) {
    updateJobStatus(DBjob, 'Error')
    MQjob.log('error heating')
    throw new Error('CHARMM heat step failed')
  }
}

const runMolecularDynamics = async (
  MQjob: BullMQJob,
  DBjob: IBilboMDJob
): Promise<void> => {
  const outputDir = path.join(dataVol, MQjob.data.uuid)
  const params = {
    template: 'dynamics',
    topology_dir: topoFiles,
    out_dir: outputDir,
    charmm_inp_file: 'heat.inp',
    charmm_out_file: 'heat.out',
    in_psf: DBjob.psf_file,
    in_crd: 'heat_output.crd',
    in_rst: 'heat_output.rst',
    constinp: DBjob.const_inp_file,
    rg_min: DBjob.rg_min,
    rg_max: DBjob.rg_max,
    conf_sample: DBjob.conformational_sampling,
    timestep: 0.001,
    inp_basename: '',
    rg: 0
  }
  // console.log('in runMD params: ', params)
  try {
    const molecularDynamicsTasks = []
    const step = Math.round((params.rg_max - params.rg_min) / 5)
    for (let rg = params.rg_min; rg <= params.rg_max; rg += step) {
      params.charmm_inp_file = `${params.template}_rg${rg}.inp`
      params.charmm_out_file = `${params.template}_rg${rg}.out`
      params.inp_basename = `${params.template}_rg${rg}`
      params.rg = rg
      await generateInputFile(params)
      molecularDynamicsTasks.push(spawnCharmm(params))
    }
    await Promise.all(molecularDynamicsTasks)
  } catch (error) {
    updateJobStatus(DBjob, 'Error')
    MQjob.log(`error molecular dynamics`)
    throw new Error('CHARMM MD step failed')
    // throw error
  }
}

const runFoxs = async (MQjob: BullMQJob, DBjob: IBilboMDJob): Promise<void> => {
  const outputDir = path.join(dataVol, MQjob.data.uuid)
  const params = {
    template: 'foxs',
    topology_dir: topoFiles,
    out_dir: outputDir,
    charmm_inp_file: 'heat.inp',
    charmm_out_file: 'heat.out',
    in_psf: DBjob.psf_file,
    in_crd: 'heat_output.crd',
    in_rst: 'heat_output.rst',
    constinp: DBjob.const_inp_file,
    rg_min: DBjob.rg_min,
    rg_max: DBjob.rg_max,
    conf_sample: DBjob.conformational_sampling,
    timestep: 0.001,
    inp_basename: '',
    foxs_rg: '',
    run: ''
  }

  try {
    const foxsDir = path.join(params.out_dir, 'foxs')
    await makeDir(foxsDir)
    params.foxs_rg = 'foxs_rg.out'
    const foxsRgFile = path.join(params.out_dir, params.foxs_rg)
    await makeFile(foxsRgFile)

    const step = Math.round((params.rg_max - params.rg_min) / 5)
    for (let rg = params.rg_min; rg <= params.rg_max; rg += step) {
      for (let run = 1; run <= params.conf_sample; run += 1) {
        const runAllCharmm = []
        const runAllFoxs = []
        const foxsRunDir = path.join(foxsDir, `rg${rg}_run${run}`)
        await makeDir(foxsRunDir)
        params.template = 'dcd2pdb'
        params.charmm_inp_file = `${params.template}_rg${rg}_run${run}.inp`
        params.charmm_out_file = `${params.template}_rg${rg}_run${run}.out`
        params.inp_basename = `${params.template}_rg${rg}_run${run}`
        params.run = `rg${rg}_run${run}`

        await generateDCD2PDBInpFile(params, rg, run)
        runAllCharmm.push(spawnCharmm(params))
        await Promise.all(runAllCharmm)

        // then run FoXS on every PDB in foxsRunDir
        runAllFoxs.push(spawnFoXS(foxsRunDir))
        // const files = await fs.readdir(foxsRunDir)
        // await spawnFoXS(foxsRunDir, files)
        await Promise.all(runAllFoxs)
      }
    }
  } catch (error) {
    updateJobStatus(DBjob, 'Error')
    MQjob.log('error FoXS')
    throw new Error('runFoxs step failed')
  }
}

const runMultiFoxs = async (MQjob: BullMQJob, DBjob: IBilboMDJob): Promise<void> => {
  const jobDir = path.join(dataVol, MQjob.data.uuid)
  const params = {
    template: 'foxs',
    topology_dir: topoFiles,
    out_dir: jobDir,
    charmm_inp_file: 'heat.inp',
    charmm_out_file: 'heat.out',
    in_psf: DBjob.psf_file,
    in_crd: 'heat_output.crd',
    in_rst: 'heat_output.rst',
    constinp: DBjob.const_inp_file,
    rg_min: DBjob.rg_min,
    rg_max: DBjob.rg_max,
    conf_sample: DBjob.conformational_sampling,
    timestep: 0.001,
    inp_basename: '',
    foxs_rg: '',
    run: '',
    data_file: DBjob.data_file
  }
  try {
    const multiFoxsDir = path.join(jobDir, 'multifoxs')
    await makeDir(multiFoxsDir)
    await makeFoxsDatFileList(multiFoxsDir)
    await spawnMultiFoxs(multiFoxsDir, params)
  } catch (error) {
    updateJobStatus(DBjob, 'Error')
    MQjob.log('error MultiFoXS')
    throw new Error('runMultiFoxs step failed')
  }
}

const gatherResults = async (MQjob: BullMQJob, DBjob: IBilboMDJob): Promise<void> => {
  try {
    const jobDir = path.join(dataVol, MQjob.data.uuid)
    const multiFoxsDir = path.join(jobDir, 'multifoxs')
    const logFile = path.join(multiFoxsDir, 'multi_foxs.log')
    const resultsDir = path.join(jobDir, 'results')
    const inpFile = DBjob.const_inp_file

    // Create new empty results directory
    await makeDir(resultsDir)
    MQjob.log('Create results directory')

    // Copy ensemble_size_*.txt files
    await execPromise(`cp ${multiFoxsDir}/ensembles_size*.txt .`, { cwd: resultsDir })
    MQjob.log('Gather ensembles_size*.txt files')

    // Copy multi_state_model_*_1_1.dat files
    await execPromise(`cp ${multiFoxsDir}/multi_state_model_*_1_1.dat .`, {
      cwd: resultsDir
    })
    MQjob.log('Gather multi_state_model_*_1_1.dat files')

    // Copy the CHARMM const.inp file
    await execPromise(`cp ${jobDir}/${inpFile} .`, { cwd: resultsDir })
    MQjob.log('Gather const.inp file')

    // Copy the original uploaded crd, psf, and dat files
    const filesToCopy = [DBjob.crd_file, DBjob.psf_file, DBjob.data_file]
    for (const file of filesToCopy) {
      await execPromise(`cp ${path.join(jobDir, file)} .`, { cwd: resultsDir })
      MQjob.log(`Gathered ${file}`)
    }
    // Only want to add N best PDBs equal to number_of_states N in logfile.
    const numEnsembles = await getNumEnsembles(logFile)
    console.log('numEnsembles', numEnsembles)
    MQjob.log(`Gather ${numEnsembles} best ensembles`)

    if (numEnsembles) {
      // Iterate through each ensembles_siz_*.txt file
      for (let i = 1; i <= numEnsembles; i++) {
        const ensembleFile = path.join(multiFoxsDir, `ensembles_size_${i}.txt`)
        const ensembleFileContent = await fs.readFile(ensembleFile, 'utf8')
        const pdbFilesRelative = extractPdbPaths(ensembleFileContent)
        const pdbFilesFullPath = pdbFilesRelative.map((item) => path.join(jobDir, item))
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
    await execPromise(`tar czvf results.tar.gz results`, { cwd: jobDir })
    MQjob.log('created results.tar.gz file')
  } catch (error) {
    updateJobStatus(DBjob, 'Error')
    MQjob.log('failed in gatherResults')
    throw new Error('gatherResults step failed')
  }
}

export {
  initializeJob,
  runPaeToConst,
  runAutoRg,
  runMinimize,
  runHeat,
  runMolecularDynamics,
  runFoxs,
  runMultiFoxs,
  gatherResults,
  cleanupJob
}
