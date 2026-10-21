const assert = require("node:assert/strict");
const packageDomain = require("./engine-package-domain.js");

const RETAINED_LIMIT = 4;
const hostContract = { id: packageDomain.HOST_CONTRACT_ID, minVersion: 1, maxVersion: 1 };
const entries = Array.from({ length: RETAINED_LIMIT + 4 }, (_, index) => Object.freeze({
  moduleId: `design.myldy.retention-${index}`,
  engineId: `retention-${index}`,
  version: "1.0.0",
  channel: "stable",
  hostContract,
  abiVersion: 65536,
  packageUrl: `https://example.test/engines/packages/retention-${index}.brkengine`,
  packageSha256: index.toString(16).padStart(64, "0"),
  stateSchemaVersion: 1,
  parameterSchemaVersion: 1,
  status: "active",
}));
const catalog = packageDomain.normalizeCatalog({ format: packageDomain.CATALOG_FORMAT, entries });
const bytes = (value) => new TextEncoder().encode(value);
const loads = new Map();

function loadedFor(entry) {
  return Object.freeze({
    entry,
    manifest: Object.freeze({
      moduleId: entry.moduleId,
      engineId: entry.engineId,
      version: entry.version,
      abiVersion: entry.abiVersion,
      stateSchemaVersion: entry.stateSchemaVersion,
      parameterSchemaVersion: entry.parameterSchemaVersion,
      contentSha256: "f".repeat(64),
      descriptors: Object.freeze({}),
      parameters: Object.freeze([]),
      runtime: Object.freeze({ directJs: "runtime/module.js", directWasm: "runtime/module.wasm" }),
    }),
    packageBytes: new Uint8Array(1024 * 64),
    files: Object.freeze({
      "runtime/module.js": bytes("globalThis.__RETENTION_FIXTURE = true;"),
      "runtime/module.wasm": new Uint8Array(1024 * 32),
    }),
  });
}

class FixtureTransportError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

globalThis.BRKTRKEnginePackageBrowser = Object.freeze({
  EnginePackageTransportError: FixtureTransportError,
  fetchCatalog: async () => Object.freeze({
    root: Object.freeze({ origin: "https://example.test", pathPrefix: "/engines/" }),
    url: "https://example.test/engines/catalog-v1.json",
    raw: Object.freeze({ trust: Object.freeze({ mode: "fixture" }) }),
    catalog,
  }),
  loadVerifiedEntry: async (entry) => {
    loads.set(entry.packageSha256, (loads.get(entry.packageSha256) ?? 0) + 1);
    return Object.freeze({ loaded: loadedFor(entry), source: "fixture" });
  },
});

globalThis.location = { href: "https://example.test/index.html" };
require("./production-engine-host.js");
const host = globalThis.BRKTRKProductionEngineHost;

const refFor = (entry) => Object.freeze({
  moduleId: entry.moduleId,
  engineId: entry.engineId,
  resolvedVersion: entry.version,
  resolvedPackageSha256: entry.packageSha256,
});

async function main() {
  for (const entry of entries) await host.ensurePackageView(refFor(entry));

  const firstSnapshot = host.snapshot();
  assert.ok(firstSnapshot.retention, "production engine diagnostics must expose bounded retention state");
  assert.equal(firstSnapshot.retention.verifiedViewLimit, RETAINED_LIMIT);
  assert.equal(firstSnapshot.verified.length, RETAINED_LIMIT,
    "browsing more exact packages than the retention budget must not retain every verified package view indefinitely");
  assert.equal(firstSnapshot.retention.residentPackageBytes, 0,
    "verified archive/WASM bytes must not remain resident merely because lightweight package metadata is retained");

  const newest = entries.at(-1);
  const oldest = entries[0];
  const loadsBeforeNewestReuse = loads.get(newest.packageSha256);
  await host.ensurePackageView(refFor(newest));
  assert.equal(loads.get(newest.packageSha256), loadsBeforeNewestReuse,
    "most-recently retained exact package view should be reused without another verification");

  const loadsBeforeOldestReuse = loads.get(oldest.packageSha256);
  await host.ensurePackageView(refFor(oldest));
  assert.equal(loads.get(oldest.packageSha256), loadsBeforeOldestReuse + 1,
    "an evicted inactive package may be reverified on demand instead of remaining resident forever");
  assert.equal(host.snapshot().verified.length, RETAINED_LIMIT,
    "reloading an evicted package must stay inside the same retention bound");
  assert.equal(host.snapshot().retention.residentPackageBytes, 0);

  console.log("A5 #349 main-thread verified package retention regression passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
