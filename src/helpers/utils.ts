import { setTimeout } from 'timers/promises'
import { DoSomeHeavyComputingJob } from '../types/jobtypes'

export const DoSomeHeavyComputingUseCase = async (job: DoSomeHeavyComputingJob) => {
  await setTimeout(job.data.magicNumber * 1000, () => {
    return 14
  })
}
