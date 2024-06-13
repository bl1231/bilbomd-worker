#!/bin/bash -l

# Check if an arguments was provided
if [ $# -ne 1 ]; then
    echo "Usage: $0 <UUID>"
    exit 1
fi

# Assign args to global variables
UUID=$1

PROJECT="m4659"

UPLOAD_DIR=${CFS}/${PROJECT}/bilbomd-uploads/${UUID}
WORKDIR=${PSCRATCH}/bilbmod/${UUID}

echo "Copying results back to CFS..."
cp -nR $WORKDIR/* $UPLOAD_DIR
echo "DONE copying $UUID"