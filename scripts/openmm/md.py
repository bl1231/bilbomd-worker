"""run MD with CHARMM-like restraints"""

import sys
import os
import yaml
from copy import deepcopy
from openmm.unit import angstroms
from openmm.app import (
    Simulation,
    PDBFile,
    Modeller,
    ForceField,
    StateDataReporter,
    DCDReporter,
    CutoffNonPeriodic,
    HBonds
)
from openmm import VerletIntegrator, XmlSerializer, NonbondedForce
from utils.rigid_body import get_rigid_bodies, create_rigid_bodies
from utils.fixed_bodies import (apply_fixed_body_constraints)
from utils.rgyr import RadiusOfGyrationCVForce , RadiusOfGyrationReporter

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
    print(f"Rigid body '{name}': {len(atoms)} atoms — indices: {atoms[:10]}{'...' if len(atoms) > 10 else ''}")

# ⚙️ Build system
system = forcefield.createSystem(
    modeller.topology,
    nonbondedMethod=CutoffNonPeriodic,
    nonbondedCutoff=4*angstroms,
    constraints=None,
    soluteDielectric=1.0,
    solventDielectric=78.5,
    removeCMMotion=False

)

# 🔒 Apply 'cons fix': freeze atoms by setting mass = 0
# 🔒 Apply fixed body constraints to freeze the atoms.
print("Applying fixed body constraints...")
#apply_fixed_body_constraints_zero_mass(system, modeller, fixed_bodies_config)
apply_fixed_body_constraints(system, modeller, fixed_bodies_config)

# Apply rigid body constraints
print("Applying rigid body constraints...")
create_rigid_bodies(system, modeller.positions, list(rigid_bodies.values()))



rgs = config["steps"]["md"]["rgyr"]["rgs"]
k_rg = config["steps"]["md"]["rgyr"]["k_rg"]
report_interval = config["steps"]["md"]["rgyr"].get("report_interval", 500)
rgyr_report = config["steps"]["md"]["rgyr"].get("filename", "rg_report.csv")

timestep = config["steps"]["md"]["parameters"]["timestep"]
nsteps = config["steps"]["md"]["parameters"]["nsteps"]

atom_indices = [a.index for a in modeller.topology.atoms() if a.name == 'CA']

# for a in modeller.topology.atoms():
#     if a.name == 'CA':
#         print(f"Atom index: {a.index}, name: {a.name}, residue: {a.residue.name} {a.residue.index}, chain: {a.residue.chain.id}")

for rg in rgs:
    print(f"\n🔁 Running MD with Rg target: {rg} Å")
    system_copy = deepcopy(system)

    rg_force = RadiusOfGyrationCVForce(
        atom_indices=atom_indices,
        k_rg=k_rg*418.4,
        rg0=rg*0.1,
        weigh_by_mass=True,
        system=system_copy,
        force_group=1
    )
    system_copy.addForce(rg_force)

    # for i, force in enumerate(system_copy.getForces()):
    #     print(f"Force {i}: {force.__class__.__name__}, group {force.getForceGroup()}")

    integrator = VerletIntegrator(timestep)

    with open(os.path.join(heat_dir, heated_restart_file_name), encoding="utf-8") as f:
        state = XmlSerializer.deserialize(f.read())

    simulation = Simulation(modeller.topology, system_copy, integrator)
    simulation.context.setState(state)

    platform = simulation.context.getPlatform().getName()
    print(f"Initialized on platform: {platform}")

    rg_md_dir = os.path.join(md_dir, f"rg_{rg}")
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
    simulation.reporters.append(RadiusOfGyrationReporter(atom_indices, system_copy, rgyr_file_path, reportInterval=report_interval))
    # for i in atom_indices:
    #     print(f"Atom {i}: mass = {system.getParticleMass(i)}, virtual = {system.isVirtualSite(i) if hasattr(system, 'isVirtualSite') else 'n/a'}")
    simulation.step(nsteps)

    with open(os.path.join(rg_md_dir, output_restart_file_name), "w", encoding="utf-8") as f:
        final_state = simulation.context.getState(getPositions=True, getForces=True)
        f.write(XmlSerializer.serialize(final_state))

    with open(os.path.join(rg_md_dir, output_pdb_file_name), "w", encoding="utf-8") as out_pdb:
        PDBFile.writeFile(simulation.topology, final_state.getPositions(), out_pdb)

    print(f"✅ Completed MD with Rg {rg}. Results in {rg_md_dir}")
