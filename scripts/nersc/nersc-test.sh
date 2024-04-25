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
conf_sample=4

# other globals
g_md_inp_files=""
g_pdb2crd_inp_files=""
g_rgs=""
g_dcd2pdb_inp_files=""
charmm_topo_dir="/app/scripts/bilbomd_top_par_files.str"
in_psf_file="bilbomd_pdb2crd.psf"
in_crd_file="bilbomd_pdb2crd.crd"
foxs_rg="foxs_rg.out"


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

initialize_job() {
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

calculate_rg_values() {
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
        g_rgs+="${rg} "
    done

    # Trim the trailing space
    g_md_inp_files=$(echo "$g_md_inp_files" | sed 's/ $//')
    # echo "MD input files: $g_md_inp_files"
}

template_dcd2pdb_file() {
    local inp_file="$1"
    local basename="$2"
    local rg="$3"
    local run="$4"
    local foxs_run_dir="rg${rg}_run${run}"
    local in_dcd="dynamics_rg${rg}_run${run}.dcd"
    cp "${WORKDIR}/dcd2pdb.inp" "${WORKDIR}/${inp_file}"
    sed -i "s|{{charmm_topo_dir}}|${charmm_topo_dir}|g" "${WORKDIR}/${inp_file}"
    sed -i "s|{{in_psf_file}}|${in_psf_file}|g" "${WORKDIR}/${inp_file}"
    sed -i "s|{{in_dcd}}|${in_dcd}|g" "${WORKDIR}/${inp_file}"
    sed -i "s|{{run}}|${foxs_run_dir}|g" "${WORKDIR}/${inp_file}"
    sed -i "s|{{inp_basename}}|${basename}|g" "${WORKDIR}/${inp_file}"
    sed -i "s|{{foxs_rg}}|${foxs_rg}|g" "${WORKDIR}/${inp_file}"
    # make all teh FoXS output directories where we will extrac PDBs from the DCD
    mkdir -p $WORKDIR/foxs/$foxs_run_dir
    # Since CHARMM is always appending to this file we need to create it first.
    touch $WORKDIR/${foxs_rg}

}

generate_dcd2pdb_input_files() {
    echo "----------"
    for rg in $g_rgs; do
        for ((run=1;run<=${conf_sample};run+=1));do
            dcd2pdb_inp_filename="dcd2pdb_rg${rg}_run${run}.inp"
            dcd2pdb_inp_filebasename="${dcd2pdb_inp_filename%.inp}"
            # echo "fn: ${dcd2pdb_inp_filename} bn: ${dcd2pdb_inp_filebasename} rg: ${rg} run: ${run}" 
            template_dcd2pdb_file "$dcd2pdb_inp_filename" "$dcd2pdb_inp_filebasename" "$rg" "$run"
            g_dcd2pdb_inp_files+="${dcd2pdb_inp_filename} "
        done
    done

}

generate_header_section() {
    cat << EOF > header
#!/bin/bash
#SBATCH --qos=regular
#SBATCH --nodes=24
#SBATCH --time=01:00:00
#SBATCH --licenses=cfs,scratch
#SBATCH --constraint=cpu
#SBATCH --account=m4659
#SBATCH --output=${WORKDIR}/slurm-%j.out
#SBATCH --error=${WORKDIR}/slurm-%j.err
#SBATCH --mail-type=BEGIN,END,FAIL
#SBATCH --mail-user=sclassen@lbl.gov

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

}

generate_dcd2pdb_section() {
    cat << EOF > dcd2pdb
# #####################################
# CHARMM Extract PDB from DCD Trajectories
EOF
    for inp in $g_dcd2pdb_inp_files; do
        echo "echo \"Starting $inp\"" >> dcd2pdb
        echo "srun -n 1 podman-hpc run --rm --userns=keep-id --volume ${WORKDIR}:/bilbomd/work ${WORKER} /bin/bash -c \"cd /bilbomd/work/ && charmm -o ${inp%.inp}.log -i $inp\" &" >> dcd2pdb
    done
    echo "" >> dcd2pdb
    echo "# Wait for all dcd2pdb jobs to finish" >> dcd2pdb
    echo "wait" >> dcd2pdb
    echo "" >> dcd2pdb
}

generate_end_section() {
    cat << EOF > endsection
# #####################################
# Copy results back to CFS
EOF
    echo "echo \"Copying results back to CFS...\"" >> endsection
    echo "cp -nR $WORKDIR/* $CFSDIR/" >> endsection
    echo "" >> endsection
}

echo "---------------------------- START JOB PREP ----------------------------"
echo "----------------- ${UUID} -----------------"
initialize_job
calculate_rg_values
generate_dcd2pdb_input_files
generate_header_section
generate_pdb2crd_section
generate_min_heat_section
generate_dynamics_section
generate_dcd2pdb_section
generate_end_section


cat header pdb2crd minheat dynamics dcd2pdb endsection > bilbomd.slurm

rm header pdb2crd minheat dynamics dcd2pdb endsection
echo "----------------------------- END JOB PREP -----------------------------"

sbatch bilbomd.slurm
