import path from 'path'
import fs from 'fs-extra'
import { logger } from '../../helpers/loggers.js'
import { promisify } from 'util'
import { IStepStatus } from '@bl1231/bilbomd-mongodb-schema'
import { IJob, IBilboMDSANSJob } from '@bl1231/bilbomd-mongodb-schema'
import { updateStepStatus } from './mongo-utils.js'
import { generateDCD2PDBInpFile } from './bilbomd-step-functions.js'
import { spawn, ChildProcess, exec } from 'node:child_process'
import { CharmmParams } from '../../types/index.js'

const execPromise = promisify(exec)

interface FileCopyParams {
  source: string
  destination: string
  filename: string
  isCritical: boolean
}

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

function isBilboMDSANSJob(job: IJob): job is IBilboMDSANSJob {
  return (job as IBilboMDSANSJob).d2o_fraction !== undefined
}

const makeFile = async (file: string) => {
  await fs.ensureFile(file)
}

const makeDir = async (directory: string) => {
  await fs.ensureDir(directory)
  logger.info(`Create Dir: ${directory}`)
}

const copyFiles = async ({
  source,
  destination,
  filename,
  isCritical
}: FileCopyParams): Promise<void> => {
  try {
    await execPromise(`cp ${source} ${destination}`)
  } catch (error) {
    logger.error(`Error copying ${filename}: ${error}`)
    if (isCritical) {
      throw new Error(`Critical error copying ${filename}: ${error}`)
    }
  }
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
    // logger.info(`Processed PDB file saved as ${inputFile}`)
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

  try {
    // Read the directory and get the list of .pdb files
    const files = await fs.readdir(analysisDir)
    const pdbFiles = files.filter((file) => file.endsWith('.pdb'))

    // Create a header line for the CSV file
    const csvLines: string[] = ['PDBNAME,SCATTERINGFILE,DAT_DIRECTORY']

    // Process each .pdb file in parallel
    const tasks = pdbFiles.map((file) => {
      return new Promise<void>((resolve, reject) => {
        const inputPath = path.join(analysisDir, file)
        const outputFile = file.replace(/\.pdb$/, '.dat')
        const outputPath = path.join(analysisDir, outputFile)

        // Spawn the Pepsi-SANS process
        const pepsiSANSProcess = spawn('Pepsi-SANS', [
          inputPath,
          '-o',
          outputPath,
          ...pepsiSANSOpts
        ])

        pepsiSANSProcess.on('error', (error) => {
          logger.error(`Failed to start Pepsi-SANS for ${file}: ${error.message}`)
          reject(error)
        })

        pepsiSANSProcess.on('close', (code) => {
          if (code === 0) {
            // Successfully completed, add entry to CSV lines
            csvLines.push(`${file},${outputFile},${runDir}`)
            resolve()
          } else {
            logger.error(`Pepsi-SANS process exited with code ${code} for ${file}`)
            reject(new Error(`Pepsi-SANS exited with code ${code}`))
          }
        })
      })
    })

    // Run all Pepsi-SANS tasks in parallel
    await Promise.all(tasks)

    // Get the directory name for the CSV file
    const csvFileName = `pepsisans_${runDir}.csv`

    // Write the CSV file
    const csvContent = csvLines.join('\n')
    await fs.writeFile(path.join(analysisDir, csvFileName), csvContent)

    logger.info(`Pepsi-SANS processing complete. ${csvFileName} created.`)
  } catch (error) {
    logger.error(
      `An error occurred during Pepsi-SANS processing: ${(error as Error).message}`
    )
    throw error // Re-throw the error after logging
  }
}

const combineCSVFiles = async (
  pepsiSANSRunDirs: string[],
  outDir: string,
  outputFileName: string
): Promise<void> => {
  const combinedCSVContent: string[] = []
  let headerWritten = false // Track if the header has been written

  for (const dir of pepsiSANSRunDirs) {
    const files = await fs.readdir(dir)
    for (const file of files) {
      if (file.endsWith('.csv')) {
        const filePath = path.join(dir, file)
        const fileContent = await fs.readFile(filePath, 'utf-8')
        const lines = fileContent.split('\n')

        if (!headerWritten) {
          // Write the header from the first CSV file
          combinedCSVContent.push(lines[0]) // Add the header line
          headerWritten = true
        }

        // Add the data lines (excluding the header line)
        combinedCSVContent.push(...lines.slice(1).filter((line) => line.trim() !== ''))
      }
    }
  }

  const outputFilePath = path.join(outDir, outputFileName)
  await fs.writeFile(outputFilePath, combinedCSVContent.join('\n'), 'utf-8')
  logger.info(`Combined CSV file written to ${outputFilePath}`)
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
  logger.info(`Configuration file written to ${outputFilePath}`)
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
  let status: IStepStatus = {
    status: 'Running',
    message: 'CHARMM Extract PDBs from DCD Trajectories has started.'
  }
  await updateStepStatus(DBjob, 'dcd2pdb', status)
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
  status = {
    status: 'Success',
    message: 'CHARMM Extract PDBs from DCD Trajectories has completed.'
  }
  await updateStepStatus(DBjob, 'dcd2pdb', status)
  logger.info('PDB extraction completed.')
}

const remediatePDBFiles = async (DBjob: IBilboMDSANSJob): Promise<void> => {
  const outputDir = path.join(DATA_VOL, DBjob.uuid)
  const analysisDir = path.join(outputDir, 'pepsisans')
  let status: IStepStatus = {
    status: 'Running',
    message: 'Remediating PDB files has started.'
  }
  await updateStepStatus(DBjob, 'pdb_remediate', status)
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
  status = {
    status: 'Success',
    message: 'Remediating PDB files has completed.'
  }
  await updateStepStatus(DBjob, 'pdb_remediate', status)
  logger.info('All PDB files have been remediated.')
}

const runPepsiSANSOnPDBFiles = async (DBjob: IBilboMDSANSJob): Promise<void> => {
  const workingDir = path.join(DATA_VOL, DBjob.uuid)
  const analysisDir = path.join(workingDir, 'pepsisans')

  try {
    let status: IStepStatus = {
      status: 'Running',
      message: 'Pepsi-SANS analysis has started.'
    }
    await updateStepStatus(DBjob, 'pepsisans', status)
    // Read all subdirectories in analysisDir
    const files = await fs.readdir(analysisDir)
    const pepsiSANSRunDirs = await Promise.all(
      files.map(async (file) => {
        const filePath = path.join(analysisDir, file)
        const stats = await fs.stat(filePath)
        return stats.isDirectory() ? filePath : null
      })
    )

    // Filter out nulls (non-directory entries)
    const validDirs = pepsiSANSRunDirs.filter((dir) => dir !== null) as string[]

    // Pepsi-SANS options
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

    // Process each directory in parallel
    await Promise.all(
      validDirs.map((pepsiSANSRunDir) => spawnPepsiSANS(pepsiSANSRunDir, pepsiSANSOpts))
    )

    // Combine all CSV files into a single CSV file.
    await combineCSVFiles(validDirs, workingDir, 'pepsisans_combined.csv')

    // Write a gasans_config.json file
    await writeConfigFile(
      'pepsisans_combined.csv',
      DBjob.data_file,
      workingDir,
      'gasans_config.json'
    )
    status = {
      status: 'Success',
      message: 'Pepsi-SANS analysis has completed.'
    }
    await updateStepStatus(DBjob, 'pepsisans', status)
    logger.info('Pepsi-SANS analysis completed.')
  } catch (error) {
    logger.error(`Error during Pepsi-SANS analysis: ${(error as Error).message}`)
    throw error // Re-throw after logging
  }
}

const runGASANS = async (DBjob: IBilboMDSANSJob): Promise<void> => {
  const workingDir = path.join(DATA_VOL, DBjob.uuid)
  const gasansOpts = ['/app/scripts/sans/GASANS-dask.py']

  // Paths to log files
  const stdoutLog = path.join(workingDir, 'gasans.log')
  const stderrLog = path.join(workingDir, 'gasans-error.log')

  let status: IStepStatus = {
    status: 'Running',
    message: 'GA-SANS analysis has started.'
  }

  try {
    // Update status to 'Running' at the start
    await updateStepStatus(DBjob, 'gasans', status)

    // Spawn the GASANS process
    const gasansProcess = spawn('python', gasansOpts, { cwd: workingDir })

    // Open write streams for stdout and stderr logs
    const stdoutStream = fs.createWriteStream(stdoutLog, { flags: 'a' })
    const stderrStream = fs.createWriteStream(stderrLog, { flags: 'a' })

    // Pipe stdout and stderr to their respective log files
    gasansProcess.stdout?.pipe(stdoutStream)
    gasansProcess.stderr?.pipe(stderrStream)

    // Handle process completion
    await new Promise<void>((resolve, reject) => {
      gasansProcess.on('close', (code) => {
        stdoutStream.close()
        stderrStream.close()

        if (code === 0) {
          logger.info(`GASANS process completed successfully. Exit code: ${code}`)
          resolve()
        } else {
          logger.error(`GASANS process exited with code ${code}`)
          reject(new Error(`GASANS process exited with code ${code}`))
        }
      })
    })

    // If the process completes successfully, update the status
    status = {
      status: 'Success',
      message: 'GA-SANS analysis has completed successfully.'
    }
    await updateStepStatus(DBjob, 'gasans', status)
  } catch (error) {
    // Update status to 'Error' if something goes wrong
    status = {
      status: 'Error',
      message: `GA-SANS analysis failed: ${(error as Error).message}`
    }
    await updateStepStatus(DBjob, 'gasans', status)
    logger.error(`Error during GASANS analysis: ${(error as Error).message}`)
    throw error
  }
}

const prepareBilboMDSANSResults = async (DBjob: IBilboMDSANSJob): Promise<void> => {
  let status: IStepStatus = {
    status: 'Running',
    message: 'Gathering BilboMD SANS results has started.'
  }
  try {
    await updateStepStatus(DBjob, 'results', status)

    if (isBilboMDSANSJob(DBjob)) {
      await prepareResults(DBjob)
      status = {
        status: 'Success',
        message: 'Gathering BilboMD SANS results successful.'
      }
      await updateStepStatus(DBjob, 'results', status)
    } else {
      throw new Error('Invalid job type')
    }
  } catch (error) {
    let errorMessage = 'Unknown error'
    if (error instanceof Error) {
      errorMessage = error.message
    }
    status = {
      status: 'Error',
      message: 'Gathering BilboMD SANS results error.'
    }
    await updateStepStatus(DBjob, 'results', status)
    logger.error(`Error during prepareBilboMDResults job: ${errorMessage}`)
  }
}

const prepareResults = async (DBjob: IBilboMDSANSJob): Promise<void> => {
  try {
    const outputDir = path.join(DATA_VOL, DBjob.uuid)
    // const multiFoxsDir = path.join(outputDir, 'multifoxs')
    // const logFile = path.join(multiFoxsDir, 'multi_foxs.log')
    const resultsDir = path.join(outputDir, 'results')

    // Create new empty results directory
    try {
      await makeDir(resultsDir)
    } catch (error) {
      logger.error(`Error creating results directory: ${error}`)
    }

    // Copy the minimized PDB
    await copyFiles({
      source: `${outputDir}/minimization_output.pdb`,
      destination: resultsDir,
      filename: 'minimization_output.pdb',
      isCritical: false
    })

    // Copy the DAT file for the minimized PDB
    // await copyFiles({
    //   source: `${outputDir}/minimization_output.pdb.dat`,
    //   destination: resultsDir,
    //   filename: 'minimization_output.pdb.dat',
    //   isCritical: false
    // })

    // Copy ensemble_size_*.txt files
    // await copyFiles({
    //   source: `${multiFoxsDir}/ensembles_size*.txt`,
    //   destination: resultsDir,
    //   filename: 'ensembles_size*.txt',

    //   isCritical: false
    // })

    // Copy multi_state_model_*_1_1.dat files
    // await copyFiles({
    //   source: `${multiFoxsDir}/multi_state_model_*_1_1.dat`,
    //   destination: resultsDir,
    //   filename: 'multi_state_model_*_1_1.dat',

    //   isCritical: false
    // })

    // Gather original uploaded files
    const filesToCopy = [{ file: DBjob.data_file, label: 'data_file' }]

    if ('pdb_file' in DBjob && DBjob.pdb_file) {
      filesToCopy.push({ file: DBjob.pdb_file, label: 'pdb_file' })
    }

    if ('crd_file' in DBjob && DBjob.crd_file) {
      filesToCopy.push({ file: DBjob.crd_file, label: 'crd_file' })
    }

    if ('psf_file' in DBjob && DBjob.psf_file) {
      filesToCopy.push({ file: DBjob.psf_file, label: 'psf_file' })
    }

    if ('const_inp_file' in DBjob && DBjob.const_inp_file) {
      filesToCopy.push({ file: DBjob.const_inp_file, label: 'const_inp_file' })
    }

    // Additional GASANS-specific files
    const gasansEnsembleCsvFiles = [
      'best_model_EnsembleSize2.csv',
      'best_model_EnsembleSize3.csv',
      'best_model_EnsembleSize4.csv'
    ]
    gasansEnsembleCsvFiles.forEach((file) => {
      filesToCopy.push({ file, label: file })
    })

    for (const { file, label } of filesToCopy) {
      if (file) {
        await copyFiles({
          source: path.join(outputDir, file),
          destination: resultsDir,
          filename: label,
          isCritical: false
        })
      } else {
        logger.warn(`Expected file for '${label}' is undefined.`)
      }
    }

    // Only want to add N best PDBs equal to number_of_states N in logfile.
    // const numEnsembles = await getNumEnsembles(logFile)
    // logger.info(`prepareResults numEnsembles: ${numEnsembles}`)
    // MQjob.log(`Gather ${numEnsembles} best ensembles`)

    // if (numEnsembles) {
    //   // Iterate through each ensembles_siz_*.txt file
    //   for (let i = 1; i <= numEnsembles; i++) {
    //     const ensembleFile = path.join(multiFoxsDir, `ensembles_size_${i}.txt`)
    //     logger.info(`prepareResults ensembleFile: ${ensembleFile}`)
    //     const ensembleFileContent = await fs.readFile(ensembleFile, 'utf8')
    //     const pdbFilesRelative = extractPdbPaths(ensembleFileContent)

    //     const pdbFilesFullPath = pdbFilesRelative.map((item) =>
    //       path.join(outputDir, item)
    //     )
    //     // Extract the first N PDB files to string[]
    //     const numToCopy = Math.min(pdbFilesFullPath.length, i)
    //     const ensembleModelFiles = pdbFilesFullPath.slice(0, numToCopy)
    //     const ensembleSize = ensembleModelFiles.length
    //     await concatenateAndSaveAsEnsemble(ensembleModelFiles, ensembleSize, resultsDir)

    //     MQjob.log(
    //       `Gathered ${pdbFilesFullPath.length} PDB files from ensembles_size_${i}.txt`
    //     )
    //   }
    // }

    // Create Job-specific README file.
    try {
      await createReadmeFile(DBjob, 4, resultsDir)
    } catch (error) {
      logger.error(`Error creating README file: ${error}`)
    }

    // Create the results tar.gz file
    try {
      const uuidPrefix = DBjob.uuid.split('-')[0]
      const archiveName = `results-${uuidPrefix}.tar.gz`
      await execPromise(`tar czvf ${archiveName} results`, { cwd: outputDir })
    } catch (error) {
      logger.error(`Error creating tar file: ${error}`)
      throw error // Critical error, rethrow or handle specifically if necessary
    }
  } catch (error) {
    logger.error(`Error preparing results: ${error}`)
    // await handleError(error, MQjob, DBjob, 'results')
  }
}

const createReadmeFile = async (
  DBjob: IBilboMDSANSJob,
  numEnsembles: number,
  resultsDir: string
): Promise<void> => {
  const originalFiles = `
- Original PDB file: ${DBjob.pdb_file}
- Converted CRD file: ${DBjob.crd_file}
- Converted PSF file: ${DBjob.psf_file}
- Original experimental SANS data file: ${DBjob.data_file}
- Original const.inp file: ${DBjob.const_inp_file}
- Generated minimized PDB file: minimized_output.pdb
- Generated minimized PDB DAT file: minimized_output.pdb.dat
`

  const readmeContent = `
# BilboMD SANS Job Results

This directory contains the results for your ${DBjob.title} BilboMD SANS job.

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
  extractPDBFilesFromDCD,
  remediatePDBFiles,
  runPepsiSANSOnPDBFiles,
  runGASANS,
  prepareBilboMDSANSResults
}
