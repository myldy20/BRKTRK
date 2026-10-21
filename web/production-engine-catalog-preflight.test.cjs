const assert = require("node:assert/strict");
const packageDomain = require("./engine-package-domain.js");

const hostContract = { id: packageDomain.HOST_CONTRACT_ID, minVersion: 1, maxVersion: 1 };
const baseEntry = {
  moduleId: "design.myldy.catalog-preflight",
  engineId: "catalog-preflight",
  channel: "stable",
  hostContract,
  packageUrl: "https://example.test/engines/packages/catalog-preflight.brkengine",
  stateSchemaVersion: 1,
  parameterSchemaVersion: 1,
  status: "active",
};
const compatibleEntry = {
  ...baseEntry,
  version: "1.0.0",
  abiVersion: 65536,
  packageSha256: "a".repeat(64),
};
const incompatibleEntry = {
  ...baseEntry,
  version: "2.0.0",
  abiVersion: 131072,
  packageSha256: "d".repeat(64),
  packageUrl: "https://example.test/engines/packages/catalog-preflight-incompatible.brkengine",
};
const catalog = packageDomain.normalizeCatalog({
  format: packageDomain.CATALOG_FORMAT,
  entries: [compatibleEntry, incompatibleEntry],
});

class FixtureTransportError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

let verificationCalls = 0;
globalThis.BRKTRKEnginePackageBrowser = Object.freeze({
  EnginePackageTransportError: FixtureTransportError,
  fetchCatalog: async () => ({
    root: { origin: "https://example.test", pathPrefix: "/engines/" },
    url: "https://example.test/engines/catalog-v1.json",
    raw: { trust: { mode: "fixture" } },
    catalog,
  }),
  loadVerifiedEntry: async () => {
    verificationCalls += 1;
    throw new Error("catalog compatibility preflight must not verify or download package bytes");
  },
});

globalThis.location = { href: "https://example.test/index.html" };
require("./production-engine-host.js");
const host = globalThis.BRKTRKProductionEngineHost;

async function main() {
  const compatibleEntries = await host.refreshCatalog();
  assert.equal(verificationCalls, 0, "refreshCatalog compatibility preflight must remain metadata-only");
  assert.equal(compatibleEntries.length, 1, "refreshCatalog must preserve its compatible-only return contract");
  assert.equal(compatibleEntries[0].packageSha256, compatibleEntry.packageSha256);

  const entries = host.catalogEntries();
  assert.equal(entries.length, 1, "catalogEntries must remain compatible-only for existing callers");
  assert.equal(entries[0].packageSha256, compatibleEntry.packageSha256);

  const candidates = host.catalogCandidates();
  assert.equal(candidates.length, 2, "catalogCandidates must expose every trusted catalog row");
  const incompatible = candidates.find((candidate) => candidate.entry.packageSha256 === incompatibleEntry.packageSha256);
  assert.ok(incompatible, "incompatible trusted row must remain visible before Create");
  assert.equal(incompatible.compatibility.compatible, false);
  assert.equal(incompatible.compatibility.code, "abi-version");
  assert.equal(incompatible.compatibility.reason, "ABI 0x00020000 is not supported by this Host");
  assert.equal(entries.some((entry) => entry.packageSha256 === incompatibleEntry.packageSha256), false,
    "incompatible trusted row must remain outside compatible-only catalogEntries");
  assert.equal(verificationCalls, 0, "reading compatibility candidates must not cross the package verification boundary");

  const snapshot = host.snapshot();
  assert.equal(snapshot.catalog?.entryCount, 2, "Host snapshot must record the loaded trusted catalog even when it contains incompatible rows");
  assert.equal(snapshot.packages.length, 0, "metadata-only preflight must not create package runtime status records");

  console.log("A5 catalog compatibility preflight metadata-only regression passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
