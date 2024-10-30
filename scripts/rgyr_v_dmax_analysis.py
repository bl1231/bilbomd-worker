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
                complex_data.append({
                    "complex_number": complex_number,
                    "chi_square": chi_square
                })
    return complex_data

def collect_pdb_data(foxs_dir):
    """Collect Rgyr, Dmax, and initial size data from PDB files."""
    pdb_data = []

    # Traverse through the foxs directory
    for root, _, files in os.walk(foxs_dir):
        for file in files:
            if file.endswith(".pdb"):
                pdb_file = os.path.join(root, file)
                # print(f"Processing PDB file: {pdb_file}")
                pdb_prefix, rgyr, dmax = parse_pdb_file(pdb_file)
                if pdb_prefix is not None:
                    pdb_data.append(
                        {
                            "pdb_prefix": pdb_prefix,
                            "rgyr": rgyr,
                            "dmax": dmax,
                            "occur": 0.00,
                        }
                    )

    return pdb_data


def build_scatter_data(base_dir):
    """Build scatter data and save separate CSV and JSON files for each ensemble size file."""
    foxs_dir = os.path.join(base_dir, "foxs")
    multifoxs_dir = os.path.join(base_dir, "multifoxs")
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
            ensemble_path = os.path.join(root, ensemble_file)
            pdb_occurrences = parse_ensemble_size_file(ensemble_path)

            # Update scatter data with sizes from the ensemble file
            scatter_data = []
            for pdb_entry in pdb_data:
                pdb_prefix = pdb_entry["pdb_prefix"]
                # print(f"PDB prefix: {pdb_prefix}")
                occur = pdb_occurrences.get(pdb_prefix, 0.00)
                scatter_data.append(
                    {
                        "rgyr": pdb_entry["rgyr"],
                        "dmax": pdb_entry["dmax"],
                        "occur": occur,
                        "pdb": pdb_prefix,
                    }
                )

            # Save the scatter data to a CSV file
            ensemble_csv = os.path.join(
                root, f"{os.path.splitext(ensemble_file)[0]}.csv"
            )
            df = pd.DataFrame(scatter_data)
            df.to_csv(ensemble_csv, index=False)
            print(f"Saved scatter data to {ensemble_csv}")

            # Save the scatter data to a JSON file
            ensemble_json = os.path.join(
                root, f"{os.path.splitext(ensemble_file)[0]}.json"
            )
            with open(ensemble_json, "w", encoding="utf-8") as json_file:
                json.dump(scatter_data, json_file, indent=2)
            print(f"Saved scatter data to {ensemble_json}")

            # Extract and save complex number and chi-square values
            complex_data = extract_complex_chi(ensemble_path)
            complex_json = os.path.join(
                root, f"{os.path.splitext(ensemble_file)[0]}_complex.json"
            )
            with open(complex_json, "w", encoding="utf-8") as json_file:
                json.dump(complex_data, json_file, indent=2)
            print(f"Saved complex data to {complex_json}")

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
