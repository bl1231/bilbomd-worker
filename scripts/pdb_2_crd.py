"""
Splits a PDB file into several, each containing one chain. \
Translate the PDB to CHARMM CRD and PSF file 

Usage:
    python pdb_2_crd.py <pdb file>

Example:
    python pdb_2_crd.py alphafold_rank1.pdb

"""

import argparse

BASENAME = "chain"

__author__ = "MH"
__email__ = "mhammel@lbl.gov"

USAGE = __doc__.format(__author__, __email__)


def delete_water(fhandel):
    """
    Delete waters
    """
    with open(file=fhandel, mode="r", encoding="utf8") as fh:
        lines = fh.readlines()
        filtered_lines = [line for line in lines if "HOH" not in line[17:20]]

    with open(file=fhandel, mode="w", encoding="utf8") as fh2:
        fh2.writelines(filtered_lines)


def split_chain(fhandle):
    """
    Split the PDB ATOM into its different chains.
    """

    chain_data = {}  # {chain_id: lines}
    prev_chain = None
    chain_ids = None
    records = ("ATOM", "TER")
    protein_residues = [
        "ALA",
        "ARG",
        "ASN",
        "ASP",
        "CYS",
        "GLN",
        "GLU",
        "GLY",
        "HIS",
        "ILE",
        "LEU",
        "LYS",
        "MET",
        "PHE",
        "PRO",
        "SER",
        "THR",
        "TRP",
        "TYR",
        "VAL",
    ]
    dna_residues = ["DA", "DT", "DC", "DG"]
    rna_residues = ["A", "U", "C", "G"]
    carb_residues = [
        "AFL",
        "ALL",
        "BMA",
        "BGC",
        "BOG",
        "FCA",
        "FCB",
        "FMF",
        " FUC",
        "FUL",
        "G4S",
        "GAL",
        "GLA",
        "GLB",
        "GLC",
        "GLS",
        "GSA",
        "LAK",
        "LAT",
        "MAF",
        "MAL",
        "NAG",
        "NAN",
        "NGA",
        "SIA",
        "SLB",
    ]

    chain_ids = []
    with open(file=fhandle, mode="r", encoding="utf8") as infile:
        for line in infile:
            if line.startswith(records):
                line_chain = line[21]
                if line_chain != prev_chain:
                    if line_chain not in chain_data:
                        chain_data[line_chain] = []
                    prev_chain = line_chain
                chain_data[line_chain].append(line)

        for chain_id in sorted(chain_data.keys()):

            protein_present = False
            dna_present = False
            rna_present = False
            carb_present = False
            lines = chain_data[chain_id]
            for line in lines:
                if line.startswith(records):
                    # Extract the residue name from the line
                    residue_name = line[17:20].strip()
                    # Check if the residue name belongs to any of the lists
                    if residue_name in protein_residues:
                        protein_present = True
                    if residue_name in dna_residues:
                        dna_present = True
                    if residue_name in rna_residues:
                        rna_present = True
                    if residue_name in carb_residues:
                        carb_present = True

            # Print the identified biomolecule types
            if protein_present:
                chain_id = chain_id.lower()
                chain_id_new = "pro" + chain_id
                chain_ids.append(chain_id_new)
                file_pdb = BASENAME + "_" + chain_id_new + ".pdb"
                file_pdb = file_pdb.lower()
                with open(file=file_pdb, mode="w", encoding="utf8") as fh:
                    fh.write("".join(lines))
            elif dna_present:
                chain_id = chain_id.lower()
                chain_id_new = "dna" + chain_id
                chain_ids.append(chain_id_new)
                file_pdb = BASENAME + "_" + chain_id_new + ".pdb"
                file_pdb = file_pdb.lower()
                with open(file=file_pdb, mode="w", encoding="utf8") as fh:
                    fh.write("".join(lines))
            elif rna_present:
                chain_id = chain_id.lower()
                chain_id_new = "rna" + chain_id
                chain_ids.append(chain_id_new)
                file_pdb = BASENAME + "_" + chain_id_new + ".pdb"
                file_pdb = file_pdb.lower()
                with open(file=file_pdb, mode="w", encoding="utf8") as fh:
                    fh.write("".join(lines))
            elif carb_present:
                chain_id = chain_id.lower()
                chain_id_new = "car" + chain_id
                chain_ids.append(chain_id_new)
                file_pdb = BASENAME + "_" + chain_id_new + ".pdb"
                file_pdb = file_pdb.lower()
                with open(file=file_pdb, mode="w", encoding="utf8") as fh:
                    fh.write("".join(lines))
    return chain_ids


def split_chain_hetatm(fhandle):
    """
    Split the HEATM into its different chains.
    Writes a new file to the disk for each chain. Non-record lines are
    """

    chain_data = {}  # {chain_id: lines}
    prev_chain = None
    chain_ids = None
    records = ("HETATM", "TER")
    carb_residues = [
        "NAG",
        "BMA",
        "MAN",
        "GAL",
        "FUL",
        "FUC",
        "AFL",
        "RIB",
        " GLC",
        "ALT",
        "ALL",
        "GUL",
        "BGC",
        "IDO",
        "TAL",
        "XYL",
        "RHM",
        "XYL",
        "SIA",
        "HEM",
    ]
    chain_ids = []
    with open(file=fhandle, mode="r", encoding="utf8") as infile:
        for line in infile:
            if line.startswith(records):
                line_chain = line[21]
                if line_chain != prev_chain:
                    if line_chain not in chain_data:
                        chain_data[line_chain] = []
                    prev_chain = line_chain
                chain_data[line_chain].append(line)

        for chain_id in sorted(chain_data.keys()):
            carb_present = False
            lines = chain_data[chain_id]
            for line in lines:
                if line.startswith(records):
                    # Extract the residue name from the line
                    residue_name = line[17:20].strip()
                    if residue_name in carb_residues:
                        carb_present = True
            # Print the identified biomolecule types
            if carb_present:
                if chain_id.islower():
                    chain_id_new = "cal" + chain_id
                    chain_id_new = chain_id_new.lower()
                else:
                    chain_id_new = "car" + chain_id
                    chain_id_new = chain_id_new.lower()
                chain_ids.append(chain_id_new)
                file_pdb = BASENAME + "_" + chain_id_new + ".pdb"
                file_pdb = file_pdb.lower()
                with open(file_pdb, "w") as fh:
                    fh.write("".join(lines))

                with open(file_pdb, "r") as infile:
                    lines = infile.readlines()
                    modified_lines = [
                        line.replace("HETATM", "ATOM  ") for line in lines
                    ]
                with open(file_pdb, "w") as fh2:
                    fh2.writelines(modified_lines)
    return chain_ids


def renumbering(chain_ids):
    for chain_id in chain_ids:
        file_pdb = BASENAME + "_" + chain_id + ".pdb"
        file_pdb = file_pdb.lower()
        data = {}
        with open(file_pdb, "r") as fh:
            lines = fh.readlines()
            prev_resid = None
            resid = 0
            data = []
            for line in lines:
                if line.startswith("ATOM") or line.startswith("HETATM"):
                    line_resuid = line[17:27]
                    if line_resuid != prev_resid:
                        prev_resid = line_resuid
                        resid += 1
                    data.append(line[:22] + str(resid).rjust(4) + line[26:])
                else:
                    data.append(line)

            with open(file_pdb, "w") as fh2:
                fh2.write("".join(data))


def change_resid_names(chain_ids):
    for chain_id in chain_ids:
        file_pdb = BASENAME + "_" + chain_id + ".pdb"
        file_pdb = file_pdb.lower()
        modify_lines = []
        with open(file_pdb, "r") as fh:
            for line in fh:
                line = line.replace("HIS", "HSD")
                line = line.replace("   C ", " CYT ")
                line = line.replace("   G ", " GUA ")
                line = line.replace("   A ", " ADE ")
                line = line.replace("   U ", " URA ")
                line = line.replace("  DC ", " CYT ")
                line = line.replace("  DG ", " GUA ")
                line = line.replace("  DA ", " ADE ")
                line = line.replace("  DT ", " THY ")
                line = line.replace("NAG ", "BGLC")
                line = line.replace("BMA ", "BMAN")
                line = line.replace("MAN ", "AMAN")

                line = line.replace("GAL ", "AGAL")
                line = line.replace("FUL ", "BFUC")
                line = line.replace("FUC ", "AFUC")
                line = line.replace("AFL ", "AFUC")
                line = line.replace("RIB ", "ARIB")
                line = line.replace("GLC ", "AGLC")
                line = line.replace("ALT ", "AALT")
                line = line.replace("ALL ", "AALL")
                line = line.replace("GUL ", "AGUL")
                line = line.replace("BGC ", "BGUL")
                line = line.replace("IDO ", "AIDO")
                line = line.replace("TAL ", "ATAL")
                line = line.replace("XYL ", "AXYL")
                line = line.replace("RHM ", "ARHM")

                line = line.replace("XYL ", "AXYL")
                line = line.replace("SIA ", "BSIA")
                line = line.replace("HEM ", "HEME")

                modify_lines.append(line)

        with open(file_pdb, "w") as fh2:
            fh2.writelines(modify_lines)


def write_pdb_2_crd_inp_file(chain_ids):
    """
    Writes a CHARMM-compatable pdb_2_crd.inp file.
    """
    with open(file="pdb_2_crd.inp", mode="w", encoding="utf8") as outfile:

        outfile.write("* PURPOSE: Convert PDB file to CRD and PSF\n")
        outfile.write("* AUTHOR: Michal Hammel\n")
        outfile.write("* AUTHOR: Scott Classen\n")
        outfile.write("*\n")
        outfile.write("\n")
        outfile.write("bomlev -2\n")
        outfile.write("\n")
        outfile.write("STREAM /home/mhammel/pae_to_domains/charmm_reader/toppar.str\n")

        for chain_id in chain_ids:
            file_pdb = BASENAME + "_" + chain_id + ".pdb"
            file_pdb = file_pdb.lower()
            chain_id = chain_id.upper()
            if chain_id.startswith("PRO"):
                outfile.write(f"open read unit 12 card name  {file_pdb}\n")
                outfile.write("read sequ pdb unit 12\n")
                outfile.write(f"generate {chain_id} setup warn first NONE last CTER\n")
                outfile.write("rewind unit 12\n")
                outfile.write("read coor pdb unit 12 append\n")
                outfile.write("hbuild sele hydrogen end\n")
                outfile.write("close unit 12\n")
                outfile.write("\n")
            elif chain_id.startswith("DNA") or chain_id.startswith("RNA"):
                outfile.write(f"open read unit 12 card name  {file_pdb}\n")
                outfile.write("read sequ pdb unit 12\n")
                outfile.write(f"generate {chain_id} setup warn first 5TER last 3TER\n")
                outfile.write("rewind unit 12\n")
                outfile.write("read coor pdb unit 12 append\n")
                outfile.write("hbuild sele hydrogen end\n")
                outfile.write("close unit 12\n")
                outfile.write("\n")
            elif chain_id.startswith("CAR"):
                outfile.write(f"open read unit 12 card name  {file_pdb}\n")
                outfile.write("read sequ pdb unit 12\n")
                outfile.write(f"generate {chain_id} setup \n")
                outfile.write("rewind unit 12\n")
                outfile.write("read coor pdb unit 12 append\n")
                outfile.write("hbuild sele hydrogen end\n")
                outfile.write("close unit 12\n")
                outfile.write("\n")
            elif chain_id.startswith("CAL"):
                outfile.write(f"open read unit 12 card name  {file_pdb}\n")
                outfile.write("read sequ pdb unit 12\n")
                outfile.write(f"generate {chain_id} setup \n")
                outfile.write("rewind unit 12\n")
                outfile.write("read coor pdb unit 12 append\n")
                outfile.write("hbuild sele hydrogen end\n")
                outfile.write("close unit 12\n")
                outfile.write("\n")

        outfile.write("ic fill preserve\n")
        outfile.write("ic parameter\n")
        outfile.write("ic build\n")
        outfile.write("coord init sele type h* end\n")
        outfile.write("hbuild\n")
        outfile.write("IOFO EXTE\n")
        outfile.write("\n")
        outfile.write("write psf card name step1_pdb2crd.psf\n")
        outfile.write("write coor card name step1_pdb2crd.crd\n")
        outfile.write("write coor pdb name step1_pdb2crd.pdb\n")
        outfile.write("stop\n")

    print(f"Wrote {outfile}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="make CRD and PSF from PDB ")

    parser.add_argument("pdb_file", type=str, help="Name of the PDB file.")
    args = parser.parse_args()

    delete_water(args.pdb_file)
    pro_chain_ids = split_chain(args.pdb_file)
    print(f"chain_ids: {pro_chain_ids}")

    hetatm_chain_ids = split_chain_hetatm(args.pdb_file)
    print(f"hetatm_chain_ids: {hetatm_chain_ids}")
    all_chain_ids = pro_chain_ids + hetatm_chain_ids
    print(f"all_chain_ids: {all_chain_ids}")

    renumbering(all_chain_ids)
    change_resid_names(all_chain_ids)
    write_pdb_2_crd_inp_file(all_chain_ids)
