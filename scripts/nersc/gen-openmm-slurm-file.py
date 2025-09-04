#!/usr/bin/env python3
import os
import sys
import json
import shutil
from pathlib import Path

# -----------------------------
# Argument and Environment Setup
# -----------------------------
def setup_environment(uuid):
    # Slurm and project parameters
    project = "m4659"
    queue = "regular"
    constraint = "gpu"
    nodes = 1
    walltime = "02:30:00"
    mailtype = "end,fail"
    mailuser = "sclassen@lbl.gov"

    # Determine environment (default to 'development')
    environment = os.environ.get("ENVIRONMENT", "development")
    pscratch = os.environ.get("PSCRATCH")
    cfs = os.environ.get("CFS")
    env_dir = "prod" if environment == "production" else "dev"

    # Directory paths
    cfs_base = f"{cfs}/{project}/bilbomd"
    upload_dir = f"{cfs_base}/{env_dir}/uploads/{uuid}"
    workdir = f"{pscratch}/bilbomd/{env_dir}/{uuid}"

    # Docker images (update as needed for OpenMM)
    openmm_worker = "bilbomd/bilbomd-openmm-worker:0.0.1"
    bilbomd_worker = "bilbomd/bilbomd-perlmutter-worker:0.0.20"
    af_worker = "bilbomd/bilbomd-colabfold:0.0.8"

    # Number of cores (example logic)
    if constraint.startswith("gpu"):
        num_cores = 128
    elif constraint == "cpu":
        num_cores = 256
    else:
        num_cores = 128
        

    # Return config dictionary
    return {
        "uuid": uuid,
        "project": project,
        "queue": queue,
        "constraint": constraint,
        "nodes": nodes,
        "walltime": walltime,
        "mailtype": mailtype,
        "mailuser": mailuser,
        "environment": environment,
        "env_dir": env_dir,
        "cfs_base": cfs_base,
        "upload_dir": upload_dir,
        "workdir": workdir,
        "openmm_worker": openmm_worker,
        "af_worker": af_worker,
        "num_cores": num_cores
    }

# -----------------------------
# Input Preparation
# -----------------------------
def prepare_input(workdir, upload_dir):
    # Create working directory if it doesn't exist
    Path(workdir).mkdir(parents=True, exist_ok=True)

    # Copy input files from upload_dir to workdir
    if os.path.exists(upload_dir):
        for item in os.listdir(upload_dir):
            src = os.path.join(upload_dir, item)
            dst = os.path.join(workdir, item)
            if os.path.isdir(src):
                shutil.copytree(src, dst, dirs_exist_ok=True)
            else:
                shutil.copy2(src, dst)
    else:
        print(f"Warning: Upload directory {upload_dir} does not exist.")

    # Read job parameters from params.json
    params_path = os.path.join(workdir, "params.json")
    params = {}
    if os.path.exists(params_path):
        with open(params_path, "r") as f:
            try:
                params = json.load(f)
            except Exception as e:
                print(f"Error reading params.json: {e}")
    else:
        print(f"Warning: params.json not found in {workdir}.")
    return params

# -----------------------------
# Status File Creation
# -----------------------------
def create_status_file(workdir):
    # Create initial status.txt file
    # ...existing code...
    pass

# -----------------------------
# Slurm Script Section Generation
# -----------------------------
def generate_slurm_header(config):
    header = f"""#!/bin/bash -l
#SBATCH --qos={config['queue']}
#SBATCH --nodes={config['nodes']}
#SBATCH --time={config['walltime']}
#SBATCH --licenses=cfs,scratch
#SBATCH --constraint={config['constraint']}
#SBATCH --account={config['project']}
#SBATCH --output={config['workdir']}/slurm-%j.out
#SBATCH --error={config['workdir']}/slurm-%j.err
#SBATCH --mail-type={config['mailtype']}
#SBATCH --mail-user={config['mailuser']}

# OpenMP settings:
export OMP_NUM_THREADS={config['num_cores']}
export OMP_PLACES=threads
export OMP_PROC_BIND=spread

# Global ENV variables
export UPLOAD_DIR="{config['upload_dir']}"
export WORKDIR="{config['workdir']}"
export STATUS_FILE="{config['workdir']}/status.txt"
"""
    return header

def generate_alphafold_section(config):
    # Generate AlphaFold section for Slurm script
    section = f"""
# -----------------------------------------------------------------------------
# Run ColabFoldLocal (i.e AlphaFold)
update_status alphafold Running
echo "Running AlphaFold..."
srun --gpus=4 --job-name alphafold podman-hpc run --rm --gpu --userns=keep-id -v {config['workdir']}:/bilbomd/work -v {config['upload_dir']}:/cfs {config['af_worker']} /bin/bash -c "cd /bilbomd/work/ && colabfold_batch --num-models=3 --amber --use-gpu-relax --num-recycle=4 af-entities.fasta alphafold"
AF_EXIT=$?
check_exit_code $AF_EXIT alphafold

echo "AlphaFold Done."
update_status alphafold Success
"""
    return section

def generate_pae2const_section(config):
    # Generate PAE to constraint file section
    # ...existing code...
    pass

def generate_minimize_section(config):
    # Generate minimization section (OpenMM)
    section = f"""
# -----------------------------------------------------------------------------
# OpenMM Minimization
update_status minimize Running
echo "Running OpenMM Minimization..."
srun --ntasks=1 \\
     --cpus-per-task={config['num_cores']} \\
     --gpus-per-task=1 \\
     --cpu-bind=cores \\
     --job-name minimize \\
     podman-hpc run --rm --userns=keep-id --gpu \\
        -v {config['workdir']}:/bilbomd/work \\
        -v {config['upload_dir']}:/cfs \\
        {config['openmm_worker']} /bin/bash -c "
            set -e
            cd /bilbomd/work/ && python minimize.py
        "
MIN_EXIT=$?
check_exit_code $MIN_EXIT minimize

echo "OpenMM Minimization complete"
update_status minimize Success
"""
    return section

def generate_heat_section(config):
    # Generate heating section (OpenMM)
    # ...existing code...
    pass

def generate_md_section(config, rg_values):
    # Generate molecular dynamics section (OpenMM)
    # Use dynamic decision making to set up multiple srun commands
    # ...existing code...
    pass

def generate_foxs_section(config):
    # Generate FoXS analysis section
    # ...existing code...
    pass

def generate_multifoxs_section(config):
    # Generate MultiFoXS ensemble analysis section
    # ...existing code...
    pass

def generate_copy_section(config):
    # Generate section to copy results back to CFS
    # ...existing code...
    pass

# -----------------------------
# Main Assembly
# -----------------------------
def main():
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <UUID>")
        sys.exit(1)
    uuid = sys.argv[1]

    # Step 1: Setup environment
    config = setup_environment(uuid)

    # Step 2: Prepare input and read the job params
    params = prepare_input(config['workdir'], config['upload_dir'])

    # Step 3: Create status file
    create_status_file(config['workdir'])

    # Step 4: Generate Slurm script sections
    slurm_sections = []
    slurm_sections.append(generate_slurm_header(config))
    if params.get('job_type') == 'BilboMdAlphaFold':
        slurm_sections.append(generate_alphafold_section(config))
        slurm_sections.append(generate_pae2const_section(config))
    slurm_sections.append(generate_minimize_section(config))
    slurm_sections.append(generate_heat_section(config))
    # Assume rg_values is determined from params or analysis
    rg_values = config.get('rg_values', [])
    slurm_sections.append(generate_md_section(config, rg_values))
    slurm_sections.append(generate_foxs_section(config))
    slurm_sections.append(generate_multifoxs_section(config))
    slurm_sections.append(generate_copy_section(config))

    # Step 5: Write final Slurm file
    slurm_file = Path(config['workdir']) / 'bilbomd_openmm.slurm'
    with open(slurm_file, 'w') as f:
        for section in slurm_sections:
            if section:
                f.write(section)
                f.write('\n')
    print(f"Slurm batch file written to {slurm_file}")

if __name__ == "__main__":
    main()