import { Job } from 'bullmq'

export interface HelloWorldJob {
  type: 'PrintHelloWorld'
  data: { hello: string }
}
export interface DoSomeHeavyComputingJob {
  type: 'DoSomeHeavyComputing'
  data: { magicNumber: number }
}
export interface MayFailOrNotJob {
  type: 'MayFailOrNot'
  data: { magicNumber: number }
}
export interface BilboMDPDBJob extends Job {
  type: 'pdb'
  data: { title: string; uuid: string; jobid: string }
  id: string
}
export interface BilboMDCRDJob extends Job {
  type: 'crd_psf'
  data: { title: string; uuid: string; jobid: string }
  id: string
}
export interface BilboMDAutoJob extends Job {
  type: 'auto'
  data: { title: string; uuid: string; jobid: string }
  id: string
}
export interface Pdb2CrdJob extends Job {
  type: 'Pdb2Crd'
  data: { title: string; uuid: string }
  id: string
}

export type WorkerJob =
  | HelloWorldJob
  | DoSomeHeavyComputingJob
  | MayFailOrNotJob
  | BilboMDPDBJob
  | BilboMDCRDJob
  | BilboMDAutoJob
  | Pdb2CrdJob
