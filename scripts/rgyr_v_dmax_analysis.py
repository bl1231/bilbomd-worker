import os
import re
import pandas as pd
import json
import argparse


def parse_pdb_file(pdb_file):
    """Parse a PDB file to extract Rgyr and Dmax."""
    with open(pdb_file, "r") as file:
        for line in file:
            if line.startswith("REMARK DCD2PDB_RG"):
                parts = line.split()
                if len(parts) >= 4:
                    rgyr = float(parts[2])
                    dmax = float(parts[3])
                    pdb_prefix = parts[1]
                    return pdb_prefix, rgyr, dmax
    return None, None, None


def parse_ensemble_size_file(ensemble_file):
    """Parse an ensemble size file to extract PDB occurrences."""
    pdb_occurrences = {}
    with open(ensemble_file, "r") as file:
        for line in file:
            match = re.search(r"(\S+)\.pdb\.dat\s+\(([\d\.]+)\)", line)
            if match:
                pdb_name = match.group(1)
                occurrence = float(match.group(2))
                pdb_occurrences[pdb_name] = occurrence
    return pdb_occurrences


def collect_pdb_data(foxs_dir):
    """Collect Rgyr, Dmax, and initial size data from PDB files."""
    pdb_data = []

    # Traverse through the foxs directory
    for root, dirs, files in os.walk(foxs_dir):
        for file in files:
            if file.endswith(".pdb"):
                pdb_file = os.path.join(root, file)
                pdb_prefix, rgyr, dmax = parse_pdb_file(pdb_file)
                if pdb_prefix is not None:
                    pdb_data.append(
                        {"pdb_prefix": pdb_prefix, "x": rgyr, "y": dmax, "size": 0.00}
                    )

    return pdb_data


def build_scatter_data(base_dir):
    """Build scatter data and save separate CSV and JSON files for each ensemble size file."""
    foxs_dir = os.path.join(base_dir, "foxs")
    multifoxs_dir = os.path.join(base_dir, "multifoxs")

    # Collect PDB data from the foxs directory
    pdb_data = collect_pdb_data(foxs_dir)

    # Traverse through the multifoxs directory for ensemble size files
    for root, dirs, files in os.walk(multifoxs_dir):
        ensemble_files = [
            f for f in files if f.startswith("ensemble_size_") and f.endswith(".txt")
        ]

        # Process each ensemble size file separately
        for ensemble_file in ensemble_files:
            ensemble_path = os.path.join(root, ensemble_file)
            pdb_occurrences = parse_ensemble_size_file(ensemble_path)

            # Update scatter data with sizes from the ensemble file
            scatter_data = []
            for pdb_entry in pdb_data:
                pdb_prefix = pdb_entry["pdb_prefix"]
                size = pdb_occurrences.get(pdb_prefix, 0.00)
                scatter_data.append(
                    {"x": pdb_entry["x"], "y": pdb_entry["y"], "size": size}
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
            with open(ensemble_json, "w") as json_file:
                json.dump(scatter_data, json_file, indent=2)
            print(f"Saved scatter data to {ensemble_json}")


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
    build_scatter_data(args.base_directory)
