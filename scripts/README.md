# build docker image on Perlmutter login node

cd projects/bilbomd/bilbomd-worker
docker build -t bilbomd/bilbomd-worker:0.0.1 --build-arg CHARMM_VER=c48b2 --build-arg USER_ID=$UID .
docker migrate bilbomd/bilbomd-worker

