
FROM ubuntu:22.04 AS builder
RUN apt-get update && \
    apt-get install -y cmake gcc gfortran g++

ARG CHARMM_VER=c47b2
FROM builder AS config_charmm
RUN mkdir -p /usr/local/src
WORKDIR /usr/local/src
COPY ./charmm/${CHARMM_VER}.tar.gz .
RUN tar zxvf ${CHARMM_VER}.tar.gz
WORKDIR /usr/local/src/charmm
RUN ./configure

FROM config_charmm AS build_charmm
WORKDIR /usr/local/src/charmm
RUN make -j8 -C build/cmake install

FROM ubuntu:22.04 as install_imp
RUN apt-get update && \
    apt-get install -y wget && \
    echo "deb https://integrativemodeling.org/latest/download jammy/" >> /etc/apt/sources.list && \
    wget -O /etc/apt/trusted.gpg.d/salilab.asc https://salilab.org/~ben/pubkey256.asc && \
    apt-get update && \
    apt-get install -y imp

FROM install_imp AS bilbomd-worker-step1
COPY --from=build_charmm /usr/local/src/charmm/bin/charmm /usr/local/bin/

ARG NODE_MAJOR=20
FROM bilbomd-worker-step1 AS bilbomd-worker-step2
RUN apt-get update && \
    apt-get install -y gpg curl && \
    mkdir -p /etc/apt/keyrings && \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list && \
    apt-get update && \
    apt-get install -y nodejs

ARG USER_ID=1001
ARG GROUP_ID=1001
FROM bilbomd-worker-step2 AS bilbomd-worker-step3
# RUN curl -L -o /tmp/RAW-2.2.1-linux-x86_64.deb "https://sourceforge.net/projects/bioxtasraw/files/RAW-2.2.1-linux-x86_64.deb/download"
# RUN apt-get install /tmp/RAW-2.2.1-linux-x86_64.deb

# Update the package repository and install dependencies
# Libraries needed by CHARMM
RUN apt-get update && \
    apt-get install -y wget bzip2 ncat gfortran libgl1-mesa-dev

# Download and install the Miniconda
RUN wget https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh -O /tmp/miniconda.sh && \
    bash /tmp/miniconda.sh -b -p /opt/miniconda && \
    rm /tmp/miniconda.sh

# Set up the Miniconda environment
ENV PATH="/opt/miniconda/bin:$PATH"

# Update conda - needed?
RUN conda update -n base -c defaults conda -y

# Copy in the environment.yml file
COPY environment.yml /tmp/environment.yml

# Update existing conda base env from environment.yml
RUN conda env update -f /tmp/environment.yml && \
    rm /tmp/environment.yml

FROM bilbomd-worker-step3 AS bilbomd-worker
RUN apt-get install -y zip build-essential
# Create a directory for BioXTAS and copy the source ZIP file
RUN mkdir /BioXTAS
COPY bioxtas/RAW-2.2.1-source.zip /BioXTAS/

# Change the working directory to BioXTAS
WORKDIR /BioXTAS

# Install BioXYAS from source
RUN unzip RAW-2.2.1-source.zip && \
    python setup.py build_ext --inplace && \
    pip install . && \
    rm /BioXTAS/RAW-2.2.1-source.zip

RUN mkdir -p /app/node_modules
RUN mkdir -p /bilbomd/uploads
VOLUME [ "/bilbomd/uploads" ]
WORKDIR /app

# Create a user and group with the provided IDs
RUN mkdir -p /home/bilbo
RUN groupadd -g $GROUP_ID bilbomd && useradd -u $USER_ID -g $GROUP_ID -d /home/bilbo -s /bin/bash bilbo

# Change ownership of directories to the user and group
RUN chown -R bilbo:bilbomd /app /bilbomd/uploads /home/bilbo

# Switch to the non-root user
USER bilbo:bilbomd

# Copy over the package*.json files
COPY --chown=bilbo:bilbomd package*.json ./

# Install dependencies
RUN npm ci

# Copy the app code
COPY --chown=bilbo:bilbomd . .

# Fire that bad boy up.
CMD ["npm", "start"]