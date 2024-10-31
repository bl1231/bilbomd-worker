"""
rgyr_v_dmax_analysis.py


"""

import argparse
import json
import os
import re

import pandas as pd


os.environ["MKL_SERVICE_FORCE_INTEL"] = "1"


def parse_pdb_file(pdb_file):
    """Parse a PDB file to extract Rgyr and Dmax."""
    with open(pdb_file, "r", encoding="utf-8") as file:
        for line in file:
            if line.startswith("REMARK DCD2PDB_RG"):
                parts = line.split()
                if len(parts) >= 4:
                    rgyr = float(parts[2])
                    dmax = float(parts[3])
                    pdb_prefix = parts[1]
                    # print(f"Rgyr: {rgyr}, Dmax: {dmax}, PDB prefix: {pdb_prefix}")
                    return pdb_prefix, rgyr, dmax
    return None, None, None


def parse_ensemble_size_file(ensemble_file):
    """Parse an ensemble size file to extract PDB occurrences."""
    pdb_occurrences = {}
    with open(ensemble_file, "r", encoding="utf-8") as file:
        for line in file:
            # Adjust the regex to capture only the filename
            match = re.search(r"([^/\\]+)\.pdb\.dat\s+\(([\d\.]+)\)", line)
            if match:
                pdb_name = match.group(1).upper()
                occurrence = float(match.group(2))
                pdb_occurrences[pdb_name] = occurrence
                # print(f"PDB: {pdb_name}, Occurrence: {occurrence}")
    return pdb_occurrences


def extract_complex_chi(ensemble_file):
    """Extract complex number and chi-square values from ensemble size file."""
    complex_data = []
    with open(ensemble_file, "r", encoding="utf-8") as file:
        for line in file:
            # Match lines that start with an integer followed by ' | ' and a floating number
            match = re.match(r"^(\d+)\s*\|\s*([\d\.]+)", line)
            if match:
                complex_number = int(match.group(1))
                chi_square = float(match.group(2))
                complex_data.append(
                    {"complex_number": complex_number, "chi_square": chi_square}
                )
    return complex_data


def collect_pdb_data(foxs_dir):
    """Collect Rgyr, Dmax, and initial size data from PDB files."""
    pdb_data = {}

    for root, _, files in os.walk(foxs_dir):
        for file in files:
            if file.endswith(".pdb"):
                pdb_file = os.path.join(root, file)
                pdb_prefix, rgyr, dmax = parse_pdb_file(pdb_file)
                if pdb_prefix is not None:
                    pdb_data[pdb_prefix] = {
                        "rgyr": rgyr,
                        "dmax": dmax,
                        "pdb": pdb_prefix
                    }

    return pdb_data


def build_scatter_data(base_dir):
    """Build scatter data and save separate CSV and JSON files for each ensemble size file."""
    foxs_dir = os.path.join(base_dir, "foxs")
    multifoxs_dir = os.path.join(base_dir, "multifoxs")
    # results_dir = os.path.join(base_dir, "multifoxs")
    print(f"Foxs directory: {foxs_dir}")
    print(f"Multifoxs directory: {multifoxs_dir}")
    # Collect PDB data from the foxs directory
    pdb_data = collect_pdb_data(foxs_dir)

    # Traverse through the multifoxs directory for ensemble size files
    for root, _, files in os.walk(multifoxs_dir):
        print(f"Processing directory: {root}")
        ensemble_files = [
            f for f in files if f.startswith("ensembles_size_") and f.endswith(".txt")
        ]

        # Process each ensemble size file separately
        for ensemble_file in ensemble_files:
            print(f"Processing ensemble size file: {ensemble_file}")

            # Extract N from the filename
            match = re.search(r"ensemble[s]?_size_(\d+)\.txt", ensemble_file)
            if not match:
                print(f"Skipping file: {ensemble_file}")
                continue
            N = int(match.group(1))

            ensemble_path = os.path.join(root, ensemble_file)
            pdb_occurrences = parse_ensemble_size_file(ensemble_path)

            # Update pdb_data to include the "N-state" occurrence data
            for pdb_prefix, occurrence in pdb_occurrences.items():
                if pdb_prefix in pdb_data:
                    pdb_data[pdb_prefix][f"{N}-state"] = occurrence
                else:
                    pdb_data[pdb_prefix] = {
                        "rgyr": None,
                        "dmax": None,
                        "pdb": pdb_prefix,
                        f"{N}-state": occurrence
                    }

    # Fill missing "N-state" fields with 0.00
    for pdb_prefix, data in pdb_data.items():
        for ensemble_file in ensemble_files:
            match = re.search(r"ensemble[s]?_size_(\d+)\.txt", ensemble_file)
            if match:
                N = match.group(1)
                data.setdefault(f"{N}-state", 0.00)

    # Save the consolidated data to a single JSON file
    consolidated_json_path = os.path.join(multifoxs_dir, "consolidated_rgyr_dmax_data.json")
    with open(consolidated_json_path, "w", encoding="utf-8") as json_file:
        json.dump(list(pdb_data.values()), json_file, indent=2)
    print(f"Saved consolidated data to {consolidated_json_path}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Build scatter data from PDB and ensemble size files."
    )
    parser.add_argument(
        "base_directory",
        type=str,
        help="Path to the base directory containing the 'foxs' and 'multifoxs' directories.",
    )
    args = parser.parse_args()
    print(f"Base directory: {args.base_directory}")
    build_scatter_data(args.base_directory)
