# -----------------------------------------------------------------------------
# Build stage 1 - grab NodeJS v20 and update container.
FROM node:20-slim AS worker-step1

# Update package lists, install Python, and create alias
RUN apt-get update && \
    apt-get install -y python3 python3-pip cmake gcc gfortran g++ wget && \
    ln -s /usr/bin/python3 /usr/bin/python

# -----------------------------------------------------------------------------
# Build stage 2 - Configure CHARMM
FROM worker-step1 AS build_charmm
ARG CHARMM_VER=c48b2

# Combine the mkdir, tar extraction, and cleanup into a single RUN command
# COPY ./charmm/${CHARMM_VER}.tar.gz /usr/local/src/
RUN wget https://bl1231.als.lbl.gov/pickup/charmm/${CHARMM_VER}.tar.gz -O /usr/local/src/${CHARMM_VER}.tar.gz
RUN mkdir -p /usr/local/src && \
    tar -zxvf /usr/local/src/${CHARMM_VER}.tar.gz -C /usr/local/src && \
    rm /usr/local/src/${CHARMM_VER}.tar.gz

# Configure CHARMM in the same layer as the extraction if possible
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
# Build stage 2 - worker app for deployment on SPIN
FROM worker-step2 AS bilbomd-spin-worker
ARG USER_ID
ARG GROUP_ID
ARG GITHUB_TOKEN
RUN mkdir -p /app/node_modules
RUN mkdir -p /bilbomd/uploads
WORKDIR /app

# Create a user and group with the provided IDs
RUN mkdir -p /home/bilbo
RUN groupadd -g $GROUP_ID bilbomd && useradd -u $USER_ID -g $GROUP_ID -d /home/bilbo -s /bin/bash bilbo

# Change ownership of directories to the user and group
RUN chown -R bilbo:bilbomd /app /bilbomd/uploads /home/bilbo

# Update NPM
RUN npm install -g npm@10.8.2

# Switch to the non-root user
USER bilbo:bilbomd

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

# USER root
RUN chown -R 62704:0 /app

# Fire that bad boy up.
CMD ["npm", "start"]