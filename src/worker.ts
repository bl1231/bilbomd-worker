import * as dotenv from 'dotenv'
import { connectDB } from './db'
import { Job, Worker, WorkerOptions } from 'bullmq'
import { WorkerJob } from 'bullmq.jobs'
import { processBilboMDJob } from './process.bilbomd'
import { processBilboMDAutoJob } from './process.bilbomdauto'

dotenv.config()

connectDB()

const workerHandler = async (job: Job<WorkerJob>) => {
  console.log('workerHandler: ', job.data)
  switch (job.data.type) {
    case 'BilboMD': {
      console.log('Start BilboMD job:', job.name)
      await processBilboMDJob(job)
      console.log('Finish job:', job.name)
      return
    }
    case 'BilboMDAuto': {
      console.log('Start BilboMDAuto job:', job.name)
      await processBilboMDAutoJob(job)
      console.log('Finished job:', job.name)
      return
    }
  }
}

const workerOptions: WorkerOptions = {
  connection: {
    host: 'redis',
    port: 6379
  },
  concurrency: 1,
  lockDuration: 90000
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const worker = new Worker('bilbomd', workerHandler, workerOptions)

console.log('Worker started!')
