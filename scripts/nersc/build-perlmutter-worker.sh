#! /bin/bash

echo "build bilbomd-perlmutter-worker as: $UID"

podman-hpc build --build-arg USER_ID=$UID -t bilbomd/bilbomd-perlmutter-worker -f bilbomd-perlmutter-worker.dockerfile .