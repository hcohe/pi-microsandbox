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
  SandboxGrepExecute,
  ToolOpsProvider,
} from "./types.ts";

export type ExecutionTarget = ContractExecutionTarget;

type RoutedToolName = "bash" | "edit" | "find" | "grep" | "ls" | "read" | "write";
const ROUTED_TOOLS: readonly RoutedToolName[] = ["bash", "edit", "find", "grep", "ls", "read", "write"];
const ROUTED_TOOL_SET = new Set<string>(ROUTED_TOOLS);
const EXECUTION_TARGET_DESCRIPTION =
  'Where to execute this tool call. Omit this or use "sandbox" normally. Use "host" only when sandbox execution cannot perform the operation; host execution requires user approval while sandboxing is active.';

/** Add the routing control without changing any of the built-in required fields. */
export function withExecutionTarget<T extends Type.TProperties>(
  schema: Type.TObject<T>,
): Type.TObject<any> {
  return Type.Object({
    ...schema.properties,
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

export function hostApprovalMessage(
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
  theme?: Pick<Theme, "fg" | "bold">,
): string {
  const label = (text: string) => theme ? theme.fg("muted", text) : text;
  const value = (text: string) => theme ? theme.fg("text", text) : text;
  const command = tool === "bash" && typeof input.command === "string" ? input.command : undefined;
  // Commands are no longer JSON-escaped: keep terminal controls visible, not executable.
  const content = command === undefined
    ? JSON.stringify(sortForFingerprint(withoutExecutionTarget(input)), null, 2)
    : command.replace(/[\p{Cc}\p{Cf}]/gu, (char) => char === "\n" ? char : `\\u{${char.codePointAt(0)!.toString(16)}}`);
  const warning = "Warning: this operation runs on the host and bypasses VM, process, and network isolation.";
  return [
    `${label("Tool:")} ${theme ? theme.bold(theme.fg("accent", tool)) : tool}`,
    `${label("Working directory:")} ${value(cwd)}`,
    "",
    theme ? theme.bold(theme.fg("warning", warning)) : warning,
    "",
    label(command === undefined ? "Exact arguments:" : "Command:"),
    ...(command === undefined ? [] : [""]),
    ...(theme && command === undefined ? highlightCode(content, "json") : content.split("\n"))
      .map((line) => command === undefined ? `  ${line}` : theme ? theme.fg("syntaxString", line) : line),
  ].join("\n");
}

export interface RegisterToolsDeps {
  provider: ToolOpsProvider;
  config: Config;
  cwd: string;
  hostReads: HostReadAccess;
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

function stateOf(deps: RegisterToolsDeps): RuntimeState {
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
  return new Error("Sandbox is unavailable; routed tool execution is blocked. Use msb_diagnostics and msb_config_get to diagnose it; msb_config_set can request an approved repair without a running sandbox.");
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

        const factory = {
          bash: createBashToolDefinition,
          edit: createEditToolDefinition,
          find: createFindToolDefinition,
          grep: createGrepToolDefinition,
          ls: createLsToolDefinition,
          read: createReadToolDefinition,
          write: createWriteToolDefinition,
        }[name] as (cwd: string, options?: never) => AnyToolDefinition;
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
  const sandboxGrepExecute = deps.createGrepExecute({
    provider: deps.provider,
    cwd: deps.cwd,
    grepHelpers: deps.grepHelpers,
  });
  const approvedHostCalls = new Map<string, string>();

  const clearApproval = (id: unknown): void => {
    if (typeof id === "string") approvedHostCalls.delete(id);
  };

  const requireApprovedHostExecution = (
    tool: string,
    id: string,
    input: Record<string, unknown>,
  ): void => {
    const approved = approvedHostCalls.get(id);
    approvedHostCalls.delete(id);
    if (approved !== hostRequestFingerprint(tool, input, deps.cwd)) {
      throw new Error("Host execution was not approved for this exact tool call.");
    }
    // Approval is deliberately consumed here rather than cached; a runtime
    // state change must never extend a one-call host escape.
  };

  const executeHost = async (
    definition: AnyToolDefinition,
    id: string,
    input: ToolParams,
    signal: AbortSignal | undefined,
    onUpdate: any,
    ctx: ExtensionContext,
    active: boolean,
  ): Promise<any> => {
    if (active) {
      if (!deps.config.allowHostExecution) {
        throw new Error("Host execution is disabled by pi-microsandbox configuration.");
      }
      requireApprovedHostExecution(definition.name, id, input);
    }
    return definition.execute(id, withoutExecutionTarget(input), signal, onUpdate, ctx);
  };

  for (const name of ROUTED_TOOLS) {
    const hostDefinition = hostDefinitions[name];
    const wrapped: AnyToolDefinition = {
      ...hostDefinition,
      parameters: withExecutionTarget(hostDefinition.parameters as Type.TObject<any>),
      execute: async (id, rawParams, signal, onUpdate, ctx) => {
        const params = rawParams as ToolParams;
        const state = stateOf(deps);
        const hostMode = isHostMode(state);
        const active = isSandboxActive(state, deps.provider);
        const targetHost = isHostTarget(params);

        if (!deps.config.routeTools.includes(name)) throw routeError(name);
        if (hostMode) {
          return executeHost(hostDefinition, id, params, signal, onUpdate, ctx, false);
        }
        if (!active) throw unavailableError(state);
        if (targetHost) {
          return executeHost(hostDefinition, id, params, signal, onUpdate, ctx, true);
        }

        if (name === "read" && deps.config.allowSkillReads) {
          const hostSkillPath = await deps.hostReads.resolve(
            String((params as Record<string, unknown>).path ?? ""),
            deps.cwd,
          );
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
          const result = await sandboxGrepExecute(
            id,
            withoutExecutionTarget(params),
            signal,
            onUpdate,
          );
          const fullOutputPath = resultFullOutputPath(result);
          if (fullOutputPath) await deps.hostReads.allowGeneratedFile(fullOutputPath);
          return result;
        }

        const sandboxDefinition = createSandboxDefinition(name, deps.cwd, deps.provider, hostDefinition);
        const result = await sandboxDefinition.execute(
          id,
          withoutExecutionTarget(params),
          signal,
          onUpdate,
          ctx,
        );
        if (name === "bash") {
          const fullOutputPath = resultFullOutputPath(result);
          if (fullOutputPath) await deps.hostReads.allowGeneratedFile(fullOutputPath);
        }
        return result;
      },
    };
    pi.registerTool(wrapped);
  }

  pi.on("tool_call", async (event, ctx) => {
    const state = stateOf(deps);
    const hostMode = isHostMode(state);
    const active = isSandboxActive(state, deps.provider);
    const tool = event.toolName;
    const input = asRecord(event.input);

    if (ROUTED_TOOL_SET.has(tool)) {
      if (!deps.config.routeTools.includes(tool)) {
        return { block: true, reason: `Tool ${tool} is excluded from pi-microsandbox routing by configuration.` };
      }
      if (hostMode) return;
      if (!active) {
        return { block: true, reason: unavailableError(state).message };
      }
      if (input.execution_target !== "host") return;
      if (!deps.config.allowHostExecution) {
        return { block: true, reason: "Host execution is disabled by pi-microsandbox configuration." };
      }
      if (!ctx.hasUI) {
        return {
          block: true,
          reason: "Host execution requires user approval, but no interactive UI is available.",
        };
      }
      // Keep RPC prompts plain, and make denial the default in the TUI selector.
      const message = hostApprovalMessage(tool, input, deps.cwd, ctx.mode === "tui" ? ctx.ui.theme : undefined);
      const choice = await ctx.ui.select(`Allow host execution?\n\n${message}`, ["No", "Yes"]);
      if (choice !== "Yes") {
        clearApproval(event.toolCallId);
        return { block: true, reason: "Host execution was denied by the user." };
      }
      approvedHostCalls.set(
        event.toolCallId,
        hostRequestFingerprint(tool, input, deps.cwd),
      );
      return;
    }

    // Explicit host/off mode is the user's host-mode handoff, so the provenance
    // gate is intentionally inactive there.
    if (hostMode) return;

    const registered = (typeof (pi as ExtensionAPI).getAllTools === "function"
      ? pi.getAllTools()
      : []).find((candidate) => candidate.name === tool);
    if ((tool === "msb_config_get" || tool === "msb_config_set" || tool === "msb_diagnostics") && ownedConfigToolEntry
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
      exec: async (command, cwd, options) => deps.provider.withRuntime((runtime) =>
        runtime.operations.bash.exec(command, cwd, options),
      ),
    };
    return { operations };
  });

  pi.on("before_agent_start", (event) => {
    const skills = (event.systemPromptOptions?.skills ?? []) as Array<{
      filePath?: string;
      baseDir?: string;
    }>;
    deps.hostReads.updateSkills(
      skills
        .filter((skill): skill is { filePath: string; baseDir: string } =>
          typeof skill.filePath === "string" && typeof skill.baseDir === "string",
        )
        .map(({ filePath, baseDir }) => ({ filePath, baseDir })),
    );
    const state = stateOf(deps);
    const note = deps.systemPromptNote(state);
    return { systemPrompt: note ? `${event.systemPrompt}\n\n${note}` : event.systemPrompt };
  });

  pi.on("session_shutdown", () => {
    approvedHostCalls.clear();
    deps.hostReads.clear();
  });
}
