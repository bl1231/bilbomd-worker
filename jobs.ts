export interface HelloWorldJob {
  type: "PrintHelloWorld"
  data: { hello: string }
};
export interface DoSomeHeavyComputingJob {
  type: "DoSomeHeavyComputing"
  data: { magicNumber: number }
};
export interface MayFailOrNotJob {
  type: "MayFailOrNot"
  data: { magicNumber: number }
};
export interface BilboMDJob {
  type: "BilboMD"
  data: { uuid: string }
  id: string
}

export type WorkerJob =
  | HelloWorldJob
  | DoSomeHeavyComputingJob
  | MayFailOrNotJob
  | BilboMDJob;

