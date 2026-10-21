const assert = require("node:assert/strict");
const domain = require("./engine-package-domain.js");

const baseEntry = {
  moduleId: "design.myldy.semver-test",
  engineId: "semver-test",
  channel: "stable",
  hostContract: { id: domain.HOST_CONTRACT_ID, minVersion: 1, maxVersion: 1 },
  abiVersion: "0x00010000",
  stateSchemaVersion: 1,
  parameterSchemaVersion: 1,
  status: "active",
};

const entry = (version, suffix) => ({
  ...baseEntry,
  version,
  packageUrl: `fixture://semver-test-${suffix}`,
  packageSha256: suffix.repeat(64),
});

assert.ok(
  domain.compareVersions("1.0.0-A", "1.0.0-a") < 0,
  "SemVer alphanumeric prerelease identifiers must use ASCII/code-unit order, not locale collation",
);
assert.ok(
  domain.compareVersions("1.0.0-Z", "1.0.0-a") < 0,
  "uppercase prerelease identifiers must sort before lowercase identifiers by SemVer ASCII order",
);
assert.ok(
  domain.compareVersions("not-A", "not-a") < 0,
  "fallback ordering for non-SemVer catalog text must remain deterministic and locale-independent",
);

const catalog = {
  format: domain.CATALOG_FORMAT,
  entries: [
    entry("1.0.0-A", "a"),
    entry("1.0.0-a", "b"),
  ],
};

const resolved = domain.resolveCatalogEntry(
  catalog,
  { moduleId: baseEntry.moduleId, engineId: baseEntry.engineId },
  { abiVersions: ["0x00010000"] },
);

assert.equal(
  resolved?.version,
  "1.0.0-a",
  "compatible engine resolution must select the same highest SemVer prerelease on every host locale",
);

console.log("engine package SemVer code-unit ordering tests passed");
