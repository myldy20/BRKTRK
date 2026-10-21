const assert = require("node:assert/strict");
const stores = require("./stores.js");
const runtimeState = require("./transport-runtime-state.js");
const queueState = require("./i1-transport-domain.js");

const model = { projectName: "queue", tempo: 120, song: [], chains: {}, phrases: {}, instruments: [] };
const state = {
  view: "phrase",
  dock: "mix",
  scope: "phrase",
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
  focus: { pane: "phrase", row: 0, col: 0 },
};
const bundle = stores.createStores({ model, state, trackCount: 8 });
const runtime = runtimeState.install(bundle.transport, { trackCount: 8 });
const queue = queueState.install(bundle.transport, runtime);

const sequence = (scope, note) => Object.freeze({
  mode: "sequence",
  scope,
  steps: Object.freeze([{ notes: Object.freeze([note]) }]),
});
const events = [];
bundle.transport.subscribe("transport", (changeSet) => events.push(changeSet));

const phrase = sequence("phrase", 60);
const start = runtime.requestStart(phrase, { source: "queue-test-start" });
runtime.acknowledgeApplied({ transport: start.identity, trackPositions: Array(8).fill(-1) });
assert.equal(runtime.snapshot().applied.scope, "phrase");
assert.equal(queue.snapshot().queued, null);

const chain = sequence("chain", 62);
const firstQueue = queue.requestQueue(chain, {
  source: "queue-test-chain",
  boundary: { kind: "phrase", track: 0, requestedAfter: 7 },
  request: { scope: "chain", songRow: 0, track: 0, chainId: 4, chainRow: 1, phraseId: 2, explicit: true },
});
assert.equal(firstQueue.descriptor.id, "queue-1");
assert.equal(firstQueue.descriptor.scope, "chain");
assert.equal(firstQueue.descriptor.boundary.requestedAfter, 7);
assert.equal(runtime.snapshot().applied.version, start.identity.version, "queueing must not replace the applied transport program");
assert.equal(runtime.getProgram(), phrase, "queueing must not mutate the Store-backed current program mirror");

const song = Object.freeze({
  mode: "track-plan",
  scope: "song",
  active: true,
  tracks: Object.freeze([
    Object.freeze({ active: true, events: Object.freeze([{ note: 64 }]), startIndex: 0 }),
    ...Array.from({ length: 7 }, () => Object.freeze({ active: false, events: Object.freeze([]), startIndex: 0 })),
  ]),
});
const replacement = queue.requestQueue(song, {
  source: "queue-test-song",
  boundary: { kind: "phrase", track: 0, requestedAfter: 9 },
  request: { scope: "song", songRow: 3, track: 0, chainId: 8, chainRow: 0, phraseId: 5, explicit: true },
});
assert.equal(replacement.descriptor.id, "queue-2");
assert.equal(queue.snapshot().queued.scope, "song", "latest explicit scope request must replace the previous queue");
assert.equal(queue.getQueuedProgram(), song);

const committed = queue.commitQueue({ source: "queue-test-commit" });
assert.equal(committed.committed, true);
assert.equal(committed.descriptor.id, "queue-2", "commit must consume the exact queued request");
assert.equal(queue.snapshot().queued, null);
assert.equal(committed.request.identity.version, start.identity.version + 1, "queue commit must enter the versioned TransportStore update lifecycle");
assert.equal(runtime.snapshot().phase, "starting");
assert.equal(runtime.snapshot().applied.scope, "phrase", "old applied scope remains authoritative until Worklet acknowledgement");
assert.equal(runtime.snapshot().requested.scope, "song");
assert.equal(runtime.getProgram(), song);

const oldStep = runtime.reportStep({ transport: start.identity, index: 8, trackSteps: Array(8).fill(-1) });
assert.equal(oldStep.accepted, true, "old applied Worklet reports remain valid while the queued update is awaiting acknowledgement");
const applied = runtime.acknowledgeApplied({
  transport: committed.request.identity,
  trackPositions: [0, -1, -1, -1, -1, -1, -1, -1],
});
assert.equal(applied.accepted, true);
assert.equal(runtime.snapshot().applied.scope, "song");
assert.equal(runtime.snapshot().applied.version, committed.request.identity.version);

queue.requestQueue(chain, {
  source: "queue-test-cancel",
  boundary: { kind: "phrase", track: 0, requestedAfter: 10 },
  request: { scope: "chain", explicit: true },
});
const cancelled = queue.cancelQueue({ source: "queue-test-cancelled" });
assert.equal(cancelled.mutated, true);
assert.equal(queue.snapshot().queued, null);
assert.equal(queue.cancelQueue().mutated, false, "cancelling an empty queue must be a no-op");

assert.ok(events.some((change) => change.target === "transport.program.queue"));
assert.ok(events.some((change) => change.target === "transport.program.queue-replace"));
assert.ok(events.some((change) => change.target === "transport.program.queue-commit"));
assert.ok(events.some((change) => change.target === "transport.program.queue-cancel"));
assert.ok(events.every((change) => change.owner === "transport"));
assert.ok(events.every((change) => change.persistsProject === false));

console.log("I1 TransportStore queue lifecycle tests passed");
