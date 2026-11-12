# Pick your Linux lunchbox

[Back to README](../README.md) · [Agent recipes](agent-recipes.md)

The default image comes with Node.js, Python, Rust, Go, and Docker. You can also
pack your own custom image. Image changes may recreate the VM and discard
guest-local state.

**New in source builds:** the default image includes **gcloud 592.0.0**, **AWS
CLI v2 2.39.6**, and **curl** alongside all four runtimes. Existing published tags
and the package's digest-pinned default are unchanged; use a new source build until a
new image is published and the package pin updated.
[Build one now →](#cloud-clis-from-this-branch)

You can ask your agent to make the change:

> Inspect my current image and the image-setting schema. Propose this Project's
> image as ghcr.io/hcohe/pi-microsandbox:1.1.0 with pull_policy if-missing,
> in one approved batch. Explain the restart impact and verify activation.

For reproducible custom setups, use an immutable digest rather than a mutable
latest tag. The bundled default is already digest-pinned.

pi-microsandbox builds one Ubuntu 26.04 image at
`ghcr.io/hcohe/pi-microsandbox`, for Linux AMD64 and ARM64. There are no base or
language-specific image builds.

## Default image

`VERSION` below is the independent image version, such as `1.0.0`. Release
tags are write-once. `latest` is a mutable development tag built from `main`;
`sha-COMMIT` identifies a main-branch build. Package versions and image versions
are separate. Maintainers publish through the
[image release workflow](development.md#image-development); selecting an image
here doesn't build or publish one. Existing published tags and the package's
bundled digest remain unchanged until a new image is published and verified.

| Image | Contents | Release tag | Latest tag |
| --- | --- | --- | --- |
| `default` | Base tools, Docker and cloud CLIs, Node.js, Python, Rust, and Go | `VERSION` | `latest` |

The image includes `bash`, `sh`, `git`, `rg`, `file`, `cat`, `mkdir`, `rm`, curl,
CA certificates, Docker Engine and CLI 29.8.0, containerd 2.3.4, runc 1.5.1,
Buildx 0.37.1, Compose 5.5.1, and Ubuntu's iptables-nft and nftables tools.
All builds include Node.js 24.21.0, npm, pnpm 12.3.4, Yarn 1.22.22,
Ubuntu Python 3, pip, uv/uvx 0.12.12, Rust 1.98.0, Cargo, rustup,
Go 1.26.8, and native build support. CA certificates support HTTPS Git operations.

Select an image in host-owned configuration outside the mounted cwd:

```toml
# ~/.pi/agent/pi-microsandbox/default.toml (or a host-owned project override)
image = "ghcr.io/hcohe/pi-microsandbox:1.1.0"
pull_policy = "if-missing"
```

If `image` is omitted and no host-owned Dockerfile is selected, pi-microsandbox
uses the configured default image release, qualified by both its `VERSION` tag
and immutable index digest. Image
versions are independent of the installed package version. If `pull_policy` is
omitted, `"if-missing"` is used: Microsandbox pulls the image only when that
exact reference is absent from its cache. Use `"always"` to check a registry for
an updated mutable tag, or `"never"` to require a cached local image.

## Host-owned Dockerfile (no host Docker)

**Call `msb_dockerfile_get` with `{"scope":"project"}` (or `"global"`) first.**
It reads the actual scoped Dockerfile, returns authoritative host paths, and gives
a recommended `FROM GLOBAL` starter for Project when a Global Dockerfile exists,
or the bundled digest-pinned `FROM` starter otherwise. Propose a complete
replacement with `msb_dockerfile_write` using the same scope and `content`, and/or
a relative `context` patch. Getter `contextPaths` requests bounded context text. Its
No-first per-proposal review combines scope and a compact unified diff in one
approval: **Scope: Project** or **Scope: Global**, then **No / Yes** (No default).
The TUI review stays inline in the normal editor/approval area, not floating over
chat. A blank line separates Scope from the dim changed-file headings. The one
scoped preview has themed Dockerfile syntax, wrapping, **Ctrl+N / Ctrl+P** scrolling
and native-selector choice colors below the changed code. Only added/removed
rows and meaningful file/mode/newline badges appear; there is no dialog footer
or expandable details view. Exact paths, provenance and warnings remain in the
getter and structured results. RPC displays the same scoped changed-code diff
in one plain question.
Escape/abort denies. Approved write changes publish each file atomically (not
jointly/crash atomic), **without build, import, image selection, reload or restart**.
Then explicitly call `msb_dockerfile_build` with the same scope: it runs
autonomously without an approval dialog or UI, including headless/print sessions,
and returns a verified reusable `artifactId` plus command logs. Build may use
PUBLIC egress; it never loads or activates the image. Inspect the result, then explicitly call
`msb_dockerfile_load` with `{"scope":"project","artifactId":"<returned ID>"}`.
Load has its own approval, imports that exact artifact, selects it for that source,
and requests guarded reload under existing Off/autoStart and scope precedence.
It never builds. Source changes make old artifacts stale for load; build the new
source explicitly. These tools need no blanket host execution permission.
Write and load require UI approval; build does not. Denied writes/loads never
advance automatically, and each phase still needs a separate tool invocation.
Write `saved` never means active.
Explicit images/higher scopes can shadow the source; image inheritance requires
separate `msb_config_set` approval. [Tool contract](tools.md#msb_dockerfile_get--msb_dockerfile_write).

Make the smallest edit needed, with minimal Dockerfile instructions. Do not add
comments or explanatory boilerplate; explain changes and scope in the normal
response, not the file. Preserve unrelated existing content and functional parser
directives. For new Project files, default to `FROM GLOBAL` when a Global
Dockerfile exists; inspect it with `msb_dockerfile_get` scope `global` first.
Otherwise (including new Global files), start FROM the bundled digest pin.
Add only needed instructions; do not change an existing file's base intent unless asked.

Tool Dockerfiles are bounded to 32 KiB valid UTF-8 (no unsupported controls),
never silently truncated. Content and full diffs are intentionally exposed to the
model/transcript: **do not embed credentials or secrets**. Context PATCH supports
UTF-8 text, `.dockerignore`, nested files, executable scripts and single-file
deletion (`content:null`), preserving unspecified/binary files. Limits are 16 files,
32 KiB/file and 64 KiB aggregate text per read/proposal/original review. Getter
inventories metadata without reading unrequested file contents. No arbitrary
host paths or binary/base64 payloads; use a human editor for unsupported inputs.

Place a Dockerfile beside your host-owned policy, outside the mounted cwd:

```text
<Pi agent dir>/pi-microsandbox/Dockerfile                         # Global
<Pi agent dir>/pi-microsandbox/build-context/                     # optional Global context
<Pi agent dir>/pi-microsandbox/projects/<home-relative-canonical-main-root>/Dockerfile             # Git Project
<Pi agent dir>/pi-microsandbox/projects/<home-relative-canonical-main-root>/build-context/          # optional Git Project context
```

The default Pi agent directory is `~/.pi/agent`; Pi's `getAgentDir()` (including
`PI_CODING_AGENT_DIR`) is authoritative. Use the getter's exact Project path, derived from the same current authoritative
identity as [Project configuration](configuration.md#host-owned-project-overrides),
not a guessed cwd-to-directory mapping. Project write uses the same shared
main/root record as config from main, linked and nested Git cwd, with no separate
Repository/Worktree destinations. Shared saves explicitly review registration of immutable
`_repository` in shared `projects/<home-relative-canonical-main-root>/config.toml` when needed, preserving
user configuration/image intent. This enables source discovery for current/future
registered worktrees, including nested cwd after checkout gitfile deletion. Getter
and setter use only Project or Global; retired destination arguments are rejected.
Non-Git/unsupported layouts stay cwd-local; Global is unchanged. Outside-home roots
use `projects-absolute/<absolute-main-root-without-root>`.
There are no hashed-path reads, automatic copies or migrations. Project storage
keys reject reserved artifact components; context contents never enter the catalog.
A standalone shared Dockerfile without catalog metadata is not discovery authority. No policy
identity changes the mounted cwd boundary. A
host-selected agent-directory symlink is supported, but descendants must not be
symlinks. Keep these paths outside the workspace and writable mounts;
a cwd encompassing the policy location (often home itself) is rejected, not
silently granted access. Build sources cannot be exposed through explicit mounts,
even read-only ones.

**Source precedence is atomic.** At each host scope, an explicit TOML `image`
wins over its colocated Dockerfile. Otherwise the Dockerfile supplies that scope's
image. Project overrides Global, and a Session `image` disables inherited
Dockerfile discovery. With neither image nor Dockerfile, the bundled digest pin
is used. Remove a scope's explicit `image` to enable its Dockerfile; changing
`pull_policy` alone does not disable discovery. Discovered images always use
`pull_policy = "never"`. Settings show the generated local reference and source
scope; unrelated settings saves do **not** persist the generated reference. When a
verified loaded selection enters startup or reload boot (not passive inspection or a no-op/live-settings
reload), Pi shows one informational notice:
`Booting from custom image (Project Dockerfile: <path>)` (or `Global Dockerfile`).
The TUI uses dim theme text; RPC receives plain text, and headless modes do not
notify. The display path preserves your configured Pi agent directory alias and
abbreviates your home as `~`. This announces a boot attempt, not success or a build.
Do not copy effective settings into a policy file.

A minimal Dockerfile can derive from the bundled image (use the exact digest pin
returned by `msb_dockerfile_get`, not effective `msb_config_get` image, which may
be a generated local reference or custom image):

```dockerfile
FROM ghcr.io/hcohe/pi-microsandbox:1.1.0
RUN apt-get update && apt-get install -y --no-install-recommends cowsay \
    && rm -rf /var/lib/apt/lists/*
```

Use a verified `@sha256:...` suffix for reproducibility; the tag above is only a
readable example. Custom images still need the required guest tools and Docker
components if runtime Docker is required.

### Extend the Global Dockerfile

A Project Dockerfile can start from the user's Global Dockerfile:

```dockerfile
FROM GLOBAL
RUN apt-get update && apt-get install -y --no-install-recommends cowsay \
    && rm -rf /var/lib/apt/lists/*
```

Use literal `GLOBAL` in the **first `FROM` instruction** (case-insensitive):
`FROM [--platform=TOKEN] GLOBAL [AS name]`. Continuations, `#escape` and official
`docker/dockerfile` frontends are supported. Later `FROM GLOBAL`, a stage named
`GLOBAL` in an inheriting build, and nonstandard frontends are rejected. `ARG`
expansion is unchanged; it is not a way to request Global inheritance.

`GLOBAL` is an extension-provided base, not a registry image. Explicit Project
build first builds the **current Global Dockerfile and its dedicated context**
in the same disposable builder, then builds Project on that image. No prior
Global build/load or separate Global activation is needed. Global `config.image`
and previously loaded images are not used. Missing/unsafe Global sources or
Global itself using `FROM GLOBAL` fail closed, with no bundled-image fallback.
Each scope's `COPY` sees only its own context; Global files are not merged into
Project context. Changes to either Dockerfile or context invalidate pending
Project artifacts and build-cache identity. Explicit activation requires rebuilding
and approving load; actual runtime boot instead prepares the changed inputs
automatically, as described below.

### Build boundary and lifecycle

On explicit build, the extension snapshots only
`Dockerfile` and the **contents of its dedicated `build-context/`** (plus the
same separately isolated Global sources when Project uses `FROM GLOBAL`). Each directory
becomes the context root for `COPY`; Dockerfile is staged at its root. No implicit
repository, TOML files, other projects, policy tree, host credentials, host Docker
socket, or runtime mounts/environment/secrets are supplied. Do not place secrets
in the dedicated context or Dockerfile: those bytes are deliberately build inputs.
`build-context/Dockerfile` is rejected to prevent overwriting the selected source.
All symlinks, multiply-linked regular files (hardlinks), special files and changing
inputs are rejected. Limits: 32 MiB total source bytes, 2,048 entries (including
Dockerfile/directories), 16 context nesting levels. For `FROM GLOBAL`, byte/entry
limits cover both scopes together. A context is optional.

A separate disposable **rootful** Microsandbox VM runs the existing digest-pinned
bundled image with guest Docker/Buildx (2 CPUs, 4,096 MiB RAM, 32,768 MiB / 32 GiB
writable root disk, 20-minute build cap). The VFS storage driver copies full layers
for RUN snapshots and across stages; the larger finite allowance accommodates
multi-stage builds beyond the bundled base. Disk capacity participates in source
build identity, so earlier smaller-disk caches do not prove the current build.
Larger builds can still exhaust this fixed disk and fail closed. Runtime disk/RAM
settings do not resize the disposable builder.

For `ENOSPC` / `no space left on device` during build, the builder's disk can be
full even when the host has free space because VFS amplifies intermediate storage.
Reduce stages/dependencies, or combine RUN steps and remove package/build caches
within the same step before retrying. Host backing storage, temporary staging/
exports and the native image cache can also exhaust host space, especially during
export/import; check the relevant host filesystem too. Failure feedback offers
this guidance only with no-space evidence, not from an exit status alone. No
automatic pruning or retry is performed.
Its independent explicit SDK Public network profile allows public downloads plus
gateway DNS, denies unmatched egress, and denies ingress. It does **not** inherit
runtime network restrictions: even a runtime configured `deny` needs public
registry/package downloads on an uncached build. No host/private allow profile,
published ports, registry credentials, pushes, host Docker, host build command,
`msb` CLI, cross-architecture emulation or cloud backend is used. Public egress is
not a guarantee against arbitrary exfiltration of the supplied build inputs.

Guest `docker buildx build --load` and `docker save` produce an archive. After
ownership-checked builder destruction, bounded streaming preflight accepts one
exact generated image reference and the native Linux architecture, and creates a
Docker-save-only archive without extra index/repository aliases. Build ends here:
it retains a verified pending archive only in private OS temporary storage and
process memory, never calls host `Image.load`, and never changes the selected or
running image. Explicit approved load (or automatic preparation for an actual
runtime boot) imports a verified private copy, checking returned handles, config
identity, OS/architecture and fresh cache-only lookups of both generated native
references before guarded activation. Runtime always uses
**pull policy never**. Import finishes before runtime replacement, which can lose
guest-local state.

**Loaded images live only in Microsandbox's native image cache.** No build tars,
receipts, selected-image JSON or build locks are created under the Pi configuration
directory; it retains only authored policy, Dockerfile and optional build-context.
The native build reference binds the canonical owned Dockerfile path, exact source
identity, platform and reference-version contract. Source identity includes exact
bytes, executable bits, builder image pin and build options. A separate stable
selected alias binds the canonical Dockerfile path/platform/reference version,
not editable source or builder options. The last loaded image remains selected
until the next explicit load or actual runtime boot refreshes it.
These aliases are generated by the extension, never supplied by guest metadata.

Build coordination uses flock in a private per-user OS-temp directory, separate
from runtime ownership locks (which are unchanged). Shared flock inodes are never
unlinked while contenders may use them. Pending exports are private temporary
files, not a second durable cache. A valid pending artifact can be retried with
fresh approval after denial or failed import in the same process. Successful
import, supersession, session replacement, Pi `/reload` and shutdown clean pending
exports; invalidated artifacts and failed build outputs are discarded when safe.
For explicit build after restart, a native build can be exported with
`Image.save` to private temp, sanitized and verified without building or importing.
Save can rewrite config/manifest bytes and legitimately change the digest of a
later reimport. New load approval binds the exact exported archive/config, not
the old native digest; the build ref is digest-checked before and after save.

Microsandbox's cache is a **same-user trusted store**, not an adversarial registry
or provenance boundary. Do not retag/replace generated references concurrently.
SDK 0.7.14 has no native tag transaction or compare-and-swap: `Image.load` adds
both the sanitized archive tag and the selected alias sequentially. Failure can
leave either/both durably changed, even when activation is withheld. Checks detect
observed changes, not same-digest ABA, and cannot promise rollback or protect a
check/use window against a trusted host process. Partial/unknown effects are
reported honestly; no automatic rollback, network pull or host fallback occurs.
Native prune/removal can discard builds/selections. With a discovered Dockerfile
but no current native selection, the next actual boot prepares it automatically;
preparation or verification failure blocks activation. If both editable source
and its native selected alias are removed, that scope is no longer discoverable and normal lower-scope/default
precedence applies. Keep the source if that scope must remain selected.

Passive configuration inspection and inactive/Off startup do not require the
native SDK. Execution resolves native selected aliases, including selections
whose editable Dockerfile was deleted, then checks the current source at actual
boot. No native backend error or malformed metadata is treated as a cache miss; only the typed
image-not-found result is absence. Passive views cannot discover a deleted source's
native-only selection until execution resolves it.

Old `<Pi agent dir>/pi-microsandbox/build-cache/` data is ignored and left untouched;
there are no compatibility reads, migrations or automatic deletions. A human may
review and remove that old generated directory manually after ensuring no older
extension process uses it. Never delete authored Dockerfiles/config/build-context
as cache cleanup.

**Actual runtime boot refreshes edited Dockerfile sources automatically.** Before
startup, re-enabling, or a settings reload that requires runtime replacement, Pi
snapshots the current Dockerfile, bounded context and any `FROM GLOBAL` inputs.
It reuses the native image without building/exporting/importing only when the
content-keyed build reference and stable selected alias have the same verified
native digest. Otherwise it builds/exports and imports the current source before
boot. This automatic boot preparation requires no separate load approval. Explicit
config images still win. Source saves, passive inspection and no-op/live-settings
reloads remain nonbuilding; edits wait for the next actual boot. Explicit build
remains export-only, and explicit load still requires its separate approval.

Interactive sessions announce source checks, changed/missing images, builds or
cached reuse/export, and imports before the actual boot notice. The optional
footer shows the current phase with its existing flashing indicator; hiding it
does not hide notices. Unchanged images are not described as rebuilding, and
no-op/live reloads do not repeat preparation notices. Print/JSON stays UI-free;
RPC receives plain notices.

Preparation failures show the failed phase/command, actual exit status or typed
failure when available, a bounded relevant output tail, and a recovery action.
Feedback is redacted and terminal-safe; unavailable secret tokens can require
withholding diagnostic detail. The footer leaves progress for Blocked on failure;
cancellation/supersession stops progress without reporting an obsolete build error.

A deleted Dockerfile can retain its native selected alias at the same scope;
this exception does not permit unsafe source paths, broken context, or missing
`FROM GLOBAL` dependencies while the Project Dockerfile still exists. With no
usable retained selection, activation fails closed. Runtime replacement is forced
when the digest changes. After a fresh integration/process starts, a previously
persisted VM is conservatively recreated even if the image is unchanged: its
stable image label cannot prove which digest it booted. This can lose guest-local
state, but unchanged native images still need no build/import.

Build/import/verification failures, cancellation and observed source, workspace
or selection changes block stale-image boot and host fallback. Failed builds
preserve written sources and the previous selected/running image. Failed imports
can leave unknown partial native alias changes; no automatic rollback is promised.
Explicit failed loads retain artifacts for retry when available. Approval/source/
artifact or directory changes fail closed.
Build logs include bounded stdout/stderr tails (explicit truncation) and actual
command exit status; approval/storage errors have no invented process status.
Build inputs/output are transcript-visible: never include secrets.

### Export failures and diagnostic limits

`EXPORT_FAILED` remains an export-phase failure, not a Docker process exit code.
In particular, **“Execution stream ended without an exit event”** originates in
our SDK transport adapter: the async iterator reached EOF without an integer
`exited` event (and without cancellation/disposal taking precedence). In pinned
`microsandbox@0.7.14`, the JS iterator ends when native `recv()` returns `null`.
This is missing completion evidence, **not** proof that `docker save` completed,
that a timeout fired, or that the VM ran out of memory. Successful retry does not
identify the original cause. No automatic retry, salvage, import or activation
is authorized by this failure.

Structured tool `details.diagnostics` reports `failureKind`: `commandNonzero`,
`streamEndedWithoutExit`, `transport`, `timeout`, `cancelled`, `disposed`, or
`operation`. Command logs retain only genuine `exitCode` values. An exit observed
before a later receive failure is retained as evidence, but does not turn that
failed stream into success. Missing status is never replaced by a synthetic
process code. Each failed command's `logs[].diagnostics` includes the mapped
`transportCode`, monotonic `elapsedMs` (including attempted stream cleanup), event
count, raw `stdoutBytes`/`stderrBytes`, `lastOutputElapsedMs` when output was seen,
`observedExitCode` if received, abort/disposal flags and kill/iterator-return
cleanup outcomes. Elapsed minus last-output time describes observed output
inactivity; it is not a silence timeout. Partial stdout/stderr remain bounded
32 KiB tails with explicit truncation; expanded tool results escape terminal
controls and bidi characters. Causal details are at most four typed error
name/code identities, not arbitrary SDK messages, stacks, environment or config.

Deadlines are distinct:

- A **20-minute aggregate cancellation timer** starts before source validation
  and lock waiting. `cancellationSource=aggregateDeadline` is owned timer evidence;
  `cancellationSource=user` means the supplied tool/interaction signal fired.
  Only the former is classified as deadline timeout. An SDK typed timeout is
  separately reported as `transportCode=TIMEOUT`; EOF alone is never a timeout.
- The attached builder separately requests **`maxDuration=1200` seconds**. Its
  enforcement timing or termination reason is not established by the command
  stream. Builder idle timeout remains **omitted**: pinned SDK/runtime zero means
  immediate idle eligibility, not “disable idle timeout”. This fixes a builder-only
  configuration mismatch, **not a proven cause of the historical incident**.
  Ordinary runtime idle policy is unchanged.
- `requestedTimeoutMs` records the SDK exec request (17 seconds for Docker
  startup; 20 minutes each for build/save). **Pinned SDK 0.7.14 implements streaming
  timeout enforcement**, hence `sdkStreamingTimeoutEnforced=true` (a source-verified
  implementation fact, not a live test result). Unlike 0.6.16, its deadline monitor
  requests SIGKILL after execution starts. Raw `recv()` reports the actual exit event;
  only SDK `wait()`/`collect()` translate an expired deadline into `ExecTimeout`.
  This adapter consumes raw events, so neither a nonzero exit nor EOF alone proves
  a timeout. Termination delivery can fail; no hard return deadline is implied.
  The guest startup helper has its own 15-second budget. Aggregate cancellation is not a hard return deadline: creation and
  pending stream acquisition/receive can still need SDK convergence. Stream
  failure cleanup bounds kill and iterator-return separately to one second;
  ownership-checked builder destruction requests ten seconds.

Before builder destruction, failure reporting attempts at most **500 ms total**
for read-only observations (skipped or abandoned on cancellation): an
identity-matched local database builder status, and no-follow archive type, byte
size and modification time under the pinned staging directory. Probe failure,
identity mismatch or budget expiry is reported, not treated as a new command
failure. There is no reconnect, guest command, captured-log/config dump, or
start/stop request in these probes. `observations.authority` is explicitly
`observationOnlyNotCompletionProof`: even a nonempty, apparently complete tar
cannot prove completion or integrity. Status is a point-in-time database
observation, not a termination cause or signal. No termination reason/OOM/timeout
is inferred from it. Primary phase/error/logs survive secondary diagnostic,
builder/staging cleanup and lock-release failures; `secondaryFailures` and
`cleanup` describe those outcomes. Unconfirmed builder stop retains staging for
host repair, never publication.

Publication still requires successful zero-exit commands and stream completion,
guards, confirmed builder destruction, no-follow regular single-link bounded and
aligned archive checks, checksummed tar structure/termination, safe unique
members/types, exactly the expected image tag/platform/config/layers, sanitized
archive copying, digest/byte verification and guarded temporary publication. These
are not cryptographic layer-content provenance checks. EOF or an archive's
presence never skips validation. Failed export has no artifact to load: inspect
diagnostics, repair source/policy if needed, then explicitly retry build. A
successful retry can be verified/reused from the artifact cache and still needs
separate load approval. New diagnostics cannot reconstruct the historical
attempt's missing stream events, archive state, VM termination cause or first
`docker save` completion.

Pinned-source references: [SDK async iteration](https://github.com/superradcompany/microsandbox/blob/60fc5071b34e6cc2671c84c8dc07709795d45d27/sdk/node-ts/src/internal/async-iter.ts),
[streaming exec and shared event receiver](https://github.com/superradcompany/microsandbox/blob/60fc5071b34e6cc2671c84c8dc07709795d45d27/sdk/rust/lib/sandbox/exec/session.rs)
(`exec_stream` enforces its deadline; raw `recv` retains actual exit events;
`wait` consumes the same receiver, not an independent cached status), [idle option storage](https://github.com/superradcompany/microsandbox/blob/60fc5071b34e6cc2671c84c8dc07709795d45d27/sdk/rust/lib/sandbox/builder.rs),
and [runtime lifetime/idle handling](https://github.com/superradcompany/microsandbox/blob/60fc5071b34e6cc2671c84c8dc07709795d45d27/crates/runtime/lib/runner/vm.rs).

Mutable `FROM` tags and external downloads are not refreshed on native cache hits.
Prefer pinned dependencies; change the pin/input and explicitly build/load when
needed. Mtime alone does not rebuild. There is no persistent guest layer cache or
extension-managed durable artifact eviction: native cache pruning is managed with
Microsandbox, separately from authored configuration.

Export archives are limited to 16 GiB, 16,384 tar entries, and 1 MiB per metadata
file; links, special entries and unsupported tar extensions fail closed. Reserve
space for guest Docker storage **plus original, sanitized and pending host archive copies**
(up to 48 GiB transient host archive bytes per build, plus other pending exports). Load needs another private archive copy. The cap
is an accepted-archive limit, not a proactive disk quota. Disk exhaustion fails closed. Normal completion/failure and
cancellation clean temporary `/tmp/pi-msb-build-*` directories and owned builders.
Staging binds use canonical paths (including `/private/tmp` on macOS), without
enabling symlink-following mounts. If creation fails after registering a builder,
cleanup checks only that attempt's exact name, local backend and unique ownership
label, then destroys the identity-bound database handle without starting it.
If ownership, absence or destruction cannot be verified, staging is retained
rather than deleting files a possibly running builder can access. A process crash can also leave
artifacts; builder lifetime is bounded, but host cleanup may be necessary. Guest
streams are aborted on timeout/session supersession/Off. The pinned SDK has no
cancellation API for create/import: late results are awaited before cleanup and
cannot activate a superseded runtime; those SDK calls may outlast the build cap.

An opt-in build/export/import/runtime roundtrip test is available on a supported
virtualization host (downloads/builds images; ordinary test skips are not proof):

```sh
PI_MSB_LIVE_BUILD_TEST=1 node --experimental-strip-types --import ./test/setup.ts \
  --test extensions/pi-msb/image-build-live.test.ts
```

The roundtrip has not been live-validated as part of this change; fake-SDK tests
cannot prove guest Docker, archive compatibility, network or SDK import behavior.

## Cloud CLIs from this branch

Want the new tools before the next published image? From a **repository
checkout**, build the default image locally on a supported host. It includes
all four runtimes, the base tools, and cloud CLIs:

```sh
docker build \
  --file default-image/Dockerfile \
  --tag pi-cloud-tools:dev \
  default-image
```

The build verifies tools without cloud credentials. Check the finished image
with networking disabled:

```sh
docker run --rm --network none pi-cloud-tools:dev gcloud version --quiet
docker run --rm --network none pi-cloud-tools:dev aws --version
docker run --rm --network none pi-cloud-tools:dev curl --version
```

Use the host Microsandbox CLI to load it into **Microsandbox's** image cache,
which is separate from Docker's:

```sh
docker save pi-cloud-tools:dev | msb load --tag pi-cloud-tools:local
```

Ask your agent:

> Propose this Project's image as pi-cloud-tools:local with pull_policy never,
> in one approved batch. Explain the VM restart and verify activation. Don't
> import my host cloud profiles or credentials.

Or save the equivalent host-owned TOML:

```toml
image = "pi-cloud-tools:local"
pull_policy = "never"
```

CLI installation is **not authentication**: configure credentials deliberately.
Start with the [keyless, read-only Google Cloud recipe](google-cloud.md). AWS credentials and
permissions likewise remain your responsibility; no host `.aws` directory is
copied or mounted automatically.

## How the image is assembled

[`default-image/variants.json`](../default-image/variants.json) retains the
workflow's matrix and tag metadata for exactly one default image. Validation
rejects extra images, missing runtimes, or alternate tag templates.
[`default-image/Dockerfile`](../default-image/Dockerfile) always installs and
verifies Node.js, Python, Rust, and Go; there are no variant or toolchain build
arguments. The common Docker, Google Cloud CLI, and AWS CLI installers run
before the modular `default-image/install/<language>.sh` scripts. curl remains
available at runtime. The verifier checks the base tools, Docker and its plugins,
cloud CLI versions/offline configuration, and a local curl transfer, then
exercises all four runtimes. Cloud CLIs include no credentials or profiles.

The final image sets `CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE` and `AWS_CA_BUNDLE` to
`/etc/ssl/certs/ca-certificates.crt`: both clients follow the system trust store
when Microsandbox adds its runtime CA, without disabling TLS verification.

The Ubuntu multi-platform base image is digest-pinned. Image assembly and runtime
use Ubuntu's normal signed package repositories, so apt package versions can
change between builds. Build-time apt downloads retry transient acquisition
failures up to three times; index updates fail on any remaining error instead
of continuing with incomplete indexes. Repository signature checking and TLS
verification remain enabled.

## Build a custom image

A custom image must provide `bash`, `sh`, `rg`, `file`, `cat`, `mkdir`, and
`rm`. Git is a useful developer tool and remains in the published images, but
workspace setup no longer requires it inside the guest. Docker is optional for
custom images. The default `docker.mode = "auto"` records it as missing and
continues; use `docker.mode = "require"` when the image contract must include a
working daemon. pi-microsandbox does not install Docker during sandbox startup.
Install Git and CA certificates if guest commands need Git over HTTPS. With
`bootstrap_tools = "auto"`, pi-microsandbox can install missing required
commands through `apt-get` when the network policy permits it. A prepared image
is required when bootstrap is disabled or package repositories are unavailable.

Microsandbox supports registry images and images loaded into its own local
cache. Images in the Docker daemon are not automatically visible to
Microsandbox.

### Publish to an OCI registry

Start from a versioned base tag so the guest contract does not change when
`main` is rebuilt:

```dockerfile
FROM ghcr.io/hcohe/pi-microsandbox:1.1.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends jq \
    && rm -rf /var/lib/apt/lists/*
```

Build and push for the current host architecture with Docker:

```sh
docker build -t registry.example.com/team/pi-image:1.0.0 .
docker push registry.example.com/team/pi-image:1.0.0
```

Or publish both supported architectures with Buildx:

```sh
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --tag registry.example.com/team/pi-image:1.0.0 \
  --push .
```

Then select it in `~/.pi/agent/pi-microsandbox/default.toml` or a
[host-owned project override](configuration.md#host-owned-project-overrides):

```toml
image = "registry.example.com/team/pi-image:1.0.0"
pull_policy = "if-missing"
```

For a private registry, configure authentication on the host with Microsandbox,
for example with `msb registry login`, or in
`~/.microsandbox/config.json`. Registry pull credentials belong in
Microsandbox configuration, not in pi-microsandbox guest `secrets`. See the
Microsandbox [image guide](https://docs.microsandbox.dev/images/overview) and
[configuration reference](https://docs.microsandbox.dev/configuration).

### Load a local Docker image

Build the image, then transfer a Docker archive into the Microsandbox cache and
assign a local tag:

```sh
docker build -t pi-image:dev .
docker save pi-image:dev | msb load --tag pi-image:local
```

The file form is useful when a pipeline cannot be used:

```sh
docker save -o pi-image.tar pi-image:dev
msb load --input pi-image.tar --tag pi-image:local
```

Use the local reference without contacting a registry:

```toml
image = "pi-image:local"
pull_policy = "never"
```

`pull_policy = "if-missing"` also uses the loaded image while it remains in the
cache, but may try a registry if it is removed. The Microsandbox
[local image guide](https://docs.microsandbox.dev/examples/docker/local-images)
documents the same transfer requirement and `msb load` forms.

## Maintain the default image

The supported runtime set is fixed: Node.js, Python, Rust, and Go. Keep each
runtime's executable `default-image/install/<language>.sh` and
`default-image/verify/<language>.sh` aligned. The dispatchers always run all four
modules; do not add reduced-runtime publication variants.

Pin downloaded tool versions, including bootstrap installers such as rustup
(currently 1.29.1). Use versioned archive URLs rather than mutable latest-download
URLs so the artifact continues to match its pinned checksum. Checksum failures
report the download URL and expected SHA-256 and stop the build; do not bypass
verification to fix a failed download. Record and verify SHA-256 checksums for
both AMD64 and ARM64 artifacts, using the helpers in `install/_common.sh`. Do not
pipe network downloads into a shell. Verifiers must test native functionality,
not only version output: for example, compile and run a native extension or a
small program.

Validate metadata and shell scripts locally:

```sh
node scripts/image-variants.mjs self-test
node scripts/image-variants.mjs matrix
shellcheck -e SC1091 default-image/install/*.sh default-image/verify/*.sh
```

Build the complete image with the same context as CI. The Dockerfile runs its
functional verifier during the build:

```sh
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --build-arg IMAGE_VERSION=dev \
  --file default-image/Dockerfile \
  default-image
```
