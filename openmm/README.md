# OpenMM

wget https://github.com/openmm/openmm/archive/refs/tags/8.1.2.tar.gz
tar xvf 8.1.2.tar.gz
cd openmm-8.1.2/
mkdir build
cd build/
cmake .. -DCMAKE_INSTALL_PREFIX=/usr/local/openmm

make -j8
make install

## Docker builds

### bilbomd/bilbomd-perlmutter-worker:0.0.12

 - OpenMM 8.1.2
 - nvcr.io/nvidia/cuda:12.2.2-devel-ubuntu22.04

### bilbomd/bilbomd-perlmutter-worker:0.0.13

 - OpenMM 8.1.2
 - nvcr.io/nvidia/cuda:12.0.0-devel-ubuntu22.04

### bilbomd/bilbomd-perlmutter-worker:0.0.14

 - OpenMM 8.1.2
 - nvcr.io/nvidia/cuda:12.0.1-devel-ubuntu22.04
