import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Image, NetworkPolicy, Sandbox } from "microsandbox";
import { BUILD_VERSION } from "./image-source.ts";

// Real native configuration serialization only: never create/start a sandbox.
test("pinned microsandbox SDK retains cwd bind flags and fail-closed network builders", async () => {
  const policy = NetworkPolicy.builder().defaultDeny().defaultIngress("deny")
    .egress((rule) => rule.allow((destination) => destination.domain("api.example.com")))
    .egress((rule) => rule.allow((destination) => destination.ip("192.0.2.1")))
    .egress((rule) => rule.allow((destination) => destination.cidr("198.51.100.0/24")))
    .egress((rule) => rule.udp().tcp().port(53).allowHost());
  const config: any = await Sandbox.builder("pi-msb-sdk-contract").image("alpine")
    .workdir("/guest/project").cpus(2).memory(4096).rootDisk(8192)
    .maxDuration(1200).detached(false)
    .volume("/guest/project", (mount) => mount.bind("/tmp/pi-msb-sdk-project"))
    .volume("/guest/readonly", (mount) => mount.bind("/tmp/pi-msb-sdk-readonly").readonly().noexec().nosuid().nodev())
    .network((network) => network.policy(policy)).build();
  assert.equal(config.runtime.workdir, "/guest/project");
  assert.deepEqual(config.mounts.map((mount: { host: string; guest: string }) => [mount.host, mount.guest]), [
    ["/tmp/pi-msb-sdk-project", "/guest/project"], ["/tmp/pi-msb-sdk-readonly", "/guest/readonly"],
  ]);
  assert.equal(config.mounts[0].options.readonly, false);
  assert.deepEqual(config.mounts[1].options, { readonly: true, noexec: true, nosuid: true, nodev: true });
  assert.equal(config.network.policy.defaultEgress, "deny");
  assert.equal(config.network.policy.defaultIngress, "deny");
  assert.equal(config.network.policy.rules.length, 4);
  assert.equal(config.lifecycle.maxDurationSecs, 1200);
  assert.equal(config.lifecycle.idleTimeoutSecs, null);

  const denied: any = await Sandbox.builder("pi-msb-sdk-denied").image("alpine").disableNetwork().build();
  assert.equal(denied.network.enabled, false);
  const publicOnly = { ...NetworkPolicy.fromProfiles(["public"]), defaultIngress: "deny" as const };
  const builder: any = await Sandbox.builder("pi-msb-sdk-builder").image("alpine").network((network) => network.policy(publicOnly)).build();
  assert.equal(builder.network.policy.defaultIngress, "deny");
  assert.deepEqual(builder.network.policy.rules.map((rule: any) => [rule.action, rule.destination.group]), [["allow", "host"], ["allow", "public"]]);
  assert.equal(builder.network.policy.defaultEgress, "deny");
  for (const method of [Sandbox.get, Sandbox.prototype.execStreamWith, Sandbox.prototype.destroy, Image.get, Image.inspect, Image.load, Image.save]) {
    assert.equal(typeof method, "function");
  }
});

test("Dockerfile cache version follows the exact runtime SDK dependency", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.match(manifest.dependencies.microsandbox, /^\d+\.\d+\.\d+$/);
  assert.ok(BUILD_VERSION.includes(`sdk-${manifest.dependencies.microsandbox}-`));
});
