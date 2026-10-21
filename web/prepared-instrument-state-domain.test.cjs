"use strict";

const assert = require("node:assert/strict");
const domain = require("./prepared-instrument-state-domain.js");

const PACKAGE_SHA = "a".repeat(64);
const CONTENT_SHA = "b".repeat(64);

function base64(bytes) {
  return Buffer.from(Uint8Array.from(bytes)).toString("base64");
}

function instrument({ id = 3, version = "0.1.0-rc6", packageSha256 = PACKAGE_SHA, bytes = [1, 2, 3, 4], parameters = { cutoff: 0.25, gain: 0.75 }, presetId = "factory-a" } = {}) {
  return {
    id,
    engineRef: {
      moduleId: "design.myldy.brk-wav",
      engineId: "brk-wav",
      requestedVersion: version,
      resolvedVersion: version,
      resolvedPackageSha256: packageSha256,
    },
    patchState: {
      schemaVersion: 131072,
      encoding: "base64",
      data: base64(bytes),
    },
    parameterSnapshot: { ...parameters },
    presetRef: presetId == null ? null : { id: presetId },
  };
}

function packageView() {
  return {
    entry: {
      moduleId: "design.myldy.brk-wav",
      engineId: "brk-wav",
      version: "0.1.0-rc6",
      packageSha256: PACKAGE_SHA,
    },
    manifest: {
      stateSchemaVersion: 131072,
      stateBytes: 4,
      contentSha256: CONTENT_SHA,
    },
    parameters: [
      { id: "gain" },
      { id: "cutoff" },
    ],
  };
}

(function sameTopologyClassifierRequiresExactIdentity() {
  const current = instrument();
  const desired = instrument({ presetId: "factory-b", bytes: [9, 8, 7, 6] });
  const result = domain.classifySameTopology({ instrumentId: 3, currentInstrument: current, desiredInstrument: desired, packageView: packageView() });
  assert.equal(result.eligible, true);
  assert.equal(result.code, "same-exact-topology");
  assert.deepEqual(result.exactEngineIdentity, {
    moduleId: "design.myldy.brk-wav",
    engineId: "brk-wav",
    version: "0.1.0-rc6",
    packageSha256: PACKAGE_SHA,
  });

  const changedPackage = instrument({ packageSha256: "c".repeat(64) });
  const packageChange = domain.classifySameTopology({ instrumentId: 3, currentInstrument: current, desiredInstrument: changedPackage, packageView: packageView() });
  assert.equal(packageChange.eligible, false);
  assert.equal(packageChange.code, "engine-topology-changed");

  const unresolved = instrument();
  delete unresolved.engineRef.resolvedVersion;
  const unresolvedResult = domain.classifySameTopology({ instrumentId: 3, currentInstrument: unresolved, desiredInstrument: desired, packageView: packageView() });
  assert.equal(unresolvedResult.eligible, false);
  assert.equal(unresolvedResult.code, "exact-engine-identity-missing");

  const mismatchedView = packageView();
  mismatchedView.entry.version = "0.1.0-rc5";
  const viewMismatch = domain.classifySameTopology({ instrumentId: 3, currentInstrument: current, desiredInstrument: desired, packageView: mismatchedView });
  assert.equal(viewMismatch.eligible, false);
  assert.equal(viewMismatch.code, "verified-package-identity-mismatch");
})();

(function preparedEnvelopeKeepsValidatedBytesPrivateAndCopiesOutExplicitly() {
  const current = instrument();
  const desired = instrument({ bytes: [9, 8, 7, 6], parameters: { cutoff: 0.125, gain: 0.875 }, presetId: "factory-b" });
  const before = JSON.stringify({ current, desired });
  const envelope = domain.prepareEnvelope({
    instrumentId: 3,
    currentInstrument: current,
    desiredInstrument: desired,
    packageView: packageView(),
    commitId: 7,
    sourceSubtype: "instrument.preset",
  });

  assert.equal(Object.isFrozen(envelope), true);
  assert.equal(envelope.instrumentId, 3);
  assert.equal(envelope.commitId, 7);
  assert.equal(envelope.stateSchemaVersion, 131072);
  assert.equal(envelope.stateByteLength, 4);
  assert.equal(Object.hasOwn(envelope, "stateBytes"), false, "validated mutable Uint8Array must not escape the prepared envelope");
  assert.equal(typeof envelope.copyStateBytesInto, "function");

  const firstCopy = new Uint8Array(6);
  assert.equal(envelope.copyStateBytesInto(firstCopy, 1), 4);
  assert.deepEqual([...firstCopy], [0, 9, 8, 7, 6, 0]);
  firstCopy[1] = 255;
  const secondCopy = new Uint8Array(4);
  envelope.copyStateBytesInto(secondCopy);
  assert.deepEqual([...secondCopy], [9, 8, 7, 6], "mutating a caller-owned copy must not alter the private validated state payload");
  assert.throws(() => envelope.copyStateBytesInto(new Uint8Array(3)), (error) => error?.code === "state-copy-capacity");
  assert.throws(() => envelope.copyStateBytesInto([0, 0, 0, 0]), (error) => error?.code === "state-copy-target");

  assert.deepEqual(envelope.parameterIds, ["gain", "cutoff"], "verified manifest order must own compact parameter ordering");
  assert.deepEqual(envelope.parameterValues, [0.875, 0.125]);
  assert.equal(Object.isFrozen(envelope.parameterIds), true);
  assert.equal(Object.isFrozen(envelope.parameterValues), true);
  assert.equal(envelope.desiredPresetId, "factory-b");
  assert.equal(envelope.contentSha256, CONTENT_SHA);
  assert.equal(JSON.stringify({ current, desired }), before, "preparation must not mutate canonical Project-owned Instrument state");
  assert.equal(Object.hasOwn(desired, "commitId"), false, "transient commit identity must never enter persisted Instrument state");
})();

(function preparationFailsClosedBeforeUnsafeDelivery() {
  const current = instrument();
  const view = packageView();

  const shortState = instrument({ bytes: [1, 2, 3] });
  assert.throws(
    () => domain.prepareEnvelope({ instrumentId: 3, currentInstrument: current, desiredInstrument: shortState, packageView: view, commitId: 1, sourceSubtype: "instrument.patch" }),
    (error) => error?.code === "state-size-mismatch",
  );

  const oversizedState = instrument({ bytes: [1, 2, 3, 4, 5, 6] });
  assert.throws(
    () => domain.prepareEnvelope({ instrumentId: 3, currentInstrument: current, desiredInstrument: oversizedState, packageView: view, commitId: 1, sourceSubtype: "instrument.patch" }),
    (error) => error?.code === "state-size-mismatch",
    "encoded length must be rejected against verified stateBytes before accepting a decode-sized payload",
  );

  const wrongSchema = instrument();
  wrongSchema.patchState.schemaVersion = 1;
  assert.throws(
    () => domain.prepareEnvelope({ instrumentId: 3, currentInstrument: current, desiredInstrument: wrongSchema, packageView: view, commitId: 1, sourceSubtype: "instrument.patch" }),
    (error) => error?.code === "state-schema-mismatch",
  );

  const jsonPatch = instrument();
  jsonPatch.patchState = { schemaVersion: 131072, encoding: "json", data: {} };
  assert.throws(
    () => domain.prepareEnvelope({ instrumentId: 3, currentInstrument: current, desiredInstrument: jsonPatch, packageView: view, commitId: 1, sourceSubtype: "instrument.patch" }),
    (error) => error?.code === "patch-encoding-unsupported",
  );

  assert.throws(() => domain.decodeBase64("AB=="), (error) => error?.code === "patch-base64-invalid",
    "non-canonical base64 with non-zero unused bits must fail closed");

  const incomplete = instrument({ parameters: { gain: 0.75 } });
  assert.throws(
    () => domain.prepareEnvelope({ instrumentId: 3, currentInstrument: current, desiredInstrument: incomplete, packageView: view, commitId: 1, sourceSubtype: "instrument.preset" }),
    (error) => error?.code === "parameter-snapshot-incomplete",
  );

  const unknown = instrument({ parameters: { gain: 0.75, cutoff: 0.25, legacy: 0.5 } });
  assert.throws(
    () => domain.prepareEnvelope({ instrumentId: 3, currentInstrument: current, desiredInstrument: unknown, packageView: view, commitId: 1, sourceSubtype: "instrument.preset" }),
    (error) => error?.code === "parameter-snapshot-unknown",
  );

  const stringValue = instrument({ parameters: { gain: 0.75, cutoff: "0.25" } });
  assert.throws(
    () => domain.prepareEnvelope({ instrumentId: 3, currentInstrument: current, desiredInstrument: stringValue, packageView: view, commitId: 1, sourceSubtype: "instrument.preset" }),
    (error) => error?.code === "parameter-value-invalid",
  );

  const noContentIdentity = packageView();
  delete noContentIdentity.manifest.contentSha256;
  assert.throws(
    () => domain.prepareEnvelope({ instrumentId: 3, currentInstrument: current, desiredInstrument: instrument(), packageView: noContentIdentity, commitId: 1, sourceSubtype: "instrument.preset" }),
    (error) => error?.code === "verified-content-sha-invalid",
  );
})();

(function sequencerIsBoundedPerInstrumentAndLatestWins() {
  const sequencer = domain.createSequencer();
  const current3 = instrument({ id: 3 });
  const first3 = instrument({ id: 3, presetId: "a", bytes: [1, 1, 1, 1] });
  const second3 = instrument({ id: 3, presetId: "b", bytes: [2, 2, 2, 2] });
  const current4 = instrument({ id: 4 });
  const first4 = instrument({ id: 4, presetId: "x", bytes: [3, 3, 3, 3] });

  const a = sequencer.prepare({ instrumentId: 3, currentInstrument: current3, desiredInstrument: first3, packageView: packageView(), sourceSubtype: "instrument.preset" });
  assert.throws(
    () => sequencer.prepare({ instrumentId: 3, currentInstrument: current3, desiredInstrument: instrument({ id: 3, bytes: [9] }), packageView: packageView(), sourceSubtype: "instrument.preset" }),
    (error) => error?.code === "state-size-mismatch",
  );
  const b = sequencer.prepare({ instrumentId: 3, currentInstrument: current3, desiredInstrument: second3, packageView: packageView(), sourceSubtype: "instrument.preset" });
  const x = sequencer.prepare({ instrumentId: 4, currentInstrument: current4, desiredInstrument: first4, packageView: packageView(), sourceSubtype: "instrument.preset" });

  assert.equal(a.commitId, 1);
  assert.equal(b.commitId, 2, "a rejected preparation must not consume a transient commit id");
  assert.equal(x.commitId, 1, "commit ids are monotonic per Instrument rather than one global persisted sequence");
  assert.equal(sequencer.latest(3).desiredPresetId, "b");
  assert.equal(sequencer.latest(4).desiredPresetId, "x");
  assert.deepEqual(sequencer.snapshot(), {
    prepared: 3,
    superseded: 1,
    released: 0,
    rejected: 1,
    queuedInstruments: 2,
    latest: [
      { instrumentId: 3, commitId: 2, sourceSubtype: "instrument.preset" },
      { instrumentId: 4, commitId: 1, sourceSubtype: "instrument.preset" },
    ],
  });
  assert.equal(sequencer.release(3, 1), false, "stale commit id must not release a newer delivery artifact");
  assert.equal(sequencer.release(3, 2), true);
  assert.equal(sequencer.latest(3), null);
  assert.equal(sequencer.snapshot().queuedInstruments, 1);
})();

console.log("A5 #297-A prepared Instrument state control-plane contract passed");
