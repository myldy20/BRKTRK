const assert = require("node:assert/strict");
const stores = require("./stores.js");
const transportRuntimeState = require("./transport-runtime-state.js");

function createRuntime() {
  const model = { projectName: "stress", tempo: 120, song: [], chains: {}, phrases: {}, instruments: [] };
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
  return { state, runtime: transportRuntimeState.install(bundle.transport, { trackCount: 8 }) };
}

const events = (length, note) => Object.freeze(Array.from({ length }, (_, index) => Object.freeze({ note: index === 0 ? note : null })));
const plan = (seed = 0) => Object.freeze({
  mode: "track-plan",
  scope: "song",
  active: true,
  tracks: Object.freeze([
    Object.freeze({ active: true, events: events(16, 60 + (seed % 4)), startIndex: seed % 16 }),
    Object.freeze({ active: true, events: events(32, 67 + (seed % 4)), startIndex: seed % 32 }),
    ...Array.from({ length: 6 }, () => Object.freeze({ active: false, events: Object.freeze([]), startIndex: 0 })),
  ]),
});

{
  const { state, runtime } = createRuntime();
  for (let cycle = 0; cycle < 50; cycle += 1) {
    const start = runtime.requestStart(plan(cycle), { source: `stress-start-${cycle}` });
    assert.equal(runtime.snapshot().phase, "starting");
    assert.equal(state.playing, true);

    const applied = runtime.acknowledgeApplied({
      transport: start.identity,
      trackPositions: [cycle % 16, cycle % 32, -1, -1, -1, -1, -1, -1],
    }, { source: `stress-applied-${cycle}` });
    assert.equal(applied.accepted, true);
    assert.equal(runtime.snapshot().phase, "playing");

    const step = runtime.reportStep({
      transport: start.identity,
      index: cycle,
      trackSteps: [cycle % 16, cycle % 32, -1, -1, -1, -1, -1, -1],
    }, { source: `stress-step-${cycle}` });
    assert.equal(step.accepted, true);

    const stop = runtime.requestStop({ source: `stress-stop-${cycle}` });
    assert.equal(runtime.snapshot().phase, "stopping");
    assert.equal(state.playing, false);
    const stopped = runtime.acknowledgeStopped({ transport: stop.identity }, { source: `stress-stopped-${cycle}` });
    assert.equal(stopped.accepted, true);
    assert.equal(runtime.snapshot().phase, "stopped");
    assert.equal(runtime.getProgram(), null);
    assert.equal(state.currentSequence, null);
  }
  assert.equal(runtime.snapshot().version, 50, "each restart must receive a fresh monotonically increasing version");
}

{
  const { runtime } = createRuntime();
  const first = runtime.requestStart(plan(1), { source: "race-first-start" });
  runtime.acknowledgeApplied({ transport: first.identity, trackPositions: [0, 0] });
  const firstStop = runtime.requestStop({ source: "race-first-stop" });

  const second = runtime.requestStart(plan(2), { source: "race-second-start" });
  assert.ok(second.identity.version > first.identity.version);
  assert.equal(runtime.snapshot().phase, "starting");

  const staleStop = runtime.acknowledgeStopped({ transport: firstStop.identity }, { source: "race-stale-stop" });
  assert.equal(staleStop.accepted, false, "an old stop acknowledgement must not stop the newest start");
  assert.equal(staleStop.stale, true);
  assert.equal(runtime.snapshot().requested.version, second.identity.version);

  const secondApplied = runtime.acknowledgeApplied({ transport: second.identity, trackPositions: [0, 0] });
  assert.equal(secondApplied.accepted, true);
  assert.equal(runtime.snapshot().phase, "playing");

  const staleStep = runtime.reportStep({ transport: first.identity, index: 99, trackSteps: [3, 3] });
  assert.equal(staleStep.accepted, false, "the first program must not move the restarted transport");

  const secondStop = runtime.requestStop({ source: "race-second-stop" });
  const secondStopped = runtime.acknowledgeStopped({ transport: secondStop.identity });
  assert.equal(secondStopped.accepted, true);
  assert.equal(runtime.snapshot().phase, "stopped");
}

{
  const { runtime } = createRuntime();
  const start = runtime.requestStart(plan(3), { source: "update-stop-start" });
  runtime.acknowledgeApplied({ transport: start.identity, trackPositions: [1, 1] });
  const update = runtime.requestUpdate(plan(4), { source: "pending-update" });
  const stop = runtime.requestStop({ source: "stop-pending-update" });
  assert.deepEqual(stop.identity, update.identity, "stop must target the newest requested version");
  const restart = runtime.requestStart(plan(5), { source: "restart-after-pending-update" });
  assert.equal(runtime.acknowledgeApplied({ transport: update.identity, trackPositions: [2, 2] }).accepted, false);
  assert.equal(runtime.acknowledgeStopped({ transport: stop.identity }).accepted, false);
  assert.equal(runtime.acknowledgeApplied({ transport: restart.identity, trackPositions: [0, 0] }).accepted, true);
  assert.equal(runtime.snapshot().phase, "playing");
}

console.log("Transport lifecycle stress tests passed");
