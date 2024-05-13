import { Job } from 'bullmq'

interface HelloWorldJob {
  type: 'PrintHelloWorld'
  data: { hello: string }
}
interface DoSomeHeavyComputingJob {
  type: 'DoSomeHeavyComputing'
  data: { magicNumber: number }
}
interface MayFailOrNotJob {
  type: 'MayFailOrNot'
  data: { magicNumber: number }
}
interface BilboMDPDBJob extends Job {
  type: 'pdb'
  data: { title: string; uuid: string; jobid: string }
  id: string
}
interface BilboMDCRDJob extends Job {
  type: 'crd_psf'
  data: { title: string; uuid: string; jobid: string }
  id: string
}
interface BilboMDAutoJob extends Job {
  type: 'auto'
  data: { title: string; uuid: string; jobid: string }
  id: string
}
interface Pdb2CrdJob extends Job {
  type: 'Pdb2Crd'
  data: { title: string; uuid: string }
  id: string
}

type WorkerJob =
  | HelloWorldJob
  | DoSomeHeavyComputingJob
  | MayFailOrNotJob
  | BilboMDPDBJob
  | BilboMDCRDJob
  | BilboMDAutoJob
  | Pdb2CrdJob
