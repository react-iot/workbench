# Two-stage-ish build that lands a runtime image with:
#   - Deno (runs bin/server.ts)
#   - Node (runs bin/serial-worker.js and bin/cp210x-write-serial.js as subprocesses)
#   - libusb-1.0 (required by the usb npm package for CP210x serial rewrite)
#
# Built for the RPi / SBC swarm worker — set DOCKER_DEFAULT_PLATFORM=linux/arm64
# when building from a non-arm host, or use `docker buildx build --platform
# linux/arm64,linux/amd64 ...` for a multi-arch image.

FROM node:20-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip \
      libusb-1.0-0 libudev1 \
      usbutils \
 && rm -rf /var/lib/apt/lists/*

# Install Deno into /usr/local/bin so it's on PATH for any user.
ENV DENO_INSTALL=/usr/local
RUN curl -fsSL https://deno.land/install.sh | sh -s -- --yes \
 && deno --version

WORKDIR /app

# Leverage Docker layer cache: copy manifests first.
COPY deno.json deno.lock* ./

# Copy source tree.
COPY bin ./bin
COPY src ./src
COPY public ./public
COPY tools ./tools

# Pre-fetch all npm deps into node_modules and compile native bindings for
# this image's target arch. Then patch esptool-js's bundler-dependent imports.
# `--allow-scripts` is needed for the `usb` package's postinstall (node-gyp).
RUN deno install --node-modules-dir --allow-scripts bin/server.ts \
 && deno task patch-deps

# HTTP UI (4000), RFC2217 default range (4001-4010), and mDNS (5353/udp via
# host networking). When deploying in swarm we use host networking so the
# published-ports block here is informational; it's only effective for
# `docker compose up` on a non-swarm host.
EXPOSE 4000 4001-4010 5353/udp

ENV PORT=4000 \
    RFC2217_HOST=0.0.0.0

CMD ["deno", "task", "start"]
