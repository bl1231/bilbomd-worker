import dotenv from 'dotenv'
dotenv.config()

export const config = {
  sendEmailNotifications: process.env.SEND_EMAIL_NOTIFICATIONS === 'true',
  runOnNERSC: process.env.USE_NERSC === 'true',
  nerscBaseAPI: process.env.SFAPI_URL || 'https://api.nersc.gov/api/v1.2',
  nerscScriptDir: process.env.SCRIPT_DIR || '/global/cfs/cdirs/m4659/bilbomd-scripts',
  scripts: {
    prepareSlurmScript: process.env.PREPARE_SLURM_SCRIPT || 'gen-bilbomd-slurm-file.sh',
    copyFromScratchToCFSScript: process.env.CP2CFS_SCRIPT || 'copy-back-to-cfs.sh',
    dockerBuildScript: process.env.DOCKER_BUILD_SCRIPT || 'build-perlmutter-worker.sh'
  }
}
