import { Job as BullMQJob } from 'bullmq'
import { BilboMdAutoJob } from '@bl1231/bilbomd-mongodb-schema'
// import { User } from '@bl1231/bilbomd-mongodb-schema'
// import { sendJobCompleteEmail } from '../../helpers/mailer'
import { prepareResults, runPaeToConstInp, runAutoRg } from '../bilbomd.functions'
import { initializeJob, cleanupJob } from '../functions/job-utils'
import {
  prepareBilboMDSlurmScript,
  submitJobToNersc,
  monitorTaskAtNERSC,
  monitorJobAtNERSC
} from '../functions/nersc-jobs'
import { handleStepError, updateStepStatus } from '../functions/mongo-utils'
import { logger } from '../../helpers/loggers'

const processBilboMDAutoNerscJobTest = async (MQjob: BullMQJob) => {
  await MQjob.updateProgress(1)

  const foundJob = await BilboMdAutoJob.findOne({ _id: MQjob.data.jobid })
    .populate('user')
    .exec()
  if (!foundJob) {
    throw new Error(`No job found for: ${MQjob.data.jobid}`)
  }
  await MQjob.updateProgress(5)

  // Initialize
  await initializeJob(MQjob, foundJob)

  // Use PAE to construct const.inp file
  await runPaeToConstInp(foundJob)

  // Use BioXTAS to calculate Rg_min and Rg_max
  await runAutoRg(foundJob)

  // More steps that require foundJob or updatedJob

  await cleanupJob(MQjob, foundJob)
  await MQjob.updateProgress(100)
}

const processBilboMDAutoJobNersc = async (MQjob: BullMQJob) => {
  await MQjob.updateProgress(1)

  const foundJob = await BilboMdAutoJob.findOne({ _id: MQjob.data.jobid })
    .populate('user')
    .exec()
  if (!foundJob) {
    throw new Error(`No job found for: ${MQjob.data.jobid}`)
  }
  await MQjob.updateProgress(5)

  // Initialize
  await initializeJob(MQjob, foundJob)
  await MQjob.updateProgress(10)

  // Run make-bilbomd.sh to prepare bilbomd.slurm
  const prepTaskID = await prepareBilboMDSlurmScript(foundJob)
  const prepResult = await monitorTaskAtNERSC(prepTaskID)
  logger.info(`prepResult: ${JSON.stringify(prepResult)}`)
  await MQjob.updateProgress(20)

  // Submit bilbomd.slurm to the queueing system
  const submitTaskID = await submitJobToNersc(foundJob)
  const submitResult = await monitorTaskAtNERSC(submitTaskID)
  logger.info(`submitResult: ${JSON.stringify(submitResult)}`)
  const submitResultObject = JSON.parse(submitResult.result)
  const jobID = submitResultObject.jobid
  logger.info(`JOBID: ${jobID}`)
  await MQjob.updateProgress(30)

  // Watch the job
  const jobResult = await monitorJobAtNERSC(foundJob, jobID)
  logger.info(`jobResult: ${JSON.stringify(jobResult)}`)
  await MQjob.updateProgress(90)

  // Prepare results
  try {
    await MQjob.log('start gather results')
    await updateStepStatus(foundJob._id, 'results', 'Running')
    await prepareResults(MQjob, foundJob)
    await updateStepStatus(foundJob._id, 'results', 'Success')
    await MQjob.log('end gather results')
  } catch (error) {
    await handleStepError(foundJob._id, 'results', error)
  }
  await MQjob.updateProgress(99)

  // Cleanup & send email
  await updateStepStatus(foundJob._id, 'email', 'Running')
  await cleanupJob(MQjob, foundJob)
  await updateStepStatus(foundJob._id, 'email', 'Success')
  await MQjob.updateProgress(100)
}

export { processBilboMDAutoJobNersc, processBilboMDAutoNerscJobTest }
