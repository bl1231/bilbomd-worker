#!/bin/bash
set -e

echo "Testing CLI tools..."
if charmm 2>&1 | grep -q "Chemistry at HARvard Macromolecular Mechanics"; then
    echo "CHARMM OK"
else
    echo "CHARMM not found or not working"
fi
Pepsi-SANS --help || echo "Pepsi-SANS not found"
if [ -x /usr/local/ATSAS-4.0.1/bin/dammin ]; then
    /usr/local/ATSAS-4.0.1/bin/dammin --version || echo "ATSAS dammin not found"
else
    echo "ATSAS dammin not found"
fi
foxs --version || echo "FOXS not found"
multi_foxs --version || echo "Multi-FOXS not found"
echo "Testing Python packages..."
/miniforge3/bin/python -c "import numpy; print('numpy OK')" || echo "numpy missing"
/miniforge3/bin/python -c "import scipy; print('scipy OK')" || echo "scipy missing"
/miniforge3/bin/python -c "import bioxtasraw; print('bioxtasraw OK')" || echo "bioxtasraw missing"
/miniforge3/bin/python -c "import lmfit; print('lmfit OK')" || echo "lmfit missing"
/miniforge3/bin/python -c "import pandas; print('pandas OK')" || echo "pandas missing"
/miniforge3/bin/python -c "import dask; print('dask OK')" || echo "dask missing"
/miniforge3/bin/python -c "import openmm; print('openmm OK')" || echo "openmm missing"

echo "Smoke test complete."