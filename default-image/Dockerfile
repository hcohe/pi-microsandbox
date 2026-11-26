# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32

ARG IMAGE_VERSION=dev

FROM docker.io/library/ubuntu:26.04@sha256:513c074113a871b51a8d16ab445c88779d6452d937a164fb5cc479f32668a41d AS assembled

ARG DEBIAN_FRONTEND=noninteractive
ARG TARGETARCH

# Follow the system trust store when Microsandbox adds its runtime interception CA.
ENV AWS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
    CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE=/etc/ssl/certs/ca-certificates.crt \
    CARGO_HOME=/usr/local/cargo \
    GOPATH=/go \
    GOTOOLCHAIN=local \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    RUSTUP_HOME=/usr/local/rustup \
    PATH="/usr/local/cargo/bin:/usr/local/go/bin:/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# Use Ubuntu's normal signed repositories, as supplied by the pinned base.
RUN apt-get update --error-on=any -o Acquire::Retries=3 \
    && apt-get install -y --no-install-recommends -o Acquire::Retries=3 \
        ca-certificates \
        curl \
        file \
        git \
        ripgrep \
    && rm -rf \
        /var/lib/apt/lists/* \
        /var/cache/apt/archives/*

COPY install/ /opt/pi-image-install/
COPY verify/ /opt/pi-image-verify/

RUN set -eux; \
    /opt/pi-image-install/docker.sh; \
    /opt/pi-image-install/gcloud.sh; \
    /opt/pi-image-install/aws.sh; \
    /opt/pi-image-install/dispatch.sh; \
    rm -rf /opt/pi-image-install; \
    /opt/pi-image-verify/dispatch.sh; \
    rm -rf \
        /opt/pi-image-verify \
        /root/.cache \
        /root/.cargo/registry \
        /root/.npm \
        /tmp/* \
        /var/cache/apt/archives/* \
        /var/lib/apt/lists/*; \
    test ! -e /opt/pi-image-install; \
    test ! -e /opt/pi-image-verify

# Copying the assembled filesystem into a fresh final stage keeps installer and
# verifier sources, temporary probes, and their build layers out of the image.
FROM scratch AS default

ARG IMAGE_VERSION

LABEL org.opencontainers.image.source="https://github.com/hcohe/pi-microsandbox" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.description="pi-microsandbox default sandbox image" \
      org.opencontainers.image.variant="default" \
      org.opencontainers.image.version="${IMAGE_VERSION}"

COPY --from=assembled / /

# COPY carries files, not the assembled stage's ENV. Keep runtime trust configured.
ENV AWS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
    CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE=/etc/ssl/certs/ca-certificates.crt \
    CARGO_HOME=/usr/local/cargo \
    GOPATH=/go \
    GOTOOLCHAIN=local \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    RUSTUP_HOME=/usr/local/rustup \
    PATH="/usr/local/cargo/bin:/usr/local/go/bin:/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

CMD ["/bin/bash"]
