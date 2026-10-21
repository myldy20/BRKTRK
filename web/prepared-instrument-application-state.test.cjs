const assert = require("node:assert/strict");
const stores = require("./stores.js");
const applicationState = require("./prepared-instrument-application-state.js");

const model = { projectName: "prepared-status", tempo: 120, instrumentPool: {} };
const state = { view: "sound", dock: "sound", playing: true, currentSequence: null, focus: { pane: "phrase", row: 0, col: 0 } };
const bundle = stores.createStores({ model, state, trackCount: 8 });
const domain = applicationState.install(bundle.transport);
assert.equal(applicationState.install(bundle.transport), domain, "install must be idempotent on TransportStore");

const events = [];
for (const channel of ["transport", "status", "render"]) {
  bundle.transport.subscribe(channel, (changeSet) => events.push({ channel, changeSet }));
}

const request1 = domain.request({ instrumentId: 3, commitId: 1, desiredPresetId: "factory-a" }, { source: "unit-request-1" });
assert.equal(request1.accepted, true);
assert.deepEqual({ ...domain.get(3) }, {
  instrumentId: 3,
  commitId: 1,
  state: "requested",
  desiredPresetId: "factory-a",
  code: null,
  reason: null,
  supersededCommitId: null,
});

for (const next of ["queued", "applying", "applied"]) {
  const result = domain.acknowledge({ state: next, instrumentId: 3, commitId: 1, desiredPresetId: "factory-a" }, { source: `unit-${next}` });
  assert.equal(result.accepted, true);
  assert.equal(domain.get(3).state, next);
}

const terminalRegression = domain.acknowledge({ state: "failed", instrumentId: 3, commitId: 1, code: "late-failure" });
assert.equal(terminalRegression.accepted, false, "terminal applied state must reject later contradictory failure");
assert.equal(terminalRegression.regressive, true);
assert.equal(domain.get(3).state, "applied");

const request2 = domain.request({ instrumentId: 3, commitId: 2, desiredPresetId: "factory-b" }, { source: "unit-request-2" });
assert.equal(request2.accepted, true);
assert.equal(domain.get(3).supersededCommitId, 1);
assert.equal(domain.get(3).state, "requested");

const staleOldAck = domain.acknowledge({ state: "applied", instrumentId: 3, commitId: 1, desiredPresetId: "factory-a" });
assert.equal(staleOldAck.accepted, false, "older Worklet acknowledgement must not overwrite latest desired commit");
assert.equal(staleOldAck.stale, true);
assert.equal(domain.get(3).commitId, 2);

assert.equal(domain.acknowledge({ state: "queued", instrumentId: 3, commitId: 2 }).accepted, true);
assert.equal(domain.acknowledge({ state: "applying", instrumentId: 3, commitId: 2 }).accepted, true);
const regression = domain.acknowledge({ state: "queued", instrumentId: 3, commitId: 2 });
assert.equal(regression.accepted, false, "queued after applying must be rejected as a status regression");
assert.equal(regression.regressive, true);

const failed = domain.acknowledge({
  state: "failed",
  instrumentId: 3,
  commitId: 2,
  desiredPresetId: "factory-b",
  code: "native-state-read",
  reason: "fixture failure",
});
assert.equal(failed.accepted, true);
assert.equal(domain.get(3).state, "failed");
assert.equal(domain.get(3).code, "native-state-read");
assert.equal(domain.get(3).reason, "fixture failure");

const staleRequest = domain.request({ instrumentId: 3, commitId: 2, desiredPresetId: "factory-c" });
assert.equal(staleRequest.accepted, false, "same commitId cannot be re-requested after terminal failure");
assert.equal(staleRequest.stale, true);

const other = domain.request({ instrumentId: 9, commitId: 1, desiredPresetId: null });
assert.equal(other.accepted, true);
assert.deepEqual(domain.snapshot().applications.map((row) => row.instrumentId), [3, 9], "sparse Instrument statuses must be sorted and independent");

const snapshot = domain.snapshot();
assert.equal(snapshot.requests, 3);
assert.equal(snapshot.acknowledgements, 6);
assert.equal(snapshot.staleAcknowledgements, 1);
assert.equal(snapshot.regressiveAcknowledgements, 2);
assert.equal(snapshot.cleared, 0);
assert.ok(events.some(({ changeSet }) => changeSet.target === "transport.preparedInstrumentState.3"));
assert.ok(events.every(({ changeSet }) => changeSet.owner === "transport"));
assert.ok(events.every(({ changeSet }) => changeSet.persistsProject === false));
assert.ok(events.some(({ changeSet }) => changeSet.renderTargets.includes("instrument.context")));

const cleared = domain.clearAll({ source: "unit-structural-recovery" });
assert.equal(cleared.mutated, true);
assert.deepEqual(cleared.rows.map((row) => row.instrumentId), [3, 9]);
assert.equal(domain.get(3), null);
assert.equal(domain.get(9), null);
assert.equal(domain.snapshot().cleared, 2);
assert.ok(events.some(({ changeSet }) => changeSet.subtype === "prepared-state.cleared" && changeSet.after === null),
  "successful structural recovery must publish removal of transient application status");

console.log("A5 #297-C TransportStore prepared-state application status contract passed");
