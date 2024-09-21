import path from 'path'
import fs from 'fs-extra'
import { logger } from '../../helpers/loggers'
import { Job as BullMQJob } from 'bullmq'
import { IStepStatus } from '@bl1231/bilbomd-mongodb-schema'
import { IBilboMDSANSJob } from '@bl1231/bilbomd-mongodb-schema'
import { updateStepStatus } from './mongo-utils'
import { handleError, generateDCD2PDBInpFile } from './bilbomd-step-functions'
import { spawn, ChildProcess } from 'node:child_process'
import { CharmmParams, CharmmDCD2PDBParams } from '../../types/index'

// Define the types and interfaces if not already defined
interface NewAnalysisParams {
  out_dir: string
  rg_min: number
  rg_max: number
  analysis_rg: string
  conf_sample: number
}

// interface CharmmDCD2PDBParams {
//   out_dir: string
//   charmm_template: string
//   charmm_topo_dir: string
//   charmm_inp_file: string
//   charmm_out_file: string
//   in_psf_file: string
//   in_crd_file: string
//   inp_basename: string
//   analysis_rg: string
//   in_dcd: string
//   run: string
// }

const DATA_VOL = process.env.DATA_VOL ?? '/bilbomd/uploads'
const TOPO_FILES = process.env.CHARM_TOPOLOGY ?? 'bilbomd_top_par_files.str'
const CHARMM_BIN = process.env.CHARMM ?? '/usr/local/bin/charmm'

const makeFile = async (file: string) => {
  await fs.ensureFile(file)
}

const makeDir = async (directory: string) => {
  await fs.ensureDir(directory)
  logger.info(`Create Dir: ${directory}`)
}

const spawnCharmm = (params: CharmmParams): Promise<void> => {
  const { charmm_inp_file: inputFile, charmm_out_file: outputFile, out_dir } = params
  const charmmArgs = ['-o', outputFile, '-i', inputFile]
  const charmmOpts = { cwd: out_dir }

  return new Promise<void>((resolve, reject) => {
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
        resolve()
      } else {
        logger.info(`CHARMM error: ${inputFile} exit code: ${code}`)
        reject(new Error(charmmOutput))
      }
    })
  })
}

// Placeholder for your new analysis program's spawn function
const spawnPepsiSANS = async (analysisDir: string): Promise<void> => {
  logger.info(`Running Pepsi-SANS in ${analysisDir}`)
}

const runNewAnalysis = async (
  MQjob: BullMQJob,
  DBjob: IBilboMDSANSJob
): Promise<void> => {
  const outputDir = path.join(DATA_VOL, DBjob.uuid)

  const analysisParams: NewAnalysisParams = {
    out_dir: outputDir,
    rg_min: DBjob.rg_min,
    rg_max: DBjob.rg_max,
    analysis_rg: 'analysis_rg.out',
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
    analysis_rg: 'analysis_rg.out',
    in_dcd: '',
    run: ''
  }

  try {
    let status: IStepStatus = {
      status: 'Running',
      message: 'New Analysis has started.'
    }
    await updateStepStatus(DBjob, 'dcd2pdb', status)

    const analysisDir = path.join(analysisParams.out_dir, 'dcd2pdb')
    await makeDir(analysisDir)
    const analysisRgFile = path.join(analysisParams.out_dir, analysisParams.analysis_rg)
    await makeFile(analysisRgFile)

    const step = Math.max(
      Math.round((analysisParams.rg_max - analysisParams.rg_min) / 5),
      1
    )

    for (let rg = analysisParams.rg_min; rg <= analysisParams.rg_max; rg += step) {
      for (let run = 1; run <= analysisParams.conf_sample; run += 1) {
        const runAllCharmm: Promise<void>[] = []
        const runAllAnalysis: Promise<void>[] = []
        const analysisRunDir = path.join(analysisDir, `rg${rg}_run${run}`)

        await makeDir(analysisRunDir)

        DCD2PDBParams.charmm_inp_file = `${DCD2PDBParams.charmm_template}_rg${rg}_run${run}.inp`
        DCD2PDBParams.charmm_out_file = `${DCD2PDBParams.charmm_template}_rg${rg}_run${run}.out`
        DCD2PDBParams.inp_basename = `${DCD2PDBParams.charmm_template}_rg${rg}_run${run}`
        DCD2PDBParams.run = `rg${rg}_run${run}`

        await generateDCD2PDBInpFile(DCD2PDBParams, rg, run)
        runAllCharmm.push(spawnCharmm(DCD2PDBParams))
        await Promise.all(runAllCharmm)

        // Run the new analysis program instead of FoXS
        runAllAnalysis.push(spawnPepsiSANS(analysisRunDir))
        await Promise.all(runAllAnalysis)
      }
    }
    status = {
      status: 'Success',
      message: 'New Analysis has completed.'
    }
    await updateStepStatus(DBjob, 'dcd2pdb', status)
  } catch (error) {
    await handleError(error, MQjob, DBjob, 'dcd2pdb')
  }
}

export { runNewAnalysis }
