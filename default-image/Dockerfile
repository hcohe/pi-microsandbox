FROM ubuntu:24.04

LABEL org.opencontainers.image.source="https://github.com/hcohe/pi-microsandbox" \
      org.opencontainers.image.description="Default sandbox image for pi-microsandbox" \
      org.opencontainers.image.licenses="MIT"

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        file \
        git \
        ripgrep \
    && rm -rf /var/lib/apt/lists/*
