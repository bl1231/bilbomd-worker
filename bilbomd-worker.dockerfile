# -----------------------------------------------------------------------------
# Build stage 1 - Install build tools
FROM ubuntu:22.04 AS builder
RUN apt-get update && \
    apt-get install -y cmake gcc gfortran g++ openmpi-bin libopenmpi-dev

# -----------------------------------------------------------------------------
# Build stage 2 - Configure CHARMM
FROM builder AS build_charmm
ARG CHARMM_VER=c48b2

# Combine the mkdir, tar extraction, and cleanup into a single RUN command
COPY ./charmm/${CHARMM_VER}.tar.gz /usr/local/src/
RUN mkdir -p /usr/local/src && \
    tar -zxvf /usr/local/src/${CHARMM_VER}.tar.gz -C /usr/local/src && \
    rm /usr/local/src/${CHARMM_VER}.tar.gz

# Configure CHARMM in the same layer as the extraction if possible
WORKDIR /usr/local/src/charmm
RUN ./configure

# Build CHARMM
RUN make -j16 -C build/cmake install

# -----------------------------------------------------------------------------
# Build stage 3 - Copy CHARMM binary
#   I'm not sure if this needs to be a separate step.
FROM build_charmm AS bilbomd-worker-step1
COPY --from=build_charmm /usr/local/src/charmm/bin/charmm /usr/local/bin/

# -----------------------------------------------------------------------------
# Build stage 4 - Install NodeJS
FROM bilbomd-worker-step1 AS bilbomd-worker-step2
ARG NODE_MAJOR=20
RUN apt-get update && \
    apt-get install -y gpg curl && \
    mkdir -p /etc/apt/keyrings && \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list && \
    apt-get update && \
    apt-get install -y nodejs

# -----------------------------------------------------------------------------
# Build stage 5 - Install Miniconda3
FROM bilbomd-worker-step2 AS bilbomd-worker-step3

# Libraries needed by CHARMM
RUN apt-get update && \
    apt-get install -y wget bzip2 ncat gfortran libgl1-mesa-dev libarchive13 && \
    rm -rf /var/lib/apt/lists/*

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

# -----------------------------------------------------------------------------
# Build stage 6 - Install BioXTAS
FROM bilbomd-worker-step3 AS bilbomd-worker-step4

# Install deps
RUN apt-get update && \
    apt-get install -y zip build-essential libarchive13

# Copy the BioXTAS GitHiub master zip file
# 1e2b05c74bbc595dc84e64ee962680b700b258be
WORKDIR /tmp
# RUN git clone https://github.com/jbhopkins/bioxtasraw.git
COPY bioxtas/bioxtasraw-master.zip .
RUN unzip bioxtasraw-master.zip && rm bioxtasraw-master.zip


# Install BioXTAS RAW into local Python environment
WORKDIR /tmp/bioxtasraw-master
RUN python setup.py build_ext --inplace && \
    pip install .

# -----------------------------------------------------------------------------
# Build stage 7 - IMP 
FROM bilbomd-worker-step4 AS bilbomd-worker-step5

RUN apt-get update && \
    apt-get install -y wget && \
    echo "deb https://integrativemodeling.org/latest/download jammy/" >> /etc/apt/sources.list && \
    wget -O /etc/apt/trusted.gpg.d/salilab.asc https://salilab.org/~ben/pubkey256.asc && \
    apt-get update && \
    apt-get install -y imp openmpi-bin libopenmpi-dev

# -----------------------------------------------------------------------------
# Build stage 8 - worker app
FROM bilbomd-worker-step5 AS bilbomd-worker
ARG USER_ID=1001
ARG GROUP_ID=1001

RUN mkdir -p /app/node_modules
RUN mkdir -p /bilbomd/uploads
WORKDIR /app

# Create a user and group with the provided IDs
RUN mkdir -p /home/bilbo
RUN groupadd -g $GROUP_ID bilbomd && useradd -u $USER_ID -g $GROUP_ID -d /home/bilbo -s /bin/bash bilbo

# Change ownership of directories to the user and group
RUN chown -R bilbo:bilbomd /app /bilbomd/uploads /home/bilbo

# Update NPM
RUN npm install -g npm@10.7.0

# Switch to the non-root user
USER bilbo:bilbomd

# Copy over the package*.json files
COPY --chown=bilbo:bilbomd package*.json .

# Install dependencies
RUN npm ci

# Copy the app code
COPY --chown=bilbo:bilbomd . .

# Fire that bad boy up.
CMD ["npm", "start"]