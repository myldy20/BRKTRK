const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const calls = { live: 0, snapshots: 0, activations: 0, invalidations: 0, readiness: 0 };
let audioSubscriber = null;
let transportSubscriber = null;
let playing = true;
let phase = "playing";
const activationResolvers = [];
const project = {
  tempo: 120,
  instrumentPool: {
    3: {
      id: 3,
      engineRef: { moduleId: "design.myldy.fixture", engineId: "fixture" },
      parameterSnapshot: { cutoff: 0.5 },
    },
  },
};

const sandbox = {
  console,
  Promise,
  audio: { ready: true, context: {}, node: {} },
  BRKTRKAudioReadiness: {
    invalidate(metadata) {
      calls.invalidations += 1;
      calls.lastInvalidation = metadata;
      return Object.freeze({ ready: false });
    },
    ensureReady(metadata) {
      calls.readiness += 1;
      calls.lastReadiness = metadata;
      return Promise.resolve();
    },
  },
  BRKTRKProductionEngineHost: {
    sendLiveParameter(input) {
      calls.live += 1;
      calls.lastLive = JSON.parse(JSON.stringify(input));
      return Object.freeze({ parameterId: input.parameterId, rampFrames: 192, policy: "parameter-ramp" });
    },
    syncProject() {
      calls.snapshots += 1;
      return true;
    },
    activateProject() {
      calls.activations += 1;
      if (calls.activations === 1) {
        return new Promise((resolve) => activationResolvers.push(resolve));
      }
      return Promise.resolve();
    },
    refreshCatalog() { return Promise.resolve(); },
    registerDiagnostics() { return true; },
  },
  BRKTRKStores: {
    project: {
      getState() { return project; },
      subscribe(channel, listener) {
        assert.equal(channel, "audio");
        audioSubscriber = listener;
        return () => { audioSubscriber = null; };
      },
    },
    transport: {
      runtime: {
        isPlaying() { return playing; },
        snapshot() { return Object.freeze({ phase, playing }); },
      },
      subscribe(channel, listener) {
        assert.equal(channel, "transport");
        transportSubscriber = listener;
        return () => { transportSubscriber = null; };
      },
    },
  },
};
sandbox.globalThis = sandbox;
vm.runInNewContext(
  fs.readFileSync("web/production-engine-store-sync.js", "utf8"),
  sandbox,
  { filename: "production-engine-store-sync.js" },
);

assert.equal(typeof audioSubscriber, "function");
assert.equal(typeof transportSubscriber, "function");
assert.equal(calls.activations, 0, "initial structural activation is serialized onto the microtask queue");
assert.equal(calls.invalidations, 1, "initial Instrument sync must revoke canonical readiness immediately");
assert.equal(calls.lastInvalidation.reason, "project-instruments-changed");
assert.equal(calls.lastInvalidation.supersedeInFlight, true, "Project Instrument invalidation must supersede an older active readiness transaction");
assert.equal(sandbox.BRKTRKProductionEngineStoreSync.structuralInstrumentMutation({ subtype: "tempo", target: "project.tempo", path: ["tempo"] }), false,
  "tempo must not be classified as an Instrument/package structural mutation");
assert.equal(sandbox.BRKTRKProductionEngineStoreSync.structuralInstrumentMutation({ subtype: "instrument.patch", path: ["instrumentPool", 3] }), true,
  "Instrument patch replacement must remain structural");
assert.equal(sandbox.BRKTRKProductionEngineStoreSync.structuralInstrumentMutation({ subtype: "file.replace", target: "project.file.replace", path: [] }), true,
  "whole-Project replacement must remain structural even with an empty path");
assert.equal(sandbox.BRKTRKProductionEngineStoreSync.structuralInstrumentMutation({
  subtype: "history.undo",
  target: "project.history.undo",
  path: [],
  transaction: { originalTarget: "project.instrumentPool.3.parameterSnapshot.cutoff" },
}), true, "Undo restoring an Instrument mutation must resynchronize the production Instrument snapshot");
assert.equal(sandbox.BRKTRKProductionEngineStoreSync.structuralInstrumentMutation({
  subtype: "history.redo",
  target: "project.history.redo",
  path: [],
  affectsPlayback: false,
  transaction: { originalTarget: "project.instrumentPool.3", originalAffectsPlayback: false },
}), false, "Undo/Redo restoring an audio-neutral Instrument rename must not resynchronize production Instruments");
assert.equal(sandbox.BRKTRKProductionEngineStoreSync.structuralInstrumentMutation({
  subtype: "history.redo",
  target: "project.history.redo",
  path: [],
  affectsPlayback: true,
  transaction: { originalTarget: "project.instrumentPool.3", originalAffectsPlayback: true },
}), true, "audio-relevant Instrument patch/package history must remain structural");
assert.equal(sandbox.BRKTRKProductionEngineStoreSync.structuralInstrumentMutation({
  subtype: "history.redo",
  target: "project.history.redo",
  path: [],
  transaction: { originalTarget: "project.tempo" },
}), false, "Undo/Redo of tempo must remain outside production Instrument synchronization");

// Tempo shares the ProjectStore `audio` channel because it affects playback,
// but its dedicated transport/runtime adapter owns that update. It must not
// invalidate package readiness or enqueue a redundant full Instrument snapshot.
audioSubscriber({
  subtype: "tempo",
  target: "project.tempo",
  path: ["tempo"],
  before: 120,
  after: 121,
  affectsPlayback: true,
}, project);
assert.equal(calls.invalidations, 1, "tempo edit must not revoke production package readiness");
assert.equal(calls.activations, 0, "tempo edit must not enqueue production Instrument activation");
assert.equal(sandbox.BRKTRKProductionEngineStoreSync.snapshot().ignoredAudioMutations, 1,
  "non-Instrument audio mutation must be observable as ignored by this owner");

for (let index = 0; index < 240; index += 1) {
  const value = index / 239;
  project.instrumentPool[3].parameterSnapshot.cutoff = value;
  audioSubscriber({
    subtype: "instrument.parameter",
    path: ["instrumentPool", 3, "parameterSnapshot", "cutoff"],
    after: value,
    transaction: { instrumentId: 3, parameterKey: "cutoff", transient: true },
  }, project);
}

assert.equal(calls.live, 240, "240 rapid live parameter edits must retain immediate dedicated delivery");
assert.equal(calls.snapshots, 0, "parameter drag must not enqueue 240 redundant full Instrument snapshots");
assert.equal(calls.invalidations, 1, "parameter-only edits must not revoke structural package readiness");
assert.equal(calls.lastLive.instrumentId, 3);
assert.equal(calls.lastLive.parameterId, "cutoff");
assert.equal(calls.lastLive.value, 1);
assert.equal(project.instrumentPool[3].parameterSnapshot.cutoff, 1, "ProjectStore remains the durable final parameter owner");

setImmediate(() => {
  assert.equal(calls.activations, 1, "initial structural project synchronization must remain active");
  assert.equal(activationResolvers.length, 1, "fixture must hold the first structural activation open");
  assert.equal(calls.readiness, 0, "active transport must not prove readiness while structural activation is pending");

  // Simulate STOP being requested while package/Project activation is still in
  // flight. The runtime is already playing=false, but the authoritative phase
  // remains `stopping` until the Worklet acknowledges the stop.
  playing = false;
  phase = "stopping";
  transportSubscriber({ target: "transport.program.stop-request", subtype: "program.stop-request" });
  assert.equal(calls.readiness, 0, "stop request must not re-prove readiness before Worklet stop acknowledgement");
  assert.equal(sandbox.BRKTRKProductionEngineStoreSync.snapshot().stopBoundaryReadinessProofs, 0);

  activationResolvers.shift()();

  setImmediate(() => {
    assert.equal(calls.readiness, 0, "activation finishing in stopping phase must still defer canonical proof");
    assert.equal(sandbox.BRKTRKProductionEngineStoreSync.snapshot().readinessDeferredUntilStop, true);
    assert.equal(sandbox.BRKTRKProductionEngineStoreSync.snapshot().stopBoundaryReadinessProofs, 0);

    phase = "stopped";
    transportSubscriber({ target: "transport.program.stopped", subtype: "program.stopped" });

    setImmediate(() => {
      assert.equal(calls.readiness, 1, "acknowledged STOP must re-prove readiness after deferred Instrument promotion");
      assert.equal(calls.lastReadiness.source, "production-engine-store-sync-stop-boundary");
      const afterStop = sandbox.BRKTRKProductionEngineStoreSync.snapshot();
      assert.equal(afterStop.readinessDeferredUntilStop, false);
      assert.equal(afterStop.stopBoundaryReadinessProofs, 1);

      audioSubscriber({
        subtype: "instrument.replace",
        path: ["instrumentPool", 3],
        after: project.instrumentPool[3],
      }, project);

      setImmediate(() => {
        assert.equal(calls.activations, 2, "stopped structural Instrument sync must activate the current Project");
        assert.equal(calls.readiness, 2, "stopped structural Instrument sync must restore readiness immediately through the canonical gate");
        assert.equal(calls.lastReadiness.source, "production-engine-store-sync");

        audioSubscriber({
          subtype: "file.replace",
          target: "project.file.replace",
          path: [],
          after: { schemaVersion: 4 },
        }, project);

        setImmediate(() => {
          assert.equal(calls.activations, 3, "whole-Project replacement must still reconcile production Instruments");
          assert.equal(calls.readiness, 3, "stopped whole-Project replacement must re-prove canonical readiness");

          audioSubscriber({
            subtype: "history.undo",
            target: "project.history.undo",
            path: [],
            transaction: { originalTarget: "project.instrumentPool.3.parameterSnapshot.cutoff" },
          }, project);

          setImmediate(() => {
            assert.equal(calls.activations, 4, "Instrument Undo must reconcile the restored production Instrument snapshot");
            assert.equal(calls.readiness, 4, "Instrument Undo must re-prove canonical package readiness");

            audioSubscriber({
              subtype: "history.redo",
              target: "project.history.redo",
              path: [],
              affectsPlayback: false,
              transaction: { originalTarget: "project.instrumentPool.3", originalAffectsPlayback: false },
            }, project);
            assert.equal(calls.activations, 4, "audio-neutral Instrument history must not activate production Instruments");
            assert.equal(calls.invalidations, 4, "audio-neutral Instrument history must not revoke production package readiness");
            assert.equal(sandbox.BRKTRKProductionEngineStoreSync.snapshot().ignoredAudioMutations, 2,
              "audio-neutral Instrument history must be observed as ignored by the production audio owner");

            audioSubscriber({
              subtype: "history.redo",
              target: "project.history.redo",
              path: [],
              transaction: { originalTarget: "project.tempo" },
            }, project);
            assert.equal(calls.activations, 4, "tempo history restore must not activate production Instruments");
            assert.equal(calls.invalidations, 4, "tempo history restore must not revoke production package readiness");

            const snapshot = sandbox.BRKTRKProductionEngineStoreSync.snapshot();
            assert.deepEqual({ ...snapshot }, {
              parameterMutations: 240,
              liveParameterMessages: 240,
              liveParameterRejections: 0,
              structuralSynchronizations: 4,
              ignoredAudioMutations: 3,
              readinessDeferredUntilStop: false,
              stopBoundaryReadinessProofs: 1,
            });

            // The generic runtime adapter owns tempo delivery, including the
            // empty-path whole-Project history restore emitted by Undo/Redo.
            const runtimeAdapters = require("./store-runtime-adapters.js");
            const tempoDeliveries = [];
            const playbackRefreshes = [];
            const adapterStores = {
              project: {
                select() { return 96; },
              },
            };
            const adapterSubscribers = runtimeAdapters.createBrowserProjectSubscribers({}, adapterStores, {
              setAudioTempo(value) { tempoDeliveries.push(value); },
              refreshPlayback(changeSet) { playbackRefreshes.push(changeSet); },
            });
            adapterSubscribers.audio({
              subtype: "history.undo",
              target: "project.history.undo",
              path: [],
              after: null,
              affectsPlayback: true,
              transaction: { originalTarget: "project.tempo" },
            });
            assert.deepEqual(tempoDeliveries, [96], "tempo Undo must send the restored ProjectStore tempo to the audio runtime");
            assert.equal(playbackRefreshes.length, 0, "tempo Undo must not fall through to a plan refresh that omits tempo");
            adapterSubscribers.audio({
              subtype: "history.undo",
              target: "project.history.undo",
              path: [],
              after: null,
              affectsPlayback: true,
              transaction: { originalTarget: "project.instrumentPool.3.parameterSnapshot.cutoff" },
            });
            assert.equal(tempoDeliveries.length, 1, "Instrument history must not be misrouted as tempo");
            assert.equal(playbackRefreshes.length, 1, "non-tempo history retains normal playback refresh ownership");

            console.log("M5A A5.2 production Store live-parameter/scoped-structural/history/rename/tempo-routing/deferred-readiness regressions passed");
          });
        });
      });
    });
  });
});