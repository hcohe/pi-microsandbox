#!/usr/bin/env node

import { lstatSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const imageRoot = fileURLToPath(new URL("../default-image/", import.meta.url));
const variantsPath = fileURLToPath(new URL("../default-image/variants.json", import.meta.url));
const namePattern = /^[a-z][a-z0-9-]{0,47}$/;
const tagPattern = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const versionSource = "(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)";
const tagAlphabet = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-"];

function fail(message) {
  throw new Error(message);
}

function splitTemplate(template) {
  const marker = "{version}";
  const index = template.indexOf(marker);
  return [template.slice(0, index), template.slice(index + marker.length)];
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function templateRegex(template) {
  const [prefix, suffix] = splitTemplate(template);
  return new RegExp(`^${escapeRegex(prefix)}${versionSource}${escapeRegex(suffix)}$`);
}

// Build a small NFA for prefix + X.Y.Z + suffix. Intersecting two such NFAs
// proves their tag namespaces are disjoint for every valid stable version,
// rather than checking one representative version.
function templateNfa(template) {
  const [prefix, suffix] = splitTemplate(template);
  const transitions = [];
  const epsilon = [];
  const state = () => {
    transitions.push(new Map());
    epsilon.push([]);
    return transitions.length - 1;
  };
  const edge = (from, char, to) => {
    const destinations = transitions[from].get(char) ?? [];
    destinations.push(to);
    transitions[from].set(char, destinations);
  };
  const exact = (start, text) => {
    let current = start;
    for (const char of text) {
      const next = state();
      edge(current, char, next);
      current = next;
    }
    return current;
  };
  const component = (start) => {
    const nonzero = state();
    const done = state();
    edge(start, "0", done);
    for (const digit of "123456789") edge(start, digit, nonzero);
    for (const digit of "0123456789") edge(nonzero, digit, nonzero);
    epsilon[nonzero].push(done);
    return done;
  };

  const start = state();
  let current = exact(start, prefix);
  for (let index = 0; index < 3; index++) {
    current = component(current);
    if (index < 2) current = exact(current, ".");
  }
  current = exact(current, suffix);
  return { start, accept: current, transitions, epsilon };
}

function closure(nfa, input) {
  const result = new Set(input);
  const pending = [...result];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const next of nfa.epsilon[current]) {
      if (!result.has(next)) {
        result.add(next);
        pending.push(next);
      }
    }
  }
  return result;
}

function advance(nfa, states, char) {
  const next = new Set();
  for (const current of states) {
    for (const destination of nfa.transitions[current].get(char) ?? []) next.add(destination);
  }
  return closure(nfa, next);
}

function intersectingTag(firstTemplate, secondTemplate) {
  const first = templateNfa(firstTemplate);
  const second = templateNfa(secondTemplate);
  const initialFirst = closure(first, [first.start]);
  const initialSecond = closure(second, [second.start]);
  const key = (left, right) => `${[...left].sort((a, b) => a - b)}|${[...right].sort((a, b) => a - b)}`;
  const queue = [{ left: initialFirst, right: initialSecond, text: "" }];
  const shortest = new Map([[key(initialFirst, initialSecond), 0]]);

  while (queue.length > 0) {
    const item = queue.shift();
    if (item.left.has(first.accept) && item.right.has(second.accept)) return item.text;
    if (item.text.length === 128) continue;
    for (const char of tagAlphabet) {
      const left = advance(first, item.left, char);
      if (left.size === 0) continue;
      const right = advance(second, item.right, char);
      if (right.size === 0) continue;
      const text = item.text + char;
      const stateKey = key(left, right);
      if ((shortest.get(stateKey) ?? Infinity) <= text.length) continue;
      shortest.set(stateKey, text.length);
      queue.push({ left, right, text });
    }
  }
  return undefined;
}

function validateGlobalTags(variants) {
  const concreteLatest = new Map();
  for (const variant of variants) {
    const tag = variant.tags.latest;
    if (concreteLatest.has(tag)) fail(`Duplicate latest tag: ${tag}`);
    concreteLatest.set(tag, variant.name);
  }

  for (const [latest, latestVariant] of concreteLatest) {
    for (const releaseVariant of variants) {
      if (templateRegex(releaseVariant.tags.release).test(latest)) {
        fail(`Latest tag ${latest} for ${latestVariant} collides with release tags for ${releaseVariant.name}`);
      }
    }
  }

  for (let left = 0; left < variants.length; left++) {
    for (let right = left + 1; right < variants.length; right++) {
      const collision = intersectingTag(variants[left].tags.release, variants[right].tags.release);
      if (collision !== undefined) {
        fail(`Release tag templates for ${variants[left].name} and ${variants[right].name} collide at ${collision}`);
      }
    }
  }
}

function loadVariants() {
  const document = JSON.parse(readFileSync(variantsPath, "utf8"));
  if (document.schemaVersion !== 1 || !Array.isArray(document.variants) || document.variants.length === 0) {
    fail("variants.json must contain a non-empty schemaVersion 1 variants array");
  }

  const names = new Set();
  for (const variant of document.variants) {
    if (!variant || typeof variant !== "object" || !namePattern.test(variant.name ?? "")) {
      fail(`Invalid variant name: ${variant?.name ?? "<missing>"}`);
    }
    if (variant.name === "dispatch") fail("Reserved variant name: dispatch");
    if (names.has(variant.name)) fail(`Duplicate variant name: ${variant.name}`);
    names.add(variant.name);
    if (typeof variant.description !== "string" || variant.description.trim().length === 0) {
      fail(`Missing description for variant ${variant.name}`);
    }

    if (!Array.isArray(variant.toolchains) || variant.toolchains.some((item) => !namePattern.test(item))) {
      fail(`Invalid toolchains for variant ${variant.name}`);
    }
    for (const toolchain of variant.toolchains) {
      if (["base", "default", "dispatch"].includes(toolchain)) {
        fail(`Reserved toolchain name: ${toolchain}`);
      }
    }
    if (new Set(variant.toolchains).size !== variant.toolchains.length) {
      fail(`Duplicate toolchain for variant ${variant.name}`);
    }

    const latest = variant.tags?.latest;
    const release = variant.tags?.release;
    if (!tagPattern.test(latest ?? "") || latest.includes("{version}")) {
      fail(`Invalid latest tag for variant ${variant.name}`);
    }
    if (typeof release !== "string" || (release.match(/\{version\}/g) ?? []).length !== 1) {
      fail(`Release tag for variant ${variant.name} must contain {version} exactly once`);
    }
    if (!tagPattern.test(release.replace("{version}", "1.2.3"))) {
      fail(`Invalid release tag for variant ${variant.name}`);
    }
  }

  if (!names.has("base")) fail("variants.json must define the base variant");
  if (!names.has("default")) fail("variants.json must define the default variant");
  for (const variant of document.variants) {
    if (variant.name === "base" && variant.toolchains.length !== 0) {
      fail("The base variant cannot include toolchains");
    }
    if (variant.name !== "base" && variant.toolchains.length === 0) {
      fail(`Variant ${variant.name} must include at least one toolchain`);
    }
    for (const toolchain of variant.toolchains) {
      if (!names.has(toolchain)) fail(`Toolchain ${toolchain} must have a matching variant`);
      for (const kind of ["install", "verify"]) {
        const path = `${imageRoot}${kind}/${toolchain}.sh`;
        let stat;
        try { stat = lstatSync(path); } catch { fail(`Missing ${kind} script for toolchain ${toolchain}`); }
        if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) {
          fail(`${kind}/${toolchain}.sh must be an executable regular file`);
        }
      }
    }
  }
  validateGlobalTags(document.variants);
  return document.variants;
}

function releaseTag(template, version) {
  if (!versionPattern.test(version ?? "")) fail(`Invalid release version: ${version ?? "<missing>"}`);
  return template.replace("{version}", version);
}

function concreteTags(variants, channel, version) {
  const tags = variants.map((variant) => ({
    variant: variant.name,
    tag: channel === "latest" ? variant.tags.latest : releaseTag(variant.tags.release, version),
  }));
  const owners = new Map();
  for (const item of tags) {
    if (!tagPattern.test(item.tag)) fail(`Invalid concrete ${channel} tag: ${item.tag}`);
    if (owners.has(item.tag)) fail(`Concrete ${channel} tag ${item.tag} is shared by ${owners.get(item.tag)} and ${item.variant}`);
    owners.set(item.tag, item.variant);
  }
  if (channel === "release") {
    for (const item of tags) {
      const latestOwner = variants.find((variant) => variant.tags.latest === item.tag)?.name;
      if (latestOwner) fail(`Release tag ${item.tag} for ${item.variant} collides with latest tag for ${latestOwner}`);
    }
  }
  return tags;
}

function verifyManifest(path, reference) {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  const platforms = new Set(
    (manifest.manifests ?? []).map((item) =>
      `${item.platform?.os ?? ""}/${item.platform?.architecture ?? ""}`,
    ),
  );
  for (const required of ["linux/amd64", "linux/arm64"]) {
    if (!platforms.has(required)) fail(`${reference} is missing ${required}`);
  }
}

function verifyConfig(path, variant, version, revision, platform) {
  const image = JSON.parse(readFileSync(path, "utf8"));
  const labels = image.config?.Labels ?? image.Config?.Labels ?? {};
  const expected = {
    "org.opencontainers.image.variant": variant,
    "org.opencontainers.image.version": version,
    "org.opencontainers.image.revision": revision,
  };
  for (const [name, value] of Object.entries(expected)) {
    if (labels[name] !== value) {
      fail(`${platform} ${name} label ${labels[name] ?? "<missing>"} does not match ${value}`);
    }
  }
}

function selfTest() {
  const expect = (condition, message) => { if (!condition) fail(`Self-test failed: ${message}`); };
  const expectThrows = (callback, pattern, message) => {
    try {
      callback();
    } catch (error) {
      expect(pattern.test(error.message), message);
      return;
    }
    fail(`Self-test failed: ${message}`);
  };
  expect(templateRegex("base-{version}").test("base-12.0.34"), "release template match");
  expect(!templateRegex("base-{version}").test("base-01.0.0"), "leading-zero rejection");
  expect(intersectingTag("{version}-9.8.7", "9.8.7-{version}") === "9.8.7-9.8.7", "non-probe template collision");
  expect(intersectingTag("node-{version}", "python-{version}") === undefined, "disjoint templates");
  expectThrows(
    () => validateGlobalTags([
      { name: "moving", tags: { latest: "node-42.0.1", release: "moving-{version}" } },
      { name: "node", tags: { latest: "node-latest", release: "node-{version}" } },
    ]),
    /Latest tag .* collides with release tags/,
    "latest/release namespace collision",
  );
  expectThrows(
    () => validateGlobalTags([
      { name: "left", tags: { latest: "left-latest", release: "{version}-9.8.7" } },
      { name: "right", tags: { latest: "right-latest", release: "9.8.7-{version}" } },
    ]),
    /Release tag templates .* collide at 9\.8\.7-9\.8\.7/,
    "release namespace collision beyond the old probe",
  );
  expectThrows(
    () => concreteTags([
      { name: "left", tags: { latest: "left-latest", release: "same-{version}" } },
      { name: "right", tags: { latest: "right-latest", release: "same-{version}" } },
    ], "release", "2.3.4"),
    /Concrete release tag .* is shared/,
    "concrete release collision",
  );
  expect(!versionPattern.test("1.2.3-beta.1"), "prerelease rejection");
  process.stdout.write("image-variants self-test: PASS\n");
}

const [command, ...args] = process.argv.slice(2);
const variants = loadVariants();

switch (command) {
  case "matrix":
    process.stdout.write(JSON.stringify({
      include: variants.map((variant) => ({
        variant: variant.name,
        toolchains: variant.toolchains.join(" "),
        latestTag: variant.tags.latest,
        releaseTemplate: variant.tags.release,
        shaPrefix: variant.name === "default" ? "sha-" : `${variant.name}-sha-`,
      })),
    }));
    break;
  case "refs": {
    const [channel, image, version] = args;
    if (channel !== "latest" && channel !== "release") fail(`Invalid tag channel: ${channel ?? "<missing>"}`);
    if (typeof image !== "string" || image.length === 0 || /[\s\t\r\n]/.test(image)) fail("Invalid image name");
    for (const item of concreteTags(variants, channel, version)) {
      process.stdout.write(`${item.variant}\t${image}:${item.tag}\n`);
    }
    break;
  }
  case "verify-manifest":
    verifyManifest(args[0], args[1] ?? "image");
    break;
  case "verify-config":
    verifyConfig(...args);
    break;
  case "self-test":
    selfTest();
    break;
  default:
    fail("Usage: image-variants.mjs matrix | refs <latest|release> <image> [version] | verify-manifest <path> <reference> | verify-config <path> <variant> <version> <revision> <platform> | self-test");
}
