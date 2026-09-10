# syntax=docker/dockerfile:1

# Use official, architecture-aware images for tools that are newer than Ubuntu's
# packages. Major/minor tags receive patch updates when this image is rebuilt.
ARG NODE_VERSION=24
ARG GO_VERSION=1.26
ARG RUST_VERSION=1.98
ARG UV_VERSION=0.12.12
ARG YQ_VERSION=4.53.6
ARG CRANE_VERSION=v0.22.1
ARG WATCHEXEC_VERSION=2.7.2
ARG PLAYWRIGHT_VERSION=1.63.0
ARG AGENT_BROWSER_VERSION=0.37.1
ARG PNPM_VERSION=12.3.4
ARG YARN_VERSION=1.22.22

FROM node:${NODE_VERSION}-bookworm-slim AS node-toolchain

FROM golang:${GO_VERSION}-bookworm AS go-toolchain
ARG TARGETARCH
ARG WATCHEXEC_VERSION
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends xz-utils; \
    rm -rf /var/lib/apt/lists/*; \
    case "${TARGETARCH}" in \
        amd64) watchexec_arch=x86_64; watchexec_sha256=a2c01f82fb4cdafca1fa12cb88e4a1145dec63364dbdf92664efbaac3bb44dd2 ;; \
        arm64) watchexec_arch=aarch64; watchexec_sha256=83cbce2ffc85adaab14d6ded09b292f4383358ac6d9a51b4e4e083df0cb7c831 ;; \
        *) echo "Unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    archive="watchexec-${WATCHEXEC_VERSION}-${watchexec_arch}-unknown-linux-musl.tar.xz"; \
    curl -fsSL "https://github.com/watchexec/watchexec/releases/download/v${WATCHEXEC_VERSION}/${archive}" -o "/tmp/${archive}"; \
    echo "${watchexec_sha256}  /tmp/${archive}" | sha256sum -c -; \
    tar -xJf "/tmp/${archive}" -C /tmp; \
    install -m 0755 "/tmp/${archive%.tar.xz}/watchexec" /usr/local/bin/watchexec

FROM rust:${RUST_VERSION}-slim-bookworm AS rust-toolchain
FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv-toolchain
FROM mikefarah/yq:${YQ_VERSION} AS yq-toolchain
FROM gcr.io/go-containerregistry/crane:${CRANE_VERSION} AS crane-toolchain

FROM ubuntu:26.04

LABEL org.opencontainers.image.source="https://github.com/hcohe/pi-microsandbox" \
      org.opencontainers.image.description="Default sandbox image for pi-microsandbox" \
      org.opencontainers.image.licenses="MIT"

COPY --from=node-toolchain /usr/local/ /usr/local/
COPY --from=go-toolchain /usr/local/go/ /usr/local/go/
COPY --from=go-toolchain /usr/local/bin/watchexec /usr/local/bin/watchexec
COPY --from=rust-toolchain /usr/local/cargo/ /usr/local/cargo/
COPY --from=rust-toolchain /usr/local/rustup/ /usr/local/rustup/
COPY --from=uv-toolchain /uv /uvx /usr/local/bin/
COPY --from=yq-toolchain /usr/bin/yq /usr/local/bin/yq
COPY --from=crane-toolchain /ko-app/crane /usr/local/bin/crane

ENV AGENT_BROWSER_ARGS=--no-sandbox \
    AGENT_BROWSER_EXECUTABLE_PATH=/usr/local/bin/chromium \
    CARGO_HOME=/usr/local/cargo \
    COREPACK_HOME=/usr/local/share/corepack \
    GOPATH=/go \
    GOTOOLCHAIN=local \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PYTHONDONTWRITEBYTECODE=1 \
    RUSTUP_HOME=/usr/local/rustup \
    PATH="/usr/local/cargo/bin:/usr/local/go/bin:/go/bin:${PATH}"

ARG DEBIAN_FRONTEND=noninteractive
ARG PLAYWRIGHT_VERSION
ARG AGENT_BROWSER_VERSION
ARG PNPM_VERSION
ARG YARN_VERSION

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        acl \
        autoconf \
        automake \
        bash \
        bash-completion \
        bat \
        bc \
        bind9-dnsutils \
        binutils-gold \
        bison \
        build-essential \
        bzip2 \
        ca-certificates \
        clang \
        clang-format \
        clang-tidy \
        cmake \
        composer \
        curl \
        default-jdk-headless \
        default-mysql-client \
        diffutils \
        fd-find \
        file \
        findutils \
        flex \
        fzf \
        g++ \
        gawk \
        gcc \
        gdb \
        gettext \
        gh \
        git \
        git-lfs \
        gnupg \
        graphviz \
        grep \
        gzip \
        httpie \
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
        postgresql-client \
        procps \
        protobuf-compiler \
        psmisc \
        python-is-python3 \
        python3 \
        python3-dev \
        python3-pip \
        python3-venv \
        redis-tools \
        ripgrep \
        rsync \
        ruby-bundler \
        ruby-full \
        sed \
        shellcheck \
        shfmt \
        skopeo \
        sqlite3 \
        strace \
        sudo \
        tar \
        tcpdump \
        time \
        tmux \
        traceroute \
        tree \
        universal-ctags \
        unzip \
        vim \
        w3m \
        wget \
        xz-utils \
        zip \
        zlib1g-dev \
        zstd \
    && git lfs install --system \
    && ln -s /usr/bin/batcat /usr/local/bin/bat \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && ln -s /usr/bin/pip3 /usr/local/bin/pip \
    && install -d -m 1777 /go /ms-playwright \
    && rm -rf /var/lib/apt/lists/*

# Install package-manager shims, browser automation CLIs, and Playwright's
# compatible Chromium build plus its Ubuntu 26.04 system dependencies.
RUN rm -f /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && corepack enable \
    && corepack install --global "pnpm@${PNPM_VERSION}" "yarn@${YARN_VERSION}" \
    && npm install --global \
        "agent-browser@${AGENT_BROWSER_VERSION}" \
        "playwright@${PLAYWRIGHT_VERSION}" \
    && playwright install --with-deps chromium \
    && chromium_path="$(node -e "console.log(require('/usr/local/lib/node_modules/playwright').chromium.executablePath())")" \
    && ln -s "${chromium_path}" /usr/local/bin/chromium \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/*

# Fail the build if a requested CLI or the headless browser is unavailable.
RUN set -eux; \
    for tool in \
        agent-browser awk autoconf automake bash bzip2 cargo chromium clang cmake \
        composer corepack crane curl diff dig fd file find fzf g++ gcc gdb gh git \
        git-lfs go grep gzip http ip jq killall less lsof lua make maven mysql nc \
        ninja node npm nslookup openssl patch ping pip pipx pkg-config playwright \
        pnpm ps psql python python3 redis-cli rg rsync rustc sed shellcheck shfmt \
        skopeo sqlite3 ssh strace tar time traceroute tree unzip update-ca-certificates \
        uv uvx watchexec w3m wget xz yarn yq zip zstd; \
    do \
        command -v "${tool}"; \
    done; \
    dpkg-query --status ca-certificates libffi-dev libssl-dev zlib1g-dev >/dev/null; \
    chromium --headless --no-sandbox --disable-gpu --dump-dom 'data:text/html,<title>ok</title>' | grep -q '<title>ok</title>'
