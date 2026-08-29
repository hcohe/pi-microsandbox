import { lstat, realpath } from "node:fs/promises";
import * as path from "node:path";

import type { DiscoveredSkillPath, HostReadAccess } from "./types.ts";

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function denied(requestedPath: string, reason: string, cause?: unknown): Error {
  const error = new Error(`Host read denied for ${requestedPath}: ${reason}`);
  if (cause !== undefined) (error as Error & { cause?: unknown }).cause = cause;
  return error;
}

async function canonicalRegularFile(requestedPath: string): Promise<string> {
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(requestedPath);
  } catch (error) {
    throw denied(requestedPath, "the file is missing or cannot be resolved", error);
  }

  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(canonicalPath);
  } catch (error) {
    throw denied(requestedPath, "the file cannot be inspected", error);
  }
  if (!stats.isFile()) throw denied(requestedPath, "the target is not a regular file");
  return canonicalPath;
}

/**
 * Resolve a read against the host copy of a Pi-discovered skill.
 *
 * A discovered SKILL.md grants its directory only after canonical containment
 * has been checked. Other discovered files are standalone skills and grant no
 * supporting files. This host exception is intentionally read-only and narrow.
 */
export async function resolveDiscoveredSkillRead(
  requestedPath: string,
  cwd: string,
  skills: readonly DiscoveredSkillPath[],
): Promise<string | undefined> {
  const requestedAbsolute = path.resolve(cwd, requestedPath);
  const exactSkills: string[] = [];
  const directorySkills: string[] = [];

  for (const skill of skills) {
    const skillFile = path.resolve(skill.filePath);
    if (requestedAbsolute === skillFile) exactSkills.push(skillFile);

    if (path.basename(skillFile) === "SKILL.md") {
      const baseDir = path.resolve(skill.baseDir);
      if (isWithin(baseDir, requestedAbsolute)) directorySkills.push(baseDir);
    }
  }

  // Do not touch unrelated host paths. An undefined result lets the normal
  // sandbox read path handle them.
  if (exactSkills.length === 0 && directorySkills.length === 0) return undefined;

  if (exactSkills.length > 0) {
    for (const skillFile of exactSkills) {
      let skillCanonical: string;
      try {
        skillCanonical = await realpath(skillFile);
      } catch (error) {
        throw denied(requestedPath, "the discovered skill is missing or cannot be resolved", error);
      }

      let requestedCanonical: string;
      try {
        requestedCanonical = await realpath(requestedAbsolute);
      } catch (error) {
        throw denied(requestedPath, "the discovered skill is missing or cannot be resolved", error);
      }
      if (requestedCanonical !== skillCanonical) {
        throw denied(requestedPath, "it no longer resolves to the discovered skill");
      }
      return canonicalRegularFile(requestedAbsolute);
    }
  }

  let requestedCanonical: string;
  try {
    requestedCanonical = await realpath(requestedAbsolute);
  } catch (error) {
    throw denied(requestedPath, "the file is missing or cannot be resolved", error);
  }

  for (const baseDir of directorySkills) {
    let canonicalBaseDir: string;
    try {
      canonicalBaseDir = await realpath(baseDir);
    } catch (error) {
      throw denied(requestedPath, "the discovered skill directory is missing or cannot be resolved", error);
    }

    if (!isWithin(canonicalBaseDir, requestedCanonical)) {
      throw denied(requestedPath, "it resolves outside the discovered skill directory");
    }
    return canonicalRegularFile(requestedAbsolute);
  }

  // The path was lexically under a discovered directory, but its canonical
  // target was outside it (usually a supporting symlink).
  throw denied(requestedPath, "it resolves outside the discovered skill directory");
}

export function createHostReadAccess(): HostReadAccess {
  let skills: readonly DiscoveredSkillPath[] = [];
  const generatedFiles = new Set<string>();

  return {
    updateSkills(nextSkills) {
      // The list is replaced on every before_agent_start; retaining an old list
      // would make a later turn inherit a host-read grant it did not discover.
      skills = nextSkills.map((skill) => ({
        filePath: skill.filePath,
        baseDir: skill.baseDir,
      }));
    },

    async allowGeneratedFile(filePath) {
      const absolutePath = path.resolve(filePath);
      const canonicalPath = await canonicalRegularFile(absolutePath);
      generatedFiles.add(canonicalPath);
    },

    async resolve(requestedPath, cwd) {
      const skillPath = await resolveDiscoveredSkillRead(requestedPath, cwd, skills);
      if (skillPath !== undefined) return skillPath;

      if (generatedFiles.size === 0) return undefined;

      const requestedAbsolute = path.resolve(cwd, requestedPath);
      let requestedCanonical: string;
      try {
        requestedCanonical = await realpath(requestedAbsolute);
      } catch (error) {
        if (generatedFiles.has(requestedAbsolute)) {
          throw denied(requestedPath, "the recorded output is missing or cannot be resolved", error);
        }
        return undefined;
      }
      // Compare canonical paths before validating the file. This prevents a
      // recorded output that was replaced by a symlink to a different host
      // file from becoming a new host-read grant.
      if (!generatedFiles.has(requestedCanonical)) return undefined;
      return canonicalRegularFile(requestedCanonical);
    },

    clear() {
      skills = [];
      generatedFiles.clear();
    },
  };
}
