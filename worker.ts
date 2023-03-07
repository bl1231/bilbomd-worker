import * as dotenv from 'dotenv';
import { connectDB } from './src/db'
import { Job, Worker, WorkerOptions } from "bullmq"
import { WorkerJob } from './src/bullmq.jobs'

import { DoSomeHeavyComputingUseCase } from "./src/utils"
import { processBilboMDJob } from "./src/process"

dotenv.config()

// Connect to MongoDB
connectDB()

const workerHandler = async (job: Job<WorkerJob>) => {
  switch (job.data.type) {
    case "PrintHelloWorld": {
      console.log(`Hello world!`, job.data)
      return
    }
    case "DoSomeHeavyComputing": {
      console.log("Starting job:", job.name)
      job.updateProgress(10)

      await DoSomeHeavyComputingUseCase(job.data)

      job.updateProgress(100)
      console.log("Finished job:", job.name)
      return
    }
    case "MayFailOrNot": {
      if (Math.random() > 0.3) {
        console.log(`FAILED ;( - ${job.data.data.magicNumber}`)
        throw new Error("Something went wrong")
      }

      console.log(`COMPLETED - ${job.data.data.magicNumber}`)
      return "Done!"
    }
    case "BilboMD": {
      console.log("Starting  job:", job.name)
      job.updateProgress(10)

      await processBilboMDJob(job)

      job.updateProgress(100)
      console.log("Finished job:", job.name)
      return
    }
  }
}

// 
const workerOptions: WorkerOptions = {
  connection: {
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT),
  },
}

const worker = new Worker("bilbomd", workerHandler, workerOptions)

console.log("Worker started!")
