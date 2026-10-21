const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");

const source = readFileSync(require.resolve("./track-mix-runtime.js"), "utf8");
const projectMix = Array.from({ length: 8 }, (_, track) => ({
  gain: track === 0 ? 0.125 : track === 1 ? 0.42 : 1,
  mute: track === 1,
  pan: track === 2 ? -0.4 : 0,
}));
const signals = {};
const project = {
  subscribe(channel, callback) {
    assert.equal(channel, "track-mix");
    signals.project = callback;
    return () => { delete signals.project; };
  },
};
const readiness = {
  subscribe(callback) {
    signals.ready = callback;
    return () => { delete signals.ready; };
  },
};
function makePort() {
  const listeners = [];
  const messages = [];
  return {
    messages, starts: 0,
    addEventListener(type, callback) {
      assert.equal(type, "message");
      listeners.push(callback);
    },
    start() { this.starts++; },
    postMessage(message) { messages.push(message); },
    acknowledge(revision) {
      for (const listener of listeners) {
        listener({ data: { type: "track-mix-applied", revision } });
      }
    },
  };
}
const portA = makePort();
const audio = { ready: true, node: { port: portA } };
const mixer = { dataset: {} };
const queued = [];
const sandbox = {
  BRKTRKStores: { project },
  BRKTRKTrackMix: {
    snapshot: () => projectMix.map((entry) => ({ ...entry })),
  },
  BRKTRKAudioReadiness: readiness,
  audio,
  queueMicrotask: (callback) => queued.push(callback),
  document: {
    body: { dataset: {} },
    querySelector(selector) {
      assert.equal(selector, "#mixer");
      return mixer;
    },
  },
};
vm.runInNewContext(source, sandbox, { filename: "track-mix-runtime.js" });
const runtime = sandbox.BRKTRKTrackMixRuntime;
assert.equal(runtime.installed, true);
function flush() {
  while (queued.length) queued.shift()();
}
function last(port) {
  return port.messages.at(-1);
}

// Initial audio readiness must publish all eight Project-owned Track bus levels.
flush();
const first = last(portA);
assert.equal(first.type, "track-mix");
assert.equal(first.tracks.length, 8);
assert.equal(first.tracks[0].gain, 0.125);
assert.equal(first.tracks[1].gain, 0.42);
assert.equal(first.tracks[1].mute, true);
assert.equal(first.tracks[2].pan, -0.4);
assert.equal(runtime.snapshot().pending, true);
portA.acknowledge(first.revision);
assert.equal(runtime.snapshot().pending, false);

// A live Project change must update the Worklet without changing Project identity.
projectMix[0].gain = 0.27;
signals.project({ source: "mix-restart-fixture", transaction: { track: 0 } });
const changed = last(portA);
assert.equal(changed.tracks[0].gain, 0.27);
portA.acknowledge(changed.revision);
assert.equal(runtime.snapshot().pending, false);

// Replace AudioWorklet/AudioContext. A new port has no mixer state; the ready
// event must replay the *Project's current* mix, not a stale default snapshot.
const portB = makePort();
audio.node = { port: portB };
signals.ready({ type: "ready", source: "new-audio-context" });
flush();
const rebound = last(portB);
assert.ok(rebound, "new Worklet must receive Project mix after restart");
assert.equal(rebound.tracks[0].gain, 0.27);
assert.equal(rebound.tracks[1].mute, true);
assert.equal(rebound.tracks[2].pan, -0.4);
assert.equal(runtime.snapshot().bound, true);
assert.equal(runtime.snapshot().pending, true);
assert.ok(rebound.revision > changed.revision);

// The old Worklet can report a late acknowledgement; it must not clear
// pending state for the replacement Worklet's newer requested revision.
portA.acknowledge(changed.revision);
assert.equal(runtime.snapshot().pending, true);
portB.acknowledge(rebound.revision);
assert.equal(runtime.snapshot().pending, false);
assert.equal(mixer.dataset.mixPending, "false");

// Changes during unavailable audio remain Project-owned and get replayed when
// a third replacement Worklet reports ready; they must not be silently lost.
audio.ready = false;
projectMix[0].gain = 0.08;
signals.project({ source: "editing-while-audio-off", transaction: { track: 0 } });
assert.equal(portB.messages.length, 1, "offline edits may not message retired node");
const portC = makePort();
audio.node = { port: portC };
audio.ready = true;
signals.ready({ type: "ready", source: "third-audio-context" });
flush();
const restored = last(portC);
assert.ok(restored && restored.revision > rebound.revision);
assert.equal(restored.tracks[0].gain, 0.08);
assert.equal(restored.tracks[1].gain, 0.42);
assert.equal(runtime.snapshot().pending, true);
portC.acknowledge(restored.revision);
assert.equal(runtime.snapshot().pending, false);

runtime.disconnect();
assert.equal(signals.project, undefined);
assert.equal(signals.ready, undefined);
console.log("Track Mixer Project gain reapply across AudioWorklet restarts passed");
