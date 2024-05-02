# -----------------------------------------------------------------------------
# Build stage 1 - grab NodeJS v20 and update container.
FROM node:20-slim AS worker-step1
RUN apt-get update

# -----------------------------------------------------------------------------
# Build stage 2 - worker app for deployment on SPIN
FROM worker-step1 AS bilbomd-spin-worker

RUN mkdir -p /app/node_modules
RUN mkdir -p /bilbomd/uploads
WORKDIR /app

# Update NPM
RUN npm install -g npm@10.7.0

# Copy over the package*.json files
COPY package*.json .

# Install dependencies
RUN npm ci

# Copy the app code
COPY . .

# USER root
RUN chown -R 62704:0 /app

# Fire that bad boy up.
CMD ["npm", "start"]