import * as dotenv from 'dotenv'
import { connectDB } from './db'
import { Job, Worker, WorkerOptions } from 'bullmq'
import { WorkerJob } from 'bullmq.jobs'
import { DoSomeHeavyComputingUseCase } from './utils'
import { processBilboMDJob } from './process.job'

dotenv.config()

connectDB()

const workerHandler = async (job: Job<WorkerJob>) => {
  switch (job.data.type) {
    case 'PrintHelloWorld': {
      console.log(`Hello world!`, job.data)
      return
    }
    case 'DoSomeHeavyComputing': {
      console.log('Starting job:', job.name)
      job.updateProgress(10)

      await DoSomeHeavyComputingUseCase(job.data)

      job.updateProgress(100)
      console.log('Finished job:', job.name)
      return
    }
    case 'MayFailOrNot': {
      if (Math.random() > 0.3) {
        console.log(`FAILED ;( - ${job.data.data.magicNumber}`)
        throw new Error('Something went wrong')
      }

      console.log(`COMPLETED - ${job.data.data.magicNumber}`)
      return 'Done!'
    }
    case 'BilboMD': {
      console.log('Starting  job:', job.name)
      job.updateProgress(10)
      await processBilboMDJob(job)
      job.updateProgress(100)
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
  lockDuration: 90000
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const worker = new Worker('bilbomd', workerHandler, workerOptions)

console.log('Worker started!')
