import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { DEFAULT_CONFIG } from "../extensions/pi-msb/config.ts";
import { createMsbIntegration } from "../extensions/pi-msb/control.ts";
import { sandboxNameFor } from "../extensions/pi-msb/types.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_RUNS = 3;
const DEFAULT_WARMUPS = 1;
const DEFAULT_MAX_MS = 2_000;

function usage() {
  return `Usage: node --experimental-strip-types scripts/test-boot-speed.mjs [options]

Measure the real pi-microsandbox session boot path with a prepared image.
One warm-up is excluded by default so an initial image pull does not affect
repeat-boot measurements.

Options:
  --image IMAGE       OCI image to boot (default: ${DEFAULT_CONFIG.image})
  --runs COUNT        Number of measured boots (default: ${DEFAULT_RUNS})
  --warmups COUNT     Number of unmeasured warm-up boots (default: ${DEFAULT_WARMUPS})
  --max-ms MS         Maximum allowed p95 boot time (default: ${DEFAULT_MAX_MS})
  --json              Print one JSON result instead of the human report
  -h, --help          Show this help
`;
}

function valueAfter(args, index, option) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function positiveInteger(value, option, allowZero = false) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new Error(`${option} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  }
  return parsed;
}

function positiveNumber(value, option) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive number`);
  }
  return parsed;
}

function parseArgs(args) {
  const options = {
    image: DEFAULT_CONFIG.image,
    runs: DEFAULT_RUNS,
    warmups: DEFAULT_WARMUPS,
    maxMs: DEFAULT_MAX_MS,
    json: false,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--image":
        options.image = valueAfter(args, index, arg);
        index += 1;
        break;
      case "--runs":
        options.runs = positiveInteger(valueAfter(args, index, arg), arg);
        index += 1;
        break;
      case "--warmups":
        options.warmups = positiveInteger(valueAfter(args, index, arg), arg, true);
        index += 1;
        break;
      case "--max-ms":
        options.maxMs = positiveNumber(valueAfter(args, index, arg), arg);
        index += 1;
        break;
      case "--json":
        options.json = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }

  if (!options.image.trim()) throw new Error("--image must not be empty");
  return options;
}

function percentile(sorted, fraction) {
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index];
}

function statistics(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
  return {
    minMs: sorted[0],
    medianMs: median,
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted.at(-1),
  };
}

function rounded(value) {
  return Math.round(value * 10) / 10;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const tempParent = join(ROOT, ".tmp");
  await mkdir(tempParent, { recursive: true });
  const testRoot = await mkdtemp(join(tempParent, "boot-speed-"));
  const cleanups = new Set();
  let signalExitCode = null;

  const cleanupAll = async () => {
    const results = await Promise.allSettled([...cleanups].map((cleanup) => cleanup()));
    const failures = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) {
      const details = failures
        .map((error) => error instanceof Error ? error.message : String(error))
        .join("; ");
      throw new AggregateError(failures, `could not clean up every benchmark sandbox; ${details}; temporary state retained at ${testRoot}`);
    }
    await rm(testRoot, { recursive: true, force: true });
  };
  const requestShutdown = (signal, exitCode) => {
    if (signalExitCode !== null) return;
    signalExitCode = exitCode;
    process.stderr.write(`boot speed test interrupted by ${signal}; cleaning up\n`);
    void cleanupAll()
      .catch((error) => console.error(error instanceof Error ? error.message : String(error)))
      .finally(() => process.exit(exitCode));
  };
  process.once("SIGINT", () => requestShutdown("SIGINT", 130));
  process.once("SIGTERM", () => requestShutdown("SIGTERM", 143));

  let attemptNumber = 0;
  const bootOnce = async (kind, index) => {
    attemptNumber += 1;
    const cwd = join(testRoot, `${kind}-${index + 1}`);
    await mkdir(cwd, { recursive: true });
    const sessionId = `pi-msb-boot-speed-${process.pid}-${Date.now()}-${attemptNumber}`;
    const env = { ...process.env, PI_MSB_DISABLE: "" };
    const integration = createMsbIntegration({
      sessionId,
      cwd,
      configDirName: ".pi",
      env,
      entries: () => [],
    });
    let cleanupPromise;
    const cleanup = async () => {
      if (!cleanupPromise) {
        cleanupPromise = (async () => {
          await integration.manager.shutdown();
          const cleanupState = integration.manager.getState();
          if (cleanupState.status === "unavailable") {
            const sandboxName = sandboxNameFor(sessionId);
            throw new Error(`cleanup failed for sandbox ${sandboxName} (session ${sessionId}): ${cleanupState.reason ?? "unknown cleanup error"}`);
          }
        })();
      }
      await cleanupPromise;
    };
    cleanups.add(cleanup);

    const config = {
      ...DEFAULT_CONFIG,
      image: options.image,
      pullPolicy: "if-missing",
      mode: "direct",
      bootstrapTools: false,
      autoStart: true,
      pruneOnStart: false,
      idleTimeoutSec: 30,
      lockDir: join(testRoot, "locks"),
      network: {
        mode: "deny",
        allowHosts: [],
        allowDns: false,
        publishPorts: [],
      },
      secrets: [],
      mounts: [],
    };

    try {
      const startedAt = performance.now();
      const state = await integration.configureSession({
        sessionId,
        cwd,
        projectTrusted: true,
        config: { config, provenance: {}, warnings: [] },
      });
      const bootMs = performance.now() - startedAt;
      if (state.status !== "active") {
        throw new Error(`boot ${kind} ${index + 1} did not become active: ${state.reason ?? state.status}`);
      }
      return bootMs;
    } finally {
      await cleanup();
      cleanups.delete(cleanup);
    }
  };

  try {
    const warmupMs = [];
    for (let index = 0; index < options.warmups; index += 1) {
      warmupMs.push(await bootOnce("warmup", index));
    }

    const runMs = [];
    for (let index = 0; index < options.runs; index += 1) {
      runMs.push(await bootOnce("run", index));
    }

    const stats = statistics(runMs);
    const pass = stats.p95Ms <= options.maxMs;
    const result = {
      image: options.image,
      warmups: warmupMs.map(rounded),
      runs: runMs.map(rounded),
      stats: Object.fromEntries(Object.entries(stats).map(([key, value]) => [key, rounded(value)])),
      maxP95Ms: options.maxMs,
      pass,
    };

    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      console.log("pi-microsandbox boot speed");
      console.log(`  image: ${options.image}`);
      console.log(`  policy: prepared image, direct mount, network denied, pruning disabled`);
      for (const [index, value] of warmupMs.entries()) {
        console.log(`  warm-up ${index + 1}: ${value.toFixed(1)} ms (excluded)`);
      }
      for (const [index, value] of runMs.entries()) {
        console.log(`  run ${index + 1}: ${value.toFixed(1)} ms`);
      }
      console.log(`  min/median/p95/max: ${stats.minMs.toFixed(1)} / ${stats.medianMs.toFixed(1)} / ${stats.p95Ms.toFixed(1)} / ${stats.maxMs.toFixed(1)} ms`);
      console.log(`  ${pass ? "PASS" : "FAIL"}: p95 ${stats.p95Ms.toFixed(1)} ms ${pass ? "<=" : ">"} ${options.maxMs} ms`);
    }

    if (!pass) process.exitCode = 1;
  } finally {
    await cleanupAll();
  }
}

main().catch((error) => {
  console.error(`boot speed test failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
