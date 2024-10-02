# -----------------------------------------------------------------------------
# Setup the base image
FROM mambaorg/micromamba:jammy AS install-dependencies

# When using micromamba  image we need to switch to root to install packages
USER root

RUN apt-get update && \
    apt-get install -y cmake gcc gfortran g++ wget libgl1-mesa-dev \
    build-essential libarchive13 zip python3-launchpadlib && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# -----------------------------------------------------------------------------
# Build CHARMM
FROM install-dependencies AS build_charmm
ARG CHARMM_VER=c48b2

# Copy or Download CHARMM source code, extract, and remove the tarball
COPY charmm/${CHARMM_VER}.tar.gz /usr/local/src/
# RUN wget https://bl1231.als.lbl.gov/pickup/charmm/${CHARMM_VER}.tar.gz -O /usr/local/src/${CHARMM_VER}.tar.gz
RUN mkdir -p /usr/local/src/charmm && \
    tar -zxvf /usr/local/src/${CHARMM_VER}.tar.gz -C /usr/local/src && \
    rm /usr/local/src/${CHARMM_VER}.tar.gz && \
    cd /usr/local/src/charmm && \
    ./configure && \
    make -j$(nproc) -C build/cmake install

# -----------------------------------------------------------------------------
# Copy CHARMM binary
FROM build_charmm AS copy-charmm-binary
COPY --from=build_charmm /usr/local/src/charmm/bin/charmm /usr/local/bin/

# -----------------------------------------------------------------------------
# Install NodeJS
FROM copy-charmm-binary AS install-node
RUN apt-get update && \
    apt-get install -y curl && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# -----------------------------------------------------------------------------
# Install BioXTAS
FROM install-node AS install-bioxtas-raw

# install deps
RUN apt-get update && \
    apt-get install -y zip build-essential libarchive13 && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Switch back to mambauser user
USER mambauser

# Install BioXTAS dependencies
RUN micromamba install --yes --name base -c conda-forge numpy scipy matplotlib
RUN micromamba install --yes --name base -c conda-forge pillow numba h5py cython reportlab
RUN micromamba install --yes --name base -c conda-forge dbus-python fabio pyfai hdf5plugin
RUN micromamba install --yes --name base -c conda-forge mmcif_pdbx svglib python-igraph
# RUN micromamba install --yes --name base pip

USER root

WORKDIR /home/mambauser
# Download or Copy the BioXTAS RAW master zip file using wget
COPY bioxtas/bioxtasraw-master.zip .
# RUN wget https://github.com/jbhopkins/bioxtasraw/archive/refs/heads/master.zip -O bioxtasraw-master.zip
RUN unzip bioxtasraw-master.zip && \
    rm bioxtasraw-master.zip

WORKDIR /home/mambauser/bioxtasraw-master
ARG MAMBA_DOCKERFILE_ACTIVATE=1
RUN python setup.py build_ext --inplace
RUN pip install .

# -----------------------------------------------------------------------------
# Install IMP (foxs & multi_foxs)
FROM install-bioxtas-raw AS install-imp

RUN apt-get update && \
    apt-get install -y --no-install-recommends software-properties-common && \
    add-apt-repository ppa:salilab/ppa && \
    apt-get update && \
    apt-get install -y --no-install-recommends imp && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# -----------------------------------------------------------------------------
# Install SANS Stuff
FROM install-imp AS install-sans-tools
RUN apt-get update && \
    apt-get install -y parallel && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Switch back to mambauser user
USER mambauser

# Install ga-sans dependencies
RUN micromamba install --yes --name base -c conda-forge pandas dask

# pip install lmfit
RUN pip install lmfit

USER root

WORKDIR /tmp

# Pepsi-SANS version 3.0 (statically linked with libstdc++ and libgcc, GLIBC 2.4)
# Must run on amd64 x86_64 architecture
COPY pepsisans/Pepsi-SANS-Linux.zip .
# RUN wget https://bl1231.als.lbl.gov/pickup/pepsisans/Pepsi-SANS-Linux.zip -O Pepsi-SANS-Linux.zip
RUN unzip Pepsi-SANS-Linux.zip && \
    mv Pepsi-SANS /usr/local/bin && \
    rm Pepsi-SANS-Linux.zip

COPY scripts/sans /usr/local/sans

# -----------------------------------------------------------------------------
# Install bilbomd-worker app
FROM install-sans-tools AS bilbomd-worker
ARG USER_ID
ARG GROUP_ID
ARG GITHUB_TOKEN
ARG BILBOMD_WORKER_GIT_HASH
ARG BILBOMD_WORKER_VERSION
RUN mkdir -p /bilbomd/uploads /bilbomd/logs
WORKDIR /app

# Create a user and group with the provided IDs
RUN groupadd -g $GROUP_ID bilbomd && \
    useradd -u $USER_ID -g $GROUP_ID -m -d /home/bilbo -s /bin/bash bilbo

# Change ownership of directories to the user and group
RUN chown -R bilbo:bilbomd /app /bilbomd/uploads /bilbomd/logs /home/bilbo

# Update NPM
RUN npm install -g npm@10.8.3

# Switch to the non-root user
USER bilbo:bilbomd

# Configure bilbo bash shell for micromamba
RUN micromamba shell init --shell bash

# Copy over the package*.json files
COPY --chown=bilbo:bilbomd package*.json .

# Create .npmrc file using the build argument
RUN echo "//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}" > /home/bilbo/.npmrc

# Install dependencies
RUN npm ci --no-audit

# Remove .npmrc file for security
RUN rm /home/bilbo/.npmrc

# Optionally, clean up the environment variable for security
RUN unset GITHUB_TOKEN

# Copy the app code
COPY --chown=bilbo:bilbomd . .

# Use the ARG to set the environment variable
ENV BILBOMD_WORKER_GIT_HASH=${BILBOMD_WORKER_GIT_HASH}
ENV BILBOMD_WORKER_VERSION=${BILBOMD_WORKER_VERSION}

EXPOSE 3000

# Fire that bad boy up.
CMD ["npm", "start"]