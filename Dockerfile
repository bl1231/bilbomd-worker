FROM debian:bullseye AS builder
RUN apt-get update && apt-get install -y cmake gcc gfortran g++

FROM builder AS config_charmm
WORKDIR /usr/local/src
ARG CHARMM_VER
COPY ./charmm/${CHARMM_VER}.tar.gz ./
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

FROM node:18-bullseye AS bilbomd-worker
COPY --from=build_charmm /usr/local/src/charmm/bin/charmm /usr/local/bin/
COPY --from=build_imp /usr/local/src/imp_release/bin/foxs /usr/local/bin/
COPY --from=build_imp /usr/local/src/imp_release/bin/multi_foxs /usr/local/bin/
RUN apt-get update && apt-get install -y perl ncat gfortran
RUN mkdir -p /home/node/app/node_modules && chown -R node:node /home/node/app
WORKDIR /home/node/app
COPY --chown=node:node package*.json ./
#USER node
RUN npm install
COPY --chown=node:node . .
CMD [ "npm", "run", "worker" ]
#CMD ["npm", "start"]