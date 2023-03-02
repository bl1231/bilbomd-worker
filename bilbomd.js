const Handlebars = require('handlebars')
const { readFile, writeFile } = require('node:fs/promises')
const { spawn } = require('node:child_process')
//const { access, watch } = require('node:fs/promises')
//const { mkdir, openSync, closeSync } = require('node:fs')
const fs = require('fs-extra')
//const path = require('node:path')
// const ac = new AbortController()
// const { signal } = ac
const chokidar = require('chokidar')
const util = require('node:util')
const execFile = util.promisify(require('node:child_process').execFile)
const myPath = require('path')
const templates = myPath.resolve(__dirname, '../templates/bilbomd')
const topoFiles = process.env.CHARM_TOPOLOGY

const writeToFile = async (templateString, params) => {
  const outFile = myPath.join(params.out_dir, params.charmm_inp_file)
  var template = Handlebars.compile(templateString)
  var outputString = template(params)
  await fs.writeFile(outFile, outputString)
}

const extractPdbFromDcd = async (params) => {
  try {
    await spawnCHARMM(params)
    console.log('extractPdbFromDcd got params:', params)
  } catch (err) {
    console.log('extractPdbFromDcd failed!')
    console.log(err)
  }
}

const generateInputFile = async (params) => {
  try {
    const templateFile = myPath.join(templates, `${params.template}.handlebars`)
    const templateString = await readFile(templateFile, 'utf8')
    await writeToFile(templateString, params)
    console.log('wrote CHARMM input file: ', params.charmm_inp_file)
  } catch (err) {
    console.log('Something went badly! Unable to generate inp file')
    console.error(err)
  }
}

const generateDCD2PDBInpFile = async (params, rg, run) => {
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

const fileExists = async (path) => {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

const runMolecularDynamics = async (params) => {
  console.log('runMolecularDynamics ------------- START')
  const makeAllInpFiles = []
  const runAllCharmm = []
  const step = (params.rg_max - params.rg_min) / 5
  for (let rg = params.rg_min; rg <= params.rg_max; rg += step) {
    params.charmm_inp_file = `${params.template}_rg${rg}.inp`
    params.charmm_out_file = `${params.template}_rg${rg}.out`
    params.inp_basename = `${params.template}_rg${rg}`
    // makeAllInpFiles.push(generateInputFile(params))
    await generateInputFile(params)
    runAllCharmm.push(spawnCHARMM(params))
  }
  // try {
  //   await Promise.all(makeAllInpFiles).then(() => {
  //     console.log('All CHARMM MD *inp files created.')
  //   })
  // } catch (error) {
  //   console.error('makeAllInpFiles:', error)
  // }

  await Promise.all(runAllCharmm).then(() => {
    console.log('All CHARMM MD runs complete.')
  })

  console.log('runMolecularDynamics ------------- END')
}

const makeFile = async (f) => {
  try {
    await fs.ensureFile(f)
    console.log('created: ', f)
  } catch (err) {
    console.error(err)
  }
}

const runFoXS = async (params) => {
  console.log(pepper, 'runFoXS ------------- START')
  const foxsDir = myPath.join(params.out_dir, 'foxs')
  console.log('foxsDir', foxsDir)
  fs.mkdir(foxsDir, (error) => {
    if (error) {
      return console.error(error)
    }
    console.log(`${foxsDir} directory created`)
  })
  params.foxs_rg = 'foxs_rg.out'
  const foxsRgFile = myPath.join(params.out_dir, params.foxs_rg)
  makeFile(foxsRgFile)

  const makeAllDcd2PdbInpFiles = []

  const step = (params.rg_max - params.rg_min) / 5
  for (let rg = params.rg_min; rg <= params.rg_max; rg += step) {
    for (let run = 1; run <= params.conf_sample; run += 1) {
      const runAllCharmm = []
      const runAllFoXS = []
      const foxsRunDir = myPath.join(foxsDir, `rg${rg}_run${run}`)
      console.log('foxsRunDir', foxsRunDir)
      fs.mkdir(foxsRunDir, (error) => {
        if (error) {
          return console.error(error)
        }
        console.log(`${foxsRunDir} directory created`)
      })
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
      runAllCharmm.push(spawnCHARMM(params))
      await Promise.all(runAllCharmm)
      // then run FoXS on every PDB in foxsRunDir
      runAllFoXS.push(spawnFoXS(foxsRunDir))
      // const files = await fs.readdir(foxsRunDir)
      // await spawnFoXS(foxsRunDir, files)
      await Promise.all(runAllFoXS)
    }
  }
  console.log('runFoXS ------------- END')
}

const spawnFoXS = async (foxsRunDir) => {
  const files = await fs.readdir(foxsRunDir)
  new Promise((resolve, reject) => {
    console.log(rocket, 'Spawn FoXS jobs:', foxsRunDir)
    try {
      for (const file of files) {
        //console.log(file)
        spawn(process.env.FOXS, ['-pr', file], {
          cwd: foxsRunDir
        })
      }
    } catch (error) {}
  })
}

const spawnCHARMM = (params) =>
  new Promise((resolve, reject) => {
    const input = params.charmm_inp_file
    const output = params.charmm_out_file
    console.log(rocket, 'Spawn CHARMM job:', input)
    const charmm = spawn(process.env.CHARMM, ['-o', output, '-i', input], {
      cwd: params.out_dir
    })
    charmm.stdout.on('data', (data) => {
      console.log('charmm stdout', data.toString())
    })
    charmm.stderr.on('data', (data) => {
      console.error('charmm stderr', data.toString())
      reject()
    })
    charmm.on('close', (code) => {
      //console.log('finished:', input, 'exit code:', code)
      resolve(code)
    })
  })

const runMinimize = async (job) => {
  console.log(job.data)
  const jobDir = myPath.join(process.env.DATA_VOL, job.data.uuid)
  const params = {
    template: 'minimize',
    topology_dir: topoFiles,
    charmm_inp_file: 'minimize.inp',
    charmm_out_file: 'minimize.out',
    in_psf: foundJob.psf_file,
    in_crd: foundJob.crd_file,
    out_min_crd: 'minimization_output.crd',
    out_min_pdb: 'minimization_output.pdb'
  }

  try {
    await generateInputFile(params)
    await spawnCHARMM(params)
    console.log('minimized complete')
  } catch (error) {
    console.error('runMinimize error:', error)
  }
}

const runHeat = async (params) => {
  params.charmm_inp_file = `${params.template}.inp`
  params.charmm_out_file = `${params.template}.out`
  try {
    await generateInputFile(params)
    await spawnCHARMM(params)
    console.log('heat complete')
  } catch (error) {
    console.error('runHeat error:', error)
  }
}

const countDownTimer = async (message, seconds) => {
  console.log('Start', message, 'countDownTimer for', seconds, 'sec')
  const go = {
    timer: null,
    message: '',
    time: 0,
    countdown: (duration = 10) => {
      clearInterval(go.timer)
      return new Promise(function (resolve, reject) {
        go.timer = setInterval(function () {
          go.time--
          console.log(go.message + ': ' + go.time)
          if (!go.time) {
            clearInterval(go.timer)
            resolve()
          }
        }, 1000)
      })
    },
    do: async (msg, time = 10) => {
      go.time = time
      go.message = msg
      await go.countdown(go.time)
    }
  }
  await go.do(message, seconds)
  console.log(`Finished ${message}`)
}
module.exports = {
  runMinimize,
  runHeat,
  runMolecularDynamics,
  runFoXS,
  countDownTimer
}
