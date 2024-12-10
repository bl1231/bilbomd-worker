# -----------------------------------------------------------------------------
# Setup the base image
FROM ubuntu:22.04 AS install-dependencies

RUN apt-get update && \
    apt-get install -y cmake gcc gfortran g++ wget libgl1-mesa-dev \
    build-essential libarchive13 zip python3-launchpadlib && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# -----------------------------------------------------------------------------
# Build CHARMM
FROM install-dependencies AS build_charmm
ARG CHARMM_VER=c49b1

# Copy or Download CHARMM source code, extract, and remove the tarball
# COPY ./charmm/${CHARMM_VER}.tar.gz /usr/local/src/
RUN wget https://bl1231.als.lbl.gov/pickup/charmm/${CHARMM_VER}.tar.gz -O /usr/local/src/${CHARMM_VER}.tar.gz
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
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# -----------------------------------------------------------------------------
# Build stage 4 - Miniconda3
FROM install-node AS install-conda

# Download and install Miniforge3
RUN wget "https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-$(uname)-$(uname -m).sh" && \
    bash Miniforge3-$(uname)-$(uname -m).sh -b -p "/miniforge3" && \
    rm Miniforge3-$(uname)-$(uname -m).sh

# Add Conda to PATH
ENV PATH="/miniforge3/bin/:${PATH}"

# Update conda
# RUN conda update -y -n base -c defaults conda && \
#     conda install -y cython swig doxygen && \
#     conda clean -afy

# Copy environment.yml and install dependencies
# COPY environment.yml /tmp/environment.yml
# RUN conda env update -f /tmp/environment.yml && \
#     rm /tmp/environment.yml && \
#     conda clean -afy

# I was having trouble installing all of these dependencies in one go so
# lets try this for now.
RUN conda install --yes --name base -c conda-forge numpy scipy matplotlib \
    pillow numba h5py cython reportlab \
    dbus-python fabio pyfai hdf5plugin \
    mmcif_pdbx svglib python-igraph && \
    conda clean -afy

# -----------------------------------------------------------------------------
# Install BioXTAS
FROM install-conda AS install-bioxtas-raw

# Copy the BioXTAS GitHiub master zip file
WORKDIR /tmp

# Download or Copy the BioXTAS RAW master zip file using wget
# COPY bioxtas/bioxtasraw-master.zip .
RUN wget https://github.com/jbhopkins/bioxtasraw/archive/refs/heads/master.zip -O bioxtasraw-master.zip
RUN unzip bioxtasraw-master.zip && rm bioxtasraw-master.zip

# Install BioXTAS RAW into local Python environment
WORKDIR /tmp/bioxtasraw-master
RUN python setup.py build_ext --inplace && \
    pip install . && \
    rm -rf /tmp/bioxtasraw-master

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

# Install ga-sans dependencies
RUN conda install --yes --name base -c conda-forge pandas dask

# pip install lmfit
RUN pip install lmfit

WORKDIR /tmp

# Pepsi-SANS version 3.0 (statically linked with libstdc++ and libgcc, GLIBC 2.4)
# Must run on amd64 x86_64 architecture
#COPY pepsisans/Pepsi-SANS-Linux.zip .
RUN wget https://bl1231.als.lbl.gov/pickup/pepsisans/Pepsi-SANS-Linux.zip -O Pepsi-SANS-Linux.zip
RUN unzip Pepsi-SANS-Linux.zip && \
    mv Pepsi-SANS /usr/local/bin && \
    rm Pepsi-SANS-Linux.zip

COPY scripts/sans /usr/local/sans

# -----------------------------------------------------------------------------
# Install ATSAS
FROM install-sans-tools AS install-atsas
RUN apt-get update && \
    apt-get install -y shared-mime-info libxkbcommon-x11-0 libxcb-cursor0 libxcb-icccm4 \
    libxcb-keysyms1 libxcb-shape0 libc6 libgcc1 libquadmath0 libstdc++6 libxml2 libtiff5 liblzma5 libgfortran5 libicu70 libharfbuzz0b && \
    apt-get clean && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp
# COPY atsas/ATSAS-4.0.1-1-Linux-Ubuntu-22.run .
# COPY atsas/atsas.lic .
RUN wget https://bl1231.als.lbl.gov/pickup/atsas/ATSAS-4.0.1-1-Linux-Ubuntu-22.run -O ATSAS-4.0.1-1-Linux-Ubuntu-22.run
RUN wget https://bl1231.als.lbl.gov/pickup/atsas/atsas.lic -O atsas.lic
RUN mkdir /root/.local && chmod +x ATSAS-4.0.1-1-Linux-Ubuntu-22.run && \
    ./ATSAS-4.0.1-1-Linux-Ubuntu-22.run --accept-licenses --auto-answer \
    AutomaticRuntimeDependencyResolution=Yes --root /usr/local/ATSAS-4.0.1 --file-query KeyFilePath=/tmp/atsas.lic \
    --confirm-command install && \
    rm ATSAS-4.0.1-1-Linux-Ubuntu-22.run

# -----------------------------------------------------------------------------
# Install bilbomd-worker app
FROM install-atsas AS bilbomd-worker
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

# Switch to the non-root user
USER bilbo:bilbomd

# Copy over the package*.json files
COPY --chown=bilbo:bilbomd package*.json .

# Create .npmrc file using the build argument
RUN echo "//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}" > /home/bilbo/.npmrc

# Install dependencies
RUN npm ci

# Remove .npmrc file for security
RUN rm /home/bilbo/.npmrc

# Optionally, clean up the environment variable for security
RUN unset GITHUB_TOKEN

# Copy the app code
COPY --chown=bilbo:bilbomd . .

# Use the ARG to set the environment variable
ENV BILBOMD_WORKER_GIT_HASH=${BILBOMD_WORKER_GIT_HASH}
ENV BILBOMD_WORKER_VERSION=${BILBOMD_WORKER_VERSION}

# set ATSAS environment variables
ENV ATSAS=/usr/local/ATSAS-4.0.1
ENV PATH="${ATSAS}/bin:${PATH}"

EXPOSE 3000

# Fire that bad boy up.
CMD ["npm", "start"]