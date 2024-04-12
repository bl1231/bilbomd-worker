"""
Splits a PDB file into individual files.
Each file containing one chain from the input PDB file.
Sanitizes the PDB files to be used by CHARMM in order to convert to CRD and PSF files.
Writes a CHARMM-compatible pdb_2_crd.inp file for CHARMM.

PDB specification from https://www.wwpdb.org/documentation/file-format-content/format33/sect1.html

COLUMNS        DATA  TYPE    FIELD        DEFINITION
-------------------------------------------------------------------------------------
 1 -  6        Record name   "ATOM  "
 7 - 11        Integer       serial       Atom  serial number.
13 - 16        Atom          name         Atom name.
17             Character     altLoc       Alternate location indicator.
18 - 20        Residue name  resName      Residue name.
22             Character     chainID      Chain identifier.
23 - 26        Integer       resSeq       Residue sequence number.
27             AChar         iCode        Code for insertion of residues.
31 - 38        Real(8.3)     x            Orthogonal coordinates for X in Angstroms.
39 - 46        Real(8.3)     y            Orthogonal coordinates for Y in Angstroms.
47 - 54        Real(8.3)     z            Orthogonal coordinates for Z in Angstroms.
55 - 60        Real(6.2)     occupancy    Occupancy.
61 - 66        Real(6.2)     tempFactor   Temperature  factor.
77 - 78        LString(2)    element      Element symbol, right-justified.
79 - 80        LString(2)    charge       Charge  on the atom.

CRD specification from the CHARMM io documentation:

The CARD file format is the standard means in CHARMM for
providing a human readable and writable coordinate file. The format is
as follows:

* Normal format for less than 100000 atoms and PSF IDs with less than
five characters
         title
         NATOM (I5)
         ATOMNO RESNO   RES  TYPE  X     Y     Z   SEGID RESID Weighting
           I5    I5  1X A4 1X A4 F10.5 F10.5 F10.5 1X A4 1X A4 F10.5

* Expanded format for more than 100000 atoms (upto 10**10) and with
upto 8 character PSF IDs. (versions c31a1 and later)
         title
         NATOM (I10)
         ATOMNO RESNO   RES  TYPE  X     Y     Z   SEGID RESID Weighting
           I10   I10 2X A8 2X A8       3F20.10     2X A8 2X A8 F20.10

"""

import argparse

# from datetime import datetime

TOPO_FILES = "/app/scripts/bilbomd_top_par_files.str"


def determine_molecule_type(lines):
    """
    Determines if the chain is Protein, DNA, RNA, or Carbohydrate
    """
    protein_residues = set(
        [
            "ALA",
            "CYS",
            "ASP",
            "GLU",
            "PHE",
            "GLY",
            "HIS",
            "ILE",
            "LYS",
            "LEU",
            "MET",
            "ASN",
            "PRO",
            "GLN",
            "ARG",
            "SER",
            "THR",
            "VAL",
            "TRP",
            "TYR",
        ]
    )
    dna_residues = set(["DA", "DC", "DG", "DT", "DI", "ADE", "CYT", "GUA", "THY"])
    rna_residues = set(["A", "C", "G", "U", "I"])
    carbohydrate_residues = set(
        [
            "AFL",
            "ALL",
            "BMA",
            "BGC",
            "BOG",
            "FCA",
            "FCB",
            "FMF",
            "FUC",
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
    )

    for line in lines:
        if line.startswith(("ATOM", "HETATM")):
            residue = line[17:20].strip()
            # print(residue)
            if residue in protein_residues:
                return "PRO"
            elif residue in dna_residues:
                return "DNA"
            elif residue in rna_residues:
                return "RNA"
            elif residue in carbohydrate_residues:
                return "CAR"
    return "UNKNOWN"


def get_chain_filename(chain_id, pdb_filename):
    """
    Generates a filename for the chain file. Appends '_uc' to the filename for uppercase chain IDs
    to differentiate from lowercase ones, since CHARMM requires lowercase filenames in all input files.

    :param chain_id: The chain ID from the PDB file.
    :param pdb_filename: The original PDB filename.
    :param output_dir: The output directory for the chain files.
    :return: A string representing the filename for the chain file.
    """
    # Check if the chain ID is uppercase and append '_uc' if true
    suffix = "_uc" if chain_id.isupper() else ""
    # Construct the filename using the lowercase chain ID and suffix if applicable
    chain_filename = f"{chain_id.lower()}{suffix}_{pdb_filename.split('/')[-1].lower()}"
    return chain_filename


def remove_water(lines):
    """
    Remove HOH residues
    """
    processed_lines = []
    for line in lines:
        if line.startswith(("ATOM", "HETATM")):
            # Extract the residue name from columns 18-20
            residue_name = line[17:20]
            if residue_name != "HOH":
                processed_lines.append(line)  # Only append if not water
        else:
            processed_lines.append(line)  # Always append non-ATOM/HETATM lines

    return processed_lines


def remove_alt_conformers(lines):
    """
    Remove lines where the 27th column (index 26 in Python) is not a space.
    This is the column used by PDB to denote an alternate conformation.

    :param lines: List of strings (lines from the PDB file).
    :return: List of strings with lines removed according to the condition.
    """
    processed_lines = [line for line in lines if line[26] == " "]
    return processed_lines


def apply_charmm_residue_names(lines):
    """
    Processes lines of a single chain renaming residues to be CHARMM-compatible.

    :param lines: The list of lines (strings) from the PDB file for a specific chain.
    :return: A list of processed lines.
    """
    residue_replacements = {
        "HIS": "HSD ",
        "C  ": "CYT ",
        "G  ": "GUA ",
        "A  ": "ADE ",
        "U  ": "URA ",
        "DC ": "CYT ",
        "DG ": "GUA ",
        "DA ": "ADE ",
        "DT ": "THY ",
        "NAG": "BGLC",
        "BMA": "BMAN",
        "MAN": "AMAN",
        "GAL": "AGAL",
        "FUL": "BFUC",
        "FUC": "AFUC",
        "AFL": "AFUC",
        "RIB": "ARIB",
        "GLC": "AGLC",
        "ALT": "AALT",
        "ALL": "AALL",
        "GUL": "AGUL",
        "BGC": "BGUL",
        "IDO": "AIDO",
        "TAL": "ATAL",
        "XYL": "AXYL",
        "RHM": "ARHM",
        "SIA": "BSIA",
        "HEM": "HEME",
    }

    processed_lines = []
    for line in lines:
        if line.startswith(("ATOM", "HETATM")):
            # Extract the residue name from columns 18-20
            residue_name = line[17:20]
            # print(f"old: {residue_name}")
            # Check if the residue name needs to be replaced
            if residue_name in residue_replacements:
                # Replace only the part of the line with the new residue name
                new_residue_name = residue_replacements[residue_name]
                # print(f"new: {new_residue_name}")
                line = line[:17] + new_residue_name + line[21:]
        processed_lines.append(line)

    return processed_lines


def replace_hetatm(lines):
    """
    Replace all HETATM with ATOM
    """
    processed_lines = []
    for line in lines:
        if "HETATM" in line:
            line = line.replace("HETATM", "ATOM  ")

        processed_lines.append(line)

    return processed_lines


def renumber_residues(lines):
    """
    Renumber residues so they always begin with 1 for each chain.

    :param lines: The list of lines (strings) from the PDB file for a specific chain.
    :return: A list of lines with renumbered residues.
    """
    processed_lines = []
    current_residue_number = 1
    last_chain_id = None
    last_residue_seq_number = None

    for line in lines:
        if line.startswith(("ATOM", "HETATM")):
            chain_id = line[21]
            residue_seq_number = line[22:26].strip()

            # Check if this is a new chain or a new residue in the same chain
            if (
                chain_id != last_chain_id
                or residue_seq_number != last_residue_seq_number
            ):
                if chain_id != last_chain_id:
                    current_residue_number = 1  # Reset numbering for a new chain
                else:
                    current_residue_number += (
                        1  # Increment for a new residue in the same chain
                    )

                last_chain_id = chain_id
                last_residue_seq_number = residue_seq_number

            # Reconstruct line with the new residue number
            new_line = f"{line[:22]}{str(current_residue_number).rjust(4)}{line[26:]}"
            processed_lines.append(new_line)
        else:
            processed_lines.append(line)

    return processed_lines


def write_pdb_2_crd_inp_file(chains, output_dir, pdb_file_path):
    """
    Write the CHARMM input file
    """
    output_file = f"{output_dir}/pdb2crd_charmm.inp"
    # timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with open(output_file, mode="w", encoding="utf8") as outfile:
        outfile.write("* PURPOSE: Convert PDB file to CRD and PSF\n")
        outfile.write("* AUTHOR: Michal Hammel\n")
        outfile.write("* AUTHOR: Scott Classen\n")
        outfile.write(f"* PDB: {pdb_file_path}\n")
        # outfile.write(f"* DATE: {timestamp}\n")
        outfile.write("*\n")
        outfile.write("\n")
        outfile.write("bomlev -2\n")
        outfile.write("\n")
        outfile.write(f"STREAM {TOPO_FILES}\n")
        outfile.write("\n")

        for chain_id, chain_data in chains.items():
            # Use the determined molecule type
            molecule_type = chain_data["type"]
            suffix = "_uc" if chain_id.isupper() else ""
            chain_filename = (
                f"{chain_id.lower()}{suffix}_{pdb_file_path.split('/')[-1].lower()}"
            )
            # chain_file = f"{output_dir}/{chain_filename}"
            # print(chain_file)

            # Adjust the generation and reading commands based on molecule_type
            if molecule_type == "PRO":
                outfile.write(f"open read unit 12 card name {chain_filename}\n")
                outfile.write("read sequ pdb unit 12\n")
                outfile.write(
                    f"generate {molecule_type}{chain_data['chainid']} "
                    f"setup warn first NTER last CTER\n"
                )
                outfile.write("rewind unit 12\n")
                outfile.write("read coor pdb unit 12 append\n")
                outfile.write("hbuild sele hydrogen end\n")
                outfile.write("close unit 12\n")
                outfile.write("\n")
            elif molecule_type == "DNA" or molecule_type == "RNA":
                outfile.write(f"open read unit 12 card name {chain_filename}\n")
                outfile.write("read sequ pdb unit 12\n")
                outfile.write(
                    f"generate {molecule_type}{chain_data['chainid']} "
                    f"setup warn first 5TER last 3TER\n"
                )
                outfile.write("rewind unit 12\n")
                outfile.write("read coor pdb unit 12 append\n")
                outfile.write("hbuild sele hydrogen end\n")
                outfile.write("close unit 12\n")
                outfile.write("\n")
            elif molecule_type == "CAR":
                chain_id = chain_data["chainid"]
                suffix = "R" if chain_id.isupper() else "L"
                outfile.write(f"open read unit 12 card name {chain_filename}\n")
                outfile.write("read sequ pdb unit 12\n")
                outfile.write(
                    f"generate CA{suffix}{chain_data['chainid'].upper()} setup\n"
                )
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
        outfile.write("write psf card name bilbomd_pdb2crd.psf\n")
        outfile.write("write coor card name bilbomd_pdb2crd.crd\n")
        outfile.write("write coor pdb name bilbomd_pdb2crd.pdb\n")
        outfile.write("stop\n")


def split_and_process_pdb(pdb_file_path: str, output_dir: str):
    """
    Reads a PDB file, splits it by chains, processes each chain in memory,
    and writes each chain to a separate file in the specified output directory.
    """
    chains = {}  # Dictionary to hold chain data, key = chain ID, value = list of lines
    # Assuming `chains` is a dictionary where each key is a chain ID,
    # and each value is now a dictionary with 'lines' and 'type' keys.
    # chains[chain_id] = {"lines": [], "type": None}

    with open(pdb_file_path, "r", encoding="utf-8") as pdb_file:
        for line in pdb_file:
            if line.startswith(("ATOM", "HETATM")):
                record_type = line[:6].strip()
                chain_id = line[21]  # Extract chain ID

                # Create a unique key for each chain that includes both chain ID and record type
                unique_chain_key = f"{record_type}_{chain_id}"

                # Initialize the chain in the dictionary if not already present
                if unique_chain_key not in chains:
                    chains[unique_chain_key] = {
                        "lines": [],
                        "type": None,
                        "chainid": chain_id,
                    }
                chains[unique_chain_key]["lines"].append(line)

    # Determine molecule type for each chain
    for chain_id, chain_data in chains.items():
        chain_data["type"] = determine_molecule_type(chain_data["lines"])

    # Process and write each chain to a separate file
    for chain_id, chain_data in chains.items():
        # Apply any processing here, e.g., renaming residues, renumbering, etc.
        # These could be done in a single for x in x loop if we wanted
        # to be more efficient
        processed_lines = remove_water(chain_data["lines"])
        processed_lines = remove_alt_conformers(processed_lines)
        processed_lines = apply_charmm_residue_names(processed_lines)
        processed_lines = replace_hetatm(processed_lines)
        # commenting this out since we really shouldn't be renumbering peoples input PDB files
        processed_lines = renumber_residues(processed_lines)

        chain_filename = get_chain_filename(chain_id, pdb_file_path)
        print(
            f"Writing processed chain to: {chain_filename} chainID: {chain_data['chainid']} type: {chain_data['type']}"
        )
        with open(
            output_dir + "/" + chain_filename, "w", encoding="utf-8"
        ) as chain_file:
            chain_file.writelines(processed_lines)
            chain_file.write("TER\n")

    write_pdb_2_crd_inp_file(chains, output_dir, pdb_file_path)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Split a PDB file into separate chain files for CHARMM."
    )
    parser.add_argument("pdb_file", type=str, help="Path to the PDB file to be split.")
    parser.add_argument(
        "output_dir", type=str, help="Directory to save the split chain files."
    )
    args = parser.parse_args()

    split_and_process_pdb(args.pdb_file, args.output_dir)
