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
  pepsisans_rg: string
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
//   pepsisans_rg: string
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

const spawnPepsiSANS = async (analysisDir: string): Promise<void> => {
  logger.info(`Running Pepsi-SANS in ${analysisDir}`)

  // Read the directory and get the list of .pdb files
  const files = await fs.readdir(analysisDir)
  const pdbFiles = files.filter((file) => file.endsWith('.pdb'))

  // Create a CSV array
  // const csvLines: string[] = ['PDBNAME','SCATTERINGFILE','Rg','RMSD']
  const csvLines: string[] = ['PDBNAME, SCATTERINGFILE']

  // Process each .pdb file
  const tasks = pdbFiles.map(async (file) => {
    const inputPath = path.join(analysisDir, file)
    const outputFile = file.replace(/\.pdb$/, '.dat')
    const outputPath = path.join(analysisDir, outputFile)

    // Create a new promise for running Pepsi-SANS
    const runPepsiSANS = new Promise<void>((resolve, reject) => {
      const pepsiSANSProcess = spawn('Pepsi-SANS', [inputPath, '-o', outputPath])

      pepsiSANSProcess.on('error', (error) => {
        reject(`Failed to start Pepsi-SANS: ${error.message}`)
      })

      pepsiSANSProcess.on('close', (code) => {
        if (code === 0) {
          // Successfully completed
          csvLines.push(`${file},${outputFile}`)
          resolve()
        } else {
          reject(`Pepsi-SANS process exited with code ${code}`)
        }
      })
    })

    // Await the completion of Pepsi-SANS process
    await runPepsiSANS
  })

  try {
    // Run all Pepsi-SANS processes in parallel
    await Promise.all(tasks)

    // Get the directory name for the CSV file
    const dirName = path.basename(analysisDir)
    const csvFileName = `pepsisans_${dirName}.csv`

    // Write the CSV file
    const csvContent = csvLines.join('\n')
    await fs.writeFile(path.join(analysisDir, csvFileName), csvContent)

    logger.info(`Pepsi-SANS processing complete. ${csvFileName} file created.`)
  } catch (error) {
    logger.error(`An error occurred: ${error}`)
  }
}

async function combineCSVFiles(
  pepsiSANSRunDirs: string[],
  outDir: string,
  outputFileName: string
): Promise<void> {
  const combinedCSVContent: string[] = []

  for (const dir of pepsiSANSRunDirs) {
    const files = await fs.readdir(dir)
    for (const file of files) {
      if (file.endsWith('.csv')) {
        const filePath = path.join(dir, file)
        const fileContent = await fs.readFile(filePath, 'utf-8')
        const lines = fileContent.split('\n')
        // Strip the header (first line) and add the rest to combined content
        combinedCSVContent.push(...lines.slice(1))
      }
    }
  }

  const outputFilePath = path.join(outDir, outputFileName)
  await fs.writeFile(outputFilePath, combinedCSVContent.join('\n'), 'utf-8')
}

const runPepsiSANS = async (MQjob: BullMQJob, DBjob: IBilboMDSANSJob): Promise<void> => {
  const outputDir = path.join(DATA_VOL, DBjob.uuid)

  const analysisParams: NewAnalysisParams = {
    out_dir: outputDir,
    rg_min: DBjob.rg_min,
    rg_max: DBjob.rg_max,
    pepsisans_rg: 'pepsisans_rg.out',
    conf_sample: DBjob.conformational_sampling
  }

  const DCD2PDBParams: CharmmDCD2PDBParams = {
    out_dir: outputDir,
    charmm_template: 'dcd2pdb-sans',
    charmm_topo_dir: TOPO_FILES,
    charmm_inp_file: '',
    charmm_out_file: '',
    in_psf_file: 'bilbomd_pdb2crd.psf',
    in_crd_file: '',
    inp_basename: '',
    pepsisans_rg: 'pepsisans_rg.out',
    in_dcd: '',
    run: ''
  }

  try {
    let status: IStepStatus = {
      status: 'Running',
      message: 'New Analysis has started.'
    }
    await updateStepStatus(DBjob, 'dcd2pdb', status)

    const analysisDir = path.join(analysisParams.out_dir, 'pepsisans')
    await makeDir(analysisDir)
    const analysisRgFile = path.join(analysisParams.out_dir, analysisParams.pepsisans_rg)
    await makeFile(analysisRgFile)

    const step = Math.max(
      Math.round((analysisParams.rg_max - analysisParams.rg_min) / 5),
      1
    )

    const pepsiSANSRunDirs: string[] = []

    for (let rg = analysisParams.rg_min; rg <= analysisParams.rg_max; rg += step) {
      for (let run = 1; run <= analysisParams.conf_sample; run += 1) {
        const runAllCharmm: Promise<void>[] = []
        const runAllPepsiSANS: Promise<void>[] = []
        const pepsiSANSRunDir = path.join(analysisDir, `rg${rg}_run${run}`)
        pepsiSANSRunDirs.push(pepsiSANSRunDir)

        await makeDir(pepsiSANSRunDir)

        DCD2PDBParams.charmm_inp_file = `${DCD2PDBParams.charmm_template}_rg${rg}_run${run}.inp`
        DCD2PDBParams.charmm_out_file = `${DCD2PDBParams.charmm_template}_rg${rg}_run${run}.out`
        DCD2PDBParams.inp_basename = `${DCD2PDBParams.charmm_template}_rg${rg}_run${run}`
        DCD2PDBParams.run = `rg${rg}_run${run}`

        await generateDCD2PDBInpFile(DCD2PDBParams, rg, run)
        runAllCharmm.push(spawnCharmm(DCD2PDBParams))
        await Promise.all(runAllCharmm)

        // Run Pepsi-SANS on every PDB file
        runAllPepsiSANS.push(spawnPepsiSANS(pepsiSANSRunDir))
        await Promise.all(runAllPepsiSANS)
      }
    }

    // Combine all CSV files into a single CSV file
    await combineCSVFiles(pepsiSANSRunDirs, analysisParams.out_dir, 'combined.csv')

    status = {
      status: 'Success',
      message: 'New Analysis has completed.'
    }
    await updateStepStatus(DBjob, 'dcd2pdb', status)
  } catch (error) {
    await handleError(error, MQjob, DBjob, 'dcd2pdb')
  }
}

export { runPepsiSANS }
