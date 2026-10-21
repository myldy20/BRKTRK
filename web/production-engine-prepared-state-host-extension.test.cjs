const assert = require("node:assert/strict");

const SHA = "a".repeat(64);
const CONTENT = "b".repeat(64);
const engineRef = Object.freeze({
  moduleId: "design.myldy.fixture",
  engineId: "fixture",
  requestedVersion: "1.0.0",
  resolvedVersion: "1.0.0",
  resolvedPackageSha256: SHA,
});
const packageView = Object.freeze({
  entry: Object.freeze({ moduleId: engineRef.moduleId, engineId: engineRef.engineId, version: "1.0.0", packageSha256: SHA }),
  manifest: Object.freeze({ stateSchemaVersion: 1, stateBytes: 4, contentSha256: CONTENT }),
  parameters: Object.freeze([Object.freeze({ id: "cutoff" })]),
});
const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));

const calls = { baseSync: 0, baseActivate: 0, baseLive: 0, baseAttach: 0, packageViews: 0 };
let baseNode = null;
globalThis.BRKTRKProductionEngineHost = Object.freeze({
  productionInstrumentSnapshot(project) {
    return clone(project?.instrumentPool ?? {});
  },
  async ensurePackageView(ref) {
    calls.packageViews += 1;
    assert.equal(ref.resolvedPackageSha256, SHA);
    return packageView;
  },
  sendLiveParameter(input) {
    calls.baseLive += 1;
    calls.lastLive = clone(input);
    return Object.freeze({ parameterId: input.parameterId, rampFrames: 0, policy: "parameter-value" });
  },
  attachNode(node) {
    calls.baseAttach += 1;
    baseNode = node;
    return true;
  },
  syncProject(project, options = {}) {
    calls.baseSync += 1;
    baseNode?.port?.postMessage?.({ type: "production-instruments", instruments: clone(project?.instrumentPool ?? {}), force: options.force === true });
    return true;
  },
  async activateProject(project) {
    calls.baseActivate += 1;
    baseNode?.port?.postMessage?.({ type: "production-instruments", instruments: clone(project?.instrumentPool ?? {}), activated: true });
    return Object.freeze({});
  },
});

const host = require("./production-engine-prepared-state-host-extension.js");

const outgoing = [];
const listeners = new Set();
const port = {
  postMessage(message) { outgoing.push(message); },
  addEventListener(type, listener) { if (type === "message") listeners.add(listener); },
  start() {},
};
const node = { port };
const context = { sampleRate: 48000 };
const emit = (message) => { for (const listener of [...listeners]) listener({ data: message }); };

const fixtureInstrument = (id, presetId, cutoff) => ({
  id,
  name: `Fixture ${id}`,
  engineRef: clone(engineRef),
  patchState: { schemaVersion: 1, encoding: "base64", data: "AQIDBA==" },
  parameterSnapshot: { cutoff },
  presetRef: { id: presetId },
});
const project = {
  instrumentPool: {
    3: fixtureInstrument(3, "factory-a", 0.7),
    4: fixtureInstrument(4, "other-a", 0.6),
  },
};

function envelope(instrumentId, commitId, presetId, bytes = Uint8Array.of(1, 2, 3, 4)) {
  const privateBytes = Uint8Array.from(bytes);
  return Object.freeze({
    instrumentId,
    commitId,
    exactEngineIdentity: Object.freeze({ moduleId: engineRef.moduleId, engineId: engineRef.engineId, version: "1.0.0", packageSha256: SHA }),
    contentSha256: CONTENT,
    stateSchemaVersion: 1,
    stateByteLength: privateBytes.byteLength,
    parameterIds: Object.freeze(["cutoff"]),
    parameterValues: Object.freeze([project.instrumentPool[instrumentId].parameterSnapshot.cutoff]),
    sourceSubtype: "instrument.preset",
    desiredPresetId: presetId,
    copyStateBytesInto(target) { target.set(privateBytes); return privateBytes.byteLength; },
  });
}

async function main() {
  assert.equal(await host.ensurePackageView(engineRef), packageView);
  assert.equal(host.verifiedPackageViewFor(engineRef), packageView, "verified exact package view must be synchronously reusable by Store orchestration");
  assert.equal(host.verifiedPackageViewFor({ ...engineRef, resolvedPackageSha256: "c".repeat(64) }), null, "wrong exact pin must not reuse a verified view");

  host.attachNode(node, context, project);
  assert.equal(calls.baseAttach, 1);
  assert.equal(listeners.size, 1, "prepared status listener must bind once to the authoritative MessagePort");
  assert.equal(host.syncProject(project), false, "attach establishes a logical mirror of the authoritative structural snapshot");

  const first = envelope(3, 1, "factory-a");
  const delivery1 = host.sendPreparedState({ envelope: first, instrument: project.instrumentPool[3], project });
  assert.deepEqual({ ...delivery1 }, { instrumentId: 3, commitId: 1, desiredPresetId: "factory-a" });
  const prepared1 = outgoing.at(-1);
  assert.equal(prepared1.type, "production-prepared-state");
  assert.ok(prepared1.stateBytes instanceof Uint8Array);
  assert.deepEqual([...prepared1.stateBytes], [1, 2, 3, 4]);
  prepared1.stateBytes[0] = 99;
  const freshCopy = new Uint8Array(4);
  first.copyStateBytesInto(freshCopy);
  assert.deepEqual([...freshCopy], [1, 2, 3, 4], "posted payload mutation must not reach the private prepared envelope bytes");

  assert.equal(host.syncProject(project), false, "pending prepared desired state must suppress a redundant full Instrument snapshot");
  assert.equal(calls.baseSync, 0);

  emit({ type: "production-prepared-state-status", state: "queued", instrumentId: 3, commitId: 1, desiredPresetId: "factory-a", supersededCommitId: null, appliedPerformers: null });
  assert.equal(host.preparedControlSnapshot().lastPreparedStatus.supersededCommitId, null,
    "nullable superseded commit metadata must not normalize to synthetic commit 0");
  assert.equal(host.preparedControlSnapshot().lastPreparedStatus.appliedPerformers, null,
    "absent performer count must remain null rather than synthetic zero");
  emit({ type: "production-prepared-state-status", state: "applying", instrumentId: 3, commitId: 1, desiredPresetId: "factory-a" });
  emit({ type: "production-prepared-state-status", state: "applied", instrumentId: 3, commitId: 1, desiredPresetId: "factory-a", appliedPerformers: 0 });
  assert.equal(host.preparedControlSnapshot().lastPreparedStatus.appliedPerformers, 0,
    "zero applied performers is a valid explicit count and must remain distinguishable from absent metadata");
  assert.equal(host.syncProject(project), false, "applied prepared state must keep Host logical signature converged without structural traffic");

  project.instrumentPool[3].parameterSnapshot.cutoff = 0.9;
  assert.ok(host.sendLiveParameter({ instrumentId: 3, instrument: project.instrumentPool[3], parameterId: "cutoff", value: 0.9 }));
  assert.equal(calls.baseLive, 1);
  assert.equal(host.syncProject(project), false, "live parameter after prepared state must advance the logical Host signature in MessagePort order");

  project.instrumentPool[3].presetRef = { id: "factory-b" };
  project.instrumentPool[3].parameterSnapshot.cutoff = 0.4;
  const second = envelope(3, 2, "factory-b", Uint8Array.of(5, 6, 7, 8));
  host.sendPreparedState({ envelope: second, instrument: project.instrumentPool[3], project });

  project.instrumentPool[4].presetRef = { id: "other-b" };
  project.instrumentPool[4].parameterSnapshot.cutoff = 0.3;
  const other = envelope(4, 1, "other-b", Uint8Array.of(13, 14, 15, 16));
  host.sendPreparedState({ envelope: other, instrument: project.instrumentPool[4], project });

  emit({ type: "production-prepared-state-status", state: "applied", instrumentId: 3, commitId: 1, desiredPresetId: "factory-a" });
  assert.equal(host.preparedControlSnapshot().stalePreparedStatuses, 1, "stale terminal acknowledgement must not promote an older logical snapshot");
  assert.equal(host.syncProject(project), false, "newer pending prepared state remains the current logical desired snapshot after stale ACK");

  emit({ type: "production-prepared-state-status", state: "applied", instrumentId: 3, commitId: 2, desiredPresetId: "factory-b" });
  assert.equal(host.syncProject(project), false,
    "Instrument 3 ACK must not roll the logical shadow back behind newer pending Instrument 4 desired state");
  emit({ type: "production-prepared-state-status", state: "applied", instrumentId: 4, commitId: 1, desiredPresetId: "other-b" });
  assert.equal(host.syncProject(project), false);

  project.instrumentPool[3].presetRef = { id: "factory-c" };
  project.instrumentPool[3].parameterSnapshot.cutoff = 0.2;
  const third = envelope(3, 3, "factory-c", Uint8Array.of(9, 10, 11, 12));
  host.sendPreparedState({ envelope: third, instrument: project.instrumentPool[3], project });
  emit({ type: "production-prepared-state-status", state: "failed", instrumentId: 3, commitId: 3, desiredPresetId: "factory-c", code: "native-state-read", reason: "fixture failure" });
  assert.equal(host.preparedControlSnapshot().hasLogicalInstrumentSnapshot, false, "matching failure must revoke transient logical convergence shadow");
  assert.equal(host.syncProject(project), true, "after prepared failure, structural reconciliation must no longer be suppressed");
  assert.equal(calls.baseSync, 1);

  const mismatch = Object.freeze({ ...envelope(3, 4, "bad"), exactEngineIdentity: Object.freeze({ moduleId: "other", engineId: "fixture", version: "1.0.0", packageSha256: SHA }) });
  assert.equal(host.sendPreparedState({ envelope: mismatch, instrument: project.instrumentPool[3], project }), false, "prepared exact engine identity mismatch must fail closed before MessagePort delivery");

  host.invalidatePreparedStateShadow();
  await host.activateProject(project);
  assert.equal(calls.baseActivate, 1, "structural activation remains authoritative and clears transient prepared tracking");
  assert.equal(host.syncProject(project), false, "structural activation re-establishes the logical Host mirror");

  const snap = host.preparedControlSnapshot();
  assert.equal(snap.preparedMessages, 4);
  assert.equal(snap.preparedMessageFailures, 1);
  assert.equal(snap.preparedStatusMessages, 7);
  assert.equal(snap.pendingInstruments, 0);
  console.log("A5 #297-C Host prepared-state control bridge contract passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
