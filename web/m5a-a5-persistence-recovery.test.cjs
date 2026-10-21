const assert = require("node:assert/strict");

require("./production-instrument-domain.js");
const storage = require("./project-storage.js");
const files = require("./project-file.js");
const recovery = require("./project-recovery.js");
const packages = require("./engine-package-domain.js");

const IDENTITY = Object.freeze({
  moduleId: "design.myldy.brk-wav",
  engineId: "brk-wav",
  version: "0.1.0-rc5",
  packageSha256: "43ae3453349bb98dc61d4d8267178d328f72e78c569010862f4161f50fc9d58e",
  contentSha256: "a9a3c60fd2b4ae608a997800c51b8fbc363319e7306fa799906a3cd34aabe321",
});
const OTHER_SHA = "b".repeat(64);
const clone = (value) => JSON.parse(JSON.stringify(value));

function instrument() {
  return {
    id: 3,
    name: "A5.3 BRK WAV",
    engineRef: {
      moduleId: IDENTITY.moduleId,
      engineId: IDENTITY.engineId,
      requestedVersion: IDENTITY.version,
      resolvedVersion: IDENTITY.version,
      resolvedPackageSha256: IDENTITY.packageSha256,
      hostContract: "brktrk-synth-gateway-v1",
    },
    patchState: {
      schemaVersion: 131072,
      encoding: "opaque",
      data: "A5_3_OPAQUE_PATCH_STATE",
    },
    parameterSnapshot: {
      shape: 0.125,
      filter_mode: 0.25,
      cutoff: 0.34,
      resonance: 0.28,
      amp: 0.16,
      level: 0.78,
    },
    presetRef: {
      id: "factory:a5-3",
      name: "A5.3 Factory",
      bank: "Factory",
      origin: "engine-package",
      readOnly: true,
      moduleId: IDENTITY.moduleId,
      engineId: IDENTITY.engineId,
      version: IDENTITY.version,
      packageSha256: IDENTITY.packageSha256,
    },
    provenance: {
      source: "m5a-a5-persistence-recovery-fixture",
      packageSha256: IDENTITY.packageSha256,
    },
    compatibilityData: { "org.example.a5-3": { preserve: true } },
    unknownData: [{ future: "preserve" }],
  };
}

function project() {
  const base = storage.migrateProject({
    schemaVersion: 3,
    projectName: "A5.3 PERSISTENCE",
    tempo: 147,
    song: [[0]],
    chains: { 0: [{ phrase: 0, transpose: 0 }] },
    phrases: { 0: [{ note: 60, velocity: 100, instrument: 3, fx: [] }] },
    tracks: Array.from({ length: 8 }, (_, id) => ({ id })),
  }).project;
  base.instrumentPool[3] = instrument();
  return storage.migrateProject(base).project;
}

function catalog(entries) {
  return {
    format: packages.CATALOG_FORMAT,
    entries: entries.map((entry) => ({
      moduleId: IDENTITY.moduleId,
      engineId: IDENTITY.engineId,
      channel: "stable",
      hostContract: "brktrk-synth-gateway-v1",
      abiVersion: "0x00010000",
      packageUrl: `./${entry.version}.tar.gz`,
      packageSha256: entry.packageSha256,
      stateSchemaVersion: 131072,
      parameterSchemaVersion: 1,
      status: "active",
      ...entry,
    })),
  };
}

const clean = project();
const cleanInstrument = clone(clean.instrumentPool[3]);
assert.equal(clean.schemaVersion, 5);
assert.equal(cleanInstrument.engineRef.resolvedVersion, IDENTITY.version);
assert.equal(cleanInstrument.engineRef.resolvedPackageSha256, IDENTITY.packageSha256);

// A real .brktrk save/open round-trip must preserve exact package identity and
// the complete production Instrument state, including opaque engine state.
const firstText = files.serializeProject(clean, {
  unknownEnvelope: { futureOuter: { preserve: true } },
  producer: { app: "A5.3-FIXTURE", version: "1" },
});
const firstOpen = files.prepareOpen(firstText);
assert.deepEqual(firstOpen.project.instrumentPool[3], cleanInstrument, "save/open must preserve the complete production Instrument");
assert.equal(firstOpen.project.instrumentPool[3].engineRef.resolvedPackageSha256, IDENTITY.packageSha256);
assert.equal(firstOpen.project.instrumentPool[3].patchState.data, "A5_3_OPAQUE_PATCH_STATE");
assert.equal(firstOpen.project.instrumentPool[3].presetRef.packageSha256, IDENTITY.packageSha256);
assert.equal(firstOpen.unknownEnvelope.futureOuter.preserve, true);

const secondText = files.serializeProject(firstOpen.project, {
  unknownEnvelope: firstOpen.unknownEnvelope,
  producer: firstOpen.producer,
});
assert.equal(secondText, firstText, "canonical save/open/save must be byte-reproducible when no state changes");
assert.equal(recovery.fingerprint(firstOpen.project), recovery.fingerprint(clean), "reopened project fingerprint must be stable");

// Crash recovery must carry both the last clean production Instrument and the
// newest dirty production Instrument without collapsing opaque/preset state.
const dirty = clone(clean);
dirty.instrumentPool[3].parameterSnapshot.cutoff = 0.875;
dirty.instrumentPool[3].parameterSnapshot.filter_mode = 1;
dirty.instrumentPool[3].patchState.data = "A5_3_DIRTY_OPAQUE_PATCH_STATE";
const journal = recovery.createJournal({
  cleanProject: clean,
  fileName: "a5-3.brktrk",
  bindingMode: "upload",
  unknownEnvelope: { futureOuter: { preserve: true } },
  producer: { app: "A5.3-FIXTURE", version: "1" },
}, dirty, 1787687000000);
assert.ok(journal, "dirty production project must create a recovery journal");
const normalizedJournal = recovery.normalizeJournal(JSON.parse(JSON.stringify(journal)));
assert.deepEqual(normalizedJournal.cleanProject.instrumentPool[3], cleanInstrument, "recovery clean checkpoint must preserve production Instrument state");
assert.equal(normalizedJournal.dirtyProject.instrumentPool[3].engineRef.resolvedPackageSha256, IDENTITY.packageSha256);
assert.equal(normalizedJournal.dirtyProject.instrumentPool[3].patchState.data, "A5_3_DIRTY_OPAQUE_PATCH_STATE");
assert.equal(normalizedJournal.dirtyProject.instrumentPool[3].parameterSnapshot.cutoff, 0.875);
assert.equal(normalizedJournal.dirtyProject.instrumentPool[3].presetRef.packageSha256, IDENTITY.packageSha256);
assert.equal(normalizedJournal.session.fileName, "a5-3.brktrk");
assert.equal(normalizedJournal.session.unknownEnvelope.futureOuter.preserve, true);
assert.equal(recovery.fingerprint(normalizedJournal.dirtyProject), recovery.fingerprint(dirty));

// Exact-pinned reopen must resolve only the exact accepted archive. A newer
// compatible version is not a recovery path for a missing exact package.
const reopenedRef = firstOpen.project.instrumentPool[3].engineRef;
const exactCatalog = catalog([
  { version: IDENTITY.version, packageSha256: IDENTITY.packageSha256 },
  { version: "0.1.0-rc6", packageSha256: OTHER_SHA },
]);
const exact = packages.resolveCatalogEntry(exactCatalog, reopenedRef, { abiVersions: ["0x00010000"] });
assert.ok(exact, "reopened exact pin must resolve when the exact archive exists");
assert.equal(exact.version, IDENTITY.version);
assert.equal(exact.packageSha256, IDENTITY.packageSha256);

const missingExactCatalog = catalog([{ version: "0.1.0-rc6", packageSha256: OTHER_SHA }]);
assert.equal(
  packages.resolveCatalogEntry(missingExactCatalog, reopenedRef, { abiVersions: ["0x00010000"] }),
  null,
  "missing exact archive must not silently repin to a newer compatible package",
);

const sameVersionWrongArchive = catalog([{ version: IDENTITY.version, packageSha256: OTHER_SHA }]);
assert.equal(
  packages.resolveCatalogEntry(sameVersionWrongArchive, reopenedRef, { abiVersions: ["0x00010000"] }),
  null,
  "same semantic version with different archive hash must not satisfy an exact pin",
);
assert.deepEqual(firstOpen.project.instrumentPool[3].engineRef, cleanInstrument.engineRef, "failed package resolution must not mutate persisted engine identity");

console.log("M5A A5.3 production save/open/recovery/exact-pin reproducibility tests passed");
