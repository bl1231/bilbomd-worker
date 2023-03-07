import Handlebars from 'handlebars'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import util from 'node:util';
import fs from 'fs-extra'
import readline from 'node:readline';
import path from 'path'
import { Job as BullMQJob } from 'bullmq'
import { Job as BilboMDJob, IBilboMDJob } from './model/Job'

const exec = util.promisify(require('node:child_process').exec);
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
  var template = Handlebars.compile(templateString)
  var outputString = template(params)
  await fs.writeFile(outFile, outputString)
}

const generateInputFile = async (params: params) => {
  try {
    const templateFile = path.join(templates, `${params.template}.handlebars`)
    const templateString = await readFile(templateFile, 'utf8')
    await writeToFile(templateString, params)
    console.log('wrote CHARMM input file: ', params.charmm_inp_file)
  } catch (err) {
    console.log('Something went badly! Unable to generate inp file')
    console.error(err)
  }
}

const generateDCD2PDBInpFile = async (params: params, rg: any, run: number) => {
  params.template = 'dcd2pdb'
  params.in_pdb = 'heat_output.pdb'
  params.in_dcd = `dynamics_rg${rg}_run${run}.dcd`
  params.foxs_rg = 'foxs_rg.out'
  // params.charmm_inp_file = `${params.template}_rg${rg}_run${run}.inp`
  try {
    await generateInputFile(params)
  } catch (error) {
    console.error(error)
  }
}

const makeFile = async (file: string) => {
  try {
    await fs.ensureFile(file)
    console.log('created: ', file)
  } catch (err) {
    console.error(err)
  }
}

const makeDir = async (directory: string) => {
  try {
    await fs.ensureDir(directory)
    console.log('created: ', directory)
    return directory
  } catch (err) {
    console.error(err)
  }
}

const makeFoxsDatFileList = async (multiFoxsDir: string) => {
  //ls -1 ../foxs/*/*.pdb.dat > foxs_dat_files.txt
  // need to use exec in order to use a shell and get globbing to work.
  const foxsDir = path.resolve(multiFoxsDir, '../foxs')
  const lookHere = foxsDir + '/*/*.pdb.dat'
  console.log('lookHere:', lookHere);
  const stdOut = path.join(multiFoxsDir, 'foxs_dat_files.txt')
  const stdErr = path.join(multiFoxsDir, 'errors.txt')
  const stdoutStream = fs.createWriteStream(stdOut)
  const errorStream = fs.createWriteStream(stdErr)

  const { stdout, stderr } = await exec('ls -1 ../foxs/*/*.pdb.dat', { cwd: multiFoxsDir },)
  //console.log('stdout:', stdout)
  //console.error('stderr:', stderr)
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
    } catch (error) { }
  })
}

const spawnMultiFoxs = (multiFoxsDir: string, params: params) => {
  const saxs_data = path.join(params.out_dir, params.data_file!)
  let p = spawn(multiFoxsBin, [saxs_data, 'foxs_dat_files.txt'], {
    cwd: multiFoxsDir
  })
  return new Promise((resolveFunc) => {
    p.stdout.on("data", (x) => {
      process.stdout.write(x.toString());
    });
    p.stderr.on("data", (x) => {
      process.stderr.write(x.toString());
    });
    p.on("exit", (code) => {
      resolveFunc(code);
    });
  });
}

const spawnCharmm = (params: params) =>
  new Promise((resolve, reject) => {
    const input = params.charmm_inp_file
    const output = params.charmm_out_file
    console.log('Spawn CHARMM job:', input)
    const charmm = spawn(charmmBin, ['-o', output, '-i', input], {
      cwd: params.out_dir
    })
    charmm.stdout.on('data', (data: { toString: () => any }) => {
      console.log('charmm stdout', data.toString())
    })
    charmm.stderr.on('data', (data: { toString: () => any }) => {
      console.error('charmm stderr', data.toString())
      reject()
    })
    charmm.on('close', (code: unknown) => {
      //console.log('finished:', input, 'exit code:', code)
      resolve(code)
    })
  })

const runMinimize = async (MQjob: BullMQJob, DBjob: IBilboMDJob) => {
  console.log(MQjob.data);
  console.log(DBjob);
  //const foundJob = await BilboMDJob.findOne({ _id: job.data.jobid }).exec()
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
    conf_sample: DBjob.conformational_sampling,
  }
  try {
    await generateInputFile(params)
    await spawnCharmm(params)
    console.log('minimized complete')
  } catch (error) {
    console.error('runMinimize error:', error)
  }
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
  try {
    await generateInputFile(params)
    await spawnCharmm(params)
    console.log('heat complete')
  } catch (error) {
    console.error('runHeat error:', error)
  }
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
  const step = (params.rg_max - params.rg_min) / 5
  for (let rg = params.rg_min; rg <= params.rg_max; rg += step) {
    params.charmm_inp_file = `${params.template}_rg${rg}.inp`
    params.charmm_out_file = `${params.template}_rg${rg}.out`
    params.inp_basename = `${params.template}_rg${rg}`
    // makeAllInpFiles.push(generateInputFile(params))
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

  const step = (params.rg_max - params.rg_min) / 5
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

      // This doesn't work for some reason!
      // using the last "version" of params...WTF?
      //makeAllDcd2PdbInpFiles.push(generateDCD2PDBInpFile(params, rg, run))
      // This does work, and all iterations of the inp file get created
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
    run: '',
    data_file: DBjob.data_file
  }
  const dir = await makeDir(path.join(params.out_dir, 'multifoxs'))
  // create foxs_dat_files.txt
  await makeFoxsDatFileList(dir!)
  // run multi_foxs
  await spawnMultiFoxs(dir!, params)
  return ('runMultiFoxs done.')
}

const gatherResults = async (MQjob: BullMQJob, DBjob: IBilboMDJob) => {
  const jobDir = path.join(dataVol, MQjob.data.uuid)
  const multiFoxsDir = path.join(dataVol, MQjob.data.uuid, 'multifoxs')
  //create results dir
  const resultsDir = await makeDir(path.join(jobDir, 'results'))
  MQjob.log('Created results directory')
  //copy files into results dir

  // need to use exec in order to use a shell and get globbing to work.
  // const stdOut = path.join(multiFoxsDir, 'foxs_dat_files.txt')
  // const stdErr = path.join(multiFoxsDir, 'errors.txt')
  // const stdoutStream = fs.createWriteStream(stdOut)
  // const errorStream = fs.createWriteStream(stdErr)

  await exec(`cp ${multiFoxsDir}/ensembles_size*.txt .`, { cwd: resultsDir },)
  MQjob.log('gather ensembles_size*.txt files')
  await exec(`cp ${multiFoxsDir}/multi_state_model_*_1_1.dat .`, { cwd: resultsDir },)
  MQjob.log('gather multi_state_model_*_1_1.dat files')
  await exec(`cp ${jobDir}/const.inp .`, { cwd: resultsDir },)
  MQjob.log('gather const.inp file')
  const clusFile = path.join(multiFoxsDir, 'cluster_representatives.txt')
  const rl = readline.createInterface({
    input: fs.createReadStream(clusFile),
    crlfDelay: Infinity,
  });

  rl.on('line', (line) => {
    let pdbFile = path.basename(line, '.dat')
    let pdbDir = path.dirname(line)
    let fullPdbPath = path.join(pdbDir, pdbFile)
    console.log(`PDB file: ${pdbFile}`)
    MQjob.log(`PDB file: ${pdbFile}`)
    exec(`cp ${fullPdbPath} .`, { cwd: resultsDir },)
  });



  //create a tar.gz file
  await exec(`tar czvf results.tar.gz ${resultsDir}`, { cwd: jobDir },)
  MQjob.log('created results.tar.gz file')
  // update MongoDB?
  return ('results.tar.gz ready for download')
}

// const countDownTimer = async (message: any, seconds: number | undefined) => {
//   console.log('Start', message, 'countDownTimer for', seconds, 'sec')
//   const go = {
//     timer: null,
//     message: '',
//     time: 0,
//     countdown: (duration = 10) => {
//       clearInterval(go.timer)
//       return new Promise(function (resolve, reject) {
//         go.timer = setInterval(function () {
//           go.time--
//           console.log(go.message + ': ' + go.time)
//           if (!go.time) {
//             clearInterval(go.timer)
//             resolve()
//           }
//         }, 1000)
//       })
//     },
//     do: async (msg: string, time = 10) => {
//       go.time = time
//       go.message = msg
//       await go.countdown(go.time)
//     }
//   }
//   await go.do(message, seconds)
//   console.log(`Finished ${message}`)
// }

export {
  runMinimize,
  runHeat,
  runMolecularDynamics,
  runFoxs,
  runMultiFoxs,
  gatherResults
}
