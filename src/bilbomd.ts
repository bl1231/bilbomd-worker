import Handlebars from 'handlebars'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import util from 'node:util'
import fs from 'fs-extra'
import readline from 'node:readline'
import path from 'path'
import { Job as BullMQJob } from 'bullmq'
import { Job as BilboMDJob, IBilboMDJob } from './model/Job'

const exec = util.promisify(require('node:child_process').exec)
const templates = path.resolve(__dirname, './templates/bilbomd')
const topoFiles: string = process.env.CHARM_TOPOLOGY!
const foxsBin: string = process.env.FOXS!
const multiFoxsBin: string = process.env.MULTIFOXS!
const charmmBin: string = process.env.CHARMM!
const dataVol: string = process?.env?.DATA_VOL!

type params = {
  template: string
  topology_dir: string
  out_dir: string
  charmm_inp_file: string
  charmm_out_file: string
  in_psf?: string
  in_crd?: string
  data_file?: string
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
}

const writeToFile = async (templateString: string, params: params) => {
  const outFile = path.join(params.out_dir, params.charmm_inp_file)
  let template = Handlebars.compile(templateString)
  let outputString = template(params)
  await fs.writeFile(outFile, outputString)
}

const generateInputFile = async (params: params) => {
  const templateFile = path.join(templates, `${params.template}.handlebars`)
  const templateString = await readFile(templateFile, 'utf8')
  await writeToFile(templateString, params)
}

const generateDCD2PDBInpFile = async (params: params, rg: any, run: number) => {
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
  console.log('Create dir:', directory)
}

const makeFoxsDatFileList = async (multiFoxsDir: string) => {
  // ls -1 ../foxs/*/*.pdb.dat > foxs_dat_files.txt
  // need to use 'exec' in order to instantiate a shell so globbing will work.
  const foxsDir = path.resolve(multiFoxsDir, '../foxs')
  const lookHere = foxsDir + '/*/*.pdb.dat'
  const stdOut = path.join(multiFoxsDir, 'foxs_dat_files.txt')
  const stdErr = path.join(multiFoxsDir, 'foxs_dat_files_errors.txt')
  const stdoutStream = fs.createWriteStream(stdOut)
  const errorStream = fs.createWriteStream(stdErr)

  const { stdout, stderr } = await exec('ls -1 ../foxs/*/*.pdb.dat', {
    cwd: multiFoxsDir
  })
  stdoutStream.write(stdout)
  errorStream.write(stderr)
}

const spawnFoXS = async (foxsRunDir: string) => {
  const files = await fs.readdir(foxsRunDir)
  new Promise((resolve, reject) => {
    console.log('Spawn FoXS jobs:', foxsRunDir)
    try {
      for (const file of files) {
        //console.log(file)
        spawn(foxsBin, ['-pr', file], {
          cwd: foxsRunDir
        })
      }
    } catch (error) {}
  })
}

const spawnMultiFoxs = (multiFoxsDir: string, params: params) => {
  const logFile = path.join(multiFoxsDir, 'multi_foxs.log')
  const errorFile = path.join(multiFoxsDir, 'multi_foxs_error.log')
  const logStream = fs.createWriteStream(logFile)
  const errorStream = fs.createWriteStream(errorFile)
  const saxsData = path.join(params.out_dir, params.data_file!)
  const multiFoxs = spawn(multiFoxsBin, [saxsData, 'foxs_dat_files.txt'], {
    cwd: multiFoxsDir
  })
  return new Promise((resolve, reject) => {
    multiFoxs.stdout.on('data', (x) => {
      console.log('spawnMultiFoxs stdout', x.toString())
      logStream.write(x.toString())
    })
    multiFoxs.stderr.on('data', (x) => {
      console.log('spawnMultiFoxs stderr', x.toString())
      errorStream.write(x.toString())
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
        reject(`spawnMultiFoxs on close reject ${code.toString()}`)
      }
    })
  })
}

const spawnCharmm = (params: params) => {
  const input = params.charmm_inp_file
  const output = params.charmm_out_file
  console.log('Spawn CHARMM job for:', input)
  const charmm = spawn(charmmBin, ['-o', output, '-i', input], {
    cwd: params.out_dir
  })
  return new Promise((resolve, reject) => {
    charmm.stdout.on('data', (x) => {
      console.log('spawnCharmm stdout: ', x.toString())
    })
    charmm.stderr.on('data', (x) => {
      console.error('spawnCharmm stderr: ', x.toString())
      reject(x.toString())
    })
    charmm.on('error', (error) => {
      console.log('spawnCharmm error:', error)
      reject(error)
    })
    charmm.on('close', (code: number) => {
      if (code === 0) {
        console.log('spawnCharmm close success:', input, 'exit code:', code)
        resolve(code.toString())
      } else {
        console.log('spawnCharmm close error:', input, 'exit code:', code)
        reject(`spawnCharmm on close reject ${code.toString()}`)
      }
    })
  })
}

const runMinimize = async (MQjob: BullMQJob, DBjob: IBilboMDJob) => {
  console.log(MQjob.data)
  console.log(DBjob)
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
  await generateInputFile(params).catch((err) => {
    console.log('Got generateInputFile error:', err.message, err.stack)
  })
  await spawnCharmm(params)
}

const runHeat = async (MQjob: BullMQJob, DBjob: IBilboMDJob) => {
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
  await generateInputFile(params)
  await spawnCharmm(params)
}

const runMolecularDynamics = async (MQjob: BullMQJob, DBjob: IBilboMDJob) => {
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
    inp_basename: ''
  }
  const runAllCharmm = []
  const step = Math.round((params.rg_max - params.rg_min) / 5)
  for (let rg = params.rg_min; rg <= params.rg_max; rg += step) {
    params.charmm_inp_file = `${params.template}_rg${rg}.inp`
    params.charmm_out_file = `${params.template}_rg${rg}.out`
    params.inp_basename = `${params.template}_rg${rg}`
    await generateInputFile(params)
    runAllCharmm.push(spawnCharmm(params))
  }
  await Promise.all(runAllCharmm).then(() => {
    console.log('All CHARMM MD runs complete.')
  })
}

const runFoxs = async (MQjob: BullMQJob, DBjob: IBilboMDJob) => {
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
}

const runMultiFoxs = async (MQjob: BullMQJob, DBjob: IBilboMDJob) => {
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
  const multiFoxsDir = path.join(jobDir, 'multifoxs')
  await makeDir(multiFoxsDir)
  await makeFoxsDatFileList(multiFoxsDir)
  await spawnMultiFoxs(multiFoxsDir, params)
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

const retrieveNumLinesFromFile = (file: string, num: number) => {
  let lines: string[] = []
  return new Promise<Array<string>>((resolve, reject) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(file),
      crlfDelay: Infinity
    })
    rl.on('line', (line) => {
      // console.log('retrieveNumLinesFromFile line:', line)
      lines.push(line)
    })
    rl.on('close', () => {
      // console.log('retrieveNumLinesFromFile close')
      const linesToProcess = lines.slice(0, num)
      resolve(linesToProcess)
    })
  })
}

const gatherResults = async (MQjob: BullMQJob, DBjob: IBilboMDJob) => {
  const jobDir = path.join(dataVol, MQjob.data.uuid)
  const multiFoxsDir = path.join(jobDir, 'multifoxs')
  const logFile = path.join(multiFoxsDir, 'multi_foxs.log')
  const resultsDir = path.join(jobDir, 'results')

  // Create new empty results directory
  await makeDir(resultsDir)
  MQjob.log('Create results directory')

  // Copy non-PDB files into results directory
  await exec(`cp ${multiFoxsDir}/ensembles_size*.txt .`, { cwd: resultsDir })
  MQjob.log('Gather ensembles_size*.txt files')
  await exec(`cp ${multiFoxsDir}/multi_state_model_*_1_1.dat .`, { cwd: resultsDir })
  MQjob.log('Gather multi_state_model_*_1_1.dat files')
  await exec(`cp ${jobDir}/const.inp .`, { cwd: resultsDir })
  MQjob.log('Gather const.inp file')

  // Only want to add N best PDBs equal to number_of_states N in logfile.
  const numEnsembles = await getNumEnsembles(logFile).catch((error) => {
    console.log(error)
  })
  console.log('numEnsembles', numEnsembles)
  MQjob.log(`Gather ${numEnsembles} best ensembles`)
  const clusFile = path.join(multiFoxsDir, 'cluster_representatives.txt')

  const linesToProcess = await retrieveNumLinesFromFile(clusFile, numEnsembles!)

  // Process N lines and await for exec cp to complete.
  for await (const line of linesToProcess) {
    console.log('in for await line:', line)
    let pdbFile = path.basename(line, '.dat')
    let pdbDir = path.dirname(line)
    let fullPdbPath = path.join(pdbDir, pdbFile)
    console.log(`PDB file: ${pdbFile}`)
    MQjob.log(`PDB file: ${pdbFile}`)
    exec(`cp ${fullPdbPath} .`, { cwd: resultsDir })
  }

  // Create a tar.gz file
  await exec(`tar czvf results.tar.gz results`, { cwd: jobDir })
  MQjob.log('created results.tar.gz file')

  // Update MongoDB?
  return 'results.tar.gz ready for download'
}

export {
  runMinimize,
  runHeat,
  runMolecularDynamics,
  runFoxs,
  runMultiFoxs,
  gatherResults
}
