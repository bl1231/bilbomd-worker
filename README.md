# bilbomd-worker

Processes BilboMD jobs and run CHARMM, FoXS, and MultiFoXS

## `bilbomd-worker` Description

`bilbomd-worker` is a simple [Typescript](https://www.typescriptlang.org/) NodeJS "worker" app that watches a BullMQ queue for incoming jobs. When a new job appears in the queue it will launch a sequence of processing tasks using CHARMM, FoXS, and MultiFoXS. The results will then be bundled up as a `results.tar.gz` file. The job progress will be updated in the main MongoDB database as well as in the BullMQ system (which uses Redis behind the scenes to store queue data).

## BilboMD processing pipeline

![BilboMD flow](scripts/bilbomd-flow.png)

## Deployment

In order to build the docker images you will need to obtain the source code fro CHARMM, BioXTAS, and OpenMPI and place them in teh appropriate folders prior to running any `build` commands.

To build the Docker image from the command line.

```bash
docker build --build-arg USER_ID=$UID -t bl1231/bilbomd-worker -f bilbomd-worker.dockerfile .
```

At the moment there are 2 versions of the `bilbomd-worker` needed for deploying at NERSC. One version for doing the work on a perlmutter compute node and a second version that does no real work, but is deployed to SPIN where it monitors for jobs and uses teh Superfacility API to prepare and launch jobs via slurm batch scripts.

For running on Perlmutter compute nodes:

```bash
podman-hpc build --build-arg USER_ID=$UID -t bilbomd/bilbomd-perlmutter-worker -f bilbomd-perlmutter-worker.dockerfile .
```

For running on SPIN Kubernetes cluster. The `$NPM_TOKEN` comes from GitHub... ask me if you need to knwo about this.

```bash
podman-hpc build --build-arg NPM_TOKEN=$NPM_TOKEN -t bilbomd/bilbomd-spin-worker -f bilbomd-spin-worker.dockerfile .
```


## Authors

- Scott Classen sclassen at lbl dot gov
- Michal Hammel mhammel at lbl dot gov

## Version History

- 1.6.1
  - A fair number of changes for NERSC deployment
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
  - Add `pdb2crd.py` script for creating teh CHARMM input file for PDB to CRD.
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
