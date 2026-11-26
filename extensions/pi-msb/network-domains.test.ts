import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import { validateConfig } from "./config.ts";
import { EXACT_DOMAIN_SCHEMA, SECRET_HOST_SCHEMA, isExactDomain, isSecretHost, networkDestinationKind } from "./network-domains.ts";

for (const host of ["github.com", "api.github.com", "REGISTRY.npmjs.org", "localhost", "xn--bcher-kva.example", "a", "a-b.example"]) {
  test(`shared domain format accepts exact ${host} without expanding or rewriting it`, () => {
    assert.equal(isExactDomain(host), true); assert.equal(networkDestinationKind(host), "domain");
    assert.equal(Check(EXACT_DOMAIN_SCHEMA, host), true);
    const config = validateConfig({ network: { allowHosts: [host] }, secrets: [{ env: "TOKEN", textValue: "private", allowHosts: [host] }] });
    assert.deepEqual(config.network.allowHosts, config.secrets[0]!.allowHosts);
    assert.equal(config.secrets[0]!.allowHosts[0], host);
  });
}
for (const host of ["api?.github.com", "api*.github.com", "*.*.github.com", "*.127.0.0.1", "*.", "*", ".github.com", "github.com.", "https://github.com", "github.com:443", "github.com/path", " github.com", "github.com ", "github.com\n", "github.com\r\n", "a..example", "-a.example", "a-.example", "a_b.example", "é.example", "a".repeat(64) + ".example", "a.".repeat(127) + "a"]) {
  test(`shared domain format rejects ambiguous ${host.slice(0, 70)}`, () => {
    assert.equal(isExactDomain(host), false); assert.equal(networkDestinationKind(host), null);
    for (const config of [{ network: { allowHosts: [host] } }, { secrets: [{ env: "TOKEN", textValue: "do-not-echo-credential", allowHosts: [host] }] }]) {
      assert.throws(() => validateConfig(config), (error: unknown) => {
        assert.match(String(error), /exact DNS names/); assert.doesNotMatch(String(error), /do-not-echo-credential/);
        return true;
      });
    }
  });
}
for (const host of ["*.googleapis.com", "*.example.com", "*.xn--bcher-kva.example", "*." + "a.".repeat(126) + "a"]) {
  test(`wildcard secret destination ${host} remains secret-only`, () => {
    assert.equal(isSecretHost(host), true);
    assert.equal(Check(SECRET_HOST_SCHEMA, host), true);
    assert.equal(networkDestinationKind(host), null);
    assert.deepEqual(validateConfig({ secrets: [{ env: "TOKEN", textValue: "private", allowHosts: [host] }] }).secrets[0]!.allowHosts, [host]);
    assert.throws(() => validateConfig({ network: { allowHosts: [host] } }), /exact DNS names/);
  });
}
for (const [host, kind] of [["127.0.0.1", "ip"], ["::1", "ip"], ["10.0.0.0/8", "cidr"], ["2001:db8::/32", "cidr"]] as const) {
  test(`IP/CIDR destination ${host} remains network-only`, () => {
    assert.equal(networkDestinationKind(host), kind); assert.equal(isExactDomain(host), false);
    assert.deepEqual(validateConfig({ network: { allowHosts: [host] } }).network.allowHosts, [host]);
    assert.throws(() => validateConfig({ secrets: [{ env: "TOKEN", textValue: "private", allowHosts: [host] }] }), /IP\/CIDR/);
  });
}
for (const host of ["10.0.0.0/33", "::1/129", "10.0.0.0/-1", "10.0.0.0/", "github.com/24", "10.0.0.0/8/extra", "10.0.0.0/8\n"]) {
  test(`invalid network CIDR ${host} fails closed`, () => {
    assert.equal(networkDestinationKind(host), null);
    assert.throws(() => validateConfig({ network: { allowHosts: [host] } }), /exact DNS names/);
  });
}
