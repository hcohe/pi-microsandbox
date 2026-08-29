import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { createHostReadAccess, resolveDiscoveredSkillRead } from "./skill-access.ts";
import type { DiscoveredSkillPath } from "./types.ts";

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "pi-msb-skill-access-"));
}

async function withTempDir(run: (root: string) => Promise<void>): Promise<void> {
  const root = await tempDir();
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("standalone discovered skills grant only their exact file", async () => {
  await withTempDir(async (root) => {
    const skill = path.join(root, "standalone.md");
    const sibling = path.join(root, "support.txt");
    await writeFile(skill, "standalone\n");
    await writeFile(sibling, "not granted\n");

    const discovered: DiscoveredSkillPath[] = [{ filePath: skill, baseDir: root }];
    const canonicalSkill = await realpath(skill);
    assert.equal(await resolveDiscoveredSkillRead(skill, root, discovered), canonicalSkill);
    assert.equal(await resolveDiscoveredSkillRead(sibling, root, discovered), undefined);
    assert.equal(await resolveDiscoveredSkillRead("missing.txt", root, discovered), undefined);
  });
});

test("an exact configured standalone symlink may resolve to its target", async () => {
  await withTempDir(async (root) => {
    const targetDir = path.join(root, "targets");
    await mkdir(targetDir);
    const target = path.join(targetDir, "skill.md");
    const configured = path.join(root, "skill.md");
    await writeFile(target, "through symlink\n");
    await symlink(target, configured);

    const discovered: DiscoveredSkillPath[] = [{ filePath: configured, baseDir: root }];
    const canonicalTarget = await realpath(target);
    assert.equal(await resolveDiscoveredSkillRead(configured, root, discovered), canonicalTarget);
    // The target is not itself the discovered standalone path.
    assert.equal(await resolveDiscoveredSkillRead(target, root, discovered), undefined);
  });
});

test("directory skills allow canonical regular supporting files", async () => {
  await withTempDir(async (root) => {
    const skillDir = path.join(root, "directory-skill");
    const nestedDir = path.join(skillDir, "docs");
    const skillFile = path.join(skillDir, "SKILL.md");
    const support = path.join(nestedDir, "guide.md");
    await mkdir(nestedDir, { recursive: true });
    await writeFile(skillFile, "instructions\n");
    await writeFile(support, "support\n");

    const discovered: DiscoveredSkillPath[] = [{ filePath: skillFile, baseDir: skillDir }];
    assert.equal(await resolveDiscoveredSkillRead(skillFile, root, discovered), await realpath(skillFile));
    assert.equal(await resolveDiscoveredSkillRead(support, root, discovered), await realpath(support));
    assert.equal(await resolveDiscoveredSkillRead(path.join(root, "other.md"), root, discovered), undefined);
  });
});

test("directory skill reads reject escaping symlinks and non-files", async () => {
  await withTempDir(async (root) => {
    const skillDir = path.join(root, "skill");
    const outside = path.join(root, "outside.txt");
    const escape = path.join(skillDir, "escape.txt");
    const directory = path.join(skillDir, "subdir");
    const skillFile = path.join(skillDir, "SKILL.md");
    await mkdir(directory, { recursive: true });
    await writeFile(skillFile, "instructions\n");
    await writeFile(outside, "outside\n");
    await symlink(outside, escape);

    const discovered: DiscoveredSkillPath[] = [{ filePath: skillFile, baseDir: skillDir }];
    await assert.rejects(
      resolveDiscoveredSkillRead(escape, root, discovered),
      /resolves outside the discovered skill directory/,
    );
    await assert.rejects(
      resolveDiscoveredSkillRead(directory, root, discovered),
      /not a regular file/,
    );
    await assert.rejects(
      resolveDiscoveredSkillRead(path.join(skillDir, "missing.txt"), root, discovered),
      /missing or cannot be resolved/,
    );
  });
});

test("generated output grants are exact, canonical, and replaceable", async () => {
  await withTempDir(async (root) => {
    const outputDir = path.join(root, "pi-output");
    const otherDir = path.join(root, "other");
    await mkdir(outputDir);
    await mkdir(otherDir);
    const output = path.join(outputDir, "full-output.txt");
    const alias = path.join(root, "output-alias.txt");
    const untracked = path.join(otherDir, "untracked.txt");
    await writeFile(output, "full output\n");
    await writeFile(untracked, "untracked\n");
    await symlink(output, alias);
    const canonicalOutput = await realpath(output);

    const access = createHostReadAccess();
    await access.allowGeneratedFile(output);
    assert.equal(await access.resolve(output, root), canonicalOutput);
    assert.equal(await access.resolve(alias, root), canonicalOutput);
    assert.equal(await access.resolve(untracked, root), undefined);

    await access.clear();
    assert.equal(await access.resolve(output, root), undefined);
  });
});

test("skill discovery is replaced and clear removes every grant", async () => {
  await withTempDir(async (root) => {
    const firstDir = path.join(root, "first");
    const secondDir = path.join(root, "second");
    await mkdir(firstDir);
    await mkdir(secondDir);
    const first = path.join(firstDir, "SKILL.md");
    const second = path.join(secondDir, "SKILL.md");
    await writeFile(first, "first\n");
    await writeFile(second, "second\n");

    const access = createHostReadAccess();
    access.updateSkills([{ filePath: first, baseDir: firstDir }]);
    assert.equal(await access.resolve(first, root), await realpath(first));
    access.updateSkills([{ filePath: second, baseDir: secondDir }]);
    assert.equal(await access.resolve(first, root), undefined);
    assert.equal(await access.resolve(second, root), await realpath(second));
    access.clear();
    assert.equal(await access.resolve(second, root), undefined);
  });
});

test("generated and skill grants reject directories", async () => {
  await withTempDir(async (root) => {
    const directory = path.join(root, "directory");
    await mkdir(directory);
    const access = createHostReadAccess();
    await assert.rejects(access.allowGeneratedFile(directory), /not a regular file/);
  });
});
