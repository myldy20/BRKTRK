const assert = require("node:assert/strict");
const packageDomain = require("./engine-package-domain.js");

const entry = Object.freeze({
  moduleId: "design.myldy.retire-reload",
  engineId: "retire-reload",
  version: "1.0.0",
  channel: "stable",
  hostContract: Object.freeze({ id: packageDomain.HOST_CONTRACT_ID, minVersion: 1, maxVersion: 1 }),
  abiVersion: 65536,
  packageUrl: "https://example.test/engines/packages/retire-reload.brkengine",
  packageSha256: "a".repeat(64),
  stateSchemaVersion: 1,
  parameterSchemaVersion: 1,
  status: "active",
});
const catalog = packageDomain.normalizeCatalog({ format: packageDomain.CATALOG_FORMAT, entries: [entry] });
let verifiedLoads = 0;
let addModuleCalls = 0;

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
  loadVerifiedEntry: async () => {
    verifiedLoads += 1;
    return Object.freeze({
      source: verifiedLoads === 1 ? "network" : "verified-cache",
      loaded: Object.freeze({
        entry,
        manifest: Object.freeze({
          moduleId: entry.moduleId,
          engineId: entry.engineId,
          version: entry.version,
          abiVersion: entry.abiVersion,
          stateSchemaVersion: 1,
          parameterSchemaVersion: 1,
          contentSha256: "b".repeat(64),
          descriptors: Object.freeze({}),
          parameters: Object.freeze([]),
          runtime: Object.freeze({ directJs: "runtime/module.js", directWasm: "runtime/module.wasm" }),
        }),
        packageBytes: new Uint8Array([1, 2, 3]),
        files: Object.freeze({
          "runtime/module.js": new TextEncoder().encode("function Module(){ return Promise.resolve({}); }"),
          "runtime/module.wasm": new Uint8Array([0, 97, 115, 109]),
        }),
      }),
    });
  },
});
globalThis.location = { href: "https://example.test/index.html" };
require("./production-engine-host.js");
const host = globalThis.BRKTRKProductionEngineHost;

const project = Object.freeze({ instrumentPool: Object.freeze({ 1: Object.freeze({ engineRef: Object.freeze({
  moduleId: entry.moduleId,
  engineId: entry.engineId,
  resolvedVersion: entry.version,
  resolvedPackageSha256: entry.packageSha256,
}) }) }) });
const context = Object.freeze({
  sampleRate: 48000,
  audioWorklet: Object.freeze({ async addModule() { addModuleCalls += 1; } }),
});
let onWorkletMessage = null;
const node = Object.freeze({
  port: Object.freeze({
    addEventListener(type, listener) { if (type === "message") onWorkletMessage = listener; },
    start() {},
    postMessage() {},
  }),
});

async function main() {
  await host.prepareContext(context, project);
  assert.equal(addModuleCalls, 1);
  assert.equal(verifiedLoads, 1);
  assert.equal(host.snapshot().retention.residentPackageBytes, 0,
    "package bytes must be released after the runtime has been installed into the Worklet");

  // Runtime retirement can only originate from the attached Worklet. Model the
  // real bootstrap order (prepareContext -> attachNode -> Worklet messages) so
  // the Host can clear the owning AudioContext package set.
  host.attachNode(node, context, project);
  assert.equal(typeof onWorkletMessage, "function");
  onWorkletMessage({ data: {
    type: "production-runtime-retired",
    packages: [{ moduleId: entry.moduleId, engineId: entry.engineId, version: entry.version, packageSha256: entry.packageSha256 }],
  } });
  assert.equal(host.snapshot().loaded.length, 0, "retired Worklet runtime must be removed from the main-thread active-context registry");

  await host.prepareContext(context, project);
  assert.equal(addModuleCalls, 2,
    "returning to an exact package after Worklet retirement must install it again instead of trusting stale context ownership");
  assert.equal(verifiedLoads, 2,
    "re-registration must reverify/reload exact package bytes after the heavy in-memory archive was released");
  assert.equal(host.snapshot().packages.some((status) => status.state === "ready"), true);
  assert.equal(host.snapshot().retention.residentPackageBytes, 0);

  console.log("A5 #349 host/Worklet runtime retirement reactivation regression passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
