#!/bin/bash -l
#
#
# #############################################################################
# We will be calling this script from the NERSC Superfacility API
#
# POST to /compute/jobs/perlmutter
#
# curl -X 'POST' \
#   'https://api.nersc.gov/api/v1.2/compute/jobs/perlmutter' \
#   -H 'accept: application/json' \
#   -H 'Content-Type: application/x-www-form-urlencoded' \
#   -d 'isPath=true&job=%2Fglobal%2Fcfs%2Fcdirs%2Fbilbomd-scripts%2Frun.sh&args=string'
# #############################################################################

# This will be an arg at some point.
UUID='4c550332-9220-4ec4-8c07-2f92bf7e16e5'
project=m4659

export CFSDIR=${CFS}/${project}/bilbomd-uploads/${UUID}
export WORKDIR=${PSCRATCH}/bilbmod/${UUID}
export TEMPLATEDIR=${CFS}/${project}/bilbomd-templates
export WORKER=bilbomd/bilbomd-worker:0.0.1

# We need to consider how we get job params
# Maybe bilbomd-worker should write a JSON file with needed params.

# from job params
pdb_file='buy1.pdb'
saxs_dat=''
constinp="const.inp"

# other globals
g_md_inp_files=""
g_pdb2crd_inp_files=""
charmm_topo_dir="/app/scripts/bilbomd_top_par_files.str"
in_psf_file="bilbomd_pdb2crd.psf"
in_crd_file="bilbomd_pdb2crd.crd"


copyInputData() {
    cp $CFSDIR/* $WORKDIR
    if [ $? -eq 0 ]; then
        echo "Files copied successfully from $CFSDIR to $WORKDIR"
    else
        echo "Failed to copy files from $CFSDIR to $WORKDIR" >&2
        exit 1
    fi
}

createWorkingDirectory() {
    mkdir -p $WORKDIR
    if [ $? -eq 0 ]; then
        echo "Directory created successfully: $WORKDIR"
    else
        echo "Failed to create directory: $WORKDIR" >&2
        exit 1
    fi
}

copyTemplateFiles() {
    echo "Copy CHARMM input file templates"

    # Copy minimize.inp and check for errors
    cp $TEMPLATEDIR/minimize.inp $WORKDIR
    if [ $? -ne 0 ]; then
        echo "Failed to copy minimize.inp from $TEMPLATEDIR to $WORKDIR" >&2
        exit 1
    fi

    # Copy heat.inp and check for errors
    cp $TEMPLATEDIR/heat.inp $WORKDIR
    if [ $? -ne 0 ]; then
        echo "Failed to copy heat.inp from $TEMPLATEDIR to $WORKDIR" >&2
        exit 1
    fi

    # Copy dynamics.inp and check for errors
    cp $TEMPLATEDIR/dynamics.inp $WORKDIR
    if [ $? -ne 0 ]; then
        echo "Failed to copy dynamics.inp from $TEMPLATEDIR to $WORKDIR" >&2
        exit 1
    fi

    # Copy dcd2pdb.inp and check for errors
    cp $TEMPLATEDIR/dcd2pdb.inp $WORKDIR
    if [ $? -ne 0 ]; then
        echo "Failed to copy dcd2pdb.inp from $TEMPLATEDIR to $WORKDIR" >&2
        exit 1
    fi

    echo "Template files copied successfully from $TEMPLATEDIR to $WORKDIR"
}

processTemplateFiles() {
    echo "Preparing CHARMM input files..."

    # Prepare minimize.inp
    sed -i "s|{{charmm_topo_dir}}|$charmm_topo_dir|g" $WORKDIR/minimize.inp
    sed -i "s|{{in_psf_file}}|$in_psf_file|g" $WORKDIR/minimize.inp
    sed -i "s|{{in_crd_file}}|$in_crd_file|g" $WORKDIR/minimize.inp

    # Prepare heat.inp
    sed -i "s|{{charmm_topo_dir}}|$charmm_topo_dir|g" $WORKDIR/heat.inp
    sed -i "s|{{in_psf_file}}|$in_psf_file|g" $WORKDIR/heat.inp
    sed -i "s|{{constinp}}|$constinp|g" $WORKDIR/heat.inp
}

initializeJob() {
    echo "Initialize Job"
    createWorkingDirectory
    copyInputData
    copyTemplateFiles
    processTemplateFiles
}

generateMDInputFile() {
    local inp_file="$1"
    local inp_basename="$2"
    local rg_value="$3"
    local conf_sample=4
    local timestep=0.001

    # Copy the template file to the new input file
    cp "${WORKDIR}/dynamics.inp" "${WORKDIR}/${inp_file}"
    echo "Generate a CHARMM MD input file ${inp_file} from a template"
    # Perform sed substitutions
    sed -i "s|{{charmm_topo_dir}}|${charmm_topo_dir}|g" "${WORKDIR}/${inp_file}"
    sed -i "s|{{in_psf_file}}|${in_psf_file}|g" "${WORKDIR}/${inp_file}"
    sed -i "s|{{constinp}}|${constinp}|g" "${WORKDIR}/${inp_file}"
    sed -i "s|{{rg}}|${rg_value}|g" "${WORKDIR}/${inp_file}"
    sed -i "s|{{inp_basename}}|${inp_basename}|g" "${WORKDIR}/${inp_file}"
    sed -i "s|{{conf_sample}}|${conf_sample}|g" "${WORKDIR}/${inp_file}"
    sed -i "s|{{timestep}}|${timestep}|g" "${WORKDIR}/${inp_file}"
}

generatePdb2CrdInputFile() {
    local pdb_file="$1"
    local command="cd /bilbomd/work/ && python /app/scripts/pdb2crd.py $pdb_file . > pdb2crd_output.txt"
    podman-hpc run --rm --userns=keep-id --volume ${WORKDIR}:/bilbomd/work ${WORKER} /bin/bash -c "$command"
    if [[ -f "${WORKDIR}/pdb2crd_output.txt" ]]; then
        local output=$(cat "${WORKDIR}/pdb2crd_output.txt")
    else
        echo "Output file not found." >&2
        exit 1
    fi
    # Parse the output to get the names of the generated .inp files
    g_pdb2crd_inp_files=($(echo "$output" | grep 'FILE_CREATED:' | awk '{print $2}'))
    if [[ ${#g_pdb2crd_inp_files[@]} -eq 0 ]]; then
        echo "No input files were parsed, check the output for errors." >&2
        exit 1
    fi
}

calculateRgValues() {
    echo "Calculate Rg values"
    local rg_min=37
    local rg_max=69
    # Calculate the step size
    local step=$(($((rg_max - rg_min)) / 5))
    local step=$(( step > 0 ? step : 1 ))  # Ensuring that step is at least 1

    # Base template for CHARMM files
    local charmm_template="dynamics"

    for (( rg=rg_min; rg<=rg_max; rg+=step )); do
        local charmm_inp_file="${charmm_template}_rg${rg}.inp"
        local inp_basename="${charmm_template}_rg${rg}"
        generateMDInputFile "$charmm_inp_file" "$inp_basename" "$rg"
        g_md_inp_files+="${charmm_inp_file} "
    done

    # Trim the trailing space
    g_md_inp_files=$(echo "$g_md_inp_files" | sed 's/ $//')
    # echo "MD input files: $g_md_inp_files"
}

generateDCD2PDBInputFiles() {
    echo "make em"

}

generate_header_section() {
    cat << EOF > header
#!/bin/bash
#SBATCH --qos=regular
#SBATCH --nodes=6
#SBATCH --time=00:40:00
#SBATCH --licenses=cfs,scratch
#SBATCH --constraint=cpu
#SBATCH --account=m4659
#SBATCH --output=${WORKDIR}/slurm-%j.out
#SBATCH --error=${WORKDIR}/slurm-%j.err

EOF
}

generate_pdb2crd_section() {
    cat << EOF > pdb2crd
# #####################################
# Convert PDB to CRD/PSF
EOF
    generatePdb2CrdInputFile $pdb_file
    for inp in "${g_pdb2crd_inp_files[@]}"; do
    echo "echo \"Starting $inp\"" >> pdb2crd
        local command="cd /bilbomd/work && charmm -o ${inp%.inp}.log -i ${inp}"
        echo "srun -n 1 podman-hpc run --rm --userns=keep-id --volume ${WORKDIR}:/bilbomd/work ${WORKER} /bin/bash -c \"$command\" &" >> pdb2crd
    done
    echo "" >> pdb2crd
    echo "# Wait for all PDB to CRD jobs to finish" >> pdb2crd
    echo "wait" >> pdb2crd
    echo "" >> pdb2crd
    echo "# Meld all individual CRD files" >> pdb2crd
    echo "echo \"Melding pdb2crd_charmm_meld.inp\"" >> pdb2crd
    local command="cd /bilbomd/work/ && charmm -o pdb2crd_charmm_meld.log -i pdb2crd_charmm_meld.inp"
    echo "srun -n 1 podman-hpc run --rm --userns=keep-id --volume ${WORKDIR}:/bilbomd/work ${WORKER} /bin/bash -c \"$command\"" >> pdb2crd
    echo "" >> pdb2crd
}

generate_min_heat_section(){
    cat << EOF > minheat
# #####################################
# CHARMM minimize
echo "Running CHARMM minimize..."
srun -n 1 podman-hpc run --rm --userns=keep-id --volume ${WORKDIR}:/bilbomd/work ${WORKER} /bin/bash -c "cd /bilbomd/work/ && charmm -o minimize.log -i minimize.inp"

# #####################################
# CHARMM heat
echo "Running CHARMM heat..."
srun -n 1 podman-hpc run --rm --userns=keep-id --volume ${WORKDIR}:/bilbomd/work ${WORKER} /bin/bash -c "cd /bilbomd/work/ && charmm -o heat.log -i heat.inp"

EOF
}

generate_dynamics_section() {
    cat << EOF > dynamics
# #####################################
# CHARMM Molecular Dynamics
EOF
    for inp in $g_md_inp_files; do
        echo "echo \"Starting $inp\"" >> dynamics
        echo "srun -n 1 podman-hpc run --rm --userns=keep-id --volume ${WORKDIR}:/bilbomd/work ${WORKER} /bin/bash -c \"cd /bilbomd/work/ && charmm -o ${inp%.inp}.log -i $inp\" &" >> dynamics
    done
    echo "" >> dynamics
    echo "# Wait for all dynamics jobs to finish" >> dynamics
    echo "wait" >> dynamics
    echo "" >> dynamics
    echo "# Copy results back to CFS" >> dynamics
    echo "echo \"Copying results back to CFS...\"" >> dynamics
    echo "cp -nR $WORKDIR/* $CFSDIR/" >> dynamics
}

echo "---------------------------- START JOB PREP ----------------------------"
echo "----------------- ${UUID} -----------------"
initializeJob
calculateRgValues
generate_header_section
generate_pdb2crd_section
generate_min_heat_section
generate_dynamics_section

cat header pdb2crd minheat dynamics > bilbomd.slurm

rm header pdb2crd minheat dynamics
echo "----------------------------- END JOB PREP -----------------------------"

# sbatch bilbomd.slurm
