const assert = require("node:assert/strict");
const packageDomain = require("./engine-package-domain.js");

assert.equal(packageDomain.normalizeAbiVersion(65536), "0x00010000");
assert.equal(packageDomain.normalizeAbiVersion("65536"), "0x00010000");
assert.equal(packageDomain.normalizeAbiVersion("0x00010000"), "0x00010000");
assert.equal(packageDomain.normalizeAbiVersion("0X00010000"), "0x00010000");
assert.throws(() => packageDomain.normalizeAbiVersion("v1"), /ABI version/);
assert.throws(() => packageDomain.normalizeAbiVersion(-1), /unsigned 32-bit/);

const entry = packageDomain.normalizeCatalogEntry({
  moduleId: "design.myldy.abi-fixture",
  engineId: "abi-fixture",
  version: "1.0.0",
  channel: "stable",
  hostContract: { id: packageDomain.HOST_CONTRACT_ID, minVersion: 1, maxVersion: 1 },
  abiVersion: "0x00010000",
  packageUrl: "fixture://abi",
  packageSha256: "a".repeat(64),
  stateSchemaVersion: 65536,
  parameterSchemaVersion: 1,
  status: "active",
});
assert.equal(entry.abiVersion, "0x00010000");
assert.equal(packageDomain.entryCompatible(entry, { abiVersions: [65536] }), true, "numeric BRKSNTH ABI and canonical host hex ABI must be equivalent");
assert.equal(packageDomain.entryCompatible(entry, { abiVersions: ["65536"] }), true, "decimal-string ABI and canonical host hex ABI must be equivalent");
assert.equal(packageDomain.entryCompatible(entry, { abiVersions: ["0x00010001"] }), false);

const manifest = {
  schema: packageDomain.PACKAGE_FORMAT,
  moduleId: entry.moduleId,
  engineId: entry.engineId,
  version: entry.version,
  hostContract: entry.hostContract,
  abiVersion: 65536,
  stateSchemaVersion: 65536,
  parameterSchemaVersion: 1,
  contentSha256: "b".repeat(64),
  files: [{ path: "runtime.bin", bytes: 1, sha256: "c".repeat(64) }],
};
assert.equal(packageDomain.verifyManifestAgainstEntry(manifest, entry, { abiVersions: ["0x00010000"] }).abiVersion, "0x00010000", "manifest numeric ABI and catalog canonical ABI must compare equal");

console.log("M5A A2 ABI normalization tests passed");
