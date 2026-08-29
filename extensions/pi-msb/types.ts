/** Shared pi-microsandbox contracts. */
import { createHash } from "node:crypto";
import type {
  BashOperations,
  EditOperations,
  FindOperations,
  GrepOperations,
  LsOperations,
  ReadOperations,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";

// --------------------------------------------------------------- identity ----

export const STATE_SCHEMA_VERSION = 1;
export const LOCKFILE_VERSION = 1;

export function resourceId(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 20);
}
export function displayId(sessionId: string): string {
  return resourceId(sessionId).slice(0, 6);
}
export function sandboxNameFor(sessionId: string): string {
  return `pi-msb-${resourceId(sessionId)}`;
}
export function volumeNameFor(sessionId: string): string {
  return `pi-msb-vol-${resourceId(sessionId)}`;
}

// ---------------------------------------------------------------- config ----

export type StorageMode = "git" | "direct" | "none";
export type ConfigStorageMode = "auto" | StorageMode;
export type NetworkMode = "default" | "open" | "allowlist" | "deny";
export type FallbackMode = "block" | "host";
export type BootstrapTools = "auto" | boolean;
export type MountType = "dir" | "file" | "named" | "tmpfs";

export interface NetworkConfig {
  mode: NetworkMode;
  allowHosts: string[];
  allowDns: boolean;
  publishPorts: string[];
}
export interface SecretConfig {
  env: string;
  value: string;
  allowHosts: string[];
}
export interface MountConfig {
  type: MountType;
  hostPath?: string;
  guestPath?: string;
  readonly: boolean;
  options: string[];
}
export interface Config {
  image: string;
  bootstrapTools: BootstrapTools;
  cpus: number;
  memoryMiB: number;
  idleTimeoutSec: number;
  stopTimeoutMs: number;
  detached: boolean;
  replace: boolean;
  replaceTimeoutMs: number;
  sandboxName: string | null;
  mode: ConfigStorageMode;
  cloneBranch: "current" | string;
  cloneDepth: number | "unlimited";
  shallowArchive: boolean;
  volumeQuotaMiB: number;
  network: NetworkConfig;
  secrets: SecretConfig[];
  mounts: MountConfig[];
  blockThirdParty: boolean;
  routeTools: string[];
  passThroughTools: string[];
  allowHostExecution: boolean;
  allowSkillReads: boolean;
  fallbackMode: FallbackMode;
  exposeSessionEnvironment: boolean;
  hostEnv: string[];
  autoStart: boolean;
  pruneOnStart: boolean;
  lockDir: string;
  hostRoAllowlist: string[];
}
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer U>
    ? Array<DeepPartial<U>> | Array<U>
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};
export type ConfigLayerName = "defaults" | "global" | "project" | "env" | "cli";
export interface ParsedConfigLayer {
  name: ConfigLayerName;
  value: DeepPartial<Config>;
  warnings: string[];
  source?: string;
}
export interface ResolvedConfig {
  config: Config;
  provenance: Record<string, ConfigLayerName>;
  warnings: string[];
}
export interface MergeResult {
  value: DeepPartial<Config>;
  provenance: Record<string, ConfigLayerName>;
  warnings: string[];
}

// ---------------------------------------------------------- labels/state ----

export const LABEL_KEYS = {
  managed: "pi-msb.managed",
  schema: "pi-msb.schema",
  session: "pi-msb.session",
  mode: "pi-msb.mode",
  cwd: "pi-msb.cwd",
  pid: "pi-msb.pid",
  volume: "pi-msb.volume",
  image: "pi-msb.image",
  keep: "pi-msb.keep",
  seedBranch: "pi-msb.seed-branch",
  seedSha: "pi-msb.seed-sha",
} as const;

export interface SandboxLabelInput {
  sessionId: string;
  mode: StorageMode;
  cwd: string;
  pid: number;
  image: string;
  volumeName?: string;
  seedBranch?: string | null;
  seedSha?: string | null;
}
export interface VolumeLabelInput {
  sessionId: string;
  cwd: string;
  seedBranch?: string | null;
  seedSha?: string | null;
}
export interface ManagedSandboxRecord {
  name: string;
  status?: string;
  labels: Record<string, string>;
  createdAt?: number;
}
export interface ValidatedManagedSandbox extends ManagedSandboxRecord {
  sessionId: string;
  mode: StorageMode;
  cwd: string;
  volumeName?: string;
}
export interface VolumeRecord {
  name: string;
  hostPath: string;
  labels: Record<string, string>;
  kind?: string;
  usedBytes?: number;
  createdAt?: number;
}
export interface PersistedSandboxState {
  version: typeof STATE_SCHEMA_VERSION;
  sessionId: string;
  sandboxName: string;
  mode: StorageMode;
  cwd: string;
  image: string;
  volumeName?: string;
  volumeHostPath?: string;
  seedBranch?: string | null;
  seedSha?: string | null;
  enabled: boolean;
  createdAt: number;
}

// ----------------------------------------------------------------- locks ----

export interface LockInfo {
  version: typeof LOCKFILE_VERSION;
  sessionId: string;
  sandboxName: string;
  volumeName?: string;
  mode: StorageMode;
  cwd: string;
  pid: number;
  createdAt: number;
}
export interface LockHandle {
  readonly path: string;
  release(): Promise<void>;
}
export interface LocksPort {
  tryAcquire(sessionId: string): Promise<LockHandle | null>;
}

// ------------------------------------------------------------- git/storage ----

export interface GitRepoInfo {
  isGitRepo: boolean;
  /** Canonical host source for direct binds; guest paths remain lexical. */
  hostCwd?: string;
  /** Canonical host source used only for Git reads and seed bundle creation. */
  repoRoot: string | null;
  /** Lexical guest namespace where the retained volume must be mounted. */
  guestRepoRoot?: string | null;
  branch: string | null;
  headSha: string | null;
  unborn: boolean;
  isLinkedWorktree: boolean;
}
export interface GitSeedBundle {
  hostPath: string;
  branch: string | null;
  headSha: string;
  cleanup(): Promise<void>;
}
export interface GitVolumePlan {
  kind: "git-volume";
  sessionId: string;
  volumeName: string;
  volumeQuotaMiB: number;
  repoRoot: string;
  mountGuestPath: string;
  workdir: string;
  branch: string | null;
  headSha: string | null;
  unborn: boolean;
  depth: number | "unlimited";
  seedRequired: boolean;
}
export type StoragePlan =
  | GitVolumePlan
  | { kind: "direct-mount"; hostPath: string; guestPath: string; workdir: string }
  | { kind: "none"; guestPath: string; workdir: string };
export interface PreparedStorage {
  plan: StoragePlan;
  volume?: VolumeRecord;
  bundle?: GitSeedBundle | null;
  createdVolume: boolean;
}
export interface SeedResult { headSha: string | null }

// ------------------------------------------------------------- transport ----

export type TransportErrorCode =
  | "NOT_FOUND"
  | "ACCESS"
  | "TIMEOUT"
  | "ABORTED"
  | "SANDBOX_DOWN"
  | "INVALID"
  | "IO"
  | "UNKNOWN";
export interface TransportError extends Error {
  readonly code: TransportErrorCode;
  readonly cause?: unknown;
}
export type EntryKind = "file" | "directory" | "other";
export interface FsEntry { name: string; kind: EntryKind }
export interface StatResult {
  kind: EntryKind;
  size: number;
  mode: number;
  readonly: boolean;
  modifiedAt: number | null;
}
export interface TransportExecResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}
export interface ExecOptions { cwd?: string; timeoutMs?: number }
export interface ExecStreamOptions extends ExecOptions {
  signal?: AbortSignal;
  onStdout?: (data: Buffer) => void;
  onStderr?: (data: Buffer) => void;
}
export interface SandboxTransport {
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: string | Buffer): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<StatResult>;
  list(path: string): Promise<FsEntry[]>;
  copyFromHost(hostPath: string, guestPath: string): Promise<void>;
  copyToHost(guestPath: string, hostPath: string): Promise<void>;
  exec(command: string, args: string[], options?: ExecOptions): Promise<TransportExecResult>;
  execStream(command: string, args: string[], options?: ExecStreamOptions): Promise<{ exitCode: number }>;
  dispose(): Promise<void>;
}

// --------------------------------------------------------------- tool ops ----

export interface ToolOperations {
  read: ReadOperations;
  write: WriteOperations;
  edit: EditOperations;
  bash: BashOperations;
  ls: LsOperations;
  find: FindOperations;
  grep: GrepOperations;
}
export interface RuntimeExecution {
  transport: SandboxTransport;
  operations: ToolOperations;
}
export interface ToolOpsProvider {
  isActive(): boolean;
  getState(): RuntimeState;
  withRuntime<T>(callback: (runtime: RuntimeExecution) => Promise<T>): Promise<T>;
}
export interface GrepFormattingHelpers {
  DEFAULT_MAX_BYTES: number;
  DEFAULT_MAX_LINES: number;
  truncateHead: (content: string, options?: unknown) => any;
  truncateLine: (line: string, maxChars?: number) => { text: string; wasTruncated: boolean };
  formatSize: (bytes: number) => string;
}
export type SandboxGrepExecute = (
  id: string,
  params: Record<string, any>,
  signal?: AbortSignal,
  onUpdate?: (value: any) => void,
) => Promise<any>;

// ----------------------------------------------------------- host access ----

export type ExecutionTarget = "sandbox" | "host";
export interface DiscoveredSkillPath { filePath: string; baseDir: string }
export interface HostReadAccess {
  updateSkills(skills: readonly DiscoveredSkillPath[]): void;
  allowGeneratedFile(path: string): Promise<void>;
  resolve(requestedPath: string, cwd: string): Promise<string | undefined>;
  clear(): void;
}

// -------------------------------------------------------- manager/runtime ----

export type RuntimeStatus =
  | "booting"
  | "active"
  | "stopping"
  | "unavailable"
  | "off"
  | "host-fallback"
  | "disabled";
export interface SandboxInfo {
  name: string;
  displayId: string;
  mode: StorageMode;
  image: string;
  pid: number;
  cwd: string;
  volumeName?: string;
  volumeHostPath?: string;
  seedBranch?: string | null;
  seedSha?: string | null;
  createdAt: number;
}
export interface RuntimeState {
  status: RuntimeStatus;
  info: SandboxInfo | null;
  reason?: string;
}
export interface BootRequest {
  sessionId: string;
  cwd: string;
  config: Config;
  restored: PersistedSandboxState | null;
}
export interface SandboxManager extends ToolOpsProvider {
  boot(request: BootRequest): Promise<RuntimeState>;
  shutdown(): Promise<void>;
  setEnabled(enabled: boolean): Promise<RuntimeState>;
}

// ------------------------------------------------------------------ prune ----

export interface PruneReport {
  inspected: number;
  removed: string[];
  kept: string[];
  errors: string[];
}

// --------------------------------------------------------------- host exec ----

export type ExecFn = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string; code: number; killed?: boolean }>;

// ------------------------------------------------------- command/control ----

export interface ExportResult { source: string; destination: string }
export interface MsbControl {
  getState(): RuntimeState;
  setEnabled(enabled: boolean): Promise<void>;
  reload(): Promise<void>;
  pruneNow(): Promise<PruneReport>;
  listVolumes(): Promise<VolumeRecord[]>;
  describeVolume(name: string): Promise<{
    volume: VolumeRecord;
    branch?: string;
    lastCommit?: string;
    dirtyCount?: number;
    mounted: boolean;
  }>;
  removeVolume(name: string): Promise<void>;
  exportPaths(paths: string[], destination?: string): Promise<ExportResult[]>;
  getLogs(tailLines?: number): Promise<string>;
  getEffectiveConfig(): ResolvedConfig;
  getEffectiveConfigToml(): string;
  setOverride(dottedSnakeKey: string, value: unknown): Promise<void>;
  unsetOverride(dottedSnakeKey: string): Promise<void>;
  resetOverrides(): Promise<void>;
}
