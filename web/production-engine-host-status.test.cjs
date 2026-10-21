const assert = require("node:assert/strict");
const packageDomain = require("./engine-package-domain.js");

const hostContract = { id: packageDomain.HOST_CONTRACT_ID, minVersion: 1, maxVersion: 1 };
const baseEntry = {
  moduleId: "design.myldy.status-fixture",
  engineId: "status-fixture",
  channel: "stable",
  hostContract,
  abiVersion: 65536,
  packageUrl: "https://example.test/engines/packages/status-fixture.brkengine",
  stateSchemaVersion: 1,
  parameterSchemaVersion: 1,
  status: "active",
};
const readyEntry = { ...baseEntry, version: "1.0.0", packageSha256: "a".repeat(64) };
const failedEntry = { ...baseEntry, version: "1.1.0", packageSha256: "b".repeat(64) };
const previewEntry = {
  ...baseEntry,
  engineId: "preview-fixture",
  channel: "preview",
  version: "0.1.0-alpha.1",
  packageSha256: "p".repeat(64).replaceAll("p", "c"),
};
const catalog = packageDomain.normalizeCatalog({
  format: packageDomain.CATALOG_FORMAT,
  entries: [readyEntry, failedEntry, previewEntry],
});

const bytes = (value) => new TextEncoder().encode(value);
const loadedFor = (entry) => ({
  entry,
  manifest: {
    moduleId: entry.moduleId,
    engineId: entry.engineId,
    version: entry.version,
    abiVersion: entry.abiVersion,
    stateSchemaVersion: entry.stateSchemaVersion,
    parameterSchemaVersion: entry.parameterSchemaVersion,
    contentSha256: "c".repeat(64),
    descriptors: {},
    parameters: [{ id: "cutoff", type: "float", min: 0, max: 1, default: 0.5 }],
    runtime: {
      directJs: "runtime/module.js",
      directWasm: "runtime/module.wasm",
      ...(entry.moduleId === previewEntry.moduleId
        && entry.engineId === previewEntry.engineId
        && entry.version === previewEntry.version
        ? { assetExtensionVersion: 65536, assetArenaBytes: 8 * 1024 * 1024, assetSlots: 1 }
        : {}),
    },
  },
  files: {
    "runtime/module.js": bytes("globalThis.__STATUS_FIXTURE = true;"),
    "runtime/module.wasm": Uint8Array.of(0),
  },
});

class FixtureTransportError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

let readyVerificationCalls = 0;
globalThis.BRKTRKEnginePackageBrowser = Object.freeze({
  EnginePackageTransportError: FixtureTransportError,
  fetchCatalog: async () => ({
    root: { origin: "https://example.test", pathPrefix: "/engines/" },
    url: "https://example.test/engines/catalog-v1.json",
    raw: { trust: { mode: "fixture" } },
    catalog,
  }),
  loadVerifiedEntry: async (entry) => {
    if (entry.version === failedEntry.version) {
      const error = new Error("fixture package failed verification");
      error.code = "fixture-verification-failed";
      throw error;
    }
    readyVerificationCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { loaded: loadedFor(entry), source: "fixture" };
  },
});

globalThis.location = { href: "https://example.test/index.html" };
require("./production-engine-host.js");
const host = globalThis.BRKTRKProductionEngineHost;

async function main() {
  const stableHref = "https://example.test/index.html";
  const previewRef = {
    moduleId: previewEntry.moduleId,
    engineId: previewEntry.engineId,
    resolvedVersion: previewEntry.version,
    resolvedPackageSha256: previewEntry.packageSha256,
    channel: "preview",
  };
  assert.deepEqual(host.catalogChannels(), ["stable"], "ordinary runtime must expose only stable engines");
  await assert.rejects(
    () => host.ensurePackageView(previewRef),
    (error) => error?.code === "engine-channel-unavailable",
    "a persisted preview Instrument must fail closed outside preview runtime",
  );
  globalThis.location.href = "https://example.test/index.html?preview=a5.5-c1";
  assert.deepEqual(host.catalogChannels(), ["stable", "preview"], "physical candidate must explicitly unlock preview engines");
  assert.deepEqual(
    host.catalogChannels("https://example.test/index.html?engineChannel=preview"),
    ["stable", "preview"],
    "explicit preview engine mode must unlock the same bounded channel set",
  );
  const previewView = await host.ensurePackageView(previewRef);
  assert.equal(previewView.entry.channel, "preview", "preview mode must resolve the exact preview catalog row");
  assert.deepEqual(previewView.manifest.runtime, {
    assetExtensionVersion: 65536,
    assetArenaBytes: 8 * 1024 * 1024,
    assetSlots: 1,
  }, "verified package view must expose bounded Asset Extension capability to the Sound surface");
  globalThis.location.href = stableHref;
  readyVerificationCalls = 0;

  const addModuleCalls = [];
  const context = {
    sampleRate: 48000,
    audioWorklet: {
      addModule: async (url) => {
        addModuleCalls.push(url);
        await new Promise((resolve) => setTimeout(resolve, 5));
      },
    },
  };
  const readyRef = {
    moduleId: readyEntry.moduleId,
    engineId: readyEntry.engineId,
    resolvedVersion: readyEntry.version,
    resolvedPackageSha256: readyEntry.packageSha256,
  };
  const failedRef = {
    moduleId: failedEntry.moduleId,
    engineId: failedEntry.engineId,
    resolvedVersion: failedEntry.version,
    resolvedPackageSha256: failedEntry.packageSha256,
  };

  const readyOnly = { instrumentPool: { 1: { engineRef: readyRef, parameterSnapshot: { cutoff: 0.5 } } } };
  await Promise.all([
    host.prepareContext(context, readyOnly),
    host.prepareContext(context, readyOnly),
  ]);
  assert.equal(readyVerificationCalls, 1, "concurrent requests for one exact package must share verification work");
  assert.equal(addModuleCalls.length, 1, "concurrent activation in one AudioContext must call audioWorklet.addModule exactly once");

  await host.prepareContext(context, {
    instrumentPool: {
      1: { engineRef: readyRef },
      2: { engineRef: failedRef },
    },
  });

  const ready = host.packageStatusFor(readyRef);
  const failed = host.packageStatusFor(failedRef);
  assert.equal(ready?.state, "ready", "ready exact pin must retain its own package status");
  assert.equal(ready?.version, "1.0.0");
  assert.equal(ready?.packageSha256, readyEntry.packageSha256);
  assert.equal(failed?.state, "package-failed", "failed exact pin must not overwrite or inherit another version's readiness");
  assert.equal(failed?.version, "1.1.0");
  assert.equal(failed?.packageSha256, failedEntry.packageSha256);
  assert.equal(host.packageStatusFor({ ...readyRef, resolvedPackageSha256: "d".repeat(64) }), null, "wrong exact package SHA must fail closed");

  const packages = host.snapshot().packages;
  assert.equal(packages.length, 2, "same module/engine with distinct exact pins must keep distinct status records");
  assert.equal(new Set(packages.map((item) => item.identity)).size, 2);

  // A live parameter is already durable in ProjectStore and accepted by the
  // Worklet. Host snapshot bookkeeping must advance by exactly that parameter
  // delta so an existing-graph readiness re-proof does not manufacture a
  // redundant full Instrument snapshot and pendingInstrumentSync while playing.
  const messages = [];
  const node = {
    port: {
      postMessage(message) { messages.push(JSON.parse(JSON.stringify(message))); },
      addEventListener() {},
      start() {},
    },
  };
  const liveProject = {
    instrumentPool: {
      1: { engineRef: readyRef, parameterSnapshot: { cutoff: 0.5 } },
    },
  };
  host.attachNode(node, context, liveProject);
  assert.equal(messages.filter((message) => message.type === "production-instruments").length, 1,
    "attach must establish one authoritative full Instrument snapshot");
  liveProject.instrumentPool[1].parameterSnapshot.cutoff = 0.75;
  const delivery = host.sendLiveParameter({
    instrumentId: 1,
    instrument: liveProject.instrumentPool[1],
    parameterId: "cutoff",
    value: 0.75,
  });
  assert.ok(delivery, "verified live parameter must be accepted");
  assert.equal(messages.filter((message) => message.type === "production-parameter").length, 1,
    "live edit must use the dedicated parameter message");
  assert.equal(host.syncProject(liveProject), false,
    "re-proof after accepted live parameter must see the logical Instrument snapshot as already synchronized");
  assert.equal(messages.filter((message) => message.type === "production-instruments").length, 1,
    "accepted live parameter must not cause a later redundant full Instrument snapshot");

  // Do not let the live bookkeeping mask a structural engine/package change.
  liveProject.instrumentPool[1].engineRef = { ...readyRef, resolvedPackageSha256: "e".repeat(64) };
  assert.equal(host.syncProject(liveProject), true,
    "structural engine/package drift must still require a full Instrument snapshot");
  assert.equal(messages.filter((message) => message.type === "production-instruments").length, 2);

  // --- ABI descriptors arriving from the Worklet -----------------------------
  // The engine binary is the authority on its own parameter ranges and units,
  // and it lives in the Worklet. The host has to receive them to ever render a
  // real unit instead of a percentage (#455).
  const bridgeMessages = [];
  let workletListener = null;
  const bridgeNode = {
    port: {
      postMessage(message) { bridgeMessages.push(JSON.parse(JSON.stringify(message))); },
      addEventListener(type, listener) { if (type === "message") workletListener = listener; },
      start() {},
    },
  };
  host.attachNode(bridgeNode, context, readyOnly);
  assert.equal(
    bridgeMessages.filter((message) => message.type === "production-engine-descriptors-request").length,
    1,
    "attaching the node must ask the Worklet what its engines report",
  );
  assert.ok(workletListener, "host must listen for Worklet replies");

  // The host decides the request id, and only the reply carrying the latest one
  // may install a snapshot - a retired node's listener is never removed, so an
  // unmatched reply must be ignored rather than clear the map.
  const latestDescriptorRequestId = () => bridgeMessages
    .filter((message) => message.type === "production-engine-descriptors-request")
    .at(-1).requestId;
  assert.ok(latestDescriptorRequestId(), "the descriptor request must carry an id the reply can be matched against");

  assert.equal(host.abiDescriptorsFor(readyEntry), null, "nothing is known before the Worklet answers");

  workletListener({
    data: {
      type: "production-engine-descriptors",
      requestId: latestDescriptorRequestId(),
      engines: [{
        moduleId: readyEntry.moduleId,
        engineId: readyEntry.engineId,
        version: readyEntry.version,
        packageSha256: readyEntry.packageSha256,
        engine: { parameterCount: 1 },
        parameters: [{ key: "cutoff", abiId: 0x0202, unit: "Hz", groupKey: "filter", plainMin: 30, plainMax: 18000 }],
      }],
    },
  });

  const described = host.abiDescriptorsFor(readyEntry);
  assert.ok(described, "the host must retain what the engine reported");
  assert.equal(described.parameters[0].unit, "Hz", "the unit must reach the host, not just the Worklet");
  assert.equal(described.parameters[0].plainMax, 18000, "the plain range must reach the host");

  // Keyed by full package identity: a different exact pin of the same
  // module/engine is a different package and must not inherit these ranges.
  assert.equal(
    host.abiDescriptorsFor({ ...readyEntry, packageSha256: "f".repeat(64) }),
    null,
    "descriptors must not leak across exact package pins",
  );
  assert.equal(host.abiDescriptorsFor(failedEntry), null, "an engine that never reported must stay unknown");

  // An engine that predates the descriptor calls reports an empty set. That is
  // absence, not an empty parameter list, and must not be recorded as fact.
  workletListener({
    data: {
      type: "production-engine-descriptors",
      requestId: latestDescriptorRequestId(),
      engines: [{ moduleId: failedEntry.moduleId, engineId: failedEntry.engineId, version: failedEntry.version, packageSha256: failedEntry.packageSha256, parameters: [] }],
    },
  });
  assert.equal(host.abiDescriptorsFor(failedEntry), null, "an empty report must remain unknown rather than becoming an empty parameter set");

  // Each response is a complete snapshot of what the Worklet holds. A package
  // the Worklet no longer reports - retired, or re-registered without
  // descriptors after an AudioContext replacement - must stop being reported
  // here too, rather than leaving a stale range presented as current truth.
  workletListener({
    data: {
      type: "production-engine-descriptors",
      requestId: latestDescriptorRequestId(),
      engines: [{
        moduleId: failedEntry.moduleId,
        engineId: failedEntry.engineId,
        version: failedEntry.version,
        packageSha256: failedEntry.packageSha256,
        parameters: [{ key: "drive", abiId: 0x0300, unit: "dB", plainMin: -6, plainMax: 24 }],
      }],
    },
  });
  assert.equal(
    host.abiDescriptorsFor(readyEntry),
    null,
    "a package the Worklet no longer reports must stop being described, not keep a stale entry",
  );
  assert.ok(host.abiDescriptorsFor(failedEntry), "the package the Worklet does report must be described");

  // abiDescriptorsFor hands back the cached object itself, so a consumer that
  // annotated a parameter would rewrite an authoritative range for every later
  // render. Each descriptor is frozen, not just the array holding them.
  const held = host.abiDescriptorsFor(failedEntry);
  assert.ok(Object.isFrozen(held.parameters), "the parameter list must be frozen");
  assert.ok(Object.isFrozen(held.parameters[0]), "each parameter descriptor must be frozen individually");

  // #463: attachNode adds a listener per node and never removes the previous
  // one, so a retired node can still answer - after the current one already
  // has. A reply that does not carry the latest request id must be ignored
  // rather than clear the map and install the retired context's package set.
  const beforeSuperseded = host.abiDescriptorsFor(failedEntry);
  workletListener({
    data: {
      type: "production-engine-descriptors",
      requestId: "abi-descriptors-from-a-retired-node",
      engines: [{
        moduleId: readyEntry.moduleId,
        engineId: readyEntry.engineId,
        version: readyEntry.version,
        packageSha256: readyEntry.packageSha256,
        parameters: [{ key: "stale", abiId: 0x0400, unit: "Hz", plainMin: 1, plainMax: 2 }],
      }],
    },
  });
  assert.deepEqual(host.abiDescriptorsFor(failedEntry), beforeSuperseded,
    "a superseded node's reply must not replace the current descriptor snapshot");
  assert.equal(host.abiDescriptorsFor(readyEntry), null,
    "a superseded node's reply must not install descriptors for a package the current node stopped reporting");
  assert.equal(host.snapshot().traffic.abiDescriptorRepliesIgnored, 1,
    "an ignored reply must be visible in diagnostics rather than silently dropped");

  // #463: the reply is asynchronous and routinely lands after the Sound
  // surface has drawn. Nothing else redraws on its own, so a changed snapshot
  // has to be announced or every control keeps its percentage fallback.
  let descriptorChanges = 0;
  const unsubscribe = host.onEngineDescriptorsChanged(() => { descriptorChanges += 1; });
  host.requestEngineDescriptors();
  const changedReply = {
    data: {
      type: "production-engine-descriptors",
      requestId: latestDescriptorRequestId(),
      engines: [{
        moduleId: failedEntry.moduleId,
        engineId: failedEntry.engineId,
        version: failedEntry.version,
        packageSha256: failedEntry.packageSha256,
        parameters: [{ key: "drive", abiId: 0x0300, unit: "dB", plainMin: -12, plainMax: 24 }],
      }],
    },
  };
  workletListener(changedReply);
  assert.equal(descriptorChanges, 1, "a changed descriptor snapshot must announce itself");

  // Re-attaching re-requests descriptors, and an identical answer must not
  // redraw the surface underneath someone dragging a control.
  host.requestEngineDescriptors();
  workletListener({ data: { ...changedReply.data, requestId: latestDescriptorRequestId() } });
  assert.equal(descriptorChanges, 1, "an unchanged snapshot must not force a redraw");

  unsubscribe();
  host.requestEngineDescriptors();
  workletListener({
    data: {
      type: "production-engine-descriptors",
      requestId: latestDescriptorRequestId(),
      engines: [{
        moduleId: failedEntry.moduleId,
        engineId: failedEntry.engineId,
        version: failedEntry.version,
        packageSha256: failedEntry.packageSha256,
        parameters: [{ key: "drive", abiId: 0x0300, unit: "dB", plainMin: -6, plainMax: 24 }],
      }],
    },
  });
  assert.equal(descriptorChanges, 1, "unsubscribing must stop the notifications");

  console.log("M5A A4B2 exact package readiness + single-flight activation + live-signature convergence passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });