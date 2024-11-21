import { config } from '../../config/config.js'
import { logger } from '../../helpers/loggers.js'
import fs from 'fs-extra'
import path from 'path'
import { IMultiJob } from '@bl1231/bilbomd-mongodb-schema'

const prepareMultiMDdatFileList = async (DBJob: IMultiJob): Promise<void> => {
  const startingDir = path.join(config.uploadDir, DBJob.uuid)
  const outputFilePath = path.join(startingDir, 'multi_md_foxs_files.txt')
  logger.info(`Starting directory: ${startingDir}`)
  logger.info(`Output file: ${outputFilePath}`)

  // Helper function to recursively traverse directories
  const findPdbDatFiles = async (dir: string): Promise<string[]> => {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    const files: string[] = []

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        // Recursively search in subdirectories
        const subDirFiles = await findPdbDatFiles(fullPath)
        files.push(...subDirFiles)
      } else if (entry.isFile() && entry.name.endsWith('.pdb.dat')) {
        files.push(fullPath)
      }
    }

    return files
  }

  try {
    // Clear or create the output file
    await fs.writeFile(outputFilePath, '')

    // Iterate over each UUID and find `.pdb.dat` files in the foxs directory
    for (const uuid of DBJob.bilbomd_uuids) {
      const foxsDir = path.join(config.uploadDir, uuid, 'foxs')
      logger.info(`Processing UUID: ${uuid}, Foxs directory: ${foxsDir}`)

      if (await fs.pathExists(foxsDir)) {
        const pdbDatFiles = await findPdbDatFiles(foxsDir)

        // Append file paths to the output file
        for (const filePath of pdbDatFiles) {
          await fs.appendFile(outputFilePath, `${filePath}\n`)
        }

        logger.info(`Found ${pdbDatFiles.length} .pdb.dat files for UUID: ${uuid}`)
      } else {
        logger.warn(`Foxs directory does not exist for UUID: ${uuid}`)
      }
    }

    logger.info(`MultiFoXS .dat file list created: ${outputFilePath}`)
  } catch (error) {
    logger.error(`Error preparing MultiFoXS .dat file list: ${error}`)
    throw error
  }
}

const processJobDetails = async (DBJob: IMultiJob) => {
  try {
    console.log(`Processing MultiJob: ${DBJob.title}`)

    // Check if bilbomd_jobs is populated
    if (!DBJob.bilbomd_jobs || DBJob.bilbomd_jobs.length === 0) {
      console.log('No associated jobs found or bilbomd_jobs is not populated.')
      return
    }

    // Iterate over the populated bilbomd_jobs and access fields
    for (const job of DBJob.bilbomd_jobs) {
      console.log(`Job UUID: ${job.uuid}`)
      console.log(`Job Title: ${job.title}`)
      console.log(`Job Status: ${job.status}`)
      console.log(`SAXS data file: ${job.data_file}`)
      // Add any additional logic here
    }
  } catch (error) {
    console.error('Error processing jobs:', error)
  }
}

export { prepareMultiMDdatFileList, processJobDetails }
