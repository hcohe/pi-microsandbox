#!/bin/bash

set -euo pipefail

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
unset BASH_ENV ENV CDPATH GLOBIGNORE \
    DOCKER_HOST DOCKER_CONTEXT DOCKER_TLS DOCKER_TLS_VERIFY DOCKER_CERT_PATH \
    LD_PRELOAD LD_LIBRARY_PATH
umask 077

readonly docker_socket=/var/run/docker.sock
readonly docker_host=unix:///var/run/docker.sock
readonly docker_pidfile=/run/docker.pid
readonly docker_log=/var/log/pi-msb-dockerd.log
readonly start_lock=/run/pi-msb-docker-start.lock
readonly launch_owner=/run/pi-msb-docker-launch.owner
readonly socket_owner=/run/pi-msb-docker-socket.owner

usage() {
    printf 'usage: pi-msb-docker-start <startup-timeout-ms>\n' >&2
    exit 2
}

[[ $# -eq 1 && "$1" =~ ^[0-9]+$ ]] || usage
readonly timeout_ms="$1"
(( timeout_ms >= 1 && timeout_ms <= 300000 )) || usage
readonly deadline_ns=$(( $(/usr/bin/date +%s%N) + timeout_ms * 1000000 ))

process_start_time() {
    local pid="$1"
    /usr/bin/awk '{ print $22; exit }' "/proc/${pid}/stat" 2>/dev/null
}

pending_launch_snapshot() {
    [[ -r "${launch_owner}" ]] || return 1
    local token pid recorded_start actual_start executable
    token=""; pid=""; recorded_start=""
    read -r token pid recorded_start < "${launch_owner}" || return 1
    [[ "${token}" =~ ^[0-9a-f-]{36}$ && "${pid}" =~ ^[0-9]+$ && "${recorded_start}" =~ ^[0-9]+$ ]] || return 1
    kill -0 "${pid}" 2>/dev/null || return 1
    actual_start="$(process_start_time "${pid}" || true)"
    [[ "${actual_start}" == "${recorded_start}" ]] || return 1
    executable="$(/usr/bin/readlink "/proc/${pid}/exe" 2>/dev/null || true)"
    case "${executable}" in
        /bin/bash|/usr/bin/bash|/usr/local/bin/dockerd) ;;
        *) return 1 ;;
    esac
    printf '%s %s %s\n' "${token}" "${pid}" "${recorded_start}"
}

launch_snapshot() {
    [[ -r "${launch_owner}" && -r "${docker_pidfile}" ]] || return 1
    local token pid recorded_start pidfile_pid actual_start executable
    token=""; pid=""; recorded_start=""; pidfile_pid=""
    read -r token pid recorded_start < "${launch_owner}" || return 1
    read -r pidfile_pid < "${docker_pidfile}" || true
    [[ "${token}" =~ ^[0-9a-f-]{36}$ && "${pid}" =~ ^[0-9]+$ && \
       "${recorded_start}" =~ ^[0-9]+$ && "${pidfile_pid}" == "${pid}" ]] || return 1
    kill -0 "${pid}" 2>/dev/null || return 1
    actual_start="$(process_start_time "${pid}" || true)"
    [[ "${actual_start}" == "${recorded_start}" ]] || return 1
    executable="$(/usr/bin/readlink "/proc/${pid}/exe" 2>/dev/null || true)"
    [[ "${executable}" == "/usr/local/bin/dockerd" ]] || return 1
    /usr/bin/tr '\0' '\n' < "/proc/${pid}/environ" 2>/dev/null |
        /usr/bin/grep -Fxq "PI_MSB_DOCKER_OWNER=${token}" || return 1
    printf '%s %s %s\n' "${token}" "${pid}" "${recorded_start}"
}

socket_snapshot() {
    [[ -S "${docker_socket}" ]] || return 1
    local token pid start filesystem_inode socket_inode fd target
    read -r token pid start < <(launch_snapshot) || return 1
    filesystem_inode="$(/usr/bin/stat -Lc '%d:%i' "${docker_socket}" 2>/dev/null || true)"
    [[ "${filesystem_inode}" =~ ^[0-9]+:[0-9]+$ ]] || return 1
    while read -r socket_inode; do
        [[ "${socket_inode}" =~ ^[0-9]+$ ]] || continue
        for fd in "/proc/${pid}/fd/"*; do
            target="$(/usr/bin/readlink "${fd}" 2>/dev/null || true)"
            if [[ "${target}" == "socket:[${socket_inode}]" ]]; then
                printf '%s %s %s %s %s\n' \
                    "${token}" "${pid}" "${start}" "${filesystem_inode}" "${socket_inode}"
                return 0
            fi
        done
    done < <(/usr/bin/awk -v path="${docker_socket}" \
        '$8 == path || $8 == "/run/docker.sock" { print $7 }' /proc/net/unix 2>/dev/null)
    return 1
}

local_docker_reachable() {
    /usr/local/bin/docker --host="${docker_host}" info >/dev/null 2>&1
}

local_docker_ready() {
    [[ -r "${socket_owner}" ]] || return 1
    local expected before after
    expected=""; before=""; after=""
    read -r expected < "${socket_owner}" || return 1
    before="$(socket_snapshot || true)"
    [[ -n "${before}" && "${before}" == "${expected}" ]] || return 1
    local_docker_reachable || return 1
    after="$(socket_snapshot || true)"
    [[ "${after}" == "${before}" && "${after}" == "${expected}" ]]
}

publish_socket_owner() {
    local before after temporary
    before="$(socket_snapshot || true)"
    [[ -n "${before}" ]] || return 1
    local_docker_reachable || return 1
    after="$(socket_snapshot || true)"
    [[ "${after}" == "${before}" ]] || return 1
    temporary="${socket_owner}.tmp.$$"
    printf '%s\n' "${after}" > "${temporary}"
    /usr/bin/chmod 0600 "${temporary}"
    /usr/bin/mv -f -- "${temporary}" "${socket_owner}"
    if ! local_docker_ready; then
        /usr/bin/rm -f -- "${socket_owner}"
        return 1
    fi
}

socket_has_listener() {
    /usr/bin/awk -v path="${docker_socket}" \
        '$8 == path || $8 == "/run/docker.sock" { found=1 } END { exit !found }' \
        /proc/net/unix 2>/dev/null
}

socket_path_matches_marker() {
    [[ -S "${docker_socket}" && -r "${socket_owner}" ]] || return 1
    local token pid start expected_inode socket_inode actual_inode
    token=""; pid=""; start=""; expected_inode=""; socket_inode=""
    read -r token pid start expected_inode socket_inode < "${socket_owner}" || return 1
    actual_inode="$(/usr/bin/stat -Lc '%d:%i' "${docker_socket}" 2>/dev/null || true)"
    [[ "${expected_inode}" == "${actual_inode}" && "${actual_inode}" =~ ^[0-9]+:[0-9]+$ ]]
}

stale_launch_record() {
    [[ -r "${launch_owner}" && -r "${docker_pidfile}" ]] || return 1
    local token pid start pidfile_pid
    token=""; pid=""; start=""; pidfile_pid=""
    read -r token pid start < "${launch_owner}" || return 1
    read -r pidfile_pid < "${docker_pidfile}" || true
    [[ "${token}" =~ ^[0-9a-f-]{36}$ && "${pid}" =~ ^[0-9]+$ && \
       "${start}" =~ ^[0-9]+$ && "${pidfile_pid}" == "${pid}" ]] || return 1
    ! kill -0 "${pid}" 2>/dev/null
}

cleanup_stale_state() {
    if [[ -e "${docker_socket}" ]]; then
        if socket_has_listener; then
            return 1
        fi
        if ! socket_path_matches_marker && ! stale_launch_record; then
            return 1
        fi
        /usr/bin/rm -f -- "${docker_socket}"
    fi
    if [[ -r "${docker_pidfile}" ]]; then
        local pid
        pid=""
        read -r pid < "${docker_pidfile}" || true
        if [[ "${pid}" =~ ^[0-9]+$ ]] && kill -0 "${pid}" 2>/dev/null; then
            return 1
        fi
    fi
    /usr/bin/rm -f -- "${docker_pidfile}" "${launch_owner}" "${socket_owner}"
}

if local_docker_ready; then
    exit 0
fi

/usr/bin/install -d -m 0700 /run
: > "${start_lock}"
/usr/bin/chmod 0600 "${start_lock}"
printf -v timeout_seconds '%d.%03d' "$((timeout_ms / 1000))" "$((timeout_ms % 1000))"
exec 9> "${start_lock}"
if ! /usr/bin/flock --exclusive --timeout "${timeout_seconds}" 9; then
    printf 'Timed out waiting for another Docker startup attempt.\n' >&2
    exit 1
fi

if local_docker_ready; then
    exit 0
fi

if launch_snapshot >/dev/null 2>&1 || pending_launch_snapshot >/dev/null 2>&1; then
    : # Safely adopt an exact pending or established launch from an interrupted helper.
elif ! cleanup_stale_state; then
    printf 'Docker runtime ownership is unknown; refusing to replace or use it.\n' >&2
    exit 1
else
    /usr/bin/install -d -m 0700 /run/docker /var/lib/docker /var/lib/docker/tmp
    /usr/bin/install -d -m 0755 /var/log
    /usr/sbin/sysctl -q -w net.ipv4.ip_forward=1
    : > "${docker_log}"
    /usr/bin/chmod 0600 "${docker_log}"
    token="$(< /proc/sys/kernel/random/uuid)"
    (
        exec 9>&-
        trap '' HUP
        daemon_pid="${BASHPID}"
        daemon_start="$(process_start_time "${daemon_pid}")"
        temporary="${launch_owner}.tmp.${daemon_pid}"
        printf '%s %s %s\n' "${token}" "${daemon_pid}" "${daemon_start}" > "${temporary}"
        /usr/bin/chmod 0600 "${temporary}"
        /usr/bin/mv -f -- "${temporary}" "${launch_owner}"
        export PI_MSB_DOCKER_OWNER="${token}"
        export DOCKER_TMPDIR=/var/lib/docker/tmp
        exec /usr/local/bin/dockerd \
            --host=unix:///var/run/docker.sock \
            --data-root=/var/lib/docker \
            --exec-root=/run/docker \
            --pidfile=/run/docker.pid \
            --storage-driver=vfs \
            --ip-forward-no-drop
    ) >> "${docker_log}" 2>&1 &
fi

while (( $(/usr/bin/date +%s%N) < deadline_ns )); do
    if publish_socket_owner; then
        exit 0
    fi
    if [[ -r "${launch_owner}" ]] && ! pending_launch_snapshot >/dev/null 2>&1; then
        break
    fi
    /usr/bin/sleep 0.1
done

if snapshot="$(pending_launch_snapshot 2>/dev/null)"; then
    read -r _ daemon_pid _ <<< "${snapshot}"
    kill "${daemon_pid}" 2>/dev/null || true
    for _ in {1..50}; do
        kill -0 "${daemon_pid}" 2>/dev/null || break
        /usr/bin/sleep 0.1
    done
fi
cleanup_stale_state || true
printf 'Docker daemon did not become ready within %s ms; see %s inside the sandbox.\n' \
    "${timeout_ms}" "${docker_log}" >&2
exit 1
