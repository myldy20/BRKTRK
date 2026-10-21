const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const packageDomain = require("./engine-package-domain.js");
const registryDomain = require("./engine-registry-domain.js");

const sha = (value) => createHash("sha256").update(value).digest("hex");
const artifactSha = sha("x");
const artifacts = [{ path: "engine.bin", kind: "fixture", bytes: 1, sha256: artifactSha }];
const contentSha256 = sha(`engine.bin\0${1}\0${artifactSha}\n`);
const hostContract = { id: packageDomain.HOST_CONTRACT_ID, minVersion: 1, maxVersion: 1 };
const manifest = {
  schema: packageDomain.PACKAGE_FORMAT,
  moduleId: "design.myldy.g7-exact",
  engineId: "g7-exact",
  version: "1.0.0",
  hostContract,
  abiVersion: "0x00010000",
  stateSchemaVersion: 1,
  parameterSchemaVersion: 1,
  contentSha256,
  files: artifacts,
};

const entry = (packageSha256, suffix) => ({
  moduleId: manifest.moduleId,
  engineId: manifest.engineId,
  version: manifest.version,
  channel: "stable",
  hostContract,
  abiVersion: manifest.abiVersion,
  packageUrl: `./packages/g7-exact-${suffix}-${packageSha256}.tar.gz`,
  packageSha256,
  stateSchemaVersion: 1,
  parameterSchemaVersion: 1,
  status: "active",
});

const shaA = "a".repeat(64);
const shaB = "b".repeat(64);
const entryA = entry(shaA, "a");
const entryB = entry(shaB, "b");
const registry = registryDomain.createEngineRegistry({ abiVersions: ["0x00010000"] });
const factoryA = () => ({ destroy() {} });
const factoryB = () => ({ destroy() {} });

const recordA = registry.register({ entry: entryA, manifest }, factoryA);
const recordB = registry.register({ entry: entryB, manifest }, factoryB);
assert.notEqual(recordA.key, recordB.key, "same semver with different exact package SHA must have distinct runtime registry identities");

const exactRef = (packageSha256) => ({
  moduleId: manifest.moduleId,
  engineId: manifest.engineId,
  resolvedVersion: manifest.version,
  resolvedPackageSha256: packageSha256,
});
assert.equal(registry.resolve(exactRef(shaA)), recordA, "exact SHA A must resolve only runtime A");
assert.equal(registry.resolve(exactRef(shaB)), recordB, "exact SHA B must resolve only runtime B");
assert.equal(registry.resolve(exactRef("c".repeat(64))), null, "unknown exact SHA must fail closed instead of substituting another same-semver runtime");
assert.equal(registry.resolve({ moduleId: manifest.moduleId, engineId: manifest.engineId, resolvedVersion: manifest.version }), null, "legacy unpinned ref must fail closed while same-semver runtime identity is ambiguous");

assert.equal(registry.unregister(exactRef(shaA)), true, "exact unregister must retire only SHA A");
assert.equal(registry.resolve(exactRef(shaA)), null);
assert.equal(registry.resolve(exactRef(shaB)), recordB);
assert.equal(registry.resolve({ moduleId: manifest.moduleId, engineId: manifest.engineId, resolvedVersion: manifest.version }), recordB, "legacy unpinned ref may resolve only when one same-semver runtime remains");

console.log("A5 #349 exact package engine-registry identity regression passed");