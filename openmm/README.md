# OpenMM

wget https://github.com/openmm/openmm/archive/refs/tags/8.1.2.tar.gz
tar xvf 8.1.2.tar.gz
cd openmm-8.1.2/
mkdir build
cd build/
cmake .. -DCMAKE_INSTALL_PREFIX=/usr/local

make -j8
make install

## Docker builds

### bilbomd/bilbomd-perlmutter-worker:0.0.9

build with OpenMM 8.1.2

### bilbomd/bilbomd-perlmutter-worker:0.0.10

build with OpenMM 8.0.0
