import type { Config, DeepReadonly } from "./types.ts";

/** Every executable example is commented; setup never changes effective defaults. */
export function defaultConfigTemplate(config: DeepReadonly<Config>): string {
  return `## pi-microsandbox host-owned configuration
## All settings below are commented out. Uncomment only what you want to change.
## Examples are placed in their correct TOML sections for uncommenting in place.
## Choose list defaults OR their example array tables, not both (secrets/mounts).
## Do not uncomment the entire reference; enable only the settings you need.
## Existing files (even empty files) are never replaced. New files use mode 0600;
## new configuration directories use mode 0700. Keep this outside any workspace.
## The workspace is mounted read/write, including the entire enclosing Git worktree.
## Sandbox failures block by default; never enable host fallback for untrusted code.
## PI_MSB_* environment settings and the /msb control panel are also supported.
## Precedence: built-ins < environment < Global (this default.toml)
## < Project (host-owned override) < Session (memory only).
## Host lists REPLACE lower lists (including secrets/mounts); [] clears them.
##
## Project configuration (panel Project button or manual host creation):
## Use the canonical Git worktree root, or canonical cwd for a non-Git project.
## For ~/Code/app, create <agentDir>/pi-microsandbox/projects/Code/app/config.toml.
## For /srv/app outside home, use
## <agentDir>/pi-microsandbox/projects-absolute/srv/app/config.toml.
## A project at home itself uses projects/config.toml. Subdirectories of a Git
## worktree share its override. agentDir is Pi's getAgentDir(): ~/.pi/agent unless
## PI_CODING_AGENT_DIR is set. Paths are canonicalized (symlink aliases share policy).
## Example host shell commands (adjust paths; never overwrite an existing file):
##   agent_dir="\u0024{PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
##   mkdir -p -m 700 "$agent_dir/pi-microsandbox/projects/Code/app"
##   (umask 077; set -C; printf 'cpus = 2\\n' > "$agent_dir/pi-microsandbox/projects/Code/app/config.toml")
## Review mounts, secrets, and host permissions before enabling settings.
## Open /msb; choose Actions > Reload settings after external edits.
## The panel applies each change to Session, Project or Global scope.

## Defaults: resource identity and lifecycle
## Digest-pinned image; custom images must supply the required runtime tools.
# image = ${JSON.stringify(config.image)}
## pull_policy: always | if-missing | never
# pull_policy = "if-missing"
## bootstrap_tools: "auto" | true | false (install required tools when needed)
# bootstrap_tools = "auto"
## cpus: 1..64; memory_mib: >=128; idle_timeout_sec: >=0 (0 disables idle stop)
# cpus = 4
# memory_mib = 8192
# idle_timeout_sec = 600
## Timeouts in milliseconds, >0.
# stop_timeout_ms = 10000
# detached = true
## Replacement is owner-guarded and coordinated by the panel.
## These replacement preference fields are retained; cleanup uses stop_timeout_ms.
# replace = false
# replace_timeout_ms = 10000
## sandbox_name defaults to null (automatic session-derived name); TOML has no null.
## To override it use a string:
## Example: sandbox-name
# sandbox_name = "my-isolated-session"
## End example
# auto_start = true
# prune_on_start = true
# show_footer = true
# lock_dir = "~/.pi-msb/locks"

## Defaults: routing and host access
## block_third_party blocks unrecognized tools; pass-through tools execute on host.
# block_third_party = true
## route_tools accepts only read, write, edit, ls, find, grep, bash.
# route_tools = ${JSON.stringify(config.routeTools)}
# pass_through_tools = ${JSON.stringify(config.passThroughTools)}
## allow_host_execution permits explicit host-target tools; panel Turn off uses host tools.
## !/!! are always host.
# allow_host_execution = true
## allow_skill_reads permits only discovered skill files and generated prompt files.
# allow_skill_reads = true
## fallback_mode: block | host. "host" explicitly permits execution after VM failure.
# fallback_mode = "block"
## Session metadata is private by default. host_env forwards named host variables;
## never forward credentials this way. Process-control variables (PATH, BASH_ENV,
## DOCKER_HOST, LD_PRELOAD, etc.) cannot be forwarded or injected as secrets.
# expose_session_environment = false
# host_env = []
# secrets = []
# mounts = []

## Defaults: network
## mode: default | open | allowlist | deny. default blocks private/host networks;
## open permits them. allowlist restricts outbound hosts; deny blocks networking.
## allowlist requires a host or allow_dns=true. Secrets need their own allow_hosts.
## Network hosts use exact DNS names: no wildcards, URLs, ports or implicit subdomains.
## Secret hosts also accept wildcard subdomain scopes such as *.googleapis.com.
## Only network hosts may additionally use IP addresses/CIDRs.
# [network]
# mode = "default"
# allow_hosts = []
# allow_dns = true
## publish_ports: strings "PORT", "HOST_PORT:GUEST_PORT", or "IP:HOST_PORT:GUEST_PORT";
## port numbers 1..65535. Publishing exposes guest services; prefer loopback binds.
# publish_ports = []
## Defaults: Docker runs inside the VM, never through a host Docker socket.
## mode: auto (best effort) | require (fail startup if unavailable) | disabled.
# [docker]
# mode = "auto"
## startup_timeout_ms: integer 1..300000.
# startup_timeout_ms = 15000

## Example: secrets
## Prefer host_env or host_cmd over literal credentials. env is a valid environment name;
## allow_hosts must be non-empty exact DNS names or wildcard subdomain scopes
## (single leading *. only, e.g. *.googleapis.com). No IP/CIDR, URLs or ports.
## Add the apex separately if needed. This scopes credential
## injection only; it does not grant network access.
## Choose exactly one source: host_env (host variable name), host_cmd (host shell
## command whose stdout is the secret), or text_value (literal string, never expanded).
## Deprecated API: value and $ENV: references are not supported; use text_value or host_env.
## Sources are resolved only on sandbox creation, never during settings inspection.
## Commands run with Pi's host privileges; configure only trusted commands.
## Agent tools can read/set host_env names and host_cmd text, never text_value.
## Do not embed credentials in command text. Panel entry is always masked.
# [[secrets]]
# env = "API_TOKEN"
# host_env = "API_TOKEN"
# allow_hosts = ["api.example.com"]
# [[secrets]]
# env = "GOOGLE_CLOUD_ACCESS_TOKEN"
# host_cmd = "gcloud auth print-access-token --quiet"
# allow_hosts = ["*.googleapis.com"]
# [[secrets]]
# env = "OTHER_TOKEN"
# text_value = "s3cre3t"
# allow_hosts = ["other.example.com"]
## End example

## Example: mounts
## type: dir (default) | file | named | tmpfs. readonly defaults true; options [].
## dir/file require an absolute host_path; guest_path defaults to host_path.
## named requires a volume name as host_path; tmpfs needs no host_path.
## guest_path must be absolute, nonoverlapping, and cannot shadow the workspace,
## /tmp, guest system paths, or Docker runtime. Host sockets are forbidden.
## Writable host mounts must not expose configuration files or their directories.
## options supports only noexec, nosuid, nodev; other options block startup.
## Write access exposes host data; named volumes persist; tmpfs is ephemeral.
# [[mounts]]
# type = "dir"
# host_path = "/opt/shared/data"
# guest_path = "/mnt/data"
# readonly = true
# options = ["noexec", "nosuid"]
# [[mounts]]
# type = "file"
# host_path = "/opt/shared/settings.json"
# guest_path = "/mnt/settings.json"
# readonly = true
# options = []
# [[mounts]]
# type = "named"
# host_path = "build-cache"
# guest_path = "/mnt/cache"
# readonly = false
# options = []
# [[mounts]]
# type = "tmpfs"
# guest_path = "/mnt/scratch"
# readonly = false
# options = ["nodev", "noexec"]
## End example
`;
}
