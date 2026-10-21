const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const packageDomain = require("./engine-package-domain.js");
const packageLoaderDomain = require("./engine-package-loader.js");
const engineRegistryDomain = require("./engine-registry-domain.js");
const performerRegistryDomain = require("./performer-registry-domain.js");
const realtimeWindowDomain = require("./realtime-event-window-domain.js");
const synthGatewayDomain = require("./synth-gateway-domain.js");

const sha = (value) => createHash("sha256").update(value).digest("hex");
const packageBytes = Buffer.from("BRKTRK_A2_CONFORMANCE_PACKAGE_V1");
const engineBytes = Buffer.from("deterministic-conformance-engine-v1");
const parameterRegistryBytes = Buffer.from(`${JSON.stringify({
  schema: "brk-test-parameter-registry-v1",
  parameters: [{ id: 256, key: "amp", name: "Amp", type: "continuous", defaultNormalized: 0.25 }],
})}\n`);
const packageSha256 = sha(packageBytes);
const engineSha256 = sha(engineBytes);
const parameterRegistrySha256 = sha(parameterRegistryBytes);
const artifactRecords = [
  { path: "engine.bin", kind: "worklet-test", bytes: engineBytes.byteLength, sha256: engineSha256 },
  { path: "descriptors/parameter-registry.json", kind: "descriptor", bytes: parameterRegistryBytes.byteLength, sha256: parameterRegistrySha256 },
];
const contentSha256 = sha([...artifactRecords]
  .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  .map((artifact) => `${artifact.path}\0${artifact.bytes}\0${artifact.sha256}\n`)
  .join(""));
const packageFiles = () => ({
  "engine.bin": engineBytes,
  "descriptors/parameter-registry.json": parameterRegistryBytes,
});

// Shape this fixture like a real brk-package.json: package/archive SHA belongs
// to catalog metadata outside the archive; the in-package manifest owns a
// deterministic content digest plus per-file hashes and descriptor paths.
const manifest = {
  schema: packageDomain.PACKAGE_FORMAT,
  moduleId: "design.myldy.conformance",
  engineId: "a2-reference",
  version: "1.0.0",
  hostContract: { id: packageDomain.HOST_CONTRACT_ID, minVersion: 1, maxVersion: 1 },
  abiVersion: "0x00010000",
  stateSchemaVersion: 1,
  parameterSchemaVersion: 1,
  contentSha256,
  files: artifactRecords,
  descriptors: { parameters: "descriptors/parameter-registry.json" },
};

const entry = {
  moduleId: manifest.moduleId,
  engineId: manifest.engineId,
  version: manifest.version,
  channel: "stable",
  hostContract: manifest.hostContract,
  abiVersion: manifest.abiVersion,
  packageUrl: "fixture://a2-reference-1.0.0",
  packageSha256,
  stateSchemaVersion: manifest.stateSchemaVersion,
  parameterSchemaVersion: manifest.parameterSchemaVersion,
  status: "active",
  publishedAt: "2026-08-19T00:00:00Z",
};

async function main() {
  const canonicalPathOrder = [
    { path: "docs/capacity-successor.json", size: 3, sha256: "c".repeat(64) },
    { path: "docs/README.md", size: 2, sha256: "b".repeat(64) },
    { path: "docs/BRKTRK_HANDOFF.md", size: 1, sha256: "a".repeat(64) },
  ];
  assert.equal(
    packageDomain.contentDigestInput(canonicalPathOrder),
    `docs/BRKTRK_HANDOFF.md\0${1}\0${"a".repeat(64)}\n`
      + `docs/README.md\0${2}\0${"b".repeat(64)}\n`
      + `docs/capacity-successor.json\0${3}\0${"c".repeat(64)}\n`,
    "content identity must use locale-independent code-unit path order",
  );

  const catalog = { format: packageDomain.CATALOG_FORMAT, entries: [
    entry,
    { ...entry, version: "1.1.0", packageUrl: "fixture://a2-reference-1.1.0", packageSha256: "1".repeat(64) },
  ] };
  assert.equal(packageDomain.resolveCatalogEntry(catalog, { moduleId: entry.moduleId, engineId: entry.engineId, resolvedVersion: "1.0.0" }, { abiVersions: ["0x00010000"] }).version, "1.0.0");
  assert.equal(packageDomain.resolveCatalogEntry(catalog, { moduleId: entry.moduleId, engineId: entry.engineId }, { abiVersions: ["0x00010000"] }).version, "1.1.0");
  assert.equal(packageDomain.resolveCatalogEntry(catalog, { moduleId: entry.moduleId, engineId: entry.engineId, resolvedVersion: "9.9.9" }, { abiVersions: ["0x00010000"] }), null);
  assert.equal(packageDomain.resolveCatalogEntry(catalog, { moduleId: entry.moduleId, engineId: entry.engineId }, { abiVersions: ["0xDEAD"] }), null);
  assert.ok(packageDomain.compareVersions("0.1.0-rc.10", "0.1.0-rc.2") > 0, "numeric SemVer prerelease identifiers must compare numerically");
  assert.ok(packageDomain.compareVersions("0.1.0", "0.1.0-rc.10") > 0, "stable SemVer must sort after its prerelease");
  assert.equal(packageDomain.compareVersions("0.1.0+build.1", "0.1.0+build.2"), 0, "SemVer build metadata must not affect precedence");
  assert.equal(synthGatewayDomain.DEFAULT_MAX_EVENTS_PER_BLOCK, realtimeWindowDomain.DEFAULT_EVENT_CAPACITY, "SynthGateway default event budget must stay aligned with accepted K4B event capacity");

  const normalizedManifest = packageDomain.normalizeManifest(manifest);
  assert.equal(normalizedManifest.format, packageDomain.PACKAGE_FORMAT, "real package schema field must normalize as package format");
  assert.equal(normalizedManifest.artifacts[0].size, engineBytes.byteLength, "real package files[].bytes must normalize as artifact size");
  assert.equal(Object.hasOwn(normalizedManifest, "packageSha256"), false, "in-package manifest must not require a self-referential archive SHA");
  assert.equal(normalizedManifest.contentSha256, contentSha256);
  assert.equal(normalizedManifest.descriptors.parameters, "descriptors/parameter-registry.json");
  assert.deepEqual(packageDomain.moduleInstanceCapability({ ...normalizedManifest, runtime: { maxModuleInstances: 16 } }), { capacity: 16, source: "runtime.maxModuleInstances", explicit: true, legacy: false });
  assert.deepEqual(packageDomain.moduleInstanceCapability(normalizedManifest), { capacity: 8, source: "legacy-host-fallback", explicit: false, legacy: true });
  assert.throws(() => packageDomain.normalizeManifest({ ...manifest, runtime: { maxModuleInstances: 0 } }), /maxModuleInstances must be at least 1/);
  assert.throws(() => packageDomain.normalizeManifest({ ...manifest, hostContract: undefined }), /hostContract is required/);
  assert.throws(() => packageDomain.normalizeManifest({ ...manifest, parameterSchemaVersion: undefined }), /parameterSchemaVersion is required/);

  const loader = packageLoaderDomain.createPackageLoader({
    host: { abiVersions: ["0x00010000"] },
    readPackage: async () => ({ packageBytes, manifest, files: packageFiles() }),
  });
  const loaded = await loader.load(entry);
  assert.equal(loaded.manifest.engineId, "a2-reference");
  assert.equal(loaded.packageSha256, packageSha256, "catalog-owned transport hash must be preserved as verified loader evidence");
  assert.equal(loaded.contentSha256, contentSha256, "manifest content digest must be independently verified");
  assert.equal(loaded.manifest.parameterRegistry.path, "descriptors/parameter-registry.json");
  assert.equal(loaded.manifest.parameterRegistry.count, 1);
  assert.equal(loaded.manifest.parameters[0].id, "amp", "host-facing parameter identity must use the stable descriptor key");
  assert.equal(loaded.manifest.parameters[0].numericId, 256, "numeric ABI parameter identity must remain available beside the stable key");
  assert.equal(Buffer.from(loaded.files["engine.bin"]).toString(), engineBytes.toString());

  const corruptLoader = packageLoaderDomain.createPackageLoader({
    host: { abiVersions: ["0x00010000"] },
    readPackage: async () => ({ packageBytes: Buffer.from("corrupt"), manifest, files: packageFiles() }),
  });
  await assert.rejects(() => corruptLoader.load(entry), (error) => error?.code === "package-hash-mismatch");

  const contentCorruptLoader = packageLoaderDomain.createPackageLoader({
    host: { abiVersions: ["0x00010000"] },
    readPackage: async () => ({ packageBytes, manifest: { ...manifest, contentSha256: "f".repeat(64) }, files: packageFiles() }),
  });
  await assert.rejects(() => contentCorruptLoader.load(entry), (error) => error?.code === "content-hash-mismatch");

  const artifactsCorruptLoader = packageLoaderDomain.createPackageLoader({
    host: { abiVersions: ["0x00010000"] },
    readPackage: async () => ({ packageBytes, manifest, files: { ...packageFiles(), "engine.bin": Buffer.from("wrong") } }),
  });
  await assert.rejects(() => artifactsCorruptLoader.load(entry), (error) => ["artifact-size-mismatch", "artifact-hash-mismatch"].includes(error?.code));

  const descriptorCorruptLoader = packageLoaderDomain.createPackageLoader({
    host: { abiVersions: ["0x00010000"] },
    readPackage: async () => ({ packageBytes, manifest, files: { ...packageFiles(), "descriptors/parameter-registry.json": Buffer.alloc(parameterRegistryBytes.byteLength, 0x20) } }),
  });
  await assert.rejects(() => descriptorCorruptLoader.load(entry), (error) => ["artifact-hash-mismatch", "invalid-descriptor-json"].includes(error?.code));

  const contractMismatchLoader = packageLoaderDomain.createPackageLoader({
    host: { abiVersions: ["0x00010000"] },
    readPackage: async () => ({
      packageBytes,
      manifest: { ...manifest, hostContract: { id: packageDomain.HOST_CONTRACT_ID, minVersion: 1, maxVersion: 2 } },
      files: packageFiles(),
    }),
  });
  await assert.rejects(() => contractMismatchLoader.load(entry), (error) => error?.code === "manifest-catalog-mismatch");

  const factoryStates = [];
  const factory = ({ track, instrumentId, parameterSnapshot }) => {
    const state = { track, instrumentId, amp: Number(parameterSnapshot?.amp ?? 0.25), active: 0, pending: [], patches: 0 };
    factoryStates.push(state);
    return {
      handleEvent(action) { state.pending.push(action); },
      applyState(next) { state.patches += 1; if (Number.isFinite(Number(next?.parameterSnapshot?.amp))) state.amp = Number(next.parameterSnapshot.amp); },
      reset() { state.active = 0; state.pending.length = 0; },
      process({ frameCount, left, right }) {
        state.pending.sort((a, b) => a.sampleOffset - b.sampleOffset);
        let pointer = 0;
        for (let frame = 0; frame < frameCount; frame += 1) {
          while (state.pending[pointer]?.sampleOffset === frame) {
            const action = state.pending[pointer++];
            if (action.type === "note-on" || action.type === "retrigger") state.active = (action.velocity / 127) * state.amp;
            else if (action.type === "note-off") state.active = 0;
            else if (action.type === "parameter" && action.parameterId === "amp") state.amp = Number(action.value);
          }
          left[frame] += state.active;
          right[frame] += state.active;
        }
        state.pending.splice(0, pointer);
      },
      __state: state,
    };
  };

  const engineRegistry = engineRegistryDomain.createEngineRegistry({ abiVersions: ["0x00010000"] });
  engineRegistry.register(loaded, factory);
  assert.throws(() => engineRegistry.register(loaded, factory), (error) => error?.code === "duplicate-engine-registration");
  assert.deepEqual(engineRegistry.snapshot()[0], {
    moduleId: entry.moduleId,
    engineId: entry.engineId,
    version: entry.version,
    packageSha256,
    contentSha256,
  }, "EngineRegistry diagnostics must distinguish archive and content integrity identities");

  const instruments = {
    3: { id: 3, engineRef: { moduleId: entry.moduleId, engineId: entry.engineId, resolvedVersion: entry.version }, patchState: { schemaVersion: 1, encoding: "json", data: { seed: 3 } }, parameterSnapshot: { amp: 0.25 } },
    7: { id: 7, engineRef: { moduleId: entry.moduleId, engineId: entry.engineId, resolvedVersion: entry.version }, patchState: { schemaVersion: 1, encoding: "json", data: { seed: 7 } }, parameterSnapshot: { amp: 0.5 } },
    9: { id: 9, engineRef: { moduleId: "missing.module", engineId: "missing", resolvedVersion: "1.0.0" }, patchState: { schemaVersion: 99, encoding: "opaque", data: "LOSSLESS" }, parameterSnapshot: { unknown: 123 } },
  };
  const performers = performerRegistryDomain.createPerformerRegistry({
    engineRegistry,
    instrumentProvider: (id) => instruments[id] ?? null,
    sampleRate: 48000,
  });
  const t0i3 = performers.prepare(0, 3);
  const t1i3 = performers.prepare(1, 3);
  const t0i7 = performers.prepare(0, 7);
  assert.ok(t0i3 && t1i3 && t0i7);
  assert.notEqual(t0i3.performer, t1i3.performer, "same durable Instrument on two Tracks must create isolated performers");
  assert.equal(performers.prepare(2, 9), null, "missing engine must stay explicitly unavailable");
  assert.equal(performers.status(2, 9).state, "missing-engine");
  assert.equal(instruments[9].patchState.data, "LOSSLESS", "missing engine preparation must not mutate durable patch state");
  assert.equal(performers.diagnostics().slotCapacity, 8 * 256, "performer registry must be explicitly bounded");

  const gateway = synthGatewayDomain.createSynthGateway({ performerRegistry: performers, sampleRate: 48000, maxEventsPerBlock: 16 });
  gateway.beginBlock(1000, 4);
  gateway.routeTracePacket({ frame: 1001, events: [
    { frame: 1001, track: 0, kind: "note-trigger", source: "fixture", data: { instrumentId: 3, note: 60, velocity: 127 } },
    { frame: 1001, track: 1, kind: "note-trigger", source: "fixture", data: { instrumentId: 3, note: 67, velocity: 64 } },
    { frame: 1002, track: 0, kind: "note-trigger", source: "fixture", data: { instrumentId: 7, note: 72, velocity: 127 } },
  ] });
  const left0 = new Float32Array(4); const right0 = new Float32Array(4);
  const left1 = new Float32Array(4); const right1 = new Float32Array(4);
  gateway.renderTrack(0, left0, right0, 4);
  gateway.renderTrack(1, left1, right1, 4);
  assert.equal(left0[0], 0);
  assert.ok(Math.abs(left0[1] - 0.25) < 1e-6, "sample offset must be preserved within the actual block");
  assert.ok(Math.abs(left0[2] - 0.75) < 1e-6, "multiple Instruments on one Track must sum to that dry Track");
  assert.ok(left1[1] > 0 && left1[1] < left0[1], "shared Instrument on another Track must have independent velocity/voice state");
  gateway.endBlock();

  gateway.beginBlock(1500, 1);
  assert.throws(() => gateway.routeTracePacket({ frame: 1500, events: [
    { frame: 1500, track: 2, kind: "note-trigger", source: "missing-engine", data: { instrumentId: 9, note: 60, velocity: 127 } },
  ] }), (error) => error?.code === "performer-unavailable" && error?.details?.unavailable?.[0]?.track === 2);
  assert.equal(gateway.diagnostics().droppedUnavailableEvents, 0, "unavailable performer events must never be silently dropped");
  assert.equal(gateway.diagnostics().unavailableEventErrors, 1);
  gateway.endBlock();

  gateway.beginBlock(2000, 1);
  gateway.applyParameter(0, 3, "amp", 0.1, 0);
  gateway.routeTracePacket({ frame: 2000, events: [{ frame: 2000, track: 0, kind: "note-trigger", source: "frame1", data: { instrumentId: 3, note: 60, velocity: 127 } }] });
  const oneL = new Float32Array(1); const oneR = new Float32Array(1);
  gateway.renderTrack(0, oneL, oneR, 1);
  assert.ok(Number.isFinite(oneL[0]) && oneL[0] > 0, "one-frame render blocks must be supported");
  gateway.endBlock();

  assert.throws(() => {
    gateway.beginBlock(3000, 2);
    gateway.applyParameter(0, 3, "not-a-real-param", 1, 0);
  }, /unknown stable parameter id/);
  gateway.endBlock();

  assert.equal(gateway.applyInstrumentState(0, 3, { parameterSnapshot: { amp: 0.2 } }), true, "patch/parameter state must propagate at an explicit safe boundary");
  assert.equal(t0i3.performer.__state.patches, 1);
  gateway.beginBlock(4000, 2);
  assert.throws(() => gateway.applyInstrumentState(0, 3, instruments[3]), /safe boundary/);
  gateway.endBlock();

  const tinyGateway = synthGatewayDomain.createSynthGateway({ performerRegistry: performers, sampleRate: 48000, maxEventsPerBlock: 1 });
  const pendingBeforeOverflow = t0i3.performer.__state.pending.length;
  tinyGateway.beginBlock(5000, 1);
  assert.throws(() => tinyGateway.routeTracePacket({ frame: 5000, events: [
    { frame: 5000, track: 0, kind: "note-trigger", data: { instrumentId: 3, note: 60, velocity: 100 } },
    { frame: 5000, track: 0, kind: "note-release", data: { instrumentId: 3, note: -2, velocity: 100 } },
  ] }), /event demand exceeded/);
  assert.equal(t0i3.performer.__state.pending.length, pendingBeforeOverflow, "rejected K4 packet must not partially mutate performer queues");
  assert.equal(tinyGateway.diagnostics().eventCount, 0, "rejected K4 packet must not consume partial event capacity");
  assert.equal(tinyGateway.diagnostics().overrunCount, 1);
  tinyGateway.endBlock();

  assert.equal(factoryStates.length, 3, "only explicitly prepared Track × Instrument performers may be instantiated");
  console.log("M5A A2 engine package / registry / SynthGateway conformance tests passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
