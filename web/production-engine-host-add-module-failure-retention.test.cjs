const assert = require("node:assert/strict");
const packageDomain = require("./engine-package-domain.js");

const hostContract = { id: packageDomain.HOST_CONTRACT_ID, minVersion: 1, maxVersion: 1 };
const entry = Object.freeze({
  moduleId: "design.myldy.add-module-failure",
  engineId: "add-module-failure",
  version: "1.0.0",
  channel: "stable",
  hostContract,
  abiVersion: 65536,
  packageUrl: "https://example.test/engines/packages/add-module-failure.brkengine",
  packageSha256: "a".repeat(64),
  stateSchemaVersion: 1,
  parameterSchemaVersion: 1,
  status: "active",
});
const catalog = packageDomain.normalizeCatalog({ format: packageDomain.CATALOG_FORMAT, entries: [entry] });
const bytes = (value) => new TextEncoder().encode(value);
const loaded = Object.freeze({
  entry,
  manifest: Object.freeze({
    moduleId: entry.moduleId,
    engineId: entry.engineId,
    version: entry.version,
    abiVersion: entry.abiVersion,
    stateSchemaVersion: entry.stateSchemaVersion,
    parameterSchemaVersion: entry.parameterSchemaVersion,
    contentSha256: "b".repeat(64),
    descriptors: Object.freeze({}),
    parameters: Object.freeze([]),
    runtime: Object.freeze({ directJs: "runtime/module.js", directWasm: "runtime/module.wasm" }),
  }),
  packageBytes: new Uint8Array(1024 * 64),
  files: Object.freeze({
    "runtime/module.js": bytes("globalThis.__ADD_MODULE_FAILURE_FIXTURE = true;"),
    "runtime/module.wasm": new Uint8Array(1024 * 32),
  }),
});

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
  loadVerifiedEntry: async () => Object.freeze({ loaded, source: "fixture" }),
});
globalThis.location = { href: "https://example.test/index.html" };
require("./production-engine-host.js");
const host = globalThis.BRKTRKProductionEngineHost;

const engineRef = Object.freeze({
  moduleId: entry.moduleId,
  engineId: entry.engineId,
  resolvedVersion: entry.version,
  resolvedPackageSha256: entry.packageSha256,
});

async function main() {
  let addAttempts = 0;
  const context = Object.freeze({
    audioWorklet: Object.freeze({
      async addModule() {
        addAttempts += 1;
        throw Object.assign(new Error("fixture addModule failure"), { code: "fixture-add-module-failed" });
      },
    }),
  });
  const project = Object.freeze({ instrumentPool: Object.freeze({ 0: Object.freeze({ id: 0, engineRef }) }) });

  const failed = await host.prepareContext(context, project);
  assert.equal(addAttempts, 1, "fixture must reach the real Worklet module installation boundary");
  assert.equal(failed.packages.some((status) => status.state === "package-failed" && status.packageSha256 === entry.packageSha256), true,
    "failed Worklet registration must remain visible as package-failed");
  assert.equal(failed.loaded.length, 0, "failed Worklet registration must not claim a loaded runtime");
  assert.equal(failed.retention.residentPackageBytes, 0,
    "verified archive/WASM bytes must be compacted even when audioWorklet.addModule fails");
  assert.equal(failed.verified.length, 1,
    "lightweight verified metadata may remain bounded for diagnostics/retry after addModule failure");

  await host.prepareContext(context, project);
  assert.equal(addAttempts, 2,
    "retry after addModule failure must reverify/reconstruct heavy runtime bytes rather than reusing a resident failed payload");
  assert.equal(host.snapshot().retention.residentPackageBytes, 0);

  console.log("A5 #349 failed Worklet install main-thread retention regression passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
