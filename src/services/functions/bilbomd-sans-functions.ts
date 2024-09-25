import path from 'path'
import fs from 'fs-extra'
import { logger } from '../../helpers/loggers'
// import { Job as BullMQJob } from 'bullmq'
// import { IStepStatus } from '@bl1231/bilbomd-mongodb-schema'
import { IBilboMDSANSJob } from '@bl1231/bilbomd-mongodb-schema'
// import { updateStepStatus } from './mongo-utils'
import { generateDCD2PDBInpFile } from './bilbomd-step-functions'
import { spawn, ChildProcess } from 'node:child_process'
import { CharmmParams } from '../../types/index'

// Define the types and interfaces if not already defined
// interface NewAnalysisParams {
//   out_dir: string
//   rg_min: number
//   rg_max: number
//   pepsisans_rg: string
//   conf_sample: number
// }

interface CharmmDCD2PDBParams {
  out_dir: string
  charmm_template: string
  charmm_topo_dir: string
  charmm_inp_file: string
  charmm_out_file: string
  in_psf_file: string
  in_crd_file: string
  inp_basename: string
  pepsisans_rg: string
  in_dcd: string
  run: string
}

// Define the structure of the configuration JSON
interface GAInput {
  number_iterations: number
  number_generations: number
  ensemble_size: number
  ensemble_split: number
  crossover_probability: number
  mutation_probability: number
  fitting_algorithm: string
  cutoff_weight: number
  fitness_function: string
  parallel: boolean
}

interface Config {
  structurefile: string
  experiment: string
  max_ensemble_size: number
  GA_inputs: GAInput[]
}

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

const writeSegidToChainid = async (inputFile: string): Promise<void> => {
  try {
    const fileContent = await fs.promises.readFile(inputFile, 'utf-8')
    const lines = fileContent.split('\n')
    const modifiedLines = lines.map((line) => {
      // Check if the line is an ATOM or HETATM line
      if (/^(ATOM|HETATM)/.test(line)) {
        // Extract the segid (columns 73-76)
        const segid = line.substring(72, 76).trim()
        const lastChar = segid.slice(-1)

        // Replace the chainid (column 22) with the last character of the segid
        return line.substring(0, 21) + lastChar + line.substring(22)
      } else {
        // If not an ATOM or HETATM line, return the line as is
        return line
      }
    })

    // Join the modified lines and overwrite the original file
    await fs.promises.writeFile(inputFile, modifiedLines.join('\n'), 'utf-8')
    logger.info(`Processed PDB file saved as ${inputFile}`)
  } catch (error) {
    logger.error('Error processing the PDB file:', error)
  }
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

const spawnPepsiSANS = async (
  analysisDir: string,
  pepsiSANSOpts: string[]
): Promise<void> => {
  logger.info(`Running Pepsi-SANS in ${analysisDir}`)
  const runDir = path.basename(analysisDir)

  // Read the directory and get the list of .pdb files
  const files = await fs.readdir(analysisDir)
  const pdbFiles = files.filter((file) => file.endsWith('.pdb'))

  // Create a header line for the CSV file
  const csvLines: string[] = ['PDBNAME,SCATTERINGFILE,DAT_DIRECTORY']

  // Process each .pdb file
  const tasks = pdbFiles.map(async (file) => {
    const inputPath = path.join(analysisDir, file)
    const outputFile = file.replace(/\.pdb$/, '.dat')
    const outputPath = path.join(analysisDir, outputFile)

    // Create a new promise for running Pepsi-SANS
    const runPepsiSANS = new Promise<void>((resolve, reject) => {
      const pepsiSANSProcess = spawn('Pepsi-SANS', [
        inputPath,
        '-o',
        outputPath,
        ...pepsiSANSOpts
      ])

      pepsiSANSProcess.on('error', (error) => {
        reject(`Failed to start Pepsi-SANS: ${error.message}`)
      })

      pepsiSANSProcess.on('close', (code) => {
        if (code === 0) {
          // Successfully completed
          csvLines.push(`${file},${outputFile},${runDir}`)
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

const combineCSVFiles = async (
  pepsiSANSRunDirs: string[],
  outDir: string,
  outputFileName: string
): Promise<void> => {
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

const writeConfigFile = async (
  pepsiSANScombinedCsv: string,
  experiment: string,
  outDir: string,
  outputFileName: string
): Promise<void> => {
  const config: Config = {
    structurefile: pepsiSANScombinedCsv,
    experiment: experiment,
    max_ensemble_size: 4,
    GA_inputs: [
      {
        number_iterations: 5,
        number_generations: 5,
        ensemble_size: 2,
        ensemble_split: 0.85,
        crossover_probability: 0.5,
        mutation_probability: 0.15,
        fitting_algorithm: 'Differential Evolution',
        cutoff_weight: 1e-6,
        fitness_function: 'inverse_absolute',
        parallel: true
      },
      {
        number_iterations: 5,
        number_generations: 5,
        ensemble_size: 3,
        ensemble_split: 0.85,
        crossover_probability: 0.5,
        mutation_probability: 0.15,
        fitting_algorithm: 'Differential Evolution',
        cutoff_weight: 1e-6,
        fitness_function: 'inverse_absolute',
        parallel: true
      },
      {
        number_iterations: 5,
        number_generations: 5,
        ensemble_size: 4,
        ensemble_split: 0.85,
        crossover_probability: 0.5,
        mutation_probability: 0.15,
        fitting_algorithm: 'Differential Evolution',
        cutoff_weight: 1e-6,
        fitness_function: 'inverse_absolute',
        parallel: true
      }
    ]
  }

  // Define the output file path
  const outputFilePath = path.join(outDir, outputFileName)

  // Convert the configuration object to JSON and write it to the file
  await fs.writeFile(outputFilePath, JSON.stringify(config, null, 2), 'utf-8')
}

const extractPDBFilesFromDCD = async (DBjob: IBilboMDSANSJob): Promise<void> => {
  const outputDir = path.join(DATA_VOL, DBjob.uuid)
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

  // Create the output directory for the PDB files
  const analysisDir = path.join(outputDir, 'pepsisans')
  await makeDir(analysisDir)
  // Create the output file for the Rg values from CHARMM
  const pepsisansRgFile = path.join(outputDir, DCD2PDBParams.pepsisans_rg)
  await makeFile(pepsisansRgFile)

  const step = Math.max(Math.round((DBjob.rg_max - DBjob.rg_min) / 5), 1)

  for (let rg = DBjob.rg_min; rg <= DBjob.rg_max; rg += step) {
    for (let run = 1; run <= DBjob.conformational_sampling; run++) {
      const pepsiSANSRunDir = path.join(analysisDir, `rg${rg}_run${run}`)
      await makeDir(pepsiSANSRunDir)

      DCD2PDBParams.charmm_inp_file = `${DCD2PDBParams.charmm_template}_rg${rg}_run${run}.inp`
      DCD2PDBParams.charmm_out_file = `${DCD2PDBParams.charmm_template}_rg${rg}_run${run}.out`
      DCD2PDBParams.inp_basename = `${DCD2PDBParams.charmm_template}_rg${rg}_run${run}`
      DCD2PDBParams.run = `rg${rg}_run${run}`

      await generateDCD2PDBInpFile(DCD2PDBParams, rg, run)
      await spawnCharmm(DCD2PDBParams) // Run CHARMM to extract PDB
    }
  }

  logger.info('PDB extraction completed.')
}

const remediatePDBFiles = async (DBjob: IBilboMDSANSJob): Promise<void> => {
  const outputDir = path.join(DATA_VOL, DBjob.uuid)
  const analysisDir = path.join(outputDir, 'pepsisans')

  // Read all subdirectories in analysisDir
  const pepsiSANSRunDirs = fs.readdirSync(analysisDir).filter((file) => {
    return fs.statSync(path.join(analysisDir, file)).isDirectory()
  })

  for (const dir of pepsiSANSRunDirs) {
    const pepsiSANSRunDir = path.join(analysisDir, dir)

    // Read all PDB files in the current directory
    const pdbFiles = fs.readdirSync(pepsiSANSRunDir).filter((file) => {
      return file.endsWith('.pdb')
    })

    for (const pdbFile of pdbFiles) {
      const pdbFilePath = path.join(pepsiSANSRunDir, pdbFile)
      await writeSegidToChainid(pdbFilePath)
    }
  }

  logger.info('All PDB files have been remediated.')
}

const runPepsiSANSOnPDBFiles = async (DBjob: IBilboMDSANSJob): Promise<void> => {
  const outputDir = path.join(DATA_VOL, DBjob.uuid)
  const analysisDir = path.join(outputDir, 'pepsisans')

  // Read all subdirectories in analysisDir
  const pepsiSANSRunDirs = fs.readdirSync(analysisDir).filter((file) => {
    return fs.statSync(path.join(analysisDir, file)).isDirectory()
  })

  for (const dir of pepsiSANSRunDirs) {
    const pepsiSANSRunDir = path.join(analysisDir, dir)

    const pepsiSANSOpts = [
      '-ms',
      '0.5',
      '-ns',
      '501',
      '--d2o',
      DBjob.d2o_fraction.toString(),
      '--deuterated',
      'A',
      '--deut',
      '0.0'
    ]

    await spawnPepsiSANS(pepsiSANSRunDir, pepsiSANSOpts) // Run Pepsi-SANS for each PDB
  }

  // Combine all CSV files into a single CSV file.
  await combineCSVFiles(pepsiSANSRunDirs, outputDir, 'pepsisans_combined.csv')

  // Write a gasans_config.json file
  await writeConfigFile(
    'pepsisans_combined.csv',
    DBjob.data_file,
    outputDir,
    'gasans_config.json'
  )

  logger.info('Pepsi-SANS analysis completed.')
}

export { extractPDBFilesFromDCD, remediatePDBFiles, runPepsiSANSOnPDBFiles }
