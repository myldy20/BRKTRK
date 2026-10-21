const assert = require("node:assert/strict");
const stores = require("./stores.js");
const sessionStore = require("./project-file-session-store.js");

function project(name = "ONE") {
  const value = {
    schemaVersion: 3,
    projectName: name,
    tempo: 120,
    tracks: Array.from({ length: 8 }, (_, id) => ({ id, mix: { gain: 1, mute: false, pan: 0 } })),
    song: Array.from({ length: 64 }, () => Array(8).fill(-1)),
    chains: { 7: Array.from({ length: 16 }, (_, row) => ({ phrase: row === 2 ? 9 : -1, transpose: 0 })) },
    phrases: { 9: Array.from({ length: 16 }, () => ({ note: -1, velocity: 100, instrument: -1, fx: Array.from({ length: 3 }, () => ({ command: 0, value: 0 })) })) },
    compatibilityExtensions: {},
    unknownData: [],
  };
  value.song[4][3] = 7;
  Object.defineProperty(value, "instruments", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: [{ params: [1, 2, 3, 4, 5, 6] }],
  });
  return value;
}

function navigationState() {
  return {
    view: "song",
    dock: "sound",
    songRow: 22,
    track: 6,
    chain: 1,
    chainRow: 8,
    phrase: 2,
    phraseRow: 9,
    instrument: 5,
    focus: { pane: "song", row: 22, col: 6 },
    lastChain: 1,
    lastPhrase: 2,
    p3: {
      activeWorkspace: "song",
      soundParam: 4,
      parents: [{ view: "song", activeWorkspace: "song", focus: { pane: "song", row: 1, col: 1 } }],
      mixReturn: { view: "phrase", activeWorkspace: "phrase", focus: { pane: "phrase", row: 3, col: 0 } },
      activeSheet: "note",
    },
  };
}

const model = project("ONE");
const state = navigationState();
const bundle = stores.createStores({ model, state, trackCount: 8 });
sessionStore.install(bundle.project, bundle.navigation);

let projectChange = null;
let navigationChange = null;
bundle.project.subscribe("project", (change) => { projectChange = change; });
bundle.navigation.subscribe("navigation", (change) => { navigationChange = change; });

const replacement = project("TWO");
Object.defineProperty(replacement, "__proto__", {
  configurable: true,
  enumerable: true,
  writable: true,
  value: { keep: true },
});
const identity = model;
const result = bundle.project.fileSession.replaceProject(replacement, { operation: "open", fileName: "two.brktrk" });
assert.equal(model, identity, "whole-project replacement must preserve ProjectStore object identity");
assert.equal(model.projectName, "TWO");
assert.equal(model.instruments[0].params[1], 2);
assert.equal(Object.keys(model).includes("instruments"), false, "runtime preview Instruments must remain non-enumerable");
assert.equal(Object.hasOwn(model, "__proto__"), true, "unknown project keys must remain own data");
assert.deepEqual(model.__proto__, { keep: true });
assert.equal(Object.getPrototypeOf(model), Object.prototype, "unknown project data must not pollute the object prototype");
assert.equal(result.projectChangeSet.target, "project.file.replace");
assert.deepEqual(result.notificationErrors, []);
assert.equal(projectChange.target, "project.file.replace");
assert.equal(projectChange.transaction.operation, "open");

const reset = bundle.navigation.fileSession.resetForProject(model, { operation: "open" });
assert.equal(state.view, "phrase");
assert.equal(state.p3.activeWorkspace, "phrase");
assert.equal(state.dock, "none", "opening or creating a Project must retain the full tracker default");
assert.deepEqual(state.focus, { pane: "phrase", row: 0, col: 0 });
assert.equal(state.songRow, 4);
assert.equal(state.track, 3);
assert.equal(state.chain, 7);
assert.equal(state.chainRow, 2);
assert.equal(state.phrase, 9);
assert.equal(state.p3.parents.length, 0);
assert.equal(state.p3.mixReturn, null);
assert.equal(state.p3.activeSheet, null);
assert.equal(reset.navigationChangeSet.target, "navigation.projectReset");
assert.deepEqual(reset.notificationErrors, []);
assert.equal(navigationChange.target, "navigation.projectReset");
assert.equal(navigationChange.persistsProject, false);

// Replacement/reset are commit boundaries. A broken post-commit subscriber may
// be observable, but it must not make the already-replaced Project look failed
// or prevent later subscribers from observing the same committed state.
{
  const committedModel = project("BEFORE");
  const committedState = navigationState();
  const committed = stores.createStores({ model: committedModel, state: committedState, trackCount: 8 });
  sessionStore.install(committed.project, committed.navigation);
  const delivered = [];

  committed.project.subscribe("project", () => { throw new Error("project listener fixture failure"); });
  committed.project.subscribe("project", (_change, live) => delivered.push(`project:${live.projectName}`));
  committed.navigation.subscribe("navigation", () => { throw new Error("navigation listener fixture failure"); });
  committed.navigation.subscribe("navigation", () => delivered.push(`navigation:${committedState.view}`));

  let projectMutation = null;
  assert.doesNotThrow(() => {
    projectMutation = committed.project.fileSession.replaceProject(project("AFTER"), { operation: "open" });
  });
  assert.equal(committedModel.projectName, "AFTER", "subscriber failure must not roll back or disguise a committed Project replacement");
  assert.equal(projectMutation.notificationErrors.length, 1);
  assert.equal(projectMutation.notificationErrors[0].channel, "project");
  assert.equal(projectMutation.notificationErrors[0].message, "project listener fixture failure");
  assert.deepEqual(delivered, ["project:AFTER"], "later Project subscribers must still observe the committed replacement");

  let navigationMutation = null;
  assert.doesNotThrow(() => {
    navigationMutation = committed.navigation.fileSession.resetForProject(committedModel, { operation: "open" });
  });
  assert.equal(committedState.view, "phrase");
  assert.equal(navigationMutation.notificationErrors.length, 1);
  assert.equal(navigationMutation.notificationErrors[0].channel, "navigation");
  assert.equal(navigationMutation.notificationErrors[0].message, "navigation listener fixture failure");
  assert.deepEqual(delivered, ["project:AFTER", "navigation:phrase"], "later Navigation subscribers must still observe the committed reset");
}

// A custom ProjectStore that implements the documented getState()+publish()
// contract must still receive the replacement notification without exposing
// ChannelStore internals or emit().
{
  const customModel = project("CUSTOM-BEFORE");
  const calls = [];
  const customStore = {
    getState: () => customModel,
    publish(changeSet, channels) { calls.push({ changeSet, channels: [...channels] }); },
  };
  const mutation = sessionStore.replaceProjectState(customStore, project("CUSTOM-AFTER"), { operation: "open" });
  assert.equal(customModel.projectName, "CUSTOM-AFTER");
  assert.equal(calls.length, 1, "publish-only ProjectStore must retain its public notification path");
  assert.equal(calls[0].changeSet.target, "project.file.replace");
  assert.deepEqual(calls[0].channels, ["project", "persistence", "audio", "render", "track-mix"]);
  assert.deepEqual(mutation.notificationErrors, []);
}

// Diagnostic extraction itself must be unable to interrupt committed fanout,
// even when the thrown value exposes hostile name/message accessors.
{
  const hostileModel = project("HOSTILE-BEFORE");
  const hostileState = navigationState();
  const hostileBundle = stores.createStores({ model: hostileModel, state: hostileState, trackCount: 8 });
  sessionStore.install(hostileBundle.project, hostileBundle.navigation);
  const delivered = [];
  const hostileThrown = {};
  Object.defineProperty(hostileThrown, "name", { get() { throw new Error("name getter exploded"); } });
  Object.defineProperty(hostileThrown, "message", { get() { throw new Error("message getter exploded"); } });
  Object.defineProperty(hostileThrown, "toString", { value() { throw new Error("toString exploded"); } });

  hostileBundle.project.subscribe("project", () => { throw hostileThrown; });
  hostileBundle.project.subscribe("project", (_change, live) => delivered.push(live.projectName));
  let mutation = null;
  assert.doesNotThrow(() => { mutation = hostileBundle.project.fileSession.replaceProject(project("HOSTILE-AFTER"), { operation: "open" }); });
  assert.equal(hostileModel.projectName, "HOSTILE-AFTER");
  assert.equal(mutation.notificationErrors.length, 1);
  assert.equal(mutation.notificationErrors[0].channel, "project");
  assert.equal(mutation.notificationErrors[0].name, "Error");
  assert.equal(mutation.notificationErrors[0].message, "Unknown subscriber failure");
  assert.deepEqual(delivered, ["HOSTILE-AFTER"], "hostile diagnostic fields must not skip later subscribers");
}

// If a proxy rejects one pre-commit field deletion, the replacement must fail
// before publication and restore the original descriptor set rather than
// silently merging stale fields with the incoming Project.
{
  const raw = project("PROXY-BEFORE");
  raw.legacyOnly = { preserveUntilCommit: true };
  const before = JSON.stringify(raw);
  let rejectTempoDeleteOnce = true;
  const proxy = new Proxy(raw, {
    deleteProperty(target, key) {
      if (key === "tempo" && rejectTempoDeleteOnce) {
        rejectTempoDeleteOnce = false;
        return false;
      }
      return Reflect.deleteProperty(target, key);
    },
  });
  let publishCalls = 0;
  const customStore = {
    getState: () => proxy,
    publish() { publishCalls += 1; },
  };
  assert.throws(
    () => sessionStore.replaceProjectState(customStore, project("PROXY-AFTER"), { operation: "open" }),
    /Could not clear project field tempo/,
  );
  assert.equal(JSON.stringify(raw), before, "pre-commit deletion failure must restore the exact prior enumerable Project data");
  assert.equal(raw.projectName, "PROXY-BEFORE");
  assert.equal(Object.hasOwn(raw, "legacyOnly"), true);
  assert.equal(publishCalls, 0, "failed pre-commit replacement must not publish a committed Project change");
}

console.log("A2 project replacement commit/error-isolation tests passed");
