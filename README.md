# bilbomd-worker

Processes BilboMD jobs and run CHARMM, FoXS, and MultiFoXS

## `bilbomd-worker` Description

`bilbomd-worker` is a simple [Typescript](https://www.typescriptlang.org/) NodeJS "worker" app that watches a BullMQ queue for incoming jobs. When a new job appears in the queue it will launch a sequence of processing tasks using CHARMM, FoXS, and MultiFoXS. The results will then be bundled up as a `results.tar.gz` file. The job progress will be updated in the main MongoDB database as well as in the BullMQ system (which uses Redis behind the scenes to store queue data).

## BilboMD processing pipeline

![BilboMD flow](scripts/bilbomd-flow.png)

## Deployment

To build the Docker image from the command line you must specify the CHARMM version.

```bash
docker build -t bl1231/bilbomd-worker:1 --build-arg CHARMM_VER=c47b2 .
```

The entire app is run within a [Docker](https://www.docker.com/) container. See the `Dockerfile` for details. It accesses BullMQ/Redis container using these env variables:

```bash
REDIS_URL=bilbomd-redis:6379
REDIS_HOST=bilbomd-redis
REDIS_PORT=6379
REDIS_PASSWORD=XXXXXXXXXXXXXXXXXXXXX
```

and the MongoDB container with these:

```bash
MONGO_PASSWORD=XXXXXXXXXXXXXXXXXXXXX
MONGO_HOSTNAME=hyperion.bl1231.als.lbl.gov
MONGO_PORT=27017
MONGO_DB=bilbomd
MONGO_AUTH_SRC=admin
```

All of these env settings (and some others) reside in a single `.env` file that is used by Docker Compose to build the suite of 4 services. This will be documented elsewhere. But for posterity they are:

- bilbomd-worker (this project)
- [bilbomd-backend](https://github.com/bl1231/bilbomd-backend)
- [bilbomd-mongodb](https://hub.docker.com/_/mongo) (official docker image from [Docker Hub](https://hub.docker.com/))
- [bilbomd-redis](https://hub.docker.com/_/redis)(official docker image [Docker Hub](https://hub.docker.com/))
