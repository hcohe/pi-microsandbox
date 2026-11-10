import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Type } from "typebox";
import type {
  BashOperations,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
  Theme,
  UserBashEventResult,
} from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  highlightCode,
} from "@earendil-works/pi-coding-agent";
import type {
  Config,
  ExecutionTarget as ContractExecutionTarget,
  GrepFormattingHelpers,
  HostReadAccess,
  RuntimeState,
  SessionExecutionIdentity,
  SandboxGrepExecute,
  ToolOpsProvider,
} from "./types.ts";
import { approveHostExecution } from "./host-approval.ts";
import { HOST_COMMAND_GUIDANCE } from "./host-command-guidance.ts";
import { assertHostBashCwdCurrent, discoverHostBashCwd, hostCwdDisplay, HOST_BASH_CWD_DESCRIPTION, HOST_BASH_CWD_ERROR, HOST_BASH_CWD_MAX_BYTES, validHostBashCwd, type HostBashCwd } from "./host-bash-cwd.ts";

export type ExecutionTarget = ContractExecutionTarget;

type RoutedToolName = "bash" | "edit" | "find" | "grep" | "ls" | "read" | "write";
const ROUTED_TOOLS: readonly RoutedToolName[] = ["bash", "edit", "find", "grep", "ls", "read", "write"];
const ROUTED_TOOL_SET = new Set<string>(ROUTED_TOOLS);
const EXECUTION_TARGET_DESCRIPTION =
  'Where to execute this tool call. Omit this or use "sandbox" normally. Use "host" only when sandbox execution cannot perform the operation; host execution requires individual user approval. For recovery while unavailable/disabled, only bash is allowed, with an explicit finite positive timeout <=120 seconds, ready workspace/configuration and host execution permission. Host commands run with real host-user privileges outside VM/network isolation; timeout does not guarantee descendant confinement. ' + HOST_COMMAND_GUIDANCE;

/** Add the routing control without changing any of the built-in required fields. */
export function withExecutionTarget<T extends Type.TProperties>(
  schema: Type.TObject<T>,
  hostBash = false,
): Type.TObject<any> {
  return Type.Object({
    ...schema.properties,
    ...(hostBash ? { cwd: Type.Optional(Type.String({ minLength: 1, maxLength: HOST_BASH_CWD_MAX_BYTES, description: HOST_BASH_CWD_DESCRIPTION })) } : {}),
    execution_target: Type.Optional(
      Type.Unsafe<ExecutionTarget>({
        type: "string",
        enum: ["sandbox", "host"],
        description: EXECUTION_TARGET_DESCRIPTION,
      }),
    ),
  });
}

export function withoutExecutionTarget<T extends { execution_target?: ExecutionTarget }>(
  value: T,
): Omit<T, "execution_target"> {
  const { execution_target: _executionTarget, ...withoutTarget } = value;
  return withoutTarget;
}

function sortForFingerprint(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForFingerprint);
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortForFingerprint((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function hostRequestFingerprint(
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
): string {
  return JSON.stringify(sortForFingerprint([tool, cwd, withoutExecutionTarget(input)]));
}

/** Restore the green base after lexer resets; carry multiline token colors across rendered lines. */
function highlightHostBash(content: string, theme: Pick<Theme, "fg">): string[] {
  const base = theme.fg("success", "").replace(/\x1b\[(?:0|39)m$/, "")
    .match(/^(?:\x1b\[[0-9;:]*m)+/)?.[0] ?? "";
  let tokenForeground = "";
  return highlightCode(content, "bash").map((line) => {
    const continuation = tokenForeground;
    const highlighted = line.replace(/\x1b\[([0-9;:]*)m/g, (escape, parameters: string) => {
      if (parameters === "0" || parameters === "39") { tokenForeground = ""; return escape + base; }
      if (/^(?:3[0-7]|9[0-7]|38[;:])/.test(parameters)) tokenForeground = escape;
      return escape;
    });
    return theme.fg("success", continuation + highlighted);
  });
}

export function hostApprovalMessage(
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
  theme?: Pick<Theme, "fg" | "bold">,
  hostCwd?: HostBashCwd,
): string {
  const label = (text: string) => theme ? theme.fg("muted", text) : text;
  const value = (text: string) => theme ? theme.fg(hostCwd?.outsideWorkspace ? "error" : "text", text) : text;
  const directory = hostCwd?.target.lexicalPath ?? cwd;
  const command = tool === "bash" && typeof input.command === "string" ? input.command : undefined;
  // Commands are no longer JSON-escaped: keep terminal controls visible, not executable.
  const content = command === undefined
    ? JSON.stringify(sortForFingerprint(withoutExecutionTarget(input)), null, 2)
    : command.replace(/[\p{Cc}\p{Cf}]/gu, (char) => char === "\n" ? char : `\\u{${char.codePointAt(0)!.toString(16)}}`);
  const warning = "Warning: this operation runs on the host and bypasses any isolation.";
  return [
    `${label("Tool:")} ${theme ? theme.bold(theme.fg("accent", tool)) : tool}`,
    `${label("Working directory:")} ${value(hostCwdDisplay(directory))}`,
    ...(hostCwd && hostCwd.target.lexicalPath !== hostCwd.target.canonicalPath
      ? [`${label("Canonical directory (execution target):")} ${value(hostCwdDisplay(hostCwd.target.canonicalPath))}`] : []),
    "",
    theme ? theme.bold(theme.fg("warning", warning)) : warning,
    "",
    label(command === undefined ? "Exact arguments:" : "Command:"),
    ...(command === undefined ? [] : [""]),
    ...(theme ? command === undefined ? highlightCode(content, "json") : highlightHostBash(content, theme) : content.split("\n"))
      .map((line) => command === undefined ? `  ${line}` : line),
  ].join("\n");
}

export interface RegisterToolsDeps {
  provider: ToolOpsProvider;
  config: Config;
  cwd: string;
  hostReads: HostReadAccess;
  /** Native lifecycle uses a fresh grant store so stale async writes cannot repopulate it. */
  createHostReads?: () => HostReadAccess;
  /** Exact entry module that owns the configuration tools; missing provenance never exempts them. */
  ownedConfigToolEntry?: string;
  createGrepExecute: (args: {
    provider: ToolOpsProvider;
    cwd: string;
    grepHelpers: GrepFormattingHelpers;
  }) => SandboxGrepExecute;
  grepHelpers: GrepFormattingHelpers;
  systemPromptNote: (state: RuntimeState) => string;
}

type AnyToolDefinition = ToolDefinition<any, any, any>;
type ToolParams = Record<string, any> & { execution_target?: ExecutionTarget };
interface HostCallApproval {
  identity: SessionExecutionIdentity;
  fingerprint: string;
  status: RuntimeState["status"];
  token: object | undefined;
  cwd?: HostBashCwd;
  rootProofRequired: boolean;
  requestCurrent(): boolean;
}
const HOST_ROOT_ERROR = "Host execution requires the originally discovered canonical cwd and physical directory identity; the root is changed, unreadable or unproven. Rediscover the workspace before retrying.";

function isHostRecoveryState(state: RuntimeState): boolean {
  return state.status === "unavailable" || state.status === "disabled";
}

function stateOf(deps: RegisterToolsDeps): RuntimeState {
  if (deps.provider.execution && !deps.provider.execution.isReady()) return { status: "unavailable", info: null };
  return deps.provider.getState();
}

function isHostMode(state: RuntimeState): boolean {
  return state.status === "off" || state.status === "host-fallback";
}

function isSandboxActive(state: RuntimeState, provider: ToolOpsProvider): boolean {
  return state.status === "active" && provider.isActive();
}

function unavailableError(_state: RuntimeState): Error {
  // Startup/adapter reasons can contain data for which no redaction context exists.
  return new Error("Sandbox is unavailable; routed tool execution is blocked. Use msb_diagnostics and msb_config_get to diagnose it; msb_config_set can request an approved repair without a running sandbox. After passive inspection, explain the narrow diagnostic need and explicitly request bash with execution_target=\"host\" and a finite positive timeout <=120 seconds for individual human approval, only with ready identity/configuration and host permission. Other routed calls remain blocked; do not disable protection or enable fallback. " + HOST_COMMAND_GUIDANCE);
}

function routeError(tool: string): Error {
  return new Error(`Tool ${tool} is excluded from pi-microsandbox routing by configuration.`);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function isHostTarget(value: ToolParams): boolean {
  return value.execution_target === "host";
}

const toolFactories = {
  bash: createBashToolDefinition,
  edit: createEditToolDefinition,
  find: createFindToolDefinition,
  grep: createGrepToolDefinition,
  ls: createLsToolDefinition,
  read: createReadToolDefinition,
  write: createWriteToolDefinition,
};

function createHostDefinition(name: RoutedToolName, cwd: string): AnyToolDefinition {
  return toolFactories[name](cwd) as AnyToolDefinition;
}

function createSandboxDefinition(
  name: RoutedToolName,
  cwd: string,
  provider: ToolOpsProvider,
  hostDefinition: AnyToolDefinition,
): AnyToolDefinition {
  return {
    ...hostDefinition,
    parameters: hostDefinition.parameters,
    execute: async (id, params, signal, onUpdate, ctx) => {
      return provider.withRuntime(async (runtime) => {
        const options = name === "bash"
          ? { operations: runtime.operations.bash, exposeSessionEnvironment: false }
          : { operations: runtime.operations[name] };

        const factory = toolFactories[name] as (cwd: string, options?: never) => AnyToolDefinition;
        const definition = (factory as any)(cwd, options) as AnyToolDefinition;
        return definition.execute(id, params, signal, onUpdate, ctx);
      });
    },
  };
}

function resultFullOutputPath(result: unknown): string | undefined {
  const details = asRecord(asRecord(result).details);
  return typeof details.fullOutputPath === "string" ? details.fullOutputPath : undefined;
}

/**
 * Register wrappers around Pi's built-ins. The built-in definitions are made once
 * and spread into each override, so renderers, prompt metadata, argument shims,
 * and execution policy are not accidentally replaced.
 */
export function registerSandboxTools(pi: ExtensionAPI, deps: RegisterToolsDeps): void {
  const canonicalEntry = (path: string | undefined): string | undefined => {
    if (!path || path.startsWith("<")) return;
    try { return realpathSync(resolve(deps.cwd, path.startsWith("~/") ? `${homedir()}/${path.slice(2)}` : path)); }
    catch { return; }
  };
  const ownedConfigToolEntry = canonicalEntry(deps.ownedConfigToolEntry);
  const hostDefinitions: Record<RoutedToolName, AnyToolDefinition> = {
    bash: createBashToolDefinition(deps.cwd),
    edit: createEditToolDefinition(deps.cwd),
    find: createFindToolDefinition(deps.cwd),
    grep: createGrepToolDefinition(deps.cwd),
    ls: createLsToolDefinition(deps.cwd),
    read: createReadToolDefinition(deps.cwd),
    write: createWriteToolDefinition(deps.cwd),
  };
  let hostReads = deps.hostReads;
  const execution = deps.provider.execution;
  const fixedIdentity: SessionExecutionIdentity = { sessionId: "adapter", cwd: deps.cwd };
  const currentIdentity = () => execution?.current() ?? fixedIdentity;
  const assertCurrent = (identity: SessionExecutionIdentity): void => execution?.assertCurrent(identity);
  const scopedProvider = (identity: SessionExecutionIdentity): ToolOpsProvider => ({
    isActive: () => deps.provider.isActive(),
    getState: () => deps.provider.getState(),
    withRuntime: (callback) => {
      assertCurrent(identity);
      return deps.provider.withRuntime((runtime) => {
        assertCurrent(identity);
        return callback(runtime);
      });
    },
  });
  const approvedHostCalls = new Map<string, HostCallApproval>();
  const clearGrants = (): void => {
    approvedHostCalls.clear();
    hostReads.clear();
  };
  execution?.onChange(() => {
    clearGrants();
    hostReads = deps.createHostReads?.() ?? deps.hostReads;
  });
  const allowOutput = async (result: unknown, identity: SessionExecutionIdentity, access: HostReadAccess): Promise<void> => {
    const fullOutputPath = resultFullOutputPath(result);
    if (!fullOutputPath || currentIdentity() !== identity) return;
    await access.allowGeneratedFile(fullOutputPath);
    // Compatibility adapters may reuse their store; native execution discards
    // it on replacement, leaving the new session's grants untouched.
    if (currentIdentity() !== identity) access.clear();
  };

  const clearApproval = (id: unknown): void => {
    if (typeof id === "string") approvedHostCalls.delete(id);
  };

  const cwdRequestError = (tool: string, input: ToolParams, state: RuntimeState): string | undefined => {
    if (!("cwd" in input)) return;
    if (tool !== "bash" || input.execution_target !== "host" || isHostMode(state)) {
      return "cwd is supported only for explicitly approved host Bash, not sandbox/other tools or off/host-fallback mode.";
    }
    if (!Object.hasOwn(input, "cwd") || !validHostBashCwd(input.cwd)) return "Host Bash cwd must be a nonempty safe directory path of at most 4096 UTF-8 bytes, without control/format characters.";
  };

  const hostRequestError = (tool: string, input: ToolParams, state: RuntimeState): string | undefined => {
    if (execution && !execution.isReady()) return unavailableError(state).message;
    const recovery = isHostRecoveryState(state);
    if (recovery && !execution?.isReady()) return unavailableError(state).message;
    if (!isSandboxActive(state, deps.provider) && !(recovery && tool === "bash")) return unavailableError(state).message;
    // Missing cached readiness must never turn permissive fallback defaults into recovery permission.
    if ((recovery || deps.provider.hostExecutionToken) && !deps.provider.hostExecutionToken?.()) {
      return "Host execution requires ready workspace identity and trustworthy current configuration; use msb_diagnostics and msb_config_get or ask for manual host repair.";
    }
    if (!deps.config.allowHostExecution) return "Host execution is disabled by pi-microsandbox configuration.";
    if (recovery && (typeof input.timeout !== "number" || !Number.isFinite(input.timeout) || input.timeout <= 0 || input.timeout > 120)) {
      return "Host recovery bash requires an explicit finite positive timeout <=120 seconds.";
    }
    return;
  };

  const validateHostRoot = async (identity: SessionExecutionIdentity, token: object | undefined): Promise<void> => {
    if (!token || !deps.provider.validateHostRecoveryRoot) throw new Error(HOST_ROOT_ERROR);
    try { await deps.provider.validateHostRecoveryRoot(identity, token); }
    catch { throw new Error(HOST_ROOT_ERROR); }
  };

  const requireApprovedHostExecution = (
    tool: string,
    id: string,
    input: Record<string, unknown>,
    identity: SessionExecutionIdentity,
    state: RuntimeState,
  ): HostCallApproval => {
    const approved = approvedHostCalls.get(id);
    approvedHostCalls.delete(id);
    if (!approved || !approved.requestCurrent() || approved.identity !== identity || approved.fingerprint !== hostRequestFingerprint(tool, input, identity.cwd)
      || approved.status !== state.status || approved.token !== deps.provider.hostExecutionToken?.()) {
      throw new Error("Host execution was not approved for this exact tool call.");
    }
    // Consume before any filesystem validation await, including on validation failure.
    return approved;
  };

  const executeHost = async (
    definition: AnyToolDefinition,
    id: string,
    input: ToolParams,
    signal: AbortSignal | undefined,
    onUpdate: any,
    ctx: ExtensionContext,
    approvalRequired: boolean,
    identity: SessionExecutionIdentity,
  ): Promise<any> => {
    assertCurrent(identity);
    if (approvalRequired) {
      // Consume even on failure; a rejected call must not revive after policy/state changes.
      const state = stateOf(deps);
      const error = hostRequestError(definition.name, input, state);
      if (error) {
        clearApproval(id);
        throw new Error(error);
      }
      const approved = requireApprovedHostExecution(definition.name, id, input, identity, state);
      if (!ctx.hasUI) throw new Error("Host execution requires user approval, but no interactive UI is available.");
      const assertApprovedCurrent = () => {
        assertCurrent(identity);
        const currentState = stateOf(deps);
        if (!approved.requestCurrent() || !isHostTarget(input) || approved.fingerprint !== hostRequestFingerprint(definition.name, input, identity.cwd)
          || currentState.status !== approved.status || deps.provider.hostExecutionToken?.() !== approved.token
          || !deps.config.routeTools.includes(definition.name as RoutedToolName) || !ctx.hasUI
          || cwdRequestError(definition.name, input, currentState) || hostRequestError(definition.name, input, currentState)) {
          throw new Error("Host execution was not approved for this exact tool call.");
        }
      };
      if (approved.rootProofRequired) {
        await validateHostRoot(identity, approved.token);
        assertApprovedCurrent();
      }
      if (approved.cwd) {
        await assertHostBashCwdCurrent(approved.cwd, assertApprovedCurrent);
        assertApprovedCurrent();
        // A per-call native tool pins the actual canonical cwd; never prefix a shell cd.
        const { cwd: _requestedCwd, ...params } = withoutExecutionTarget(input);
        return createHostDefinition("bash", approved.cwd.target.canonicalPath).execute(id, params, signal, onUpdate, ctx);
      }
    } else clearApproval(id);
    return definition.execute(id, withoutExecutionTarget(input), signal, onUpdate, ctx);
  };

  for (const name of ROUTED_TOOLS) {
    const hostDefinition = hostDefinitions[name];
    const wrapped: AnyToolDefinition = {
      ...hostDefinition,
      parameters: withExecutionTarget(hostDefinition.parameters as Type.TObject<any>, name === "bash"),
      execute: async (id, rawParams, signal, onUpdate, ctx) => {
        const identity = currentIdentity();
        assertCurrent(identity);
        const cwd = identity.cwd;
        const access = hostReads;
        const hostDefinition = createHostDefinition(name, cwd);
        const provider = scopedProvider(identity);
        const params = rawParams as ToolParams;
        const state = stateOf(deps);
        const hostMode = isHostMode(state);
        const active = isSandboxActive(state, deps.provider);
        const targetHost = isHostTarget(params);
        const cwdError = cwdRequestError(name, params, state);
        if (cwdError) { clearApproval(id); throw new Error(cwdError); }

        if (!deps.config.routeTools.includes(name)) {
          clearApproval(id);
          throw routeError(name);
        }
        if (hostMode) {
          return executeHost(hostDefinition, id, params, signal, onUpdate, ctx, false, identity);
        }
        if (targetHost) {
          return executeHost(hostDefinition, id, params, signal, onUpdate, ctx, true, identity);
        }
        if (!active) throw unavailableError(state);

        if (name === "read" && deps.config.allowSkillReads) {
          const hostSkillPath = await access.resolve(
            String((params as Record<string, unknown>).path ?? ""),
            cwd,
          );
          assertCurrent(identity);
          if (hostSkillPath) {
            return hostDefinition.execute(
              id,
              { ...withoutExecutionTarget(params), path: hostSkillPath },
              signal,
              onUpdate,
              ctx,
            );
          }
        }

        if (name === "grep") {
          const sandboxGrepExecute = deps.createGrepExecute({ provider, cwd, grepHelpers: deps.grepHelpers });
          const result = await sandboxGrepExecute(
            id,
            withoutExecutionTarget(params),
            signal,
            onUpdate,
          );
          await allowOutput(result, identity, access);
          return result;
        }

        const sandboxDefinition = createSandboxDefinition(name, cwd, provider, hostDefinition);
        const result = await sandboxDefinition.execute(
          id,
          withoutExecutionTarget(params),
          signal,
          onUpdate,
          ctx,
        );
        if (name === "bash") await allowOutput(result, identity, access);
        return result;
      },
    };
    pi.registerTool(wrapped);
  }

  pi.on("tool_call", async (event, ctx) => {
    const identity = currentIdentity();
    const state = stateOf(deps);
    const hostMode = isHostMode(state);
    const active = isSandboxActive(state, deps.provider);
    const tool = event.toolName;
    const input = asRecord(event.input);

    if (ROUTED_TOOL_SET.has(tool)) {
      clearApproval(event.toolCallId);
      if (execution && !execution.isReady()) return { block: true, reason: unavailableError(state).message };
      if (!deps.config.routeTools.includes(tool)) {
        return { block: true, reason: `Tool ${tool} is excluded from pi-microsandbox routing by configuration.` };
      }
      const cwdError = cwdRequestError(tool, input, state);
      if (cwdError) return { block: true, reason: cwdError };
      if (hostMode) return;
      if (input.execution_target !== "host") {
        if (!active) return { block: true, reason: unavailableError(state).message };
        return;
      }
      const error = hostRequestError(tool, input, state);
      if (error) return { block: true, reason: error };
      if (!ctx.hasUI) {
        return {
          block: true,
          reason: "Host execution requires user approval, but no interactive UI is available.",
        };
      }
      // Capture authorization before any filesystem/UI await, never from later mutable input.
      const id = event.toolCallId;
      const fingerprint = hostRequestFingerprint(tool, input, identity.cwd);
      const token = deps.provider.hostExecutionToken?.();
      const status = state.status;
      const requestedCwd = tool === "bash" ? input.cwd as string | undefined : undefined;
      const reviewedInput = structuredClone(input);
      const changed = () => currentIdentity() !== identity || execution && !execution.isReady()
        || event.toolCallId !== id || event.toolName !== tool || event.input !== input
        || asRecord(event.input).execution_target !== "host"
        || (tool === "bash" && asRecord(event.input).cwd !== requestedCwd)
        || hostRequestFingerprint(tool, asRecord(event.input), identity.cwd) !== fingerprint
        || stateOf(deps).status !== status || deps.provider.hostExecutionToken?.() !== token
        || !ctx.hasUI || !deps.config.routeTools.includes(tool as RoutedToolName)
        || cwdRequestError(tool, asRecord(event.input), stateOf(deps))
        || hostRequestError(tool, asRecord(event.input), stateOf(deps));
      const changedResult = () => ({ block: true, reason: "Session execution context or host request/readiness/configuration/runtime changed while awaiting approval; request again." });
      const rootProofRequired = isHostRecoveryState(state) || tool === "bash" && !!token && !!deps.provider.validateHostRecoveryRoot;
      if (rootProofRequired) {
        try { await validateHostRoot(identity, token); }
        catch { return { block: true, reason: HOST_ROOT_ERROR }; }
        if (changed()) return changedResult();
      }
      let hostCwd: HostBashCwd | undefined;
      const assertRequestCurrent = () => { if (changed()) throw new Error("Host request changed while awaiting approval."); };
      if (tool === "bash") {
        try { hostCwd = await discoverHostBashCwd(identity.cwd, requestedCwd, assertRequestCurrent); }
        catch { return changed() ? changedResult() : { block: true, reason: HOST_BASH_CWD_ERROR }; }
        if (changed()) return changedResult();
      }
      const choice = await approveHostExecution(ctx, (theme) => hostApprovalMessage(tool, reviewedInput, identity.cwd, theme, hostCwd));
      if (changed()) return changedResult();
      if (choice !== "Yes") return { block: true, reason: "Host execution was denied by the user." };
      if (rootProofRequired) {
        try { await validateHostRoot(identity, token); }
        catch { return { block: true, reason: HOST_ROOT_ERROR }; }
        if (changed()) return changedResult();
      }
      if (hostCwd) {
        try { await assertHostBashCwdCurrent(hostCwd, assertRequestCurrent); }
        catch { return changed() ? changedResult() : { block: true, reason: HOST_BASH_CWD_ERROR }; }
        if (changed()) return changedResult();
      }
      approvedHostCalls.set(id, { identity, fingerprint, status, token, cwd: hostCwd, rootProofRequired, requestCurrent: () => !changed() });
      return;
    }

    // Explicit host/off mode is the user's host-mode handoff, so the provenance
    // gate is intentionally inactive there.
    if (hostMode) return;

    const registered = (typeof (pi as ExtensionAPI).getAllTools === "function"
      ? pi.getAllTools()
      : []).find((candidate) => candidate.name === tool);
    if ((tool === "msb_config_get" || tool === "msb_config_set" || tool === "msb_diagnostics" || tool === "msb_dockerfile_get" || tool === "msb_dockerfile_write" || tool === "msb_dockerfile_build" || tool === "msb_dockerfile_load") && ownedConfigToolEntry
      && canonicalEntry(registered?.sourceInfo?.path) === ownedConfigToolEntry) return;
    const source = registered?.sourceInfo?.source;
    if (source === "builtin") return;
    if (!deps.config.blockThirdParty) return;
    if (deps.config.passThroughTools.includes(tool)) return;
    return {
      block: true,
      reason: `Tool ${tool} is not an approved pass-through tool for the selected pi-microsandbox environment.`,
    };
  });

  pi.on("tool_execution_end", (event) => {
    clearApproval(event.toolCallId);
  });

  pi.on("user_bash", (): UserBashEventResult | undefined => {
    const identity = currentIdentity();
    const state = stateOf(deps);
    if (isHostMode(state)) return undefined;
    if (!isSandboxActive(state, deps.provider)) {
      const error = unavailableError(state);
      const operations: BashOperations = {
        exec: async () => {
          throw error;
        },
      };
      return { operations };
    }
    const operations: BashOperations = {
      exec: async (command, _cwd, options) => scopedProvider(identity).withRuntime((runtime) =>
        runtime.operations.bash.exec(command, identity.cwd, options),
      ),
    };
    return { operations };
  });

  pi.on("before_agent_start", (event) => {
    const skills = (event.systemPromptOptions?.skills ?? []) as Array<{
      filePath?: string;
      baseDir?: string;
    }>;
    hostReads.updateSkills(
      (execution && !execution.isReady() ? [] : skills)
        .filter((skill): skill is { filePath: string; baseDir: string } =>
          typeof skill.filePath === "string" && typeof skill.baseDir === "string",
        )
        .map(({ filePath, baseDir }) => ({ filePath, baseDir })),
    );
    const state = stateOf(deps);
    const note = `${deps.systemPromptNote(state)}\nBefore creating Dockerfile customization, call msb_dockerfile_get with scope project/global for current content, authoritative host-owned paths and the bundled pinned base. Make the smallest Dockerfile edit needed, using minimal instructions. Do not add comments or explanatory boilerplate; put explanations and scope recommendations in the normal response, not the file. Preserve unrelated existing content and functional parser directives. New Dockerfiles start FROM the bundled digest pin. Propose the complete resulting content with msb_dockerfile_write in that scope; its explicit per-proposal approval covers writing only. Then explicitly call msb_dockerfile_build in that scope (autonomous build/export only, no approval dialog or UI needed), inspect its logs and artifactId, and explicitly call msb_dockerfile_load with that artifactId (separate default-No approval for import/select/guarded activation only). Failed builds preserve source and the previous image; load retries reuse the artifact. Edited sources are never implicitly built at startup/reload; stale artifacts cannot be loaded. Never use host commands or sandbox file tools for this flow, grant blanket host access, embed secrets, or silently change image intent; inspect shadowing with msb_config_get and propose image inherit separately.`;
    return { systemPrompt: note ? `${event.systemPrompt}\n\n${note}` : event.systemPrompt };
  });

  pi.on("session_shutdown", clearGrants);
}
