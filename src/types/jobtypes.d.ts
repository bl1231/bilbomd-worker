import { Job } from 'bullmq'

interface BilboMDPDBJob extends Job {
  type: 'pdb'
  data: { type: string; title: string; uuid: string; jobid: string }
  id: string
}
interface BilboMDCRDJob extends Job {
  type: 'crd_psf'
  data: { type: string; title: string; uuid: string; jobid: string }
  id: string
}
interface BilboMDAutoJob extends Job {
  type: 'auto'
  data: { type: string; title: string; uuid: string; jobid: string }
  id: string
}
interface Pdb2CrdJob extends Job {
  type: 'Pdb2Crd'
  data: { title: string; uuid: string }
  id: string
}
interface WebhooksJob extends Job {
  type: 'webhooks'
  data: { type: string; title: string; uuid: string }
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
  | WebhooksJob
