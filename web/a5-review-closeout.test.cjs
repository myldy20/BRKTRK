const assert = require("node:assert/strict");
const stores = require("./stores.js");
const sessionStore = require("./project-file-session-store.js");
const sessionDomain = require("./project-file-session.js");

// An existing journal is not enough to claim recovery retention. The journal
// must represent the latest dirty Project and be in a healthy current state.
assert.equal(sessionDomain.recoveryRetentionConfirmed({ status: "armed", journalPresent: true, lastError: null }), true);
assert.equal(sessionDomain.recoveryRetentionConfirmed({ status: "recovered", journalPresent: true, lastError: null }), true);
assert.equal(sessionDomain.recoveryRetentionConfirmed({ status: "error", journalPresent: true, lastError: "quota" }), false);
assert.equal(sessionDomain.recoveryRetentionConfirmed({ status: "armed", journalPresent: true, lastError: "stale write" }), false);
assert.equal(sessionDomain.recoveryRetentionConfirmed({ status: "armed", journalPresent: false, lastError: null }), false);

// A custom ProjectStore is defined by its public getState()+publish() contract.
// An incidental Map-valued `listeners` field must never make it look like the
// repository's concrete ChannelStore implementation.
{
  const state = { schemaVersion: 4, projectName: "CUSTOM BEFORE", legacyOnly: true };
  const published = [];
  const customStore = {
    listeners: new Map([["private", new Set()]]),
    getState: () => state,
    publish(changeSet, channels) { published.push({ changeSet, channels: [...channels] }); },
  };
  assert.equal(sessionStore.isConcreteChannelStore(customStore), false);
  const result = sessionStore.replaceProjectState(customStore, { schemaVersion: 4, projectName: "CUSTOM AFTER" }, { operation: "open" });
  assert.equal(result.mutated, true);
  assert.deepEqual(result.notificationErrors, []);
  assert.equal(published.length, 1, "custom Map-backed Store must route through public publish exactly once");
  assert.deepEqual(published[0].channels, ["project", "persistence", "audio", "render", "track-mix"]);
  assert.equal(state.projectName, "CUSTOM AFTER");
  assert.equal(Object.hasOwn(state, "legacyOnly"), false);
}

// Proxy traps may legally claim success while leaving configurable properties
// unchanged. The commit boundary must verify the resulting own descriptors and
// roll back before publication when that happens.
{
  const backing = { schemaVersion: 4, projectName: "DELETE BEFORE", legacyOnly: true };
  const proxy = new Proxy(backing, {
    deleteProperty(target, key) {
      if (key === "legacyOnly") return true;
      return Reflect.deleteProperty(target, key);
    },
  });
  let publishCount = 0;
  const store = { getState: () => proxy, publish() { publishCount += 1; } };
  assert.throws(
    () => sessionStore.replaceProjectState(store, { schemaVersion: 4, projectName: "DELETE AFTER" }),
    /Project replacement verification failed/,
  );
  assert.equal(publishCount, 0, "unverified descriptor replacement must fail before publication");
  assert.deepEqual(backing, { schemaVersion: 4, projectName: "DELETE BEFORE", legacyOnly: true });
}

{
  const backing = { schemaVersion: 4, projectName: "DEFINE BEFORE" };
  const proxy = new Proxy(backing, {
    defineProperty(target, key, descriptor) {
      if (key === "newOnly") return true;
      return Reflect.defineProperty(target, key, descriptor);
    },
  });
  let publishCount = 0;
  const store = { getState: () => proxy, publish() { publishCount += 1; } };
  assert.throws(
    () => sessionStore.replaceProjectState(store, { schemaVersion: 4, projectName: "DEFINE AFTER", newOnly: 7 }),
    /Project replacement verification failed/,
  );
  assert.equal(publishCount, 0);
  assert.deepEqual(backing, { schemaVersion: 4, projectName: "DEFINE BEFORE" });
}

// Repository Stores are intentionally recognized as concrete so their
// post-commit listener fanout can isolate one broken subscriber.
{
  const model = { schemaVersion: 4, projectName: "REAL", tracks: [], instrumentPool: {} };
  const navigation = { view: "phrase", focus: { pane: "phrase", row: 0, col: 0 }, p3: { activeWorkspace: "phrase", parents: [] } };
  const bundle = stores.createStores({ model, state: navigation, trackCount: 0 });
  assert.equal(sessionStore.isConcreteChannelStore(bundle.project), true);
  assert.equal(sessionStore.isConcreteChannelStore(bundle.navigation), true);
}

console.log("A5 review-closeout safety regressions passed");
