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
readonly docker_exec_root=/run/docker
readonly docker_log=/var/log/pi-msb-dockerd.log
readonly start_lock=/run/pi-msb-docker-start.lock
readonly launch_owner=/run/pi-msb-docker-launch.owner
readonly socket_owner=/run/pi-msb-docker-socket.owner

current_boot_id=""
IFS= read -r current_boot_id < /proc/sys/kernel/random/boot_id || {
    printf 'Unable to determine the current kernel boot ID.\n' >&2
    exit 1
}
[[ "${current_boot_id}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || {
    printf 'Kernel boot ID is malformed; refusing to start Docker.\n' >&2
    exit 1
}
readonly current_boot_id

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

is_uuid() {
    [[ "$1" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]
}

path_absent() {
    [[ ! -e "$1" && ! -L "$1" ]]
}

safe_metadata_file() {
    [[ -f "$1" && ! -L "$1" ]] || return 1
    local uid links mode
    uid="$(/usr/bin/stat -Lc '%u' "$1" 2>/dev/null || true)"
    links="$(/usr/bin/stat -Lc '%h' "$1" 2>/dev/null || true)"
    mode="$(/usr/bin/stat -Lc '%a' "$1" 2>/dev/null || true)"
    [[ "${uid}" == 0 && "${links}" == 1 && "${mode}" =~ ^[0-7]{3,4}$ ]] || return 1
    (( (8#${mode} & 0022) == 0 ))
}

read_launch_owner() {
    safe_metadata_file "${launch_owner}" || return 1
    local record token pid start boot extra
    record="$(< "${launch_owner}")" || return 1
    token=""; pid=""; start=""; boot=""; extra=""
    read -r token pid start boot extra <<< "${record}" || return 1
    [[ -z "${extra}" && "${record}" == "${token} ${pid} ${start} ${boot}" && \
       "${pid}" =~ ^[0-9]+$ && "${start}" =~ ^[0-9]+$ ]] || return 1
    is_uuid "${token}" && is_uuid "${boot}" || return 1
    printf '%s %s %s %s\n' "${token}" "${pid}" "${start}" "${boot}"
}

read_docker_pid() {
    safe_metadata_file "${docker_pidfile}" || return 1
    local record
    record="$(< "${docker_pidfile}")" || return 1
    [[ "${record}" =~ ^[0-9]+$ ]] || return 1
    printf '%s\n' "${record}"
}

read_socket_owner() {
    safe_metadata_file "${socket_owner}" || return 1
    local record token pid start boot filesystem_inode socket_inode extra
    record="$(< "${socket_owner}")" || return 1
    token=""; pid=""; start=""; boot=""; filesystem_inode=""; socket_inode=""; extra=""
    read -r token pid start boot filesystem_inode socket_inode extra <<< "${record}" || return 1
    [[ -z "${extra}" && \
       "${record}" == "${token} ${pid} ${start} ${boot} ${filesystem_inode} ${socket_inode}" && \
       "${pid}" =~ ^[0-9]+$ && "${start}" =~ ^[0-9]+$ && \
       "${filesystem_inode}" =~ ^[0-9]+:[0-9]+$ && "${socket_inode}" =~ ^[0-9]+$ ]] || return 1
    is_uuid "${token}" && is_uuid "${boot}" || return 1
    printf '%s %s %s %s %s %s\n' \
        "${token}" "${pid}" "${start}" "${boot}" "${filesystem_inode}" "${socket_inode}"
}

pending_launch_snapshot() {
    local token pid recorded_start recorded_boot actual_start executable
    token=""; pid=""; recorded_start=""; recorded_boot=""
    read -r token pid recorded_start recorded_boot < <(read_launch_owner) || return 1
    [[ "${recorded_boot}" == "${current_boot_id}" ]] || return 1
    kill -0 "${pid}" 2>/dev/null || return 1
    actual_start="$(process_start_time "${pid}" || true)"
    [[ "${actual_start}" == "${recorded_start}" ]] || return 1
    executable="$(/usr/bin/readlink "/proc/${pid}/exe" 2>/dev/null || true)"
    case "${executable}" in
        /bin/bash|/usr/bin/bash|/usr/local/bin/dockerd) ;;
        *) return 1 ;;
    esac
    printf '%s %s %s %s\n' "${token}" "${pid}" "${recorded_start}" "${recorded_boot}"
}

launch_snapshot() {
    local token pid recorded_start recorded_boot pidfile_pid actual_start executable
    token=""; pid=""; recorded_start=""; recorded_boot=""; pidfile_pid=""
    read -r token pid recorded_start recorded_boot < <(read_launch_owner) || return 1
    read -r pidfile_pid < <(read_docker_pid) || return 1
    [[ "${recorded_boot}" == "${current_boot_id}" && "${pidfile_pid}" == "${pid}" ]] || return 1
    kill -0 "${pid}" 2>/dev/null || return 1
    actual_start="$(process_start_time "${pid}" || true)"
    [[ "${actual_start}" == "${recorded_start}" ]] || return 1
    executable="$(/usr/bin/readlink "/proc/${pid}/exe" 2>/dev/null || true)"
    [[ "${executable}" == "/usr/local/bin/dockerd" ]] || return 1
    /usr/bin/tr '\0' '\n' < "/proc/${pid}/environ" 2>/dev/null |
        /usr/bin/grep -Fxq "PI_MSB_DOCKER_OWNER=${token}" || return 1
    printf '%s %s %s %s\n' "${token}" "${pid}" "${recorded_start}" "${recorded_boot}"
}

socket_snapshot() {
    [[ -S "${docker_socket}" && ! -L "${docker_socket}" ]] || return 1
    local token pid start boot filesystem_inode socket_inode fd target
    read -r token pid start boot < <(launch_snapshot) || return 1
    filesystem_inode="$(/usr/bin/stat -Lc '%d:%i' "${docker_socket}" 2>/dev/null || true)"
    [[ "${filesystem_inode}" =~ ^[0-9]+:[0-9]+$ ]] || return 1
    while read -r socket_inode; do
        [[ "${socket_inode}" =~ ^[0-9]+$ ]] || continue
        for fd in "/proc/${pid}/fd/"*; do
            target="$(/usr/bin/readlink "${fd}" 2>/dev/null || true)"
            if [[ "${target}" == "socket:[${socket_inode}]" ]]; then
                printf '%s %s %s %s %s %s\n' \
                    "${token}" "${pid}" "${start}" "${boot}" \
                    "${filesystem_inode}" "${socket_inode}"
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
    local expected before after
    expected=""; before=""; after=""
    expected="$(read_socket_owner || true)"
    [[ -n "${expected}" ]] || return 1
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
    temporary="$(/usr/bin/mktemp "${socket_owner}.tmp.XXXXXXXXXX")" || return 1
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

cleanup_path_is_mounted() {
    [[ -r /proc/self/mountinfo ]] || return 0
    /usr/bin/awk -v root="${docker_exec_root}" -v socket="${docker_socket}" \
        -v pidfile="${docker_pidfile}" -v launch="${launch_owner}" -v owner="${socket_owner}" \
        '$5 == root || index($5, root "/") == 1 || $5 == socket || \
         $5 == "/run/docker.sock" || $5 == pidfile || $5 == launch || $5 == owner \
         { found=1; exit } END { exit !found }' /proc/self/mountinfo
}

stale_launch_record() {
    local token pid start boot pidfile_pid
    token=""; pid=""; start=""; boot=""; pidfile_pid=""
    read -r token pid start boot < <(read_launch_owner) || return 1

    if path_absent "${docker_pidfile}"; then
        # A prior boot may have stopped after publishing provenance but before
        # dockerd created its PID file. In the current boot, only a published
        # socket-owner record distinguishes an exited established daemon from
        # an interrupted pending launch.
        if [[ "${boot}" == "${current_boot_id}" ]] && path_absent "${socket_owner}"; then
            return 1
        fi
    else
        read -r pidfile_pid < <(read_docker_pid) || return 1
        [[ "${pidfile_pid}" == "${pid}" ]] || return 1
    fi

    if [[ "${boot}" == "${current_boot_id}" ]]; then
        ! kill -0 "${pid}" 2>/dev/null || return 1
    fi
    printf '%s %s %s %s\n' "${token}" "${pid}" "${start}" "${boot}"
}

cleanup_stale_state() {
    local token pid start boot marker marker_token marker_pid marker_start marker_boot
    local marker_filesystem_inode actual_inode

    if path_absent "${launch_owner}" && path_absent "${docker_pidfile}" && \
       path_absent "${socket_owner}" && path_absent "${docker_socket}" && \
       path_absent "${docker_exec_root}"; then
        return 0
    fi

    token=""; pid=""; start=""; boot=""
    read -r token pid start boot < <(stale_launch_record) || return 1

    marker=""
    if ! path_absent "${socket_owner}"; then
        marker="$(read_socket_owner || true)"
        [[ -n "${marker}" ]] || return 1
        marker_token=""; marker_pid=""; marker_start=""; marker_boot=""
        marker_filesystem_inode=""
        read -r marker_token marker_pid marker_start marker_boot \
            marker_filesystem_inode _ <<< "${marker}"
        [[ "${marker_token} ${marker_pid} ${marker_start} ${marker_boot}" == \
           "${token} ${pid} ${start} ${boot}" ]] || return 1
    fi

    if ! path_absent "${docker_socket}"; then
        [[ -S "${docker_socket}" && ! -L "${docker_socket}" ]] || return 1
        socket_has_listener && return 1
        if [[ -n "${marker}" ]]; then
            actual_inode="$(/usr/bin/stat -Lc '%d:%i' "${docker_socket}" 2>/dev/null || true)"
            [[ "${actual_inode}" == "${marker_filesystem_inode}" ]] || return 1
        fi
    fi

    if ! path_absent "${docker_exec_root}"; then
        [[ -d "${docker_exec_root}" && ! -L "${docker_exec_root}" ]] || return 1
    fi

    # rm does not traverse symlinks within the exec-root tree. Reject mounts at
    # every cleanup target before changing anything, so it cannot cross a mount
    # boundary or partially clean state hidden by a bind mount.
    ! cleanup_path_is_mounted || return 1

    /usr/bin/rm -rf -- "${docker_exec_root}"
    /usr/bin/rm -f -- "${docker_socket}" "${docker_pidfile}" "${launch_owner}" "${socket_owner}"
}

if local_docker_ready; then
    exit 0
fi

/usr/bin/install -d -m 0700 /run
if path_absent "${start_lock}"; then
    ( set -o noclobber; : > "${start_lock}" ) 2>/dev/null || true
fi
if ! safe_metadata_file "${start_lock}"; then
    printf 'Docker startup lock is unsafe; refusing to use it.\n' >&2
    exit 1
fi
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
        temporary="$(/usr/bin/mktemp "${launch_owner}.tmp.XXXXXXXXXX")"
        printf '%s %s %s %s\n' \
            "${token}" "${daemon_pid}" "${daemon_start}" "${current_boot_id}" > "${temporary}"
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
