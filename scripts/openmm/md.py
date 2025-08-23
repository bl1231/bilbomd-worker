"""run MD with CHARMM-like restraints"""

import sys
import os
import time
import yaml

# from copy import deepcopy
from openmm.unit import angstroms
from openmm.app import (
    Simulation,
    PDBFile,
    Modeller,
    ForceField,
    StateDataReporter,
    DCDReporter,
    CutoffNonPeriodic,
)
from openmm import VerletIntegrator, XmlSerializer, RGForce, CustomCVForce
from utils.rigid_body import get_rigid_bodies, create_rigid_bodies
from utils.fixed_bodies import apply_fixed_body_constraints
from utils.pdb_writer import PDBFrameWriter

if len(sys.argv) != 2:
    print("Usage: python md.py <config.yaml>")
    sys.exit(1)

config_path = sys.argv[1]
with open(config_path, "r", encoding="utf-8") as f:
    config = yaml.safe_load(f)

# Build output directories:
output_dir = config["output"]["output_dir"]
min_dir = os.path.join(output_dir, config["output"]["min_dir"])
heat_dir = os.path.join(output_dir, config["output"]["heat_dir"])
md_dir = os.path.join(output_dir, config["output"]["md_dir"])

heated_pdb_file_name = config["steps"]["heating"]["output_pdb"]
heated_restart_file_name = config["steps"]["heating"]["output_restart"]

output_pdb_file_name = config["steps"]["md"]["output_pdb"]
output_restart_file_name = config["steps"]["md"]["output_restart"]
output_dcd_file_name = config["steps"]["md"]["output_dcd"]


for d in [output_dir, min_dir, heat_dir, md_dir]:
    if not os.path.exists(d):
        os.makedirs(d)

# Load heated structure
input_pdb_file = os.path.join(heat_dir, heated_pdb_file_name)
pdb = PDBFile(file=input_pdb_file)

forcefield = ForceField(*config["input"]["forcefield"])
modeller = Modeller(pdb.topology, pdb.positions)

fixed_bodies_config = config["constraints"]["fixed_bodies"]
rigid_bodies_configs = config["constraints"]["rigid_bodies"]

# Get all rigid bodies from the modeller based on our configurations.
rigid_bodies = get_rigid_bodies(modeller, rigid_bodies_configs)

for name, atoms in rigid_bodies.items():
    print(
        f"Rigid body '{name}': {len(atoms)} atoms — indices: {atoms[:10]}{'...' if len(atoms) > 10 else ''}"
    )

# ⚙️ Build system
system = forcefield.createSystem(
    modeller.topology,
    nonbondedMethod=CutoffNonPeriodic,
    nonbondedCutoff=4 * angstroms,
    constraints=None,
    soluteDielectric=1.0,
    solventDielectric=78.5,
    removeCMMotion=False,
)

# 🔒 Apply 'cons fix': freeze atoms by setting mass = 0
# 🔒 Apply fixed body constraints to freeze the atoms.
print("Applying fixed body constraints...")
# apply_fixed_body_constraints_zero_mass(system, modeller, fixed_bodies_config)
apply_fixed_body_constraints(system, modeller, fixed_bodies_config)

# Apply rigid body constraints
print("Applying rigid body constraints...")
create_rigid_bodies(system, modeller.positions, list(rigid_bodies.values()))


rgs = config["steps"]["md"]["rgyr"]["rgs"]
k_rg_yaml = float(config["steps"]["md"]["rgyr"]["k_rg"])  # kcal/mol/Å^2 from YAML
timestep = float(config["steps"]["md"]["parameters"]["timestep"])
nsteps = int(config["steps"]["md"]["parameters"]["nsteps"])
pdb_report_interval = int(config["steps"]["md"]["pdb_report_interval"])
report_interval = int(config["steps"]["md"]["rgyr"]["report_interval"])
rgyr_report = config["steps"]["md"]["rgyr"]["filename"]
# Allow overriding the target Rg from environment for parallel runs
rg_env = os.environ.get("OMM_RG")
rg = float(rg_env) if rg_env is not None else float(rgs[0])
print(f"\n🔁 Running MD with Rg target: {rg} Å")

rg_force = RGForce()
# Convert kcal/mol/Å^2 → kJ/mol/nm^2 (4.184 kJ/kcal and 1 Å^2 = 0.01 nm^2 ⇒ × 418.4)
k_rg = k_rg_yaml * 418.4
rg0 = rg * 0.1  # Å → nm
cv = CustomCVForce("0.5 * k * (rg - rg0)^2")
cv.addCollectiveVariable("rg", rg_force)
cv.addGlobalParameter("k", k_rg)
cv.addGlobalParameter("rg0", rg0)

system.addForce(cv)

integrator = VerletIntegrator(timestep)

with open(os.path.join(heat_dir, heated_restart_file_name), encoding="utf-8") as f:
    state = XmlSerializer.deserialize(f.read())

simulation = Simulation(modeller.topology, system, integrator)
simulation.context.setState(state)

platform = simulation.context.getPlatform().getName()
print(f"Initialized on platform: {platform}")

rg_label = str(int(rg)) if float(rg).is_integer() else str(rg)
rg_md_dir = os.path.join(md_dir, f"rg_{rg_label}")
os.makedirs(rg_md_dir, exist_ok=True)

simulation.reporters = []
simulation.reporters.append(
    StateDataReporter(
        sys.stdout,
        report_interval,
        step=True,
        temperature=True,
        potentialEnergy=True,
        totalEnergy=True,
        speed=True,
    )
)
dcd_file_path = os.path.join(rg_md_dir, output_dcd_file_name)
rgyr_file_path = os.path.join(rg_md_dir, rgyr_report)
simulation.reporters.append(DCDReporter(dcd_file_path, report_interval))
base_name = os.path.splitext(output_pdb_file_name)[0]
simulation.reporters.append(
    PDBFrameWriter(rg_md_dir, base_name, reportInterval=pdb_report_interval)
)
simulation.step(nsteps)

with open(
    os.path.join(rg_md_dir, output_restart_file_name), "w", encoding="utf-8"
) as f:
    final_state = simulation.context.getState(getPositions=True, getForces=True)
    f.write(XmlSerializer.serialize(final_state))

with open(
    os.path.join(rg_md_dir, output_pdb_file_name), "w", encoding="utf-8"
) as out_pdb:
    PDBFile.writeFile(simulation.topology, final_state.getPositions(), out_pdb)

print(f"✅ Completed MD with Rg {rg}. Results in {rg_md_dir}")
