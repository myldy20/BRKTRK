const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("web/production-r6-realtime-extension.js", "utf8");
const preparedPairs = new Set();
const deliveries = [];
const existingEngineId = "fixture-engine";
const activeInstruments = new Set();
let transportActive = false;

const gateway = {
  resolveParameterHandle(track, instrumentId, parameterId) {
    if (!preparedPairs.has(`${track}:${instrumentId}`)) return -1;
    if (parameterId === "cutoff") return 1000 + Number(instrumentId);
    if (parameterId === "resonance") return 2000 + Number(instrumentId);
    return -1;
  },
  applyPreparedParameter(track, instrumentId, handle, value, sampleOffset, rampFrames) {
    deliveries.push({ track, instrumentId, handle, value, sampleOffset, rampFrames });
    return true;
  },
};

const baseDomain = Object.freeze({
  MAX_PENDING_PARAMETERS: 64,
  DEFAULT_TRACK_COUNT: 1,
  createProductionAudioRuntime() {
    return {
      configureInstruments(snapshot) {
        if (!transportActive) {
          activeInstruments.clear();
          for (const [idText, instrument] of Object.entries(snapshot ?? {})) {
            if (instrument?.engineRef?.engineId === existingEngineId) activeInstruments.add(Number(idText));
          }
          return true;
        }
        for (const [idText, instrument] of Object.entries(snapshot ?? {})) {
          if (instrument?.engineRef?.engineId === existingEngineId) activeInstruments.add(Number(idText));
        }
        return false;
      },
      hasInstrument(id) {
        return activeInstruments.has(Number(id)) ? existingEngineId : false;
      },
      prepareProgram(program) {
        preparedPairs.clear();
        for (const step of program?.steps ?? []) {
          const instrumentId = Number(step?.instrumentIds?.[0]);
          if (activeInstruments.has(instrumentId)) preparedPairs.add(`0:${instrumentId}`);
        }
        transportActive = true;
        return Object.freeze({ requiredPairs: preparedPairs.size });
      },
      queueAudition() { return false; },
      instrumentParameterValue() { return undefined; },
      beginBlock() { return true; },
      stop() { transportActive = false; return true; },
      diagnostics() { return Object.freeze({ traffic: Object.freeze({}) }); },
      handleMessage() { return false; },
    };
  },
});

const context = {
  console,
  module: { exports: {} },
  BRKTRKProductionAudioRuntime: baseDomain,
  BRKTRKSynthGatewayDomain: Object.freeze({
    getGatewayCreationSerial: () => 0,
    getGatewayCreatedAfter: () => gateway,
  }),
};
context.globalThis = context;
vm.runInNewContext(source, context, { filename: "production-r6-realtime-extension.js" });

const runtime = context.BRKTRKProductionAudioRuntime.createProductionAudioRuntime({ trackCount: 1 });
const existingInstrument = (id) => ({
  id,
  engineRef: { moduleId: "design.myldy.fixture", engineId: existingEngineId, resolvedVersion: "1.0.0" },
  parameterSnapshot: {},
});
const newEngineInstrument = (id) => ({
  id,
  engineRef: { moduleId: "design.myldy.future", engineId: "future-engine", resolvedVersion: "1.0.0" },
  parameterSnapshot: {},
});

assert.equal(runtime.configureInstruments({ 1: existingInstrument(1) }), true);
runtime.prepareProgram({ mode: "sequence", steps: [{ instrumentIds: [1] }] });

assert.equal(runtime.configureInstruments({ 1: existingInstrument(1), 2: existingInstrument(2) }), false, "active transport keeps the structural snapshot deferred");
assert.ok(runtime.hasInstrument(2), "primitive same-package addition must already be promoted into the active registry");
runtime.prepareProgram({ mode: "sequence", steps: [{ instrumentIds: [1] }, { instrumentIds: [2] }, { instrumentIds: [1] }] });

assert.equal(runtime.queueParameter({ instrumentId: 2, parameterId: "cutoff", value: 0.25, rampFrames: 0 }), true);
runtime.beginBlock(0, 16);
assert.deepEqual(deliveries, [{ track: 0, instrumentId: 2, handle: 1002, value: 0.25, sampleOffset: 0, rampFrames: 0 }], "the first live edit after additive promotion must resolve and reach the prepared realtime handle");
assert.equal(runtime.diagnostics().r6Realtime.promotedActiveSnapshotAdditions, 1, "realtime diagnostics must expose the promoted active Instrument view");

const beforeDeferredDeliveryCount = deliveries.length;
assert.equal(runtime.configureInstruments({ 1: existingInstrument(1), 2: existingInstrument(2), 3: newEngineInstrument(3) }), false);
assert.equal(runtime.hasInstrument(3), false, "a genuinely new engine must remain outside the active registry while transport is running");
assert.equal(runtime.queueParameter({ instrumentId: 3, parameterId: "cutoff", value: 0.75, rampFrames: 0 }), true, "deferred structural state must still retain later parameter truth");
runtime.beginBlock(16, 16);
assert.equal(deliveries.length, beforeDeferredDeliveryCount, "a deferred new-engine Instrument must not receive realtime parameter traffic before the stopped-boundary admission");
assert.equal(runtime.diagnostics().r6Realtime.promotedActiveSnapshotAdditions, 1, "new-engine deferral must not be misreported as active promotion");

const beforeReplacementEdit = deliveries.length;
assert.equal(runtime.configureInstruments({ 1: existingInstrument(1), 2: newEngineInstrument(2), 3: newEngineInstrument(3) }), false);
assert.equal(runtime.queueParameter({ instrumentId: 2, parameterId: "resonance", value: 0.6, rampFrames: 0 }), true);
runtime.beginBlock(32, 16);
assert.equal(deliveries.length, beforeReplacementEdit, "a deferred engine replacement must not reuse a promoted Instrument ID to resolve parameters against the old performer");

console.log("R6 same-package Instrument promotion + first live parameter handle + new-engine/replacement deferral regression passed");