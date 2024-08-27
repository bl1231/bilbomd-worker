# -----------------------------------------------------------------------------
# Build stage 1 - grab NodeJS v20 and update container.
FROM ubuntu:22.04 AS worker-step1

# Update package lists, install build tools, dependencies, and clean up
RUN apt-get update && \
    apt-get install -y cmake gcc gfortran g++ wget libgl1-mesa-dev \
    build-essential libarchive13 zip python3-launchpadlib && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# -----------------------------------------------------------------------------
# Build stage 2 - CHARMM
FROM worker-step1 AS build_charmm
ARG CHARMM_VER=c48b2

# Copy or Download CHARMM source code, extract, and remove the tarball
# COPY ./charmm/${CHARMM_VER}.tar.gz /usr/local/src/
RUN wget https://bl1231.als.lbl.gov/pickup/charmm/${CHARMM_VER}.tar.gz -O /usr/local/src/${CHARMM_VER}.tar.gz
RUN mkdir -p /usr/local/src && \
    tar -zxvf /usr/local/src/${CHARMM_VER}.tar.gz -C /usr/local/src && \
    rm /usr/local/src/${CHARMM_VER}.tar.gz

# Configure CHARMM
WORKDIR /usr/local/src/charmm
RUN ./configure

# Build CHARMM
RUN make -j$(nproc) -C build/cmake install

# -----------------------------------------------------------------------------
# Build stage 3 - Copy CHARMM binary
#   I'm not sure if this needs to be a separate step.
FROM build_charmm AS worker-step2
COPY --from=build_charmm /usr/local/src/charmm/bin/charmm /usr/local/bin/

# -----------------------------------------------------------------------------
# Build stage ## - Install NodeJS
FROM worker-step2 AS install-node
ARG NODE_MAJOR=20
RUN apt-get update && \
    apt-get install -y gpg curl && \
    mkdir -p /etc/apt/keyrings && \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list && \
    apt-get update && \
    apt-get install -y nodejs

# -----------------------------------------------------------------------------
# Build stage 4 - Miniconda3
FROM install-node AS build-conda

# Download and install Miniforge3
RUN wget "https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-$(uname)-$(uname -m).sh" && \
    bash Miniforge3-$(uname)-$(uname -m).sh -b -p "/miniforge3" && \
    rm Miniforge3-$(uname)-$(uname -m).sh

# Add Conda to PATH
ENV PATH="/miniforge3/bin/:${PATH}"

# Update conda
RUN conda update -y -n base -c defaults conda && \
    conda install -y cython swig doxygen && \
    conda clean -afy

# Copy environment.yml and install dependencies
COPY environment.yml /tmp/environment.yml
RUN conda env update -f /tmp/environment.yml && \
    rm /tmp/environment.yml && \
    conda clean -afy

# -----------------------------------------------------------------------------
# Build stage 5 - BioXTAS
FROM build-conda AS bilbomd-worker-step5

# Copy the BioXTAS GitHiub master zip file
WORKDIR /tmp
# COPY bioxtas/bioxtasraw-master.zip .

# Download the BioXTAS RAW master zip file using wget
RUN wget https://github.com/jbhopkins/bioxtasraw/archive/refs/heads/master.zip -O bioxtasraw-master.zip
RUN unzip bioxtasraw-master.zip && rm bioxtasraw-master.zip

# Install BioXTAS RAW into local Python environment
WORKDIR /tmp/bioxtasraw-master
RUN python setup.py build_ext --inplace && \
    pip install . && \
    rm -rf /tmp/bioxtasraw-master

# -----------------------------------------------------------------------------
# Build stage 6 - IMP
FROM bilbomd-worker-step5 AS bilbomd-worker-step6

RUN apt-get update && \
    apt-get install -y --no-install-recommends software-properties-common && \
    add-apt-repository ppa:salilab/ppa && \
    apt-get update && \
    apt-get install -y --no-install-recommends imp && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# -----------------------------------------------------------------------------
# Build stage 7 - worker app for deployment on SPIN
FROM bilbomd-worker-step6 AS bilbomd-worker
ARG USER_ID
ARG GROUP_ID
ARG GITHUB_TOKEN
ARG GIT_HASH
ARG BILBOMD_WORKER_VERSION
RUN mkdir -p /app/node_modules
RUN mkdir -p /bilbomd/uploads
RUN mkdir -p /bilbomd/logs
WORKDIR /app

# Create a user and group with the provided IDs
RUN mkdir -p /home/bilbo
RUN groupadd -g $GROUP_ID bilbomd && useradd -u $USER_ID -g $GROUP_ID -d /home/bilbo -s /bin/bash bilbo

# Change ownership of directories to the user and group
RUN chown -R bilbo:bilbomd /app /bilbomd/uploads /bilbomd/logs /home/bilbo

# Update NPM
RUN npm install -g npm@10.8.2

# Switch to the non-root user
USER bilbo:bilbomd

# Use the ARG to set the environment variable
ENV GIT_HASH=${GIT_HASH}
ENV BILBOMD_WORKER_VERSION=${BILBOMD_WORKER_VERSION}

# Copy over the package*.json files
COPY --chown=bilbo:bilbomd package*.json .

# Create .npmrc file using the build argument
RUN echo "//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}" > /home/bilbo/.npmrc

# Install dependencies
RUN npm ci 

# Optionally, clean up the environment variable for security
RUN unset GITHUB_TOKEN

# Copy the app code
COPY --chown=bilbo:bilbomd . .

EXPOSE 3000

# Fire that bad boy up.
CMD ["npm", "start"]