# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32

ARG IMAGE_VARIANT=default
ARG TOOLCHAINS="node python rust go"
ARG IMAGE_VERSION=dev
# Ubuntu archive state used by every apt operation during image assembly.
ARG UBUNTU_SNAPSHOT=20260910T000000Z

FROM docker.io/library/ubuntu:26.04@sha256:513c074113a871b51a8d16ab445c88779d6452d937a164fb5cc479f32668a41d AS assembled

ARG DEBIAN_FRONTEND=noninteractive
ARG TARGETARCH
ARG IMAGE_VARIANT
ARG TOOLCHAINS
ARG UBUNTU_SNAPSHOT

ENV CARGO_HOME=/usr/local/cargo \
    GOPATH=/go \
    GOTOOLCHAIN=local \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    RUSTUP_HOME=/usr/local/rustup \
    PATH="/usr/local/cargo/bin:/usr/local/go/bin:/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# The minimal base has no CA bundle yet. This vendored ISRG Root X1 trust
# anchor bootstraps authenticated snapshot HTTPS until ca-certificates installs.
COPY install/ubuntu-snapshot-ca.pem /opt/pi-image-bootstrap/ubuntu-snapshot-ca.pem

# Use the explicit snapshot URL for both primary and ports architectures. Apt's
# Snapshot field is not supported by ports.ubuntu.com. Preserve and later
# restore the base image's normal runtime sources.
RUN set -eux; \
    test "${UBUNTU_SNAPSHOT}" = "20260910T000000Z"; \
    sources=/etc/apt/sources.list.d/ubuntu.sources; \
    runtime_sources=/etc/apt/ubuntu.sources.runtime; \
    test -f "${sources}"; \
    test ! -e "${runtime_sources}"; \
    signed_by_count="$(grep -c '^Signed-By:' "${sources}")"; \
    uri_count="$(grep -c '^URIs:' "${sources}")"; \
    test "${signed_by_count}" = 2; \
    test "${uri_count}" = 2; \
    case "${TARGETARCH}" in \
        amd64) \
            test "$(grep -c '^URIs: http://archive.ubuntu.com/ubuntu/$' "${sources}")" = 1; \
            test "$(grep -c '^URIs: http://security.ubuntu.com/ubuntu/$' "${sources}")" = 1; \
            ;; \
        arm64) \
            test "$(grep -c '^URIs: http://ports.ubuntu.com/ubuntu-ports/$' "${sources}")" = 2; \
            ;; \
        *) \
            printf 'Unsupported architecture: %s\n' "${TARGETARCH}" >&2; \
            exit 1; \
            ;; \
    esac; \
    cp "${sources}" "${runtime_sources}"; \
    sed -i "s|^URIs: .*$|URIs: https://snapshot.ubuntu.com/ubuntu/${UBUNTU_SNAPSHOT}/|" "${sources}"; \
    test "$(grep -c "^URIs: https://snapshot.ubuntu.com/ubuntu/${UBUNTU_SNAPSHOT}/\$" "${sources}")" = 2; \
    test -s /opt/pi-image-bootstrap/ubuntu-snapshot-ca.pem; \
    printf '%s\n' \
        'Acquire::https::snapshot.ubuntu.com::CaInfo "/opt/pi-image-bootstrap/ubuntu-snapshot-ca.pem";' \
        > /etc/apt/apt.conf.d/00pi-microsandbox-snapshot-ca

# Ubuntu already supplies bash and coreutils. Keep the base contract deliberately
# small; language-specific build dependencies belong to their installers.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        file \
        git \
        ripgrep \
    && rm -rf \
        /etc/apt/apt.conf.d/00pi-microsandbox-snapshot-ca \
        /opt/pi-image-bootstrap \
        /var/lib/apt/lists/* \
        /var/cache/apt/archives/*

COPY install/ /opt/pi-image-install/
COPY verify/ /opt/pi-image-verify/

RUN set -eux; \
    test -n "${IMAGE_VARIANT}"; \
    /opt/pi-image-install/dispatch.sh "${TOOLCHAINS}"; \
    rm -rf /opt/pi-image-install; \
    /opt/pi-image-verify/dispatch.sh "${IMAGE_VARIANT}" "${TOOLCHAINS}"; \
    rm -rf \
        /opt/pi-image-verify \
        /root/.cache \
        /root/.cargo/registry \
        /root/.npm \
        /tmp/* \
        /var/cache/apt/archives/* \
        /var/lib/apt/lists/*; \
    sources=/etc/apt/sources.list.d/ubuntu.sources; \
    runtime_sources=/etc/apt/ubuntu.sources.runtime; \
    test -f "${runtime_sources}"; \
    mv "${runtime_sources}" "${sources}"; \
    test "$(grep -c '^URIs: https://snapshot.ubuntu.com/' "${sources}" || true)" = 0; \
    test ! -e /opt/pi-image-install; \
    test ! -e /opt/pi-image-verify

# Copying the assembled filesystem into a fresh final stage keeps installer and
# verifier sources, temporary probes, and their build layers out of every image.
FROM scratch AS default

ARG IMAGE_VARIANT
ARG IMAGE_VERSION
ARG UBUNTU_SNAPSHOT

LABEL org.opencontainers.image.source="https://github.com/hcohe/pi-microsandbox" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.description="pi-microsandbox ${IMAGE_VARIANT} sandbox image" \
      org.opencontainers.image.variant="${IMAGE_VARIANT}" \
      org.opencontainers.image.version="${IMAGE_VERSION}" \
      io.github.hcohe.pi-microsandbox.ubuntu-snapshot="${UBUNTU_SNAPSHOT}"

COPY --from=assembled / /

ENV CARGO_HOME=/usr/local/cargo \
    GOPATH=/go \
    GOTOOLCHAIN=local \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    RUSTUP_HOME=/usr/local/rustup \
    PATH="/usr/local/cargo/bin:/usr/local/go/bin:/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

CMD ["/bin/bash"]
