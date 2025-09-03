# -----------------------------------------------------------------------------
# Setup the base image for building (CUDA devel)
FROM nvidia/cuda:12.2.2-devel-ubuntu22.04 AS install-dependencies

RUN apt-get update && \
    apt-get install -y cmake gcc gfortran g++ wget libgl1-mesa-dev \
    build-essential libarchive13 zip python3-launchpadlib curl && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# -----------------------------------------------------------------------------
# Build CHARMM
FROM install-dependencies AS build_charmm
ARG CHARMM_VER=c49b1
RUN wget https://bl1231.als.lbl.gov/pickup/charmm/${CHARMM_VER}.tar.gz -O /usr/local/src/${CHARMM_VER}.tar.gz
RUN mkdir -p /usr/local/src/charmm && \
    tar -zxvf /usr/local/src/${CHARMM_VER}.tar.gz -C /usr/local/src && \
    rm /usr/local/src/${CHARMM_VER}.tar.gz && \
    cd /usr/local/src/charmm && \
    ./configure && \
    make -j$(nproc) -C build/cmake install && \
    strip /usr/local/src/charmm/bin/charmm || true

# -----------------------------------------------------------------------------
# Copy CHARMM binary (utility stage)
FROM build_charmm AS copy-charmm-binary
COPY --from=build_charmm /usr/local/src/charmm/bin/charmm /usr/local/bin/

# -----------------------------------------------------------------------------
# Install NodeJS (for building the app later)
FROM copy-charmm-binary AS install-node
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get update && \
    apt-get install -y nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# -----------------------------------------------------------------------------
# Miniforge / Conda base build stage
FROM install-node AS install-conda
# Download and install Miniforge3
RUN wget "https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-$(uname)-$(uname -m).sh" && \
    bash Miniforge3-$(uname)-$(uname -m).sh -b -p "/miniforge3" && \
    rm Miniforge3-$(uname)-$(uname -m).sh
# Add Conda to PATH
ENV PATH="/miniforge3/bin/:${PATH}"
RUN conda install --yes --name base -c conda-forge numpy scipy matplotlib \
    pillow numba h5py cython reportlab \
    dbus-python fabio pyfai hdf5plugin \
    mmcif_pdbx svglib python-igraph biopython && \
    conda clean -afy

# -----------------------------------------------------------------------------
# Install BioXTAS RAW
FROM install-conda AS install-bioxtas-raw
WORKDIR /tmp
RUN wget https://github.com/jbhopkins/bioxtasraw/archive/refs/heads/master.zip -O bioxtasraw-master.zip && \
    unzip bioxtasraw-master.zip && rm bioxtasraw-master.zip
WORKDIR /tmp/bioxtasraw-master
RUN python setup.py build_ext --inplace && \
    pip install . && \
    rm -rf /tmp/bioxtasraw-master

# -----------------------------------------------------------------------------
# Install IMP (FoXS & multi_foXS)
FROM install-bioxtas-raw AS install-imp
RUN apt-get update && \
    apt-get install -y --no-install-recommends software-properties-common && \
    add-apt-repository ppa:salilab/ppa && \
    apt-get update && \
    apt-get install -y --no-install-recommends imp && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# -----------------------------------------------------------------------------
# Install SANS tools, Pepsi-SANS, and Python deps
FROM install-imp AS install-sans-tools
RUN apt-get update && \
    apt-get install -y parallel && \
    apt-get clean && rm -rf /var/lib/apt/lists/*
RUN conda install --yes --name base -c conda-forge pandas dask && \
    conda clean -afy
RUN pip install lmfit
WORKDIR /tmp
RUN wget https://bl1231.als.lbl.gov/pickup/pepsisans/Pepsi-SANS-Linux.zip -O Pepsi-SANS-Linux.zip && \
    unzip Pepsi-SANS-Linux.zip && \
    mv Pepsi-SANS /usr/local/bin && \
    rm Pepsi-SANS-Linux.zip && \
    strip /usr/local/bin/Pepsi-SANS || true
COPY scripts/sans /usr/local/sans

# -----------------------------------------------------------------------------
# Install ATSAS (downloaded assets kept here; not copied unless needed)
FROM install-sans-tools AS install-atsas
RUN apt-get update && \
    apt-get install -y shared-mime-info libxkbcommon-x11-0 libxcb-cursor0 libxcb-icccm4 \
    libxcb-keysyms1 libxcb-shape0 libc6 libgcc-s1 libstdc++6 libxml2 libtiff5 liblzma5 libgfortran5 libicu70 libharfbuzz0b && \
    apt-get clean && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp
RUN wget https://bl1231.als.lbl.gov/pickup/atsas/ATSAS-4.0.1-1-Linux-Ubuntu-22.run -O ATSAS-4.0.1-1-Linux-Ubuntu-22.run && \
    wget https://bl1231.als.lbl.gov/pickup/atsas/atsas.lic -O atsas.lic
# (Installation commented out to avoid bloating builder; enable if needed)
# RUN mkdir /root/.local && chmod +x ATSAS-4.0.1-1-Linux-Ubuntu-22.run && \
#     ./ATSAS-4.0.1-1-Linux-Ubuntu-22.run --accept-licenses --auto-answer \
#     AutomaticRuntimeDependencyResolution=Yes --root /usr/local/ATSAS-4.0.1 --file-query KeyFilePath=/tmp/atsas.lic \
#     --confirm-command install && rm ATSAS-4.0.1-1-Linux-Ubuntu-22.run

# -----------------------------------------------------------------------------
# Build OpenMM from source and install
FROM install-atsas AS openmm-build
ARG OPENMM_BRANCH=master
ARG OPENMM_PREFIX=/opt/openmm-${OPENMM_BRANCH}
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    git build-essential cmake gfortran make wget ca-certificates bzip2 tar swig && \
    rm -rf /var/lib/apt/lists/*
RUN conda update -y -n base -c defaults conda && \
    conda create -y -n openmm python=3.12 numpy doxygen pip cython pyyaml && \
    conda clean -afy
ENV PATH=/miniforge3/envs/openmm/bin:/miniforge3/bin:${PATH}
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

# -----------------------------------------------------------------------------
# Build & install PDBFixer into the openmm env
FROM openmm-build AS pdbfixer-build
WORKDIR /tmp
RUN git clone https://github.com/openmm/pdbfixer.git && \
    cd pdbfixer && \
    python setup.py install

# -----------------------------------------------------------------------------
# Build Node app with devDependencies
FROM install-node AS node-build-deps
WORKDIR /app

ARG GITHUB_TOKEN

# Copy manifests and create .npmrc
COPY package*.json ./
RUN echo "//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}" > /root/.npmrc

# Install ALL deps (including devDeps, so npm-run-all is available)
RUN npm ci --no-audit --no-fund
RUN rm /root/.npmrc

# Copy sources
COPY tsconfig*.json ./
COPY src ./src
COPY scripts ./scripts

# Run build (works now because npm-run-all is installed)
RUN npm run build:ci


# -----------------------------------------------------------------------------
# Install only production dependencies
FROM install-node AS node-prod-deps
WORKDIR /app

ARG GITHUB_TOKEN

COPY package*.json ./
RUN echo "//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}" > /root/.npmrc
RUN npm ci --omit=dev --no-audit --no-fund
RUN rm /root/.npmrc

# -----------------------------------------------------------------------------
# Pack conda envs (base + openmm) to copy only runtime artifacts
FROM pdbfixer-build AS pack-openmm-env
RUN conda install -y -n base  -c conda-forge conda-pack && \
    conda install -y -n openmm -c conda-forge conda-pack && \
    conda clean -afy
RUN conda run -n openmm python -c "import sys; print(sys.version)" || true
RUN conda run -n base   python -c "import sys; print(sys.version)" || true
RUN conda run -n openmm conda-pack -n openmm -o /tmp/openmm-env.tar.gz
RUN conda run -n base   conda-pack -p /miniforge3 -o /tmp/base-env.tar.gz

# -----------------------------------------------------------------------------
# Slim final runtime image (CUDA runtime only)
FROM nvidia/cuda:12.2.2-runtime-ubuntu22.04 AS bilbomd-worker

ARG USER_ID
ARG GROUP_ID
ARG BILBOMD_WORKER_GIT_HASH
ARG BILBOMD_WORKER_VERSION
ARG OPENMM_BRANCH=master
ARG OPENMM_PREFIX=/opt/openmm-${OPENMM_BRANCH}

# Minimal runtime libs (no compilers). Add others only if required at runtime.
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates curl software-properties-common \
    libgfortran5 libstdc++6 libxml2 libtiff5 liblzma5 libicu70 libharfbuzz0b \
    parallel && \
    rm -rf /var/lib/apt/lists/*

# Install Node.js runtime so both `node` and `npm` are available in the final image
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

# IMP (FoXS) runtime via apt (no dev headers)
RUN add-apt-repository -y ppa:salilab/ppa && \
    apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends imp && \
    rm -rf /var/lib/apt/lists/*

# Create app dirs and non-root user
RUN mkdir -p /bilbomd/uploads /bilbomd/logs /opt/envs/openmm /opt/envs/base
WORKDIR /app
RUN groupadd -g ${GROUP_ID} bilbomd && \
    useradd -u ${USER_ID} -g ${GROUP_ID} -m -d /home/bilbo -s /bin/bash bilbo && \
    chown -R bilbo:bilbomd /app /bilbomd/uploads /bilbomd/logs /home/bilbo

# ---- Copy runtime artifacts from builder stages ----
# 1) CHARMM binary
COPY --from=build_charmm /usr/local/src/charmm/bin/charmm /usr/local/bin/charmm

# 2) Pepsi-SANS binary and helper scripts
COPY --from=install-sans-tools /usr/local/bin/Pepsi-SANS /usr/local/bin/Pepsi-SANS
COPY --from=install-sans-tools /usr/local/sans /usr/local/sans

# 3) OpenMM install tree (C++ libs and plugins) from openmm-build
COPY --from=openmm-build ${OPENMM_PREFIX} ${OPENMM_PREFIX}

# 4) Conda envs (openmm + base) from conda-pack stage
COPY --from=pack-openmm-env /tmp/openmm-env.tar.gz /tmp/openmm-env.tar.gz
COPY --from=pack-openmm-env /tmp/base-env.tar.gz   /tmp/base-env.tar.gz
RUN mkdir -p /opt/envs/openmm /opt/envs/base && \
    cd /opt/envs/openmm && tar -xzf /tmp/openmm-env.tar.gz && ./bin/conda-unpack || true && \
    cd /opt/envs/base   && tar -xzf /tmp/base-env.tar.gz   && ./bin/conda-unpack || true && \
    rm -f /tmp/openmm-env.tar.gz /tmp/base-env.tar.gz

# 5) Node app: dist + production node_modules
ENV NODE_ENV=production
COPY --from=node-build-deps /app/dist ./dist
COPY --from=node-prod-deps /app/node_modules ./node_modules
COPY --from=node-prod-deps /app/package*.json ./

# ---- Runtime environment ----
# ENV PATH="/opt/envs/openmm/bin:/opt/envs/base/bin:${PATH}"
ENV OPENMM_HOME="${OPENMM_PREFIX}"
ENV OPENMM_DIR="${OPENMM_PREFIX}"
ENV OPENMM_INCLUDE_DIR="${OPENMM_PREFIX}/include"
ENV OPENMM_LIBRARY="${OPENMM_PREFIX}/lib"
ENV OPENMM_LIBRARIES="${OPENMM_PREFIX}/lib"
ENV OPENMM_PLUGIN_DIR="${OPENMM_PREFIX}/lib/plugins"
ENV BILBOMD_WORKER_GIT_HASH=${BILBOMD_WORKER_GIT_HASH}
ENV BILBOMD_WORKER_VERSION=${BILBOMD_WORKER_VERSION}

USER bilbo:bilbomd
EXPOSE 3000
CMD ["node", "dist/worker.js"]