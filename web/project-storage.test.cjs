const assert = require("node:assert/strict");
require("./production-instrument-domain.js");
const s = require("./project-storage.js");

class MemoryStorage {
  constructor(entries = {}) { this.map = new Map(Object.entries(entries)); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(String(k), String(v)); }
  removeItem(k) { this.map.delete(String(k)); }
}

class FailingMigrationStorage extends MemoryStorage {
  setItem(k, v) {
    if (String(k) === s.STAGING_KEY) throw new Error("simulated staging write failure");
    super.setItem(k, v);
  }
}

class FailingQuarantineStorage extends MemoryStorage {
  setItem(k, v) {
    if (String(k).startsWith(s.RECOVERY_PREFIX)) throw new Error("simulated quarantine write failure");
    super.setItem(k, v);
  }
}

class StagingVerificationStorage extends MemoryStorage {
  constructor(entries = {}) { super(entries); this.corruptStaging = true; }
  setItem(k, v) {
    if (this.corruptStaging && String(k) === s.STAGING_KEY) return super.setItem(k, "{broken-staging");
    super.setItem(k, v);
  }
}

class CanonicalWriteStorage extends MemoryStorage {
  constructor(entries = {}) { super(entries); this.failCanonical = true; }
  setItem(k, v) {
    if (this.failCanonical && String(k) === s.STORAGE_KEY) throw new Error("simulated canonical write failure");
    super.setItem(k, v);
  }
}

class CleanupFailStorage extends MemoryStorage {
  constructor(entries = {}) { super(entries); this.failCleanup = true; }
  removeItem(k) {
    if (this.failCleanup && String(k) === s.STAGING_KEY) throw new Error("simulated staging cleanup failure");
    super.removeItem(k);
  }
}

const PREVIEW_EXTENSION = "org.myldydesign.brktrk.preview-instruments-v2";
const PRE_V4_POOL_EXTENSION = "org.myldydesign.brktrk.pre-v4-instrument-pool-unknown";
const UNKNOWN_EXTENSION = "org.example.unknown";
const PRE_V5_PARAMETER_EVENTS_EXTENSION = "org.myldydesign.brktrk.pre-v5-phrase-parameter-events-unknown";

const legacy = (schemaVersion = 2) => ({
  schemaVersion,
  projectName: "legacy jam",
  tempo: 138,
  song: [[7]],
  chains: { 7: [{ phrase: 9, transpose: -12 }] },
  phrases: { 9: [{ note: 61, velocity: 87, instrument: 3, fx: [2, 4, 0xE1] }] },
  instruments: [{ params: [1, 2, 3, 4, 5, 6], volume: 0.2, pan: 0.25, mute: true, wave: 2 }],
  tracks: [{ mix: { gain: 0.42, mute: true, pan: -0.25 } }],
  transport: { followPlayhead: false, scopeLocked: true, lockedScope: "phrase" },
  compatibilityExtensions: {
    [PREVIEW_EXTENSION]: { shouldDisappear: true },
    [PRE_V4_POOL_EXTENSION]: { shouldDisappear: true },
    [UNKNOWN_EXTENSION]: { keep: true },
  },
  unknownFutureField: { keep: true },
});

const productionInstrument = (id = 3) => ({
  id,
  name: "BRK TEST",
  engineRef: {
    moduleId: "org.myldydesign.brk.test-module",
    engineId: "org.myldydesign.brk.test-engine",
    requestedVersion: "^1.0.0",
    resolvedVersion: null,
    hostContract: "1.x",
    futureRef: { keep: true },
  },
  patchState: {
    schemaVersion: 1,
    encoding: "json",
    data: { shape: 7 },
    futurePatch: { keep: true },
  },
  parameterSnapshot: { "osc.shape": 7, "amp.gain": 0.75 },
  presetRef: null,
  provenance: { source: "fixture" },
  compatibilityData: { "org.example.future": { keep: true } },
  unknownData: [{ keep: true }],
  futureInstrumentField: { keep: true },
});

function assertCompatibilityCleanup(project) {
  assert.equal(project.compatibilityExtensions?.[UNKNOWN_EXTENSION]?.keep, true, "unrelated compatibility extension must survive preview retirement");
  assert.equal(Object.hasOwn(project.compatibilityExtensions ?? {}, PREVIEW_EXTENSION), false, "retired preview extension must be removed");
  assert.equal(Object.hasOwn(project.compatibilityExtensions ?? {}, PRE_V4_POOL_EXTENSION), false, "retired pre-v4 collision extension must be removed");
}

for (const schemaVersion of [0, 1, 2, 3]) {
  const source = legacy(schemaVersion);
  const before = JSON.stringify(source);
  const migrated = s.migrateProject(source);
  assert.equal(migrated.fromVersion, schemaVersion);
  assert.equal(migrated.toVersion, 5);
  assert.equal(migrated.project.schemaVersion, 5);
  assert.equal(migrated.project.song[0][0], 7);
  assert.equal(migrated.project.chains[7][0].phrase, 9);
  assert.equal(migrated.project.phrases[9][0].instrument, 3, "Phrase Instrument byte remains structural data");
  assert.deepEqual(
    migrated.project.phrases[9][0].condition,
    { probability: 100, every: 1, offset: 0 },
    "legacy Phrase rows must acquire the canonical unconditional condition",
  );
  assert.deepEqual(migrated.project.phrases[9][0].parameterEvents, [], "legacy Phrase rows must acquire an empty canonical ParameterEvent list");
  assert.deepEqual(migrated.project.instrumentPool, {}, "pre-v4 data must not fabricate production Instruments");
  assert.equal(Object.hasOwn(migrated.project, "instruments"), false);
  assert.equal(Object.hasOwn(migrated.project, "previewInstruments"), false);
  assertCompatibilityCleanup(migrated.project);
  assert.equal(Object.hasOwn(migrated.project, "transport"), false);
  assert.equal(migrated.project.unknownFutureField.keep, true, "ordinary unrelated top-level data remains intact");
  assert.equal(JSON.stringify(source), before, `schema ${schemaVersion} migration must not mutate its source object`);
}

{
  const source = legacy();
  delete source.schemaVersion;
  const migrated = s.migrateProject(source);
  assert.equal(migrated.fromVersion, 0);
  assert.equal(migrated.project.schemaVersion, 5);
  assertCompatibilityCleanup(migrated.project);
}

{
  const schema4 = {
    ...legacy(4),
    instrumentPool: {
      3: productionInstrument(3),
      254: productionInstrument(254),
    },
  };
  const migrated = s.migrateProject(schema4);
  assert.equal(migrated.fromVersion, 4);
  assert.equal(migrated.project.schemaVersion, 5);
  assert.equal(migrated.project.instrumentPool[3].engineRef.engineId, "org.myldydesign.brk.test-engine");
  assert.equal(migrated.project.instrumentPool[3].engineRef.futureRef.keep, true);
  assert.equal(migrated.project.instrumentPool[3].patchState.futurePatch.keep, true);
  assert.equal(migrated.project.instrumentPool[3].futureInstrumentField.keep, true);
  assert.equal(migrated.project.instrumentPool[254].id, 254);
  assertCompatibilityCleanup(migrated.project);
  assert.deepEqual(migrated.project.phrases[9][0].parameterEvents, []);
  assert.equal(s.migrateProject(migrated.project).migrated, false, "canonical schema-v5 production project must be idempotent");
}

{
  const source = s.migrateProject(legacy()).project;
  source.phrases[9][0].condition = { probability: -9.2, every: 99.1, offset: 99 };
  const migrated = s.migrateProject(source);
  assert.deepEqual(
    migrated.project.phrases[9][0].condition,
    { probability: 0, every: 16, offset: 15 },
    "Phrase condition normalization must clamp the durable representation",
  );
  assert.equal(s.migrateProject(migrated.project).migrated, false, "normalized Phrase conditions must serialize idempotently");
}

{
  const oldSchema4 = legacy(4);
  delete oldSchema4.phrases[9][0].condition;
  const migrated = s.migrateProject(oldSchema4);
  assert.equal(migrated.fromVersion, 4);
  assert.equal(migrated.migrated, true, "pre-condition schema-v4 bytes must still be canonicalized on load");
  assert.deepEqual(migrated.project.phrases[9][0].condition, { probability: 100, every: 1, offset: 0 });
  assert.deepEqual(migrated.project.phrases[9][0].parameterEvents, []);
  assert.equal(s.migrateProject(migrated.project).migrated, false, "canonicalized schema-v5 row must become idempotent");
}

{
  const schema5 = s.migrateProject(legacy(4)).project;
  schema5.phrases[9][0].parameterEvents = [
    { instrumentId: 7, parameterId: "filter.cutoff", value: 0.7, interpolationOut: "linear" },
    { instrumentId: 3, parameterId: "amp.gain", value: 0.5, interpolationOut: "step" },
  ];
  const migrated = s.migrateProject(schema5);
  assert.equal(migrated.fromVersion, 5);
  assert.deepEqual(migrated.project.phrases[9][0].parameterEvents, [
    { instrumentId: 3, parameterId: "amp.gain", value: 0.5, interpolationOut: "step" },
    { instrumentId: 7, parameterId: "filter.cutoff", value: 0.7, interpolationOut: "linear" },
  ], "schema-v5 ParameterEvents must serialize in canonical stable-target order");
  assert.equal(s.migrateProject(migrated.project).migrated, false);
}

{
  const schema4 = legacy(4);
  schema4.phrases[9][0].parameterEvents = { vendorOpaque: ["do", "not", "reinterpret"] };
  const migrated = s.migrateProject(schema4);
  assert.deepEqual(migrated.project.phrases[9][0].parameterEvents, [], "pre-v5 same-named row data must not become authored locks");
  assert.deepEqual(
    migrated.project.compatibilityExtensions[PRE_V5_PARAMETER_EVENTS_EXTENSION],
    [{ phraseId: 9, row: 0, value: { vendorOpaque: ["do", "not", "reinterpret"] } }],
    "pre-v5 same-named row data must survive in compatibility data",
  );
}

{
  const schema4 = legacy(4);
  schema4.phrases[9][0].parameterEvents = { vendorOpaque: true };
  schema4.compatibilityExtensions[PRE_V5_PARAMETER_EVENTS_EXTENSION] = { existing: "keep" };
  assert.throws(() => s.migrateProject(schema4), /parameterEvents migration conflicts/, "collision extension must fail closed rather than overwrite either payload");
}

{
  const store = new MemoryStorage({ [s.STORAGE_KEY]: JSON.stringify(legacy()) });
  const status = s.bootstrapStorage(store, { now: 10 });
  const saved = JSON.parse(store.getItem(s.STORAGE_KEY));
  assert.equal(status.kind, "migrated");
  assert.equal(saved.schemaVersion, 5);
  assert.deepEqual(saved.instrumentPool, {});
  assert.equal(Object.hasOwn(saved, "instruments"), false);
  assertCompatibilityCleanup(saved);
  assert.equal(Object.hasOwn(saved, "transport"), false);
}

// A conflicting legacy reserved-field migration that cannot be quarantined
// is explicitly non-installable. Production runtime must fall back without
// re-reading these preserved bytes into the live model.
{
  const conflicting = legacy(4);
  Object.defineProperty(conflicting, "constructor", {
    value: { keep: "complete legacy value" },
    enumerable: true,
    configurable: true,
    writable: true,
  });
  conflicting.compatibilityExtensions[s.RESERVED_FIELDS_EXTENSION] = { existing: true };
  const raw = JSON.stringify(conflicting);
  const store = new FailingQuarantineStorage({ [s.STORAGE_KEY]: raw });
  const status = s.bootstrapStorage(store, { now: 105 });

  assert.equal(status.kind, "blocked");
  assert.equal(status.canonicalInstallable, false);
  assert.match(status.error, /conflicts with existing compatibility data/);
  assert.match(status.backupError, /simulated quarantine write failure/);
  assert.equal(store.getItem(s.STORAGE_KEY), raw, "failed quarantine must preserve the original canonical bytes");
}

// Fault 1: staging write. A valid legacy canonical must remain valid data, not
// be reclassified as corrupt content merely because persistence failed.
{
  const raw = JSON.stringify(legacy(3));
  const store = new FailingMigrationStorage({ [s.STORAGE_KEY]: raw });
  const status = s.bootstrapStorage(store, { now: 11 });
  assert.equal(status.kind, "migration-write-failed");
  assert.equal(status.errorCode, "BRKTRK_STAGING_WRITE_FAILED");
  assert.equal(status.fromVersion, 3);
  assert.equal(status.toVersion, 5);
  assert.equal(status.canonicalPreserved, true);
  assert.equal(status.canonicalUpdated, false);
  assert.equal(status.stagingPresent, false);
  assert.equal(store.getItem(s.STORAGE_KEY), raw, "valid canonical Project must remain byte-for-byte intact after migration write failure");
  assert.equal([...store.map.keys()].some((key) => key.startsWith(s.RECOVERY_PREFIX)), false, "storage faults must not manufacture corrupt-content recovery copies");
}

// Fault 2: staging verification. Canonical remains intact; on the next healthy
// bootstrap the invalid orphan staging is preserved as evidence and reclaimed.
{
  const canonical = s.migrateProject(legacy()).project;
  const raw = JSON.stringify(canonical);
  const next = { ...canonical, tempo: 151 };
  const store = new StagingVerificationStorage({ [s.STORAGE_KEY]: raw });
  assert.throws(() => s.writeCanonical(store, next), (error) => error?.code === "BRKTRK_STAGING_VERIFY_FAILED");
  assert.equal(store.getItem(s.STORAGE_KEY), raw);
  assert.equal(store.getItem(s.STAGING_KEY), "{broken-staging");
  store.corruptStaging = false;
  const status = s.bootstrapStorage(store, { now: 12 });
  assert.equal(status.kind, "staging-invalid-recovered");
  assert.equal(store.getItem(s.STORAGE_KEY), raw);
  assert.equal(store.getItem(s.STAGING_KEY), null);
  assert.equal(store.getItem(`${s.RECOVERY_PREFIX}12:staging`), "{broken-staging");
}

// Fault 3: canonical write after a verified staging write. The verified staging
// remains the newer transaction and is promoted deterministically next boot.
{
  const canonical = s.migrateProject(legacy()).project;
  const oldRaw = JSON.stringify({ ...canonical, tempo: 120 });
  const next = { ...canonical, tempo: 166 };
  const store = new CanonicalWriteStorage({ [s.STORAGE_KEY]: oldRaw });
  assert.throws(() => s.writeCanonical(store, next), (error) => error?.code === "BRKTRK_CANONICAL_WRITE_FAILED");
  assert.equal(store.getItem(s.STORAGE_KEY), oldRaw);
  assert.equal(JSON.parse(store.getItem(s.STAGING_KEY)).tempo, 166);
  store.failCanonical = false;
  const status = s.bootstrapStorage(store, { now: 13 });
  assert.equal(status.kind, "staging-recovered");
  assert.equal(JSON.parse(store.getItem(s.STORAGE_KEY)).tempo, 166);
  assert.equal(store.getItem(s.STAGING_KEY), null);
}

// Fault 4: cleanup after canonical succeeds. The canonical is already durable;
// cleanup failure remains observable and the equal orphan is reclaimed next boot.
{
  const canonical = s.migrateProject(legacy()).project;
  const next = { ...canonical, tempo: 177 };
  const store = new CleanupFailStorage();
  assert.throws(() => s.writeCanonical(store, next), (error) => error?.code === "BRKTRK_STAGING_CLEANUP_FAILED");
  assert.equal(JSON.parse(store.getItem(s.STORAGE_KEY)).tempo, 177);
  assert.equal(JSON.parse(store.getItem(s.STAGING_KEY)).tempo, 177);
  store.failCleanup = false;
  const status = s.bootstrapStorage(store, { now: 14 });
  assert.equal(status.kind, "staging-reclaimed");
  assert.equal(JSON.parse(store.getItem(s.STORAGE_KEY)).tempo, 177);
  assert.equal(store.getItem(s.STAGING_KEY), null);
}

// Fault 5 / orphan staging: a verified newer staging value wins over the older
// canonical, matching the staging-before-canonical transaction order.
{
  const canonical = s.migrateProject(legacy()).project;
  const oldRaw = JSON.stringify({ ...canonical, tempo: 121 });
  const stagedRaw = JSON.stringify({ ...canonical, tempo: 199 });
  const store = new MemoryStorage({ [s.STORAGE_KEY]: oldRaw, [s.STAGING_KEY]: stagedRaw });
  const status = s.bootstrapStorage(store, { now: 15 });
  assert.equal(status.kind, "staging-recovered");
  assert.equal(JSON.parse(store.getItem(s.STORAGE_KEY)).tempo, 199);
  assert.equal(store.getItem(s.STAGING_KEY), null);
}

{
  const store = new MemoryStorage({ [s.STORAGE_KEY]: "{broken" });
  const status = s.bootstrapStorage(store, { now: 42 });
  assert.equal(status.kind, "recovery");
  assert.equal(store.getItem(`${s.RECOVERY_PREFIX}42`), "{broken");
}

{
  const model = legacy();
  s.installRuntimeProject(model);
  assert.equal(model.schemaVersion, 5);
  assert.deepEqual(model.instrumentPool, {});
  assert.equal(Object.hasOwn(model, "instruments"), false, "runtime must not rehydrate the removed preview Instrument array");
  assert.equal(Object.hasOwn(model, "previewInstruments"), false);
  assertCompatibilityCleanup(model);
  model.instrumentPool[3] = productionInstrument(3);
  const store = new MemoryStorage();
  const saved = JSON.parse(s.writeCanonical(store, model));
  assert.equal(saved.instrumentPool[3].engineRef.engineId, "org.myldydesign.brk.test-engine");
  assert.equal(Object.hasOwn(saved, "instruments"), false);
  assertCompatibilityCleanup(saved);
}

assert.throws(() => s.migrateProject({ schemaVersion: 99 }), /Unsupported project schema/);
assert.throws(() => s.migrateProject({ ...legacy(5), instrumentPool: { 300: productionInstrument(3) } }), /00–FF/);

{
  const files = require("./project-file.js");
  const stores = require("./stores.js");
  assert.equal(stores.PROJECT_SCHEMA_VERSION, s.CURRENT_SCHEMA_VERSION);
  const change = stores.createProjectChangeSet({ target: "project.tempo" });
  assert.equal(change.schemaVersion, 5);

  const text = files.serializeProject(legacy(), { unknownEnvelope: { keepOuter: true } });
  const envelope = JSON.parse(text);
  assert.equal(envelope.format, "BRKTRK_PROJECT");
  assert.equal(envelope.formatVersion, 1);
  assert.equal(envelope.project.schemaVersion, 5);
  assert.deepEqual(envelope.project.instrumentPool, {});
  assert.equal(Object.hasOwn(envelope.project, "instruments"), false);
  assertCompatibilityCleanup(envelope.project);
  assert.equal(envelope.keepOuter, true);

  const prepared = files.prepareOpen(text);
  assert.equal(prepared.projectSchemaVersion, 5);
  assert.deepEqual(prepared.project.instrumentPool, {});
  assertCompatibilityCleanup(prepared.project);

  const schema5 = s.migrateProject(legacy(4)).project;
  schema5.instrumentPool[3] = productionInstrument(3);
  const productionPrepared = files.prepareOpen(files.serializeProject(schema5));
  assert.equal(productionPrepared.project.instrumentPool[3].parameterSnapshot["osc.shape"], 7);
  assert.equal(productionPrepared.project.instrumentPool[3].futureInstrumentField.keep, true);
  assertCompatibilityCleanup(productionPrepared.project);

  const detachedEnvelope = {
    format: "BRKTRK_PROJECT",
    formatVersion: 1,
    producer: { app: "fixture", version: "1" },
    project: legacy(1),
    futureOuter: { keep: true },
  };
  const detachedBefore = JSON.stringify(detachedEnvelope);
  const detachedPrepared = files.prepareOpen(detachedEnvelope);
  assert.equal(JSON.stringify(detachedEnvelope), detachedBefore, "prepareOpen must not mutate its source");
  assert.equal(detachedPrepared.sourceProjectSchemaVersion, 1);
  assert.equal(detachedPrepared.projectSchemaVersion, 5);
  assert.equal(detachedPrepared.project.song[0][0], 7);
  assert.deepEqual(detachedPrepared.project.instrumentPool, {});
  assertCompatibilityCleanup(detachedPrepared.project);
  assert.equal(detachedPrepared.unknownEnvelope.futureOuter.keep, true);

  assert.throws(() => files.parseEnvelope("{broken"), /Invalid \.brktrk JSON/);
  assert.throws(() => files.parseEnvelope({ format: "OTHER", formatVersion: 1, project: {} }), /Unsupported project format/);
  assert.throws(() => files.parseEnvelope({ format: "BRKTRK_PROJECT", formatVersion: 2, project: {} }), /Unsupported \.brktrk format version 2/);
  assert.throws(() => files.parseEnvelope({ format: "BRKTRK_PROJECT", formatVersion: 1, project: { schemaVersion: 6 } }), /Unsupported project schema 6/);
  assert.throws(() => files.createEnvelope({ ...legacy(), view: "phrase" }), /Session-only field/);
}

console.log("Project storage schema v5 + ParameterEvent collision safety + browser staging fault-injection tests passed");
