# bilbomd-worker

Processes BilboMD jobs and run CHARMM, FoXS, and MultiFoXS

## `bilbomd-worker` Description

`bilbomd-worker` is a simple [Typescript](https://www.typescriptlang.org/) NodeJS "worker" app that watches a BullMQ queue for incoming jobs. When a new job appears in the queue it will launch a sequence of processing tasks using CHARMM, FoXS, and MultiFoXS. The results will then be bundled up as a `results.tar.gz` file. The job progress will be updated in the main MongoDB database as well as in the BullMQ system (which uses Redis behind the scenes to store queue data).

## BilboMD processing pipeline

![BilboMD flow](scripts/bilbomd-flow.png)

## Deployment

In order to build the docker images you will need to obtain the source codes for CHARMM, BioXTAS, and OpenMPI and place them in the appropriate folders prior to running any `docker build` commands.

### Deploy via `docker compose` on Hyperion

To build the Docker image from the command line.

```bash
git clone git@github.com:bl1231/bilbomd-worker.git
cd bilbomd-worker
docker build --build-arg USER_ID=$UID -t bl1231/bilbomd-worker -f bilbomd-worker.dockerfile .
```

### Deploy via Rancher/SPIN at NERSC

At the moment there are two versions of the `bilbomd-worker` needed for deploying **BilboMD** at NERSC. One version for doing the work on a perlmutter compute node and a second version that does no real "work", but is deployed to SPIN where it monitors for jobs and uses the Superfacility API to prepare and launch jobs via slurm batch scripts.

In general, all of the build steps are performed as part of the Continuous Integration steps coordinated by GitHub Actions. If you need to buidl the Docker images manually you will need to build two images. To build `bilbomd-perlmutter-worker` which is the podman-hpc runtime for performing the Molecular Dynamics steps on Perlmutter compute nodes:

```bash
cd bilbomd-worker
podman-hpc build --build-arg USER_ID=$UID -t bilbomd/bilbomd-perlmutter-worker -f bilbomd-perlmutter-worker.dockerfile .
```

To build `bilbomd-spin-worker` for running on the SPIN Kubernetes cluster. The `$GITHUB_TOKEN` comes from GitHub... ask me if you need to know about this.

```bash
cd bilbomd-worker
podman-hpc build --build-arg GITHUB_TOKEN=$GITHUB_TOKEN -t bilbomd/bilbomd-spin-worker -f bilbomd-spin-worker.dockerfile .
```

## Authors

- Scott Classen sclassen at lbl dot gov
- Michal Hammel mhammel at lbl dot gov

## Version History
- 1.12.0 (11/21/2024)
  - Add BilboMD Multi pipeline
- 1.11.2 (11/20/2024)
  - Fix PAE Jiffy bug preventing it from working as expected.
- 1.11.1 (11/19/2024)
  - Return `minimization_output_$datfileprefix.dat` in results.tar.gz file
  - Update several dependencies
- 1.11.0 (11/15/2024)
  - Add a PDB remediation step to non-NERSC pipelines
- 1.10.1 (11/13/2024)
  - Update job progress in Mongo Job entry for all non-NERSC jobs
- 1.10.0 (11/08/2024)
  - Decouple job submission from job monitoring on NERSC
  - Add the step to calculate Rgyr vs. Dmax consolodated json file
- 1.9.4 (11/04/2024)
  - Simplify package name from `bilbomd-worker/bilbomd-worker` to `bilbomd-worker`
- 1.9.3 (11/04/2024)
  - Changes required to migrate from CJS to ESM
- 1.9.2
  - Update dependencies
- 1.9.1
  - Add feedback analysis sub-step for BilboMD Classic PDB (others will be added later)
- 1.9.0
  - Add BilboMD SANS capabilities
  - Refactor BullMQ worker code to make it more modular
- 1.8.1
  - Increase monitorJobAtNERSC polling to 24 hours at 1 min intervals
- 1.8.0
  - Add worker functions to process BilboMD AF (AlphaFold) jobs
- 1.7.0
  - Remove `bilbomd-spin-worker`
  - Add an API endpoint to deliver config info
  - Improvements to CI/CD workflow
- 1.6.7
  - Unified Docker image for both beamline and NERSC SPIN deployment
- 1.6.6
  - Add BioXTAS RAW & IMP to docker image.
  - Additional changes so we can eventually have a single Docker image for SPIN and beamline deployment
  - Fix & refactor the `pae_ratios.py` script to deal with adjacent Rigid Domains.
- 1.6.5
  - Fix bug with PAE Jiffy when replacing DNA residues
  - Install Python and CHARMM into `bilbomd-spin-worker` Docker image
- 1.6.4
  - Dependency updates
  - Implement GitHub Actions CI workflows
  - Better job-handling logic for NERSC Jobs
- 1.6.3
  - Add steps object to mongodb entry
  - Some improvements to logging
- 1.6.2
  - Use @bl1231/bilbomd-mongodb-schema
  - Update dependencies
  - Update README
- 1.6.1
  - A fair number of changes for NERSC deployment.
- 1.6.0
  - Extensive changes to `pdb2crd.py` in order to preserve incoming residue numbering.
  - Refactor for the changes in `pdb2crd.py`
  - Create one `CRD` file per chain then combine before running the rest of the BilboMD pipeline.
  - Make sure original files are included in `results.tar.gz` file
  - Create `results.tar.gz` files with unique names (e.g. `results-2ff9f312.tar.gz`)
- 1.5.5
  - Fix bug in `pdb2crd.py` script for substituting CHARMM residues names in DNA.
  - Update dependencies
- 1.5.4
  - Sync `pae_ratios.py` script with `bilbomd-backend`.
- 1.5.2
  - Changes to allow PDB files for BilboMD Classic
- 1.5.1
  - Changes to allow PDB files for BilboMD Auto
- 1.5.0
  - Mainly changes to allow building and deploying on local laptop and NERSC SPIN.
- 1.4.0
  - Add new functions for converting PDB to CRD and PSF.
  - Enforce Python style guidelines with Black.
  - Add `pdb2crd.py` script for creating the CHARMM input file for PDB to CRD.
- 1.3.1
  - Close fs streams properly so we don't have dangling NFS lock files.
- 1.3.0
  - Add new functions to run `FoXS` analysis on initial PDB for BilboMD classic/auto
- 1.2.9
  - Add a README file to all `results.tar.gz` files explaining the contents.
- 1.2.8
  - Fix bug when `rg_min` and `rg_max` are too close.
- 1.2.7
  - Update dependencies
- 1.2.6
  - Synchronize `mongoose` schema files with other BilboMD codes
- 1.2.5
  - Change all CHARMM bomlev values to `-2``
- 1.2.4
  - Upgrade mongoose from 7.6.3 to 8.0.2
- 1.2.3
  - add the hidden `-o` option for all `multi_foxs` runs
- 1.2.2
  - update `pae_ratios.py` script
- 1.2.1
  - Small change to logging messages
- 1.2.0
  - Refactor bilbomd function code
  - Add single `handleError` function
  - improve error handling logic
- 1.1.0
  - Rewrite gatherResults
  - Return single PDB file for each MultiFoXS ensemble
- 1.0.0
  - Start using Ubuntu for Docker build
  - IMP 2.19.0
- 0.0.12
  - Add BilboMDAuto job type (experimental and untested!)
- 0.0.11
  - bump nodejs to 18.18.0
- 0.0.10
  - Remove the `-r` option from FoXS in `spawnFoXS` function.
- 0.0.9
  - add job title to emails
