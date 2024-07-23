# -----------------------------------------------------------------------------
# Build stage 1 - Install build tools & dependencies
# FROM ubuntu:24.04 AS builder
FROM nvcr.io/nvidia/cuda:12.5.1-devel-ubuntu24.04 AS builder
RUN apt-get update && \
    apt-get install -y cmake gcc gfortran g++ python3 \
    libpmix-bin libpmix-dev parallel wget bzip2 ncat \
    gfortran libgl1-mesa-dev libarchive13 zip build-essential && \
    rm -rf /var/lib/apt/lists/*

# -----------------------------------------------------------------------------
# Build stage 2 - Miniconda3
FROM builder AS build-conda

# Download and install Miniforge3
RUN wget "https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-$(uname)-$(uname -m).sh" && \
    bash Miniforge3-$(uname)-$(uname -m).sh -b -p "/miniforge3" && \
    rm Miniforge3-$(uname)-$(uname -m).sh

# Add Conda to PATH
ENV PATH="/miniforge3/bin/:${PATH}"

# Update conda
RUN conda update -y -n base -c defaults conda

# Copy in the environment.yml file
COPY environment.yml /tmp/environment.yml

# Update existing conda base env from environment.yml
RUN conda env update -f /tmp/environment.yml && \
    rm /tmp/environment.yml

RUN conda install -y cython swig doxygen

# -----------------------------------------------------------------------------
# Build stage 3 - OpenMM
FROM build-conda AS build-openmm
ARG OPENMM_VER=8.1.2

COPY ./openmm/${OPENMM_VER}.tar.gz /usr/local/src
RUN tar -zxvf /usr/local/src/${OPENMM_VER}.tar.gz -C /usr/local/src && \
    rm /usr/local/src/${OPENMM_VER}.tar.gz
WORKDIR /usr/local/src/openmm-${OPENMM_VER}/build
RUN cmake .. -DCMAKE_INSTALL_PREFIX=/usr/local

RUN make -j$(nproc) && make install

# -----------------------------------------------------------------------------
# Build stage 4 - CHARMM
FROM build-openmm AS build-charmm
ARG CHARMM_VER=c48b2

COPY ./charmm/${CHARMM_VER}.tar.gz /usr/local/src/
RUN mkdir -p /usr/local/src && \
    tar -zxvf /usr/local/src/${CHARMM_VER}.tar.gz -C /usr/local/src && \
    rm /usr/local/src/${CHARMM_VER}.tar.gz

WORKDIR /usr/local/src/charmm
RUN ./configure

RUN make -j$(nproc) -C build/cmake install
RUN cp /usr/local/src/charmm/bin/charmm /usr/local/bin/

# -----------------------------------------------------------------------------
# Build stage 5 - BioXTASRAW
FROM build-charmm AS bilbomd-worker-step1

# Copy the BioXTAS GitHiub master zip file
WORKDIR /tmp
COPY bioxtas/bioxtasraw-master.zip .
RUN unzip bioxtasraw-master.zip && rm bioxtasraw-master.zip

# Install BioXTAS RAW into local Python environment
WORKDIR /tmp/bioxtasraw-master
RUN python setup.py build_ext --inplace && \
    pip install .

# -----------------------------------------------------------------------------
# Build stage 6 - IMP
FROM bilbomd-worker-step1 AS bilbomd-worker-step2

RUN apt-get update && \ 
    apt-get install -y software-properties-common && \
    add-apt-repository ppa:salilab/ppa && \
    apt-get update && \
    apt-get install -y imp && \
    rm -rf /var/lib/apt/lists/*

# -----------------------------------------------------------------------------
# Build stage 7 - worker app
# need the python script files... I think that's all we need?
FROM bilbomd-worker-step2 AS bilbomd-perlmutter-worker
ARG USER_ID
WORKDIR /app
COPY scripts/ scripts/

# Needed in order to have podman-hpc runtime run as me.
RUN chown -R $USER_ID:0 /app
