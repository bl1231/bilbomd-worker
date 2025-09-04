#!/usr/bin/env python3
import os
import sys
import json
import shutil
from pathlib import Path
import yaml
import re
import numpy as np

# -----------------------------
# Argument and Environment Setup
# -----------------------------
def setup_environment(uuid):
    # Slurm and project parameters
    project = "m4659"
    queue = "debug"
    constraint = "gpu"
    nodes = 1
    walltime = "00:30:00"
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

    # Docker images
    openmm_worker = "bilbomd/bilbomd-openmm-worker:0.0.4"
    bilbomd_worker = "bilbomd/bilbomd-perlmutter-worker:0.0.20"
    af_worker = "bilbomd/bilbomd-colabfold:0.0.8"

    # Number of cores
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
# Convert const.inp to OpenMM config yaml
# -----------------------------
def prepare_openmm_config(workdir, params):
    """
    Locate const.inp in workdir, parse CHARMM-style constraints, and write OpenMM-compatible config.yaml.
    This is a draft; parsing logic should be expanded for your specific CHARMM syntax.
    """
    

    # Locate const.inp
    const_inp_path = os.path.join(workdir, "const.inp")
    if not os.path.exists(const_inp_path):
        print(f"Warning: {const_inp_path} not found. Skipping OpenMM config generation.")
        return None

    # Build OpenMM config dictionary (skeleton)
    openmm_config = {
        "input": {
            "dir": "/bilbomd/work",
            "pdb_file": params.get("pdb_file", "input.pdb"),
            "forcefield": ["charmm36.xml", "implicit/hct.xml"]
        },
        "output": {
            "output_dir": "/bilbomd/work/openmm",
            "min_dir": "minimization",
            "heat_dir": "heating",
            "md_dir": "md"
        },
        "constraints": {
            "fixed_bodies": [],
            "rigid_bodies": []
        },
        "steps": {
            "minimization": {
                "parameters": {"max_iterations": 1000},
                "output_pdb": "minimized.pdb"
            },
            "heating": {
                "parameters": {
                    "first_temp": 300,
                    "final_temp": 1500,
                    "total_steps": 15000,
                    "timestep": 0.001
                },
                "output_pdb": "heated.pdb",
                "output_restart": "heated.xml"
            },
            "md": {
                "parameters": {
                    "temperature": 1500,
                    "friction": 0.1,
                    "nsteps": 100000,
                    "timestep": 0.001
                },
                "rgyr": {
                    "rgs": [],
                    "k_rg": 1,
                    "report_interval": 500,
                    "filename": "rgyr_report.csv"
                },
                "output_pdb": "md.pdb",
                "pdb_report_interval": 500,
                "output_restart": "md.xml",
                "output_dcd": "md.dcd",
            }
        }
    }

    # Parse CHARMM-style constraints for fixed and rigid bodies
    
    fixed_bodies = []
    rigid_bodies = []
    with open(const_inp_path, "r") as f:
        for line in f:
            line = line.strip()
            # Fixed bodies
            m_fixed = re.match(r'define fixed(\d+) sele \( resid (\d+):(\d+) .and. segid (\w+) \) end', line)
            if m_fixed:
                idx, start, stop, segid = m_fixed.groups()
                fixed_bodies.append({
                    "name": f"FixedBody{idx}",
                    "chain_id": segid[-1],
                    "residues": {
                        "start": int(start),
                        "stop": int(stop)
                    }
                })
            # Rigid bodies
            m_rigid = re.match(r'define rigid(\d+) sele \( resid (\d+):(\d+) .and. segid (\w+) \) end', line)
            if m_rigid:
                idx, start, stop, segid = m_rigid.groups()
                rigid_bodies.append({
                    "name": f"RigidBody{idx}",
                    "chain_id": segid[-1],
                    "residues": {
                        "start": int(start),
                        "stop": int(stop)
                    }
                })

    # Merge into openmm_config
    openmm_config["constraints"]["fixed_bodies"] = fixed_bodies
    openmm_config["constraints"]["rigid_bodies"] = rigid_bodies

    # Compute Rg values for MD step
    
    rg_min = int(params.get("rg_min", 0))
    rg_max = int(params.get("rg_max", 0))
    N = int(params.get("rg_N", 10))  # Default to 10 values if not specified
    if rg_max > rg_min and N > 0:
        rgs = np.linspace(rg_min, rg_max, N)
        rgs = [int(round(rg)) for rg in rgs]
        openmm_config["steps"]["md"]["rgyr"]["rgs"] = rgs
    else:
        openmm_config["steps"]["md"]["rgyr"]["rgs"] = []

    # Write to config.yaml
    config_yaml_path = os.path.join(workdir, "openmm_config.yaml")
    with open(config_yaml_path, "w") as f:
        yaml.dump(openmm_config, f)
    print(f"OpenMM config written to {config_yaml_path}")
    return config_yaml_path

# -----------------------------
# Status File Creation
# -----------------------------
def create_status_file(workdir):
    status_file = os.path.join(workdir, "status.txt")
    steps = [
        "alphafold", "pae", "autorg", "minimize", "initfoxs", "heat", "md", "dcd2pdb", "foxs", "multifoxs", "copy2cfs"
    ]
    with open(status_file, "w") as f:
        for step in steps:
            f.write(f"{step}: Waiting\n")

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

def add_helper_functions():
    section  = """
# Updates our status.txt file using sed to update values
update_status() {
  local step=$1
  local status=$2
  echo "Update $step status: $status"
  # Use sed to update the status file
  sed -i "s/^$step: .*/$step: $status/" "$STATUS_FILE"
}

# Check exit code and cancel the SLURM job if non-zero
check_exit_code() {
  local exit_code=$1
  local step=$2
  if [ $exit_code -ne 0 ]; then
    echo "Process in $step failed with exit code $exit_code. Cancelling SLURM job."
    update_status $step Error
    scancel $SLURM_JOB_ID
    exit $exit_code
  fi
  }
"""
    return section

def generate_alphafold_section(config):
    # Generate AlphaFold section for Slurm script
    section = f"""
# --------------------------------------------------------------------------------------
# Run ColabFoldLocal (i.e AlphaFold)
update_status alphafold Running
echo "Running AlphaFold..."
srun --gpus=4 \\
     --job-name alphafold \\
     podman-hpc run --rm --gpu \\
        -v {config['workdir']}:/bilbomd/work \\
        -v {config['upload_dir']}:/cfs \\
        {config['af_worker']} /bin/bash -c "
            set -e
            cd /bilbomd/work/ &&
            colabfold_batch --num-models=3 --amber --use-gpu-relax --num-recycle=4 af-entities.fasta alphafold
        "
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
    section = f"""
# --------------------------------------------------------------------------------------
# OpenMM Minimization
update_status minimize Running
echo "Running OpenMM Minimization..."
srun --ntasks=1 \\
     --cpus-per-task={config['num_cores']} \\
     --gpus-per-task=1 \\
     --cpu-bind=cores \\
     --job-name minimize \\
     podman-hpc run --rm --gpu \\
        -v $WORKDIR:/bilbomd/work \\
        -v $UPLOAD_DIR:/cfs \\
        {config['openmm_worker']} /bin/bash -c "
            set -e
            cd /bilbomd/work/ && python /app/scripts/openmm/minimize.py openmm_config.yaml
        "
MIN_EXIT=$?
check_exit_code $MIN_EXIT minimize

echo "OpenMM Minimization complete"
update_status minimize Success
"""
    return section

def generate_heat_section(config):
    section = f"""
# --------------------------------------------------------------------------------------
# OpenMM Heating
update_status heat Running
echo "Running OpenMM Heating..."
srun --ntasks=1 \\
     --cpus-per-task={config['num_cores']} \\
     --gpus-per-task=1 \\
     --cpu-bind=cores \\
     --job-name heat \\
     podman-hpc run --rm --gpu \\
        -v $WORKDIR:/bilbomd/work \\
        -v $UPLOAD_DIR:/cfs \\
        {config['openmm_worker']} /bin/bash -c "
            set -e
            cd /bilbomd/work/ && python /app/scripts/openmm/heat.py openmm_config.yaml
        "
HEAT_EXIT=$?
check_exit_code $HEAT_EXIT heat

echo "OpenMM Heating complete"
update_status heat Success
"""
    return section

def generate_md_section(config):
    section = f"""
# --------------------------------------------------------------------------------------
# OpenMM Molecular Dynamics (all Rg values)
update_status md Running
echo "Running OpenMM MD for all Rg values..."
srun --ntasks=1 \\
     --cpus-per-task={config['num_cores']} \\
     --gpus-per-task=4 \\
     --cpu-bind=cores \\
     --job-name md \\
     podman-hpc run --rm --gpu \\
        -v $WORKDIR:/bilbomd/work \\
        -v $UPLOAD_DIR:/cfs \\
        {config['openmm_worker']} /bin/bash -c "
            set -e
            cd /bilbomd/work/ && python /app/scripts/openmm/md.py openmm_config.yaml
        "
MD_EXIT=$?
check_exit_code $MD_EXIT md

echo "OpenMM MD complete"
update_status md Success
"""
    return section

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

    # Step 4: Prepare OpenMM config from const.inp
    prepare_openmm_config(config['workdir'], params)

    # Step 5: Generate Slurm script sections
    slurm_sections = []
    slurm_sections.append(generate_slurm_header(config))
    slurm_sections.append(add_helper_functions())
    if params.get('job_type') == 'BilboMdAlphaFold':
        slurm_sections.append(generate_alphafold_section(config))
        slurm_sections.append(generate_pae2const_section(config))
    slurm_sections.append(generate_minimize_section(config))
    slurm_sections.append(generate_heat_section(config))
    slurm_sections.append(generate_md_section(config))
    slurm_sections.append(generate_foxs_section(config))
    slurm_sections.append(generate_multifoxs_section(config))
    slurm_sections.append(generate_copy_section(config))

    # Step 6: Write final Slurm file
    slurm_file = Path(config['workdir']) / 'bilbomd_omm.slurm'
    with open(slurm_file, 'w') as f:
        for section in slurm_sections:
            if section:
                f.write(section)
                f.write('\n')
    print(f"Slurm batch file written to {slurm_file}")

if __name__ == "__main__":
    main()