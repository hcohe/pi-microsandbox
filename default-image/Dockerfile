# syntax=docker/dockerfile:1

# Use the official language images as architecture-aware toolchain sources. The
# major/minor tags receive patch and security updates when this image is rebuilt.
ARG NODE_VERSION=22
ARG GO_VERSION=1.26
ARG RUST_VERSION=1.98

FROM node:${NODE_VERSION}-bookworm-slim AS node-toolchain
FROM golang:${GO_VERSION}-bookworm AS go-toolchain
FROM rust:${RUST_VERSION}-slim-bookworm AS rust-toolchain

FROM ubuntu:24.04

LABEL org.opencontainers.image.source="https://github.com/hcohe/pi-microsandbox" \
      org.opencontainers.image.description="Default sandbox image for pi-microsandbox" \
      org.opencontainers.image.licenses="MIT"

# Copy current, multi-architecture Node.js, Go, and Rust toolchains instead of
# Ubuntu's older language packages. Python and the other runtimes come from
# Ubuntu so they continue to receive distribution security updates.
COPY --from=node-toolchain /usr/local/ /usr/local/
COPY --from=node-toolchain /opt/ /opt/
COPY --from=go-toolchain /usr/local/go/ /usr/local/go/
COPY --from=rust-toolchain /usr/local/cargo/ /usr/local/cargo/
COPY --from=rust-toolchain /usr/local/rustup/ /usr/local/rustup/

ENV CARGO_HOME=/usr/local/cargo \
    GOPATH=/go \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    RUSTUP_HOME=/usr/local/rustup \
    PATH="/usr/local/cargo/bin:/usr/local/go/bin:/go/bin:${PATH}"

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        acl \
        autoconf \
        automake \
        bash-completion \
        bat \
        bc \
        bison \
        build-essential \
        ca-certificates \
        clang \
        clang-format \
        clang-tidy \
        cmake \
        composer \
        curl \
        default-jdk-headless \
        dnsutils \
        fd-find \
        file \
        flex \
        fzf \
        gawk \
        gdb \
        gettext \
        gh \
        git \
        git-lfs \
        gnupg \
        graphviz \
        iproute2 \
        iputils-ping \
        jq \
        less \
        libatomic1 \
        libffi-dev \
        libssl-dev \
        libtool \
        lsof \
        lua5.4 \
        luarocks \
        make \
        maven \
        nano \
        netcat-openbsd \
        ninja-build \
        openssh-client \
        openssl \
        patch \
        perl \
        php-cli \
        php-curl \
        php-mbstring \
        php-xml \
        pipx \
        pkg-config \
        procps \
        protobuf-compiler \
        python-is-python3 \
        python3 \
        python3-dev \
        python3-pip \
        python3-venv \
        ripgrep \
        rsync \
        ruby-bundler \
        ruby-full \
        shellcheck \
        shfmt \
        sqlite3 \
        strace \
        sudo \
        tar \
        tcpdump \
        tmux \
        tree \
        universal-ctags \
        unzip \
        vim \
        wget \
        xz-utils \
        zip \
        zstd \
    && git lfs install --system \
    && ln -s /usr/bin/batcat /usr/local/bin/bat \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && ln -s /usr/bin/pip3 /usr/local/bin/pip \
    && install -d -m 1777 /go \
    && rm -rf /var/lib/apt/lists/*
