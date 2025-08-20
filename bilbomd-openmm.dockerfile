# --- Build stage: compile OpenMM from source and install Python wrappers ---
FROM nvidia/cuda:12.2.2-devel-ubuntu22.04 AS builder

ENV DEBIAN_FRONTEND=noninteractive

# Pick the OpenMM version and install prefix at build-time
# ARG OPENMM_VERSION=8.1.2
# ARG OPENMM_PREFIX=/opt/openmm-${OPENMM_VERSION}
ARG OPENMM_BRANCH=main
ARG OPENMM_PREFIX=/opt/openmm-main

# Basic build deps + SWIG for Python wrappers + Python headers
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    git build-essential cmake gfortran make \
    wget ca-certificates bzip2 tar \
    swig python3 python3-dev && \
    rm -rf /var/lib/apt/lists/*

# --- Miniforge (Conda) ---
# Install Miniforge and create a clean Python env for the OpenMM Python wrappers
RUN wget -q "https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-$(uname)-$(uname -m).sh" -O /tmp/miniforge.sh && \
    bash /tmp/miniforge.sh -b -p /miniforge3 && \
    rm /tmp/miniforge.sh

ENV PATH=/miniforge3/bin:${PATH}

RUN conda update -y -n base -c defaults conda && \
    conda create -y -n openmm python=3.11 numpy && \
    conda clean -afy

# Ensure the env is first on PATH for CMake to find the intended Python
ENV PATH=/miniforge3/envs/openmm/bin:/miniforge3/bin:${PATH}

# --- Build & install OpenMM ---
WORKDIR /tmp
RUN git clone https://github.com/openmm/openmm.git && \
    cd openmm && \
    git checkout ${OPENMM_BRANCH} && \
    mkdir build && cd build && \
    cmake .. \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX=${OPENMM_PREFIX} \
    -DOPENMM_BUILD_PYTHON_WRAPPERS=ON \
    -DPYTHON_EXECUTABLE=/miniforge3/envs/openmm/bin/python \
    -DSWIG_EXECUTABLE=/usr/bin/swig \
    -DOPENMM_BUILD_CUDA_LIB=ON \
    -DCUDA_TOOLKIT_ROOT_DIR=/usr/local/cuda && \
    make -j"$(nproc)" && \
    make install && \
    make PythonInstall && \
    ldconfig

# --- Runtime stage: slim image with CUDA runtime + OpenMM + conda env ---
FROM nvidia/cuda:12.2.2-runtime-ubuntu22.04

# ARG OPENMM_VERSION=8.1.2
ARG OPENMM_BRANCH=main
ARG OPENMM_PREFIX=/opt/openmm-${OPENMM_BRANCH}

# Copy the conda env and the compiled OpenMM install from the builder
COPY --from=builder /miniforge3 /miniforge3
COPY --from=builder ${OPENMM_PREFIX} ${OPENMM_PREFIX}

# Runtime environment
ENV PATH=/miniforge3/envs/openmm/bin:/miniforge3/bin:${PATH}
ENV OPENMM_HOME=${OPENMM_PREFIX}
ENV OPENMM_PLUGIN_DIR=${OPENMM_PREFIX}/lib/plugins
ENV LD_LIBRARY_PATH=${OPENMM_PREFIX}/lib:${LD_LIBRARY_PATH}

# Make sure the dynamic linker can find the OpenMM libs without setting LD_LIBRARY_PATH
RUN echo "${OPENMM_PREFIX}/lib" > /etc/ld.so.conf.d/openmm.conf && ldconfig

# (Optional) verify python import during build
# RUN python -c "import simtk.openmm as mm; print('OpenMM', mm.__version__)"