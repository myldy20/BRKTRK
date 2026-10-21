const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(__dirname + "/audio-lifecycle.js", "utf8");
const lifecycleEvents = [];
const documentListeners = new Map();
const windowListeners = new Map();
const contextListeners = new Map();
let readinessListener = null;
let canonicalReady = false;

const context = {
  state: "running",
  addEventListener(type, listener) { contextListeners.set(type, listener); },
};
const audio = {
  context,
  async init() {},
};
const lifecycleDomain = {
  install(_store, initial) {
    assert.equal(initial.contextState, "running");
    return {
      report(event, metadata) {
        lifecycleEvents.push({ event: { ...event }, metadata: { ...metadata } });
        return event;
      },
      snapshot() { return lifecycleEvents.at(-1)?.event ?? null; },
    };
  },
};
const readiness = {
  snapshot() { return { ready: canonicalReady }; },
  subscribe(listener) {
    readinessListener = listener;
    return () => { if (readinessListener === listener) readinessListener = null; };
  },
};
const document = {
  visibilityState: "visible",
  body: { dataset: {} },
  addEventListener(type, listener) { documentListeners.set(type, listener); },
};
const window = {
  addEventListener(type, listener) { windowListeners.set(type, listener); },
};
const sandbox = {
  console,
  audio,
  document,
  window,
  BRKTRKAudioReadiness: readiness,
  BRKTRKAudioLifecycleDomain: lifecycleDomain,
  BRKTRKStores: { transport: {} },
};
sandbox.globalThis = sandbox;
vm.runInNewContext(source, sandbox, { filename: "audio-lifecycle.js" });

const eventTypes = () => lifecycleEvents.map((entry) => entry.event.type);
const contextRunningCount = () => lifecycleEvents.filter((entry) => entry.event.type === "CONTEXT_STATE" && entry.event.contextState === "running").length;

assert.ok(sandbox.BRKTRKAudioLifecycle, "audio lifecycle integration must install");
assert.equal(contextRunningCount(), 0, "raw running context at install must not publish lifecycle READY before canonical readiness");
assert.ok(eventTypes().includes("INIT_REQUEST"), "already-running but canonically unready graph must present pending readiness at install");

contextListeners.get("statechange")?.();
assert.equal(contextRunningCount(), 0, "running statechange must remain suppressed while canonical readiness is false");

documentListeners.get("visibilitychange")?.();
windowListeners.get("pageshow")?.({ persisted: false });
assert.equal(contextRunningCount(), 0, "visibility/pageshow context snapshots must not bypass canonical readiness");

readinessListener?.({ type: "existing-failed", error: "package proof failed", source: "fixture-revalidation" });
assert.equal(lifecycleEvents.at(-1)?.event.type, "INIT_FAILED", "existing-graph package revalidation failure must enter lifecycle error path");
assert.equal(lifecycleEvents.at(-1)?.event.error, "package proof failed");

readinessListener?.({ type: "existing-request", source: "fixture-retry" });
assert.equal(lifecycleEvents.at(-1)?.event.type, "INIT_REQUEST", "existing-graph revalidation retry must leave lifecycle error/ready state");

canonicalReady = true;
readinessListener?.({ type: "ready", source: "fixture-ready" });
assert.equal(lifecycleEvents.at(-1)?.event.type, "INIT_READY", "only canonical readiness may publish lifecycle ready");
assert.equal(lifecycleEvents.at(-1)?.event.contextState, "running");

contextListeners.get("statechange")?.();
assert.equal(contextRunningCount(), 1, "running context state may be reported after canonical readiness is true");

canonicalReady = false;
readinessListener?.({ type: "invalidated", source: "fixture-project-change", reason: "project-structure-changed" });
assert.equal(lifecycleEvents.at(-1)?.event.type, "INIT_REQUEST", "canonical invalidation must immediately revoke lifecycle READY presentation");
assert.equal(lifecycleEvents.at(-1)?.metadata.source, "fixture-project-change");
const runningBeforeInvalidatedSnapshot = contextRunningCount();
contextListeners.get("statechange")?.();
assert.equal(contextRunningCount(), runningBeforeInvalidatedSnapshot, "raw running context must stay suppressed after explicit readiness invalidation");

readinessListener?.({ type: "existing-request", source: "fixture-revalidate-again" });
const runningBefore = contextRunningCount();
contextListeners.get("statechange")?.();
assert.equal(contextRunningCount(), runningBefore, "later revalidation must suppress raw running state until a new canonical proof succeeds");

readinessListener?.({ type: "terminal-failed", error: "reload BRKTRK to restore audio", source: "fixture-processorerror" });
assert.equal(lifecycleEvents.at(-1)?.event.type, "INIT_FAILED", "a dead processor must make the visible audio lifecycle fail");
assert.match(lifecycleEvents.at(-1)?.event.error, /reload BRKTRK/);

console.log("Audio lifecycle canonical readiness gating tests passed");
