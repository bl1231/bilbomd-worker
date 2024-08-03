# -----------------------------------------------------------------------------
# Build stage 1 - grab NodeJS v20 and update container.
FROM node:20-slim AS worker-step1
RUN apt-get update

# -----------------------------------------------------------------------------
# Build stage 2 - worker app for deployment on SPIN
FROM worker-step1 AS bilbomd-spin-worker
ARG GITHUB_TOKEN
RUN mkdir -p /app/node_modules
RUN mkdir -p /bilbomd/uploads
WORKDIR /app

# Update NPM
RUN npm install -g npm@10.8.2

# Copy over the package*.json files
COPY package*.json .

# Create .npmrc file using the build argument
RUN echo "//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}" > /root/.npmrc

# Install dependencies
RUN npm ci

# Optionally, clean up the environment variable for security
RUN unset GITHUB_TOKEN

# Copy the app code
COPY . .

# USER root
RUN chown -R 62704:0 /app

# Fire that bad boy up.
CMD ["npm", "start"]