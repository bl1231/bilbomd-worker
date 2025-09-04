"""run OpenMM Molecular Dynamics with CHARMM-like restraints"""

import sys
import os
import yaml
from concurrent.futures import ThreadPoolExecutor   # ⬅️ use threads, not processes
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
from openmm import VerletIntegrator, XmlSerializer, RGForce, CustomCVForce, Platform
from utils.rigid_body import get_rigid_bodies, create_rigid_bodies
from utils.fixed_bodies import apply_fixed_body_constraints
from utils.pdb_writer import PDBFrameWriter
from utils.rgyr import RadiusOfGyrationReporter

def run_md_for_rg(rg, config_path, gpu_id=None):
    """
    Run a single MD trajectory targeting radius-of-gyration `rg` (Å).
    If `gpu_id` is provided, bind the Simulation to that CUDA device.
    """

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
            os.makedirs(d, exist_ok=True)

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
            f"[GPU {gpu_id}] Rigid body '{name}': {len(atoms)} atoms — indices: "
            f"{atoms[:10]}{'...' if len(atoms) > 10 else ''}"
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

    # 🔒 Apply fixed body constraints and rigid bodies
    print(f"[GPU {gpu_id}] Applying fixed body constraints...")
    apply_fixed_body_constraints(system, modeller, fixed_bodies_config)

    print(f"[GPU {gpu_id}] Applying rigid body constraints...")
    create_rigid_bodies(system, modeller.positions, list(rigid_bodies.values()))

    # ⛓️ RG restraint
    k_rg_yaml = float(config["steps"]["md"]["rgyr"]["k_rg"])  # kcal/mol/Å^2 from YAML
    timestep = float(config["steps"]["md"]["parameters"]["timestep"])
    nsteps = int(config["steps"]["md"]["parameters"]["nsteps"])
    pdb_report_interval = int(config["steps"]["md"]["pdb_report_interval"])
    report_interval = int(config["steps"]["md"]["rgyr"]["report_interval"])
    rgyr_report = config["steps"]["md"]["rgyr"]["filename"]
    print(f"\n[GPU {gpu_id}] 🔁 Running MD with Rg target: {rg} Å")

    rg_force = RGForce()
    # Convert kcal/mol/Å^2 → kJ/mol/nm^2
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

    # Prefer CUDA and pin to a device if provided
    try:
        cuda_platform = Platform.getPlatformByName("CUDA")
        platform_props = {}
        if gpu_id is not None:
            # Bind this Simulation to a specific GPU on the node
            platform_props["CudaDeviceIndex"] = str(gpu_id)
            # Optional: Perlmutter A100s are great with mixed/single
            # platform_props["CudaPrecision"] = "single"  # or "mixed"
        simulation = Simulation(modeller.topology, system, integrator, cuda_platform, platform_props)
        simulation.context.setState(state)
        platform = simulation.context.getPlatform().getName()
        print(f"[GPU {gpu_id}] Initialized on platform: {platform} (CudaDeviceIndex={platform_props.get('CudaDeviceIndex','-')})")
    except Exception as e:
        print(f"[GPU {gpu_id}] [WARNING] CUDA not available; falling back. Error: {e}")
        simulation = Simulation(modeller.topology, system, integrator)
        simulation.context.setState(state)
        platform = simulation.context.getPlatform().getName()
        print(f"[GPU {gpu_id}] Initialized on platform: {platform}")

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

    # Radius of Gyration Reporter
    atom_indices = [a.index for a in modeller.topology.atoms() if a.name == 'CA']
    simulation.reporters.append(RadiusOfGyrationReporter(atom_indices, system, rgyr_file_path, reportInterval=report_interval))

    # PDB Frame Writer
    base_name = os.path.splitext(output_pdb_file_name)[0]
    simulation.reporters.append(PDBFrameWriter(rg_md_dir, base_name, reportInterval=pdb_report_interval))

    simulation.step(nsteps)

    with open(os.path.join(rg_md_dir, output_restart_file_name), "w", encoding="utf-8") as f:
        final_state = simulation.context.getState(getPositions=True, getForces=True)
        f.write(XmlSerializer.serialize(final_state))

    with open(os.path.join(rg_md_dir, output_pdb_file_name), "w", encoding="utf-8") as out_pdb:
        PDBFile.writeFile(simulation.topology, final_state.getPositions(), out_pdb)

    print(f"[GPU {gpu_id}] ✅ Completed MD with Rg {rg}. Results in {rg_md_dir}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python md.py <config.yaml>")
        sys.exit(1)

    config_path = sys.argv[1]
    with open(config_path, "r", encoding="utf-8") as f:
        config = yaml.safe_load(f)

    rgs = list(config["steps"]["md"]["rgyr"]["rgs"])
    if not rgs:
        print("No Rg targets provided.")
        sys.exit(1)

    # Map Rgs to available GPUs in a round-robin fashion (0..3)
    gpu_ids = [0, 1, 2, 3]
    assignments = [(rg, gpu_ids[i % len(gpu_ids)]) for i, rg in enumerate(rgs)]

    print("Assignments:", ", ".join([f"Rg={rg}→GPU{gid}" for rg, gid in assignments]))

    # Run up to 8 jobs concurrently
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = [pool.submit(run_md_for_rg, rg, config_path, gid) for rg, gid in assignments]
        for fut in futures:
            fut.result()  # bubble exceptions