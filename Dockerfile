FROM debian:bullseye AS builder
RUN apt-get update && apt-get install -y cmake gcc gfortran g++

FROM builder AS config_charmm
RUN mkdir -p /usr/local/src
WORKDIR /usr/local/src
ARG CHARMM_VER
COPY ./charmm/${CHARMM_VER}.tar.gz .
RUN tar zxvf ${CHARMM_VER}.tar.gz
WORKDIR /usr/local/src/charmm
RUN ./configure

FROM config_charmm AS build_charmm
WORKDIR /usr/local/src/charmm
RUN make -j8 -C build/cmake install

FROM builder AS build_imp
RUN apt-get install -y \
    libboost-all-dev \
    libeigen3-dev \
    google-perftools \
    libcgal-dev \
    graphviz \
    libgsl-dev \
    libhdf5-dev \
    swig \
    fftw-dev \
    opencv-data \
    python3-dev \
    python3-numpy \
    doxygen
WORKDIR /usr/local/src
COPY ./scripts/imp-2.18.0.tar.gz .
RUN tar zxvf imp-2.18.0.tar.gz
RUN mkdir imp_release
WORKDIR /usr/local/src/imp_release
RUN cmake /usr/local/src/imp-2.18.0 -DIMP_STATIC=On -DIMP_DISABLED_MODULES=cgal:membrane:example
RUN make -j8

FROM continuumio/miniconda3:latest AS bilbomd-worker
ARG USER_ID=1001
ARG GROUP_ID=1001
COPY --from=build_charmm /usr/local/src/charmm/bin/charmm /usr/local/bin/
COPY --from=build_imp /usr/local/src/imp_release/bin/foxs /usr/local/bin/
COPY --from=build_imp /usr/local/src/imp_release/bin/multi_foxs /usr/local/bin/

RUN apt-get update
RUN apt-get install -y gpg curl

RUN mkdir -p /etc/apt/keyrings
RUN curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg

RUN echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_18.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list

RUN apt-get update
RUN apt-get install -y nodejs zip build-essential

# Copy the environment.yml file into the image
COPY environment.yml /tmp/environment.yml

# Update existing base environment from environment.yml
RUN conda env update -f /tmp/environment.yml

# Create a directory for BioXTAS and copy the source ZIP file
RUN mkdir /BioXTAS
COPY bioxtas/RAW-2.2.1-source.zip /BioXTAS/

# Change the working directory to BioXTAS
WORKDIR /BioXTAS

# Unzip the source ZIP file
RUN unzip RAW-2.2.1-source.zip

# Build BioXTAS using Python setup.py
RUN python setup.py build_ext --inplace

# Install BioXTAS using pip
RUN pip install .

# Libraries needed by CHARMM
RUN apt-get install -y ncat gfortran

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

# RUN echo "conda init bash" >> /home/node/.bashrc

COPY --chown=bilbo:bilbomd package*.json ./

RUN npm ci

COPY --chown=bilbo:bilbomd . .
CMD ["npm", "start"]