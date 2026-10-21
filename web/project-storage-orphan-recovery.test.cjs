const assert = require("node:assert/strict");
require("./production-instrument-domain.js");
const storageDomain = require("./project-storage.js");

class MemoryStorage {
  constructor(entries = {}) {
    this.map = new Map(Object.entries(entries));
  }
  getItem(key) {
    return this.map.has(String(key)) ? this.map.get(String(key)) : null;
  }
  setItem(key, value) {
    this.map.set(String(key), String(value));
  }
  removeItem(key) {
    this.map.delete(String(key));
  }
}

class RecoveryReverificationFailureStorage extends MemoryStorage {
  constructor(entries = {}) {
    super(entries);
    this.corruptRecoveryRestage = true;
  }
  setItem(key, value) {
    if (this.corruptRecoveryRestage && String(key) === storageDomain.STAGING_KEY) {
      this.corruptRecoveryRestage = false;
      return super.setItem(key, "{recovery-restage-corrupted");
    }
    return super.setItem(key, value);
  }
}

function canonicalProject(tempo) {
  return storageDomain.migrateProject({
    schemaVersion: 3,
    projectName: "ORPHAN REVERIFY",
    tempo,
    song: [],
    chains: {},
    phrases: {},
    tracks: [],
  }).project;
}

// An orphan value that parses/migrates successfully is still not copied directly
// over a valid canonical Project. reconcileOrphanStaging() routes it back through
// writeCanonical(), which must restage + exact-read verify before canonical write.
// If that fresh verification fails, recovery is fail-closed and canonical bytes
// remain untouched for the next session / user-directed recovery path.
{
  const oldRaw = JSON.stringify(canonicalProject(121));
  const orphanRaw = JSON.stringify(canonicalProject(199));
  const store = new RecoveryReverificationFailureStorage({
    [storageDomain.STORAGE_KEY]: oldRaw,
    [storageDomain.STAGING_KEY]: orphanRaw,
  });

  const status = storageDomain.bootstrapStorage(store, { now: 35301 });

  assert.equal(status.kind, "staging-recovery-failed");
  assert.equal(status.errorCode, "BRKTRK_STAGING_VERIFY_FAILED");
  assert.equal(status.canonicalPreserved, true);
  assert.equal(status.stagingPresent, true);
  assert.equal(
    store.getItem(storageDomain.STORAGE_KEY),
    oldRaw,
    "an orphan candidate that fails fresh staging verification must never replace valid canonical bytes",
  );
  assert.equal(
    JSON.parse(store.getItem(storageDomain.STORAGE_KEY)).tempo,
    121,
    "fail-closed bootstrap must keep the previous canonical Project authoritative",
  );
}

console.log("Project orphan staging recovery re-verification fail-closed test passed");
