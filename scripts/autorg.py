"""
Simple python jiffy to calculate the min and max Rg values
"""

import argparse
import bioxtasraw.RAWAPI as raw
import json


def parse_args():
    parser = argparse.ArgumentParser(description="Calculate min and max Rg values")
    parser.add_argument("file_path", type=str, help="Path to the data file")
    return parser.parse_args()


def calculate_rg(file_path):
    """
    Simple function that takes SAXS data as input and uses BioXTAS
      to calculate a min_rg and max_rg for use in BilboMD
    """
    profiles = raw.load_profiles(file_path)
    gi_profile = profiles[0]
    guinier_results = raw.auto_guinier(gi_profile)
    (
        rg,
        izero,
        rg_err,
        izero_err,
        qmin,
        qmax,
        qrg_min,
        qrg_max,
        idx_min,
        idx_max,
        r_sqr,
    ) = guinier_results

    rg_min = round(rg * 0.8)
    rg_max = round(rg * 1.5)

    # Clamp rg_min to be no less than 10 and no more than 100
    rg_min = max(10, min(100, rg_min))

    # Clamp rg_max to be no less than 10 and no more than 100
    rg_max = max(10, min(100, rg_max))

    # Create a dictionary with the results
    result_dict = {"rg": round(rg), "rg_min": rg_min, "rg_max": rg_max}

    # Convert the dictionary to a JSON string
    json_result = json.dumps(result_dict)

    # Print the JSON string
    print(json_result)


if __name__ == "__main__":
    args = parse_args()
    calculate_rg(args.file_path)
