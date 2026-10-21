const assert = require("node:assert/strict");
const stores = require("./stores.js");
const transportRuntimeState = require("./transport-runtime-state.js");

const model = {
  projectName: "transport",
  tempo: 120,
  song: [],
  chains: {},
  phrases: {},
  instruments: [],
};
const state = {
  view: "song",
  dock: "mix",
  scope: "song",
  playing: false,
  currentSequence: null,
  songRow: 0,
  track: 0,
  chain: 0,
  chainRow: 0,
  phrase: 0,
  phraseRow: 0,
  instrument: 0,
  lastChain: 0,
  lastPhrase: 0,
  focus: { pane: "song", row: 0, col: 0 },
};
const bundle = stores.createStores({ model, state, trackCount: 8 });
const runtime = transportRuntimeState.install(bundle.transport, { trackCount: 8 });

const events = (length) => Array.from({ length }, (_, index) => ({ note: index === 0 ? 60 : null }));
const plan = (shortLength = 16, longLength = 32) => Object.freeze({
  mode: "track-plan",
  scope: "song",
  active: true,
  tracks: Object.freeze([
    Object.freeze({ active: true, events: Object.freeze(events(shortLength)), startIndex: 3 }),
    Object.freeze({ active: true, events: Object.freeze(events(longLength)), startIndex: 17 }),
    ...Array.from({ length: 6 }, () => Object.freeze({ active: false, events: Object.freeze([]), startIndex: 0 })),
  ]),
});

const channels = { transport: 0, status: 0, position: 0, render: 0 };
const changes = [];
for (const channel of Object.keys(channels)) {
  bundle.transport.subscribe(channel, (changeSet) => {
    channels[channel] += 1;
    changes.push({ channel, changeSet });
  });
}

assert.equal(runtime.snapshot().phase, "stopped");
assert.equal(runtime.isPlaying(), false);
assert.equal(state.playing, false);
assert.equal(state.currentSequence, null);

const firstPlan = plan();
const first = runtime.requestStart(firstPlan, { source: "unit-start" });
assert.deepEqual(first.identity, { id: "transport-1", version: 1, mode: "track-plan", scope: "song" });
assert.equal(runtime.snapshot().phase, "starting");
assert.equal(runtime.isPlaying(), true);
assert.equal(state.playing, true, "legacy state.playing must be a Store-owned mirror");
assert.equal(state.currentSequence, firstPlan, "legacy currentSequence must be a Store-owned mirror");
assert.deepEqual(runtime.snapshot().requestedTrackPositions.slice(0, 3), [3, 17, -1]);
assert.equal(channels.transport, 1);
assert.equal(channels.status, 1);
assert.equal(channels.render, 1);

const staleApplied = runtime.acknowledgeApplied({
  transport: { id: "transport-0", version: 0, mode: "track-plan", scope: "song" },
  trackPositions: [0, 0],
});
assert.equal(staleApplied.accepted, false);
assert.equal(staleApplied.stale, true);
assert.equal(runtime.snapshot().phase, "starting");

const applied = runtime.acknowledgeApplied({
  transport: first.identity,
  trackPositions: [3, 17, -1, -1, -1, -1, -1, -1],
}, { source: "unit-applied" });
assert.equal(applied.accepted, true);
assert.equal(runtime.snapshot().phase, "playing");
assert.equal(runtime.snapshot().applied.version, 1);
assert.deepEqual(runtime.snapshot().trackPositions.slice(0, 3), [3, 17, -1]);

const report = runtime.reportStep({
  transport: first.identity,
  index: 14,
  trackSteps: [1, 31, -1, -1, -1, -1, -1, -1],
}, { source: "unit-step" });
assert.equal(report.accepted, true);
assert.equal(runtime.snapshot().globalStep, 14);
assert.deepEqual(runtime.snapshot().trackPositions.slice(0, 3), [1, 31, -1]);
assert.equal(channels.position, 1);

const staleStep = runtime.reportStep({
  transport: { id: "transport-0", version: 0, mode: "track-plan", scope: "song" },
  index: 99,
  trackSteps: [9, 9],
});
assert.equal(staleStep.accepted, false);
assert.equal(runtime.snapshot().globalStep, 14, "stale Worklet reports must not move the Store");
assert.deepEqual(runtime.snapshot().trackPositions.slice(0, 2), [1, 31]);

const updatedPlan = plan(16, 48);
const update = runtime.requestUpdate(updatedPlan, { source: "unit-update" });
assert.deepEqual(update.identity, { id: "transport-2", version: 2, mode: "track-plan", scope: "song" });
assert.equal(runtime.snapshot().phase, "starting");
assert.equal(runtime.snapshot().applied.version, 1, "old applied version remains authoritative until Worklet acknowledgement");
assert.equal(state.currentSequence, updatedPlan);
assert.equal(runtime.snapshot().globalStep, 14);
assert.deepEqual(runtime.snapshot().trackPositions.slice(0, 2), [1, 31]);

const oldDuringUpdate = runtime.reportStep({
  transport: first.identity,
  index: 15,
  trackSteps: [2, 0, -1, -1, -1, -1, -1, -1],
});
assert.equal(oldDuringUpdate.accepted, true, "old applied reports remain valid until the update is acknowledged");
assert.equal(runtime.snapshot().globalStep, 15);

const updatedApplied = runtime.acknowledgeApplied({
  transport: update.identity,
  trackPositions: [2, 32, -1, -1, -1, -1, -1, -1],
});
assert.equal(updatedApplied.accepted, true);
assert.equal(runtime.snapshot().applied.version, 2);
assert.deepEqual(runtime.snapshot().trackPositions.slice(0, 2), [2, 32]);

const staleAfterUpdate = runtime.reportStep({
  transport: first.identity,
  index: 16,
  trackSteps: [3, 1],
});
assert.equal(staleAfterUpdate.accepted, false, "reports from a superseded applied version must be ignored");
assert.equal(runtime.snapshot().globalStep, 15);

const stop = runtime.requestStop({ source: "unit-stop" });
assert.deepEqual(stop.identity, update.identity);
assert.equal(runtime.snapshot().phase, "stopping");
assert.equal(runtime.isPlaying(), false);
assert.equal(state.playing, false);
assert.equal(state.currentSequence, updatedPlan, "program remains available until the Worklet confirms stop");

const staleStopped = runtime.acknowledgeStopped({ transport: first.identity });
assert.equal(staleStopped.accepted, false);
assert.equal(runtime.snapshot().phase, "stopping");

const stopped = runtime.acknowledgeStopped({ transport: update.identity }, { source: "unit-stopped" });
assert.equal(stopped.accepted, true);
assert.equal(runtime.snapshot().phase, "stopped");
assert.equal(runtime.snapshot().playing, false);
assert.equal(runtime.snapshot().globalStep, -1);
assert.deepEqual(runtime.snapshot().trackPositions, Array(8).fill(-1));
assert.equal(state.currentSequence, null);
const repeatedStop = runtime.requestStop({ source: "unit-already-stopped" });
assert.equal(repeatedStop.mutated, false, "stopping an already stopped transport must be a no-op");
assert.equal(runtime.snapshot().phase, "stopped");

const legacyPlan = { scope: "phrase", steps: [{ notes: [] }] };
state.currentSequence = legacyPlan;
state.playing = true;
assert.equal(runtime.getProgram(), legacyPlan, "legacy writes must be routed through the TransportStore compatibility adapter");
assert.equal(runtime.isPlaying(), true);
assert.equal(runtime.snapshot().phase, "starting");
state.playing = false;
state.currentSequence = null;
assert.equal(runtime.snapshot().phase, "stopped");
assert.equal(runtime.getProgram(), null);

runtime.markWorkletReady({ source: "unit-ready" });
assert.equal(runtime.snapshot().worklet.ready, true);
runtime.markWorkletError(new Error("boom"), { source: "unit-error" });
assert.equal(runtime.snapshot().phase, "error");
assert.equal(runtime.snapshot().playing, false);
assert.equal(runtime.snapshot().worklet.error, "boom");

const doomed = runtime.requestStart(legacyPlan, { source: "unit-terminal-start" });
runtime.acknowledgeApplied({ transport: doomed.identity });
assert.equal(runtime.snapshot().applied?.version, doomed.identity.version, "terminal case begins during real playback");
runtime.markWorkletError(new Error("processor died"), { source: "unit-processorerror", terminal: true });
const terminal = runtime.snapshot();
assert.equal(terminal.phase, "error");
assert.equal(terminal.worklet.terminal, true);
assert.equal(terminal.worklet.ready, false);
assert.equal(terminal.worklet.error, "processor died");
assert.equal(runtime.getProgram(), null, "a dead processor cannot hold a playing program");
assert.equal(terminal.applied, null, "scope UI cannot display PLAYING after processorerror");
assert.equal(terminal.requested, null);
assert.equal(terminal.stopRequest, null);
assert.equal(terminal.globalStep, -1);
assert.deepEqual(terminal.trackPositions, Array(8).fill(-1));
assert.equal(runtime.requestStop({ source: "unit-stop-dead-node" }).mutated, false, "Stop cannot wait for an impossible acknowledgement");
assert.equal(runtime.snapshot().phase, "error");
assert.equal(runtime.acknowledgeStopped({ transport: doomed.identity }).accepted, false, "late Worklet messages cannot erase terminal evidence");
assert.equal(runtime.acknowledgeApplied({ transport: doomed.identity }).accepted, false);
assert.equal(runtime.reportStep({ transport: doomed.identity, index: 9 }).accepted, false);
assert.equal(runtime.markWorkletReady().mutated, false);
assert.throws(() => runtime.requestStart(legacyPlan), /reload BRKTRK/);
runtime.markWorkletError(new Error("late init failure"));
assert.equal(runtime.snapshot().worklet.error, "processor died", "a later readiness rejection cannot hide the original processor failure");

assert.ok(changes.some(({ changeSet }) => changeSet.target === "transport.program.start"));
assert.ok(changes.some(({ changeSet }) => changeSet.target === "transport.program.applied"));
assert.ok(changes.some(({ changeSet }) => changeSet.target === "transport.position.report"));
assert.ok(changes.some(({ changeSet }) => changeSet.target === "transport.program.stopped"));
assert.ok(changes.every(({ changeSet }) => changeSet.owner === "transport"));
assert.ok(changes.every(({ changeSet }) => changeSet.persistsProject === false));

// Exercise the actual P3.6 audio-port handler against a real TransportStore.
// Non-fatal Worklet deferral must keep Play/positions and restore the applied
// program; stale messages and a later Stop must never resurrect playback.
{
  const vm = require("node:vm");
  const source = require("node:fs").readFileSync(require.resolve("./p36-transport.js"), "utf8");
  const portBinding = source.slice(source.indexOf("  function bindAudioPort()"), source.indexOf("  // Subscribe before the first init."));
  const testState = { playing: false, currentSequence: null, p36: { queue: "keep" }, queued: "keep" };
  const testStore = stores.createStores({ model: { ...model }, state: testState, trackCount: 8 });
  const live = transportRuntimeState.install(testStore.transport);
  const liveProgram = plan();
  const start = live.requestStart(liveProgram);
  live.acknowledgeApplied({ transport: start.identity });
  live.reportStep({ transport: start.identity, index: 9, trackSteps: [4, 8] });
  const pending = live.requestUpdate(plan(16, 64));
  const calls = { steps: [], pressed: [], statuses: [] };
  const audio = { node: { port: {} }, onStep: (...args) => calls.steps.push(args) };
  const context = vm.createContext({
    audio, state: testState, transportRuntime: live,
    $: () => ({ setAttribute: (...args) => calls.pressed.push(args) }),
    setStatus: (...args) => calls.statuses.push(args), renderAll() {},
  });
  vm.runInContext(`${portBinding}\nbindAudioPort();`, context);
  const deferred = { type: "production-transport-rejected", code: "engine-registry-refresh-boundary", message: "New engine waits for Stop", stoppedTransport: false, deferredUpdate: true, transport: pending.identity, appliedTransport: start.identity };
  audio.node.port.onmessage({ data: deferred });
  assert.equal(live.isPlaying(), true);
  assert.equal(live.snapshot().phase, "playing");
  assert.equal(live.getProgram(), liveProgram);
  assert.equal(live.snapshot().requested.version, start.identity.version);
  assert.equal(live.snapshot().globalStep, 9);
  assert.deepEqual(live.snapshot().trackPositions.slice(0, 2), [4, 8]);
  assert.equal(testState.p36.queue, "keep");
  assert.equal(calls.steps.length, 0);
  assert.equal(calls.pressed.length, 0);
  assert.match(calls.statuses.at(-1)[0], /STOP.*PLAY/);
  const later = live.requestUpdate(plan(16, 96));
  assert.ok(later.identity.version > pending.identity.version, "deferral cannot reuse a transport version");
  audio.node.port.onmessage({ data: deferred });
  assert.equal(live.snapshot().requested.version, later.identity.version, "a stale deferral cannot roll back a newer request");
  assert.equal(live.acknowledgeDeferred({ ...deferred, transport: later.identity, appliedTransport: later.identity }).accepted, false, "the Worklet must confirm the current applied identity");
  live.acknowledgeApplied({ transport: later.identity });
  audio.node.port.onmessage({ data: { ...deferred, deferredUpdate: false, transport: later.identity } });
  assert.equal(live.isPlaying(), true, "a failed compatible-Instrument refresh cannot stop host transport");
  const stop = live.requestStop();
  assert.equal(live.acknowledgeDeferred({ ...deferred, transport: later.identity }).accepted, false);
  live.acknowledgeStopped({ transport: stop.identity });
  audio.node.port.onmessage({ data: deferred });
  assert.equal(live.isPlaying(), false);
  audio.node.port.onmessage({ data: { type: "production-transport-rejected", message: "Fatal fixture", stoppedTransport: true } });
  assert.equal(live.snapshot().phase, "error", "fatal rejections must retain the existing error behavior");
  assert.equal(calls.pressed.at(-1)[1], "false");
}

console.log("TransportStore runtime ownership and non-fatal deferred audio-port tests passed");
