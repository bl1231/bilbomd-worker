# Notes on some of these scripts

Until I implement a mono repo there are, unfortunately, a few duplicate scripts needed both here in the worker app and in the backend app.

## pae_ratio.py

Provides functions to create `const.inp` file from PAE and CRD files.

## pdb2crd.py

Splits a PDB file into individual files.
Each file containing one chain from the input PDB file.
Sanitizes the PDB files to be used by CHARMM in order to convert to CRD and PSF files.
Writes a CHARMM-compatible pdb_2_crd.inp file for CHARMM.
