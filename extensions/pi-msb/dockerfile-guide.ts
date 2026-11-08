import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { assertPolicyOutsideWorkspace, DEFAULT_CONFIG, hostConfigTargets, type ResolveConfigInput } from "./config.ts";
import { assertBuildPath, BUILD_LIMITS } from "./image-source.ts";
import type { MsbControl, SessionExecutionContext } from "./types.ts";

type ScopePaths = { config: string; dockerfile: string; buildContext: string };
export interface DockerfileGuidePaths {
  agentDir: string;
  canonicalAgentDir: string;
  global: ScopePaths;
  project: ScopePaths;
}

/** Resolve locations only, never discover/read build inputs or resolve configuration/secrets. */
export async function dockerfileGuidePaths(input: ResolveConfigInput, canonicalCwd: string, check: () => void): Promise<DockerfileGuidePaths> {
  check();
  if (await realpath(input.cwd) !== canonicalCwd) throw new Error("Workspace identity changed");
  const targets = await hostConfigTargets(input);
  for (const path of Object.values(targets.lexicalPaths)) {
    await assertPolicyOutsideWorkspace(path, [input.cwd, canonicalCwd]);
  }
  const scope = (config: string): ScopePaths => ({ config, dockerfile: join(dirname(config), "Dockerfile"), buildContext: join(dirname(config), "build-context") });
  const paths = { agentDir: targets.agentDir, canonicalAgentDir: targets.canonicalAgentDir, global: scope(targets.paths.global), project: scope(targets.paths.project) };
  for (const selected of [paths.global, paths.project]) for (const path of Object.values(selected)) {
    await assertPolicyOutsideWorkspace(path, [input.cwd, canonicalCwd]);
    await assertBuildPath(targets.canonicalAgentDir, path);
  }
  if (await realpath(input.cwd) !== canonicalCwd || JSON.stringify(await hostConfigTargets(input)) !== JSON.stringify(targets)) throw new Error("Path identity changed");
  check();
  return paths;
}

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const minimalDockerfile = () => `FROM ${DEFAULT_CONFIG.image}\nRUN apt-get update && apt-get install -y --no-install-recommends jq \\\n    && rm -rf /var/lib/apt/lists/*\n`;
function guide(paths?: DockerfileGuidePaths) {
  const dockerfile = minimalDockerfile();
  const create = (scope: ScopePaths) => ({
    tool: "bash", input: { execution_target: "host", command: `umask 077 && test ! -e ${quote(scope.dockerfile)} && test ! -L ${quote(scope.dockerfile)} && mkdir -p -- ${quote(dirname(scope.dockerfile))} && (set -C; printf '%s' ${quote(dockerfile)} > ${quote(scope.dockerfile)})` },
  });
  return {
    outcome: paths ? "guided" : "unavailable", readOnly: true,
    ...(!paths ? { reason: "Canonical workspace/session or safe host policy paths unavailable. No paths or commands guessed. Repair working-directory identity on the host and restart Pi if needed; call this guide again." } : { paths, createOnlyExamples: { global: create(paths.global), project: create(paths.project) } }),
    baseImage: DEFAULT_CONFIG.image, minimalDockerfile: dockerfile,
    workflow: [
      "Call msb_dockerfile_guide before creating Dockerfile customization. This getter only returns instructions; never executes them or requests approval.",
      "Choose ONE scope. These are host-owned policy files outside the sandbox bind, not repository files. Inspect existing files with approved HOST tools, then propose a reviewed host edit. Never use ordinary sandbox Bash/read/write for these paths.",
      "Examples are optional create-only bash calls with execution_target: host (not target). They refuse an existing Dockerfile; do not replace this with an overwrite. For existing files, inspect then use an explicitly approved host edit. Context creation/edits also require approved host tools.",
      "When active, host tools require allowHostExecution and explicit per-call user approval with an approving UI; denial/no UI means stop. Off/host-fallback follows existing host routing, not a new approval grant from this guide. While blocked, routed host tools may also be blocked: ask the human to use their host editor/terminal. Never enable host execution, turn protection off, or enable host fallback as an automatic repair; no blanket host approval.",
      "Use msb_config_get to inspect image intent. Project overrides Global; within either scope an explicit image wins over its Dockerfile. A Session image overrides inherited Dockerfile discovery. Remove/inherit the relevant explicit image with an approved msb_config_set proposal before discovery; higher scopes can still shadow it. Do not persist the generated effective image reference.",
      "After human/approved host edits, request an explicit settings reload through /msb → Actions → Reload settings. This guide never reloads. Activation can rebuild/recreate the runtime and lose guest-local state; failures block, never silently run on the host.",
    ],
    context: {
      copyRoot: "Only contents of the selected scope's optional build-context/ are COPY root. Global and Project contexts are separate, never merged. Neither the whole config directory nor repository is implicitly included. Keep secrets/credentials out of Dockerfile and context.",
      rejected: "build-context/Dockerfile, symlinks (including descendant path components), hardlinked regular files, special files and changing inputs are rejected. The selected Pi agent-directory symlink itself is supported. No Git root/ancestor policy inference or parent-policy inheritance; nested canonical cwd selects its own Project.",
      limits: { bytes: BUILD_LIMITS.bytes, entries: BUILD_LIMITS.entries, depth: BUILD_LIMITS.depth },
    },
    lifecycle: "A disposable Microsandbox builder uses guest Docker/Buildx and SDK archive import: no host Docker, host CLI build/import, or push needed. Generated images are local, never-pull. Unchanged content reuses the validated cache on reload; content changes rebuild. To refresh mutable FROM/downloads, manually change a Dockerfile comment and reload (mtime alone is insufficient). Public build downloads are independent of runtime network deny; no host credentials, runtime secrets or mounts are supplied.",
    imageContract: "Start FROM the bundled published digest pin above, NOT resolved config.image (possibly custom or a generated local reference). It includes required guest tools and Docker. Keep required guest commands in the final image; Docker is optional unless docker.mode=require.",
    notPerformed: ["file contents read", "writes", "commands", "environment credential reads", "secret command resolution", "approval", "SDK loading", "VM start", "build/import", "reload"],
  };
}
function result(paths?: DockerfileGuidePaths) {
  let details = guide(paths);
  if (Buffer.byteLength(JSON.stringify(details, null, 2)) > 47 * 1024) details = guide();
  return { content: [{ type: "text" as const, text: "Microsandbox Dockerfile guide (read-only)\n" + JSON.stringify(details, null, 2) }], details };
}

export function registerDockerfileGuideTool(pi: ExtensionAPI, control: MsbControl, execution?: SessionExecutionContext): void {
  pi.registerTool({
    name: "msb_dockerfile_guide", label: "Microsandbox Dockerfile guide",
    description: "Call before creating Dockerfile customization. Read-only host-owned Global/Project Dockerfile, context and config locations, pinned bundled FROM example, approved HOST-tool workflow and build lifecycle. Available off/blocked when canonical workspace is known. Empty arguments. Returns instructions only: never creates/edits files, executes commands, resolves secrets, prompts approval, builds, starts or reloads anything.",
    parameters: Type.Object({}, { additionalProperties: false }),
    renderCall() { return new Text("Microsandbox Dockerfile guide (read-only)", 0, 0); },
    renderResult() { return new Text("Dockerfile guidance only; no commands or changes performed. See tool content.", 0, 0); },
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (!params || typeof params !== "object" || Array.isArray(params) || Reflect.ownKeys(params).length) {
        return { content: [{ type: "text" as const, text: "Only empty arguments {} are accepted. No paths inspected or changes made." }], details: { outcome: "rejected", readOnly: true } };
      }
      try {
        const identity = ctx ? JSON.stringify([ctx.sessionManager.getSessionId(), ctx.cwd]) : undefined;
        const executionIdentity = execution?.current();
        if (executionIdentity && identity !== undefined
          && identity !== JSON.stringify([executionIdentity.sessionId, executionIdentity.cwd])) return result();
        const paths = await control.getDockerfileGuidePaths?.();
        if (signal?.aborted || execution?.current() !== executionIdentity
          || ctx && identity !== JSON.stringify([ctx.sessionManager.getSessionId(), ctx.cwd])) return result();
        return result(paths);
      } catch { return result(); }
    },
  });
}
