"use strict";

const assert = require("node:assert/strict");
const domain = require("./prepared-instrument-state-worklet-domain.js");

const PACKAGE_SHA = "a".repeat(64);
const identity = Object.freeze({
  moduleId: "design.myldy.brk-wav",
  engineId: "brk-wav",
  version: "0.1.0-rc6",
  packageSha256: PACKAGE_SHA,
});

function commit({ instrumentId = 3, commitId = 1, bytes = [1, 2, 3, 4], parameterIds = ["gain", "cutoff"], parameterValues = [0.75, 0.25], presetId = "factory-a" } = {}) {
  return {
    instrumentId,
    commitId,
    exactEngineIdentity: identity,
    stateSchemaVersion: 131072,
    stateBytes: Uint8Array.from(bytes),
    parameterIds,
    parameterValues,
    sourceSubtype: "instrument.preset",
    desiredPresetId: presetId,
  };
}

(function validatesAndOwnsQueuedPayload() {
  const queue = domain.createQueue();
  const input = commit();
  const queued = queue.stage(input);
  assert.deepEqual(queued, {
    state: "queued",
    instrumentId: 3,
    commitId: 1,
    supersededCommitId: null,
    desiredPresetId: "factory-a",
  });
  input.stateBytes[0] = 99;
  input.parameterValues[0] = 0;

  const applying = queue.beginNext();
  assert.equal(applying.instrumentId, 3);
  assert.equal(applying.commitId, 1);
  assert.deepEqual([...applying.stateBytes], [1, 2, 3, 4], "Worklet queue must own a staged byte copy independent of the message caller");
  assert.deepEqual(applying.parameterValues, [0.75, 0.25]);
  assert.equal(queue.snapshot().pending, 0);
  assert.equal(queue.snapshot().applying, 1);
  assert.equal(Object.hasOwn(queue.snapshot().pendingCommits[0] ?? {}, "stateBytes"), false, "diagnostics must never expose prepared state bytes");

  assert.deepEqual(queue.finishApplied(3, 1), {
    state: "applied",
    instrumentId: 3,
    commitId: 1,
    desiredPresetId: "factory-a",
  });
  assert.equal(queue.snapshot().applying, 0);
  assert.deepEqual(queue.snapshot().lastApplied, [{ instrumentId: 3, commitId: 1 }]);
})();

(function latestWinsPerInstrumentWithoutCrossInstrumentReplacement() {
  const queue = domain.createQueue();
  assert.equal(queue.stage(commit({ instrumentId: 3, commitId: 1, presetId: "a" })).supersededCommitId, null);
  assert.equal(queue.stage(commit({ instrumentId: 4, commitId: 1, presetId: "x" })).supersededCommitId, null);
  assert.equal(queue.stage(commit({ instrumentId: 3, commitId: 2, presetId: "b", bytes: [2, 2, 2, 2] })).supersededCommitId, 1);

  const snapshot = queue.snapshot();
  assert.equal(snapshot.pending, 2);
  assert.equal(snapshot.superseded, 1);
  assert.deepEqual(snapshot.pendingCommits, [
    { instrumentId: 3, commitId: 2, sourceSubtype: "instrument.preset", desiredPresetId: "b", stateByteLength: 4, parameterCount: 2 },
    { instrumentId: 4, commitId: 1, sourceSubtype: "instrument.preset", desiredPresetId: "x", stateByteLength: 4, parameterCount: 2 },
  ]);

  const first = queue.beginNext();
  assert.equal(first.instrumentId, 3, "drain ordering must be deterministic by sparse Instrument id");
  assert.equal(first.commitId, 2, "latest same-Instrument commit must win before application");
  queue.finishApplied(first.instrumentId, first.commitId);
  const second = queue.beginNext();
  assert.equal(second.instrumentId, 4, "unrelated Instrument pending state must survive replacement on Instrument 3");
  queue.finishApplied(second.instrumentId, second.commitId);
})();

(function staleAndLowerCommitIdsFailClosed() {
  const queue = domain.createQueue();
  queue.stage(commit({ commitId: 2 }));
  assert.throws(() => queue.stage(commit({ commitId: 2 })), (error) => error?.code === "stale-commit");
  assert.throws(() => queue.stage(commit({ commitId: 1 })), (error) => error?.code === "stale-commit");
  assert.equal(queue.snapshot().staleRejected, 2);

  const applying = queue.beginNext();
  queue.finishFailed(applying.instrumentId, applying.commitId, "fixture failure");
  assert.equal(queue.snapshot().failed, 1);
  assert.throws(() => queue.stage(commit({ commitId: 2 })), (error) => error?.code === "stale-commit", "failed commit ids remain consumed so retries require a newer transient id");
  assert.equal(queue.stage(commit({ commitId: 3 })).commitId, 3);
})();

(function newerCommitCanQueueWhileOlderCommitIsApplying() {
  const queue = domain.createQueue();
  queue.stage(commit({ commitId: 1, presetId: "a" }));
  const applying = queue.beginNext();
  assert.equal(applying.commitId, 1);
  assert.equal(queue.stage(commit({ commitId: 2, presetId: "b" })).commitId, 2);
  queue.finishApplied(3, 1);
  const next = queue.beginNext();
  assert.equal(next.commitId, 2);
  queue.finishApplied(3, 2);
  assert.deepEqual(queue.snapshot().lastApplied, [{ instrumentId: 3, commitId: 2 }]);
})();

(function validationIsStrictAndBounded() {
  const queue = domain.createQueue();
  assert.throws(() => queue.stage(commit({ instrumentId: 256 })), (error) => error?.code === "instrument-id");
  assert.throws(() => queue.stage(commit({ commitId: 0 })), (error) => error?.code === "commit-id");
  assert.throws(() => queue.stage({ ...commit(), exactEngineIdentity: { ...identity, packageSha256: "bad" } }), (error) => error?.code === "exact-engine-identity");
  assert.throws(() => queue.stage({ ...commit(), stateBytes: [1, 2, 3, 4] }), (error) => error?.code === "state-bytes");
  assert.throws(() => queue.stage(commit({ parameterIds: ["gain"], parameterValues: [0.5, 0.4] })), (error) => error?.code === "parameter-shape");
  assert.throws(() => queue.stage(commit({ parameterIds: ["gain", "gain"], parameterValues: [0.5, 0.4] })), (error) => error?.code === "parameter-id");
  assert.throws(() => queue.stage(commit({ parameterValues: [0.5, 1.1] })), (error) => error?.code === "parameter-value");
  assert.throws(() => queue.stage({ ...commit(), sourceSubtype: "instrument.create" }), (error) => error?.code === "source-subtype");
})();

console.log("A5 #297-B bounded Worklet prepared-state queue contract passed");
