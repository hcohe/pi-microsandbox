import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { readRepositoryCatalog, type CatalogOptions } from "./repository-catalog.ts";

/** Policy identity only: never use projectPolicyRoot as a workspace/mount root. */
export interface ProjectIdentity {
  cwd: string;
  projectPolicyRoot: string;
  repositoryName: string;
  worktreeName: string;
  isWorktree: boolean;
  /** Structural association to pin for a session; removing metadata must not downgrade policy. */
  association: {
    kind: "non-git" | "main" | "linked" | "gitfile" | "bare";
    checkoutRoot: string;
    gitDir: string | null;
    commonDir: string | null;
    mainCheckoutRoot: string | null;
  };
  /** Proof locations reserved against additional writable host mounts; the checkout gitfile remains untrusted. */
  protectedPaths: string[];
  /** Includes discovery dependencies even when no policy files exist. Re-discover before approval/use. */
  fingerprint: string;
}

export class ProjectIdentityError extends Error {
  constructor() {
    super("Git project identity could not be safely verified");
    this.name = "ProjectIdentityError";
  }
}

/** No Git execution, config interpretation, hooks, or ambient Git environment. */
export async function discoverProjectIdentity(cwd: string, realpath: (path: string) => Promise<string> = fs.realpath, catalog?: CatalogOptions): Promise<ProjectIdentity> {
  const canonicalCwd = await realpath(resolve(cwd));
  const evidence: unknown[] = [canonicalCwd];
  const dependencies = new Map<string, string>();
  // Directory contents legitimately change during guest writes. Only replacement
  // (not mutable directory timestamps/size) changes a directory identity.
  const signature = (stat: import("node:fs").Stats | null) => JSON.stringify(stat === null ? null
    : stat.isDirectory() ? [stat.dev, stat.ino, stat.mode]
      : [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs]);
  const record = (path: string, stat: import("node:fs").Stats | null) => {
    const value = signature(stat);
    if (dependencies.has(path) && dependencies.get(path) !== value) throw new ProjectIdentityError();
    dependencies.set(path, value);
    evidence.push([path, value]);
  };
  const inspect = async (path: string) => {
    try {
      const stat = await fs.lstat(path);
      record(path, stat);
      return stat;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ProjectIdentityError();
      record(path, null);
      return null;
    }
  };
  const directory = async (path: string) => {
    const stat = await inspect(path);
    if (!stat?.isDirectory() || await fs.realpath(path) !== path) throw new ProjectIdentityError();
  };
  const metadata = async (path: string): Promise<string> => {
    const before = await inspect(path);
    if (!before?.isFile() || before.size > 16 * 1024 || before.nlink !== 1) throw new ProjectIdentityError();
    const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const same = (stat: typeof before) => stat.dev === before.dev && stat.ino === before.ino && stat.size === before.size && stat.mtimeMs === before.mtimeMs && stat.ctimeMs === before.ctimeMs;
      if (!same(await file.stat())) throw new ProjectIdentityError();
      const buffer = Buffer.alloc(before.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = await file.read(buffer, length, buffer.length - length, length);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length !== before.size || !same(await file.stat())) throw new ProjectIdentityError();
      const text = buffer.subarray(0, length).toString("utf8");
      if (text.includes("\0")) throw new ProjectIdentityError();
      evidence.push([path, text]);
      return text.trim();
    } finally { await file.close(); }
  };
  let checkoutRoot = canonicalCwd;
  let projectPolicyRoot = canonicalCwd;
  let isWorktree = false;
  let kind: ProjectIdentity["association"]["kind"] = "non-git";
  let gitDir: string | null = null;
  let commonDir: string | null = null;
  let mainCheckoutRoot: string | null = null;
  const protectedPaths: string[] = [];
  try {
    await inspect(canonicalCwd);
    const inside = (path: string, root: string) => { const suffix = relative(root, path); return !suffix || suffix !== ".." && !suffix.startsWith(`..${sep}`) && !suffix.startsWith(sep); };
    const candidates: Array<{ checkoutRoot: string; gitDir: string; commonDir: string; mainRoot: string }> = [];
    let authoritative: { checkoutRoot: string; gitDir: string; commonDir: string; mainRoot: string } | undefined;
    if (catalog) {
      const entries = await readRepositoryCatalog(catalog);
      evidence.push(["repository-catalog", entries]);
      const match = (candidate: NonNullable<typeof authoritative>) => {
        if (inside(canonicalCwd, candidate.checkoutRoot)) candidates.push(candidate);
      };
      for (const { metadata: entry } of entries) {
        // Every catalog proof is authoritative on future loads, even for an
        // unrelated current cwd. No explicit writable mount may forge one.
        protectedPaths.push(entry.common_dir, join(entry.common_dir, "worktrees"));
        await directory(entry.common_dir);
        match({ checkoutRoot: entry.main_root, gitDir: entry.common_dir, commonDir: entry.common_dir, mainRoot: entry.main_root });
        const registrations = join(entry.common_dir, "worktrees");
        const stat = await inspect(registrations);
        if (!stat) continue;
        await directory(registrations);
        let count = 0;
        const dir = await fs.opendir(registrations);
        const names: string[] = [];
        for await (const registration of dir) {
          if (++count > 4096 || !registration.isDirectory()) throw new ProjectIdentityError();
          names.push(registration.name);
        }
        evidence.push([registrations, names.sort()]);
        for (const name of names) {
          const registered = join(registrations, name);
          await directory(registered);
          const backpointer = await metadata(join(registered, "gitdir"));
          if (!backpointer || /[\r\n]/.test(backpointer)) throw new ProjectIdentityError();
          const backlink = resolve(registered, backpointer);
          if (basename(backlink) !== ".git") throw new ProjectIdentityError();
          let root: string;
          try { root = await fs.realpath(dirname(backlink)); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
          const common = await metadata(join(registered, "commondir"));
          if (!common || /[\r\n]/.test(common) || await fs.realpath(resolve(registered, common)) !== entry.common_dir) throw new ProjectIdentityError();
          match({ checkoutRoot: root, gitDir: registered, commonDir: entry.common_dir, mainRoot: entry.main_root });
        }
      }
    }
    // A catalog association survives a deleted checkout gitfile, but never
    // inherits across a nearer repository/submodule/bare discovery boundary.
    let boundary = canonicalCwd;
    for (let depth = 0; ; depth++) {
      if (depth > 256) throw new ProjectIdentityError();
      const matches = candidates.filter((candidate) => candidate.checkoutRoot === boundary);
      if (matches.length > 1) throw new ProjectIdentityError();
      if (matches.length) { authoritative = matches[0]; break; }
      if (await inspect(join(boundary, ".git"))
        || (await inspect(join(boundary, "HEAD")))?.isFile()
          && (await inspect(join(boundary, "objects")))?.isDirectory()
          && (await inspect(join(boundary, "refs")))?.isDirectory()) break;
      const parent = dirname(boundary);
      if (parent === boundary) break;
      boundary = parent;
    }
    if (authoritative) {
      checkoutRoot = authoritative.checkoutRoot;
      gitDir = authoritative.gitDir;
      commonDir = authoritative.commonDir;
      mainCheckoutRoot = authoritative.mainRoot;
      isWorktree = gitDir !== commonDir;
      kind = isWorktree ? "linked" : "main";
      projectPolicyRoot = mainCheckoutRoot;
      // Shared policy cannot be downgraded by deleting the checkout gitfile
      // or replacing it with a guest-created .git directory/conflicting pointer.
      const dotgit = join(checkoutRoot, ".git");
      const stat = await inspect(dotgit);
      if (stat) {
        if (isWorktree) {
          if (!stat.isFile()) throw new ProjectIdentityError();
          const pointer = /^gitdir: ([^\r\n]+)$/.exec(await metadata(dotgit));
          if (!pointer || await fs.realpath(resolve(checkoutRoot, pointer[1]!)) !== gitDir) throw new ProjectIdentityError();
        } else if (!stat.isDirectory() || await fs.realpath(dotgit) !== commonDir) throw new ProjectIdentityError();
      }
      if (isWorktree) {
        if (inside(commonDir, checkoutRoot)) throw new ProjectIdentityError();
        protectedPaths.push(commonDir, gitDir, join(gitDir, "commondir"), join(gitDir, "gitdir"));
      }
    }
    let current = canonicalCwd;
    for (let depth = 0; !authoritative; depth++) {
      if (depth > 256) throw new ProjectIdentityError();
      const dotgit = join(current, ".git");
      const entry = await inspect(dotgit);
      if (entry) {
        checkoutRoot = current;
        if (entry.isDirectory()) {
          kind = "main";
          gitDir = dotgit;
          commonDir = dotgit;
          mainCheckoutRoot = current;
          projectPolicyRoot = current;
          await directory(dotgit);
          protectedPaths.push(dotgit, join(dotgit, "worktrees"));
          // Main association only; host targets select the shared namespace separately.
          if (await inspect(join(dotgit, "commondir"))) throw new ProjectIdentityError();
        } else if (entry.isFile()) {
          const pointer = /^gitdir: ([^\r\n]+)$/.exec(await metadata(dotgit));
          if (!pointer) throw new ProjectIdentityError();
          const gitdirPath = resolve(current, pointer[1]!);
          const gitdir = await fs.realpath(gitdirPath);
          kind = "gitfile";
          gitDir = gitdir;
          await directory(gitdir);
          const commondirFile = join(gitdir, "commondir");
          if (await inspect(commondirFile)) {
            const commonPointer = await metadata(commondirFile);
            if (!commonPointer || /[\r\n]/.test(commonPointer)) throw new ProjectIdentityError();
            const commonPath = resolve(gitdir, commonPointer);
            const common = await fs.realpath(commonPath);
            await directory(common);
            const commonRelative = relative(current, common);
            if (!commonRelative || commonRelative !== ".." && !commonRelative.startsWith(`..${sep}`) && !commonRelative.startsWith(sep)) throw new ProjectIdentityError();
            // Only the standard, main-checkout .git layout is shared. Separate
            // git dirs and submodules stay cwd-local; core.worktree is never read.
            if (basename(common) !== ".git" || dirname(dirname(gitdir)) !== common || basename(dirname(gitdir)) !== "worktrees") throw new ProjectIdentityError();
            await directory(dirname(gitdir));
            const mainRoot = dirname(common);
            if ((await inspect(join(mainRoot, ".git")))?.isDirectory() !== true) throw new ProjectIdentityError();
            const backpointer = await metadata(join(gitdir, "gitdir"));
            if (!backpointer || /[\r\n]/.test(backpointer) || await fs.realpath(resolve(gitdir, backpointer)) !== dotgit) throw new ProjectIdentityError();
            projectPolicyRoot = mainRoot;
            isWorktree = true;
            kind = "linked";
            commonDir = common;
            mainCheckoutRoot = mainRoot;
            protectedPaths.push(common, gitdir, gitdirPath, commonPath, commondirFile, join(gitdir, "gitdir"), resolve(gitdir, backpointer));
          }
          // A gitfile without commondir (e.g. submodule/separate-git-dir) is local.
        } else throw new ProjectIdentityError();
        break;
      }
      // Match Git's bare-repository stopping boundary without interpreting config.
      if ((await inspect(join(current, "HEAD")))?.isFile()
        && (await inspect(join(current, "objects")))?.isDirectory()
        && (await inspect(join(current, "refs")))?.isDirectory()) {
        kind = "bare";
        checkoutRoot = current;
        break;
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    // Refuse a discovery assembled across concurrent metadata/cwd replacement.
    for (const [path, expected] of dependencies) {
      let stat = null;
      try { stat = await fs.lstat(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (signature(stat) !== expected) throw new ProjectIdentityError();
    }
    if (await realpath(resolve(cwd)) !== canonicalCwd) throw new ProjectIdentityError();
  } catch { throw new ProjectIdentityError(); }
  const repositoryRoot = mainCheckoutRoot ?? checkoutRoot;
  const identity = {
    cwd: canonicalCwd,
    projectPolicyRoot,
    repositoryName: basename(repositoryRoot),
    worktreeName: basename(checkoutRoot),
    isWorktree,
    association: { kind, checkoutRoot, gitDir, commonDir, mainCheckoutRoot },
    protectedPaths: [...new Set(protectedPaths)],
  };
  return { ...identity, fingerprint: createHash("sha256").update(JSON.stringify([identity, evidence])).digest("hex") };
}
