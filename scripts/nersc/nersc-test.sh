#!/bin/bash -l

# This will be an arg at some point.
UUID='4c550332-9220-4ec4-8c07-2f92bf7e16e5'
project=m4659

# We may want to consider how we can get job params
# Can bilbomd-worker write a JSON file with needed params?

export CFSDIR=${CFS}/${project}/bilbomd-uploads/${UUID}
export WORKDIR=${PSCRATCH}/bilbmod/${UUID}
export TEMPLATEDIR=${CFS}/${project}/bilbomd-templates
export WORKER=bilbomd/bilbomd-worker:0.0.1

echo "---------------------------- START JOB PREP ----------------------------"
echo "Setup working directory & copy uploaded files to Perlmutter scratch"
mkdir -p $WORKDIR
if [ $? -eq 0 ]; then
    echo "Directory created successfully: $WORKDIR"
else
    echo "Failed to create directory: $WORKDIR" >&2
    exit 1
fi

cp $CFSDIR/* $WORKDIR
if [ $? -eq 0 ]; then
    echo "Files copied successfully from $CFSDIR to $WORKDIR"
else
    echo "Failed to copy files from $CFSDIR to $WORKDIR" >&2
    exit 1
fi

echo "Copy CHARMM input file templates"
cp $TEMPLATEDIR/minimize.inp $WORKDIR
cp $TEMPLATEDIR/heat.inp $WORKDIR
cp $TEMPLATEDIR/dynamics.inp $WORKDIR
if [ $? -eq 0 ]; then
    echo "Template files copied successfully from $CFSDIR to $WORKDIR"
else
    echo "Template failed to copy files from $CFSDIR to $WORKDIR" >&2
    exit 1
fi

echo "Preparing CHARMM input files..."
charmm_topo_dir="/app/scripts/bilbomd_top_par_files.str"
in_psf_file="bilbomd_pdb2crd.psf"
in_crd_file="bilbomd_pdb2crd.crd"
constinp="const.inp"

sed -i "s|{{charmm_topo_dir}}|$charmm_topo_dir|g" $WORKDIR/minimize.inp
sed -i "s|{{in_psf_file}}|$in_psf_file|g" $WORKDIR/minimize.inp
sed -i "s|{{in_crd_file}}|$in_crd_file|g" $WORKDIR/minimize.inp

sed -i "s|{{charmm_topo_dir}}|$charmm_topo_dir|g" $WORKDIR/heat.inp
sed -i "s|{{in_psf_file}}|$in_psf_file|g" $WORKDIR/heat.inp
sed -i "s|{{constinp}}|$constinp|g" $WORKDIR/heat.inp

# Function to generate a CHARMM input file from a template
generateInputFile() {
    local inp_file="$1"
    local inp_basename="$2"
    local rg_value="$3"

    # Copy the template file to the new input file
    cp "${WORKDIR}/dynamics.inp" "${WORKDIR}/${inp_file}"

    # Perform sed substitutions
    sed -i "s|{{charmm_topo_dir}}|${charmm_topo_dir}|g" "${WORKDIR}/${inp_file}"
    sed -i "s|{{in_psf_file}}|${in_psf_file}|g" "${WORKDIR}/${inp_file}"
    sed -i "s|{{constinp}}|${constinp}|g" "${WORKDIR}/${inp_file}"
    sed -i "s|{{rg}}|${rg_value}|g" "${WORKDIR}/${inp_file}"
    sed -i "s|{{inp_basename}}|${inp_basename}|g" "${WORKDIR}/${inp_file}"
}

echo "Calculate Rg values"
rg_min=37
rg_max=69
# Calculate the step size
step=$(($((rg_max - rg_min)) / 5))
step=$(( step > 0 ? step : 1 ))  # Ensuring that step is at least 1

# Base template for CHARMM files
charmm_template="dynamics"

rg_values=""
for (( rg=rg_min; rg<=rg_max; rg+=step )); do
    charmm_inp_file="${charmm_template}_rg${rg}.inp"
    inp_basename="${charmm_template}_rg${rg}"
    generateInputFile "$charmm_inp_file" "$inp_basename" "$rg"
    rg_values+="${rg}Å "
done

# Trim the trailing space and print all rg values on a single line
rg_values=$(echo "$rg_values" | sed 's/ $//')
echo "All Rg values: $rg_values"

echo "----------------------------- END JOB PREP -----------------------------"

cat << EOF > bilbomd.slurm
#!/bin/bash
#SBATCH --qos=debug
#SBATCH --nodes=1
#SBATCH --time=00:05:00
#SBATCH --licenses=cfs,scratch
#SBATCH --constraint=cpu
#SBATCH --account=m4659
#SBATCH --output=${WORKDIR}/slurm-%j.out
#SBATCH --error=${WORKDIR}/slurm-%j.err

# Convert PDB to CRD/PSF
# Creates individual CHARMM input files.
srun -n 1 podman-hpc run --rm --userns=keep-id --volume ${WORKDIR}:/bilbomd/work ${WORKER} /bin/bash -c \
    "cd /bilbomd/work/ && python /app/scripts/pdb2crd.py buy1.pdb . > pdb2crd_output.txt"

if [[ -f "\${WORKDIR}/pdb2crd_output.txt" ]]; then
    output=\$(cat "${WORKDIR}/pdb2crd_output.txt")
    echo "Captured Output:"
    echo "\$output"
else
    echo "Output file not found." >&2
    exit 1
fi

# Parse the output to get the names of the generated .inp files
inp_files=(\$(echo "\$output" | grep 'FILE_CREATED:' | awk '{print \$2}'))
if [[ \${#inp_files[@]} -eq 0 ]]; then
    echo "No input files were parsed, check the output for errors." >&2
    exit 1
fi

# Run CHARMM jobs for each .inp file
for inp_file in "\${inp_files[@]}"; do
    echo "Running CHARMM on \$inp_file..."
    srun -n 1 podman-hpc run --rm --userns=keep-id --volume "${WORKDIR}:/bilbomd/work" ${WORKER} /bin/bash -c \
        "cd /bilbomd/work && charmm -o \${inp_file%.inp}.log -i \$inp_file" &
done

# Wait for all background jobs to finish
wait

# Merge the multiple CRD files
echo "Merging CRD files..."
srun -n 1 podman-hpc run --rm --userns=keep-id --volume ${WORKDIR}:/bilbomd/work ${WORKER} /bin/bash -c "cd /bilbomd/work/ && charmm -o pdb2crd_charmm_meld.log -i pdb2crd_charmm_meld.inp"

# CHARMM minimize
echo "Running CHARMM minimize..."
srun -n 1 podman-hpc run --rm --userns=keep-id --volume ${WORKDIR}:/bilbomd/work ${WORKER} /bin/bash -c "cd /bilbomd/work/ && charmm -o minimize.log -i minimize.inp"

# CHARMM heat
echo "Running CHARMM heat..."
srun -n 1 podman-hpc run --rm --userns=keep-id --volume ${WORKDIR}:/bilbomd/work ${WORKER} /bin/bash -c "cd /bilbomd/work/ && charmm -o heat.log -i heat.inp"

# now things get a bit more complicated.
# Need dynamics_rg##.inp

# copy results back to CFS
echo "Copy results back to CFS"
cp -nR $WORKDIR/* $CFSDIR/
EOF

# sbatch bilbomd.slurm
