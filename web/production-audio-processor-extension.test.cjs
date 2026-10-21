const assert = require("node:assert/strict");

let baseStops = 0;
const messages = [];
const runtimeRecords = [];
const prepareCalls = [];
let mode = "linear";
let prepareMustFail = false;
let beginCalls = 0;
let endCalls = 0;
let runtimeMessageCalls = 0;
const registeredPackage = Object.freeze({
  moduleId: "design.myldy.brk-wav",
  engineId: "brk-wav",
  version: "0.1.0-rc5",
  packageSha256: "43ae3453349bb98dc61d4d8267178d328f72e78c569010862f4161f50fc9d58e",
  contentSha256: "a9a3c60fd2b4ae608a997800c51b8fbc363319e7306fa799906a3cd34aabe321",
});
const newEnginePackage = Object.freeze({
  moduleId: "design.myldy.future",
  engineId: "future-engine",
  version: "1.0.0",
  packageSha256: "b".repeat(64),
  contentSha256: "c".repeat(64),
});
let registeredPackages = [registeredPackage];
let registerNewRuntimeOnSnapshot = false;
const activeRegistryPackages = [registeredPackage];
const addressableInstruments = new Set([1]);
const existingInstrument = (id) => ({
  id,
  engineRef: { moduleId: registeredPackage.moduleId, engineId: registeredPackage.engineId, resolvedVersion: registeredPackage.version },
});
const newEngineInstrument = (id) => ({
  id,
  engineRef: { moduleId: newEnginePackage.moduleId, engineId: newEnginePackage.engineId, resolvedVersion: newEnginePackage.version },
});

globalThis.sampleRate = 48000;
globalThis.BRKTRKProductionAudioRuntime = Object.freeze({
  MAX_BLOCK_FRAMES: 2048,
  createProductionAudioRuntime() {
    const record = { begin: null, renderedTrackMix: null, endCount: 0 };
    runtimeRecords.push(record);
    return {
      handleMessage: (message) => {
        runtimeMessageCalls += 1;
        if (message?.type !== "production-instruments") return false;
        for (const [idText, instrument] of Object.entries(message.instruments ?? {})) {
          const id = Number(idText);
          if (instrument?.engineRef?.engineId === registeredPackage.engineId) addressableInstruments.add(id);
          if (instrument?.engineRef?.engineId === newEnginePackage.engineId && registerNewRuntimeOnSnapshot) registeredPackages = [registeredPackage, newEnginePackage];
        }
        return true;
      },
      diagnostics: () => Object.freeze({
        registeredPackages: Object.freeze([...registeredPackages]),
        activeRegistryPackages: Object.freeze([...activeRegistryPackages]),
        pendingInstrumentSync: registeredPackages.length !== activeRegistryPackages.length,
        transportActive: false,
      }),
      hasInstrument: (id) => (addressableInstruments.has(Number(id)) ? registeredPackage.engineId : false),
      prepareProgram: (program) => {
        prepareCalls.push(program);
        if (prepareMustFail) throw Object.assign(new Error("fixture registry refresh would stop transport"), { code: "engine-registry-refresh-boundary" });
        return true;
      },
      routeTracePacket: () => new Set(),
      hasProductionInstruments: () => true,
      hasPreparedPerformers: () => true,
      beginBlock(startFrame, frameCount) {
        beginCalls += 1;
        record.begin = { startFrame, frameCount };
      },
      endBlock() {
        endCalls += 1;
        record.endCount += 1;
      },
      renderInto(left, right, trackMix) {
        record.renderedTrackMix = trackMix;
        left[0] = 2;
        right[0] = -1.5;
        left[1] = 0.25;
        right[1] = 0.5;
      },
      stop() {
        if (mode !== "cleanup-error") return;
        const error = new Error("fixture destroy failed");
        error.code = "fixture-destroy-failed";
        throw error;
      },
    };
  },
});
globalThis.BRKTRKEventTraceDomain = Object.freeze({ buildFramePacket: () => Object.freeze({ events: Object.freeze([]) }) });

class BaseProcessor {
  constructor() {
    this.voices = [{}];
    this.trackMix = [{ gain: 1, pan: 0, mute: false }];
    this.playing = true;
    this.mode = "sequence";
    this.sequence = [{ instrumentIds: [1] }, { instrumentIds: [2] }, { instrumentIds: [1] }];
    this.trackPrograms = [{ active: true, events: [] }];
    this.meterCounter = 1;
    this.transportIdentity = Object.freeze({ id: "fixture-transport", version: 1 });
    this.port = {
      onmessage() {},
      postMessage(message) { messages.push(message); },
    };
  }

  currentBlockStartFrame() { return 0; }
  process() { return true; }
  startSequence() {}
  startPlan() {}
  updateSequence() {}
  updatePlan() {}
  processTimelineLifecycle(_frame, packet) { return packet; }

  stop(transport) {
    baseStops += 1;
    this.playing = false;
    this.port.postMessage({ type: "transport-stopped", transport });
  }
}

const extension = require("./production-audio-processor-extension.js");
const Processor = extension.extendProcessor(BaseProcessor);

const renderProcessor = new Processor();
renderProcessor.port.onmessage({ data: { type: "production-package-registry-request", requestId: "registry-7" } });
const registryResponse = messages.find((message) => message.type === "production-package-registry");
assert.deepEqual(registryResponse, {
  type: "production-package-registry",
  requestId: "registry-7",
  packages: [registeredPackage],
  pendingInstrumentSync: false,
  transportActive: false,
  // No package failed to register in this scope; the probe says so explicitly
  // so the host can tell "not yet" from "never" (worklet-failure-evidence.test.cjs).
  registrationFailures: [],
}, "processor must correlate exact active EngineRegistry identity and current Instrument-sync state");
assert.equal(runtimeMessageCalls, 0, "registry probes must be handled by the processor extension rather than falling through as runtime control messages");

// --- ABI descriptors cross the Worklet boundary ------------------------------
// The module instance exists only in the Worklet; the Sound surface renders on
// the main thread. Without this the host cannot know a parameter's real range
// or unit and can only print a percentage (#455).
globalThis.BRKTRKBrkSynthAbiV1Runtime = Object.freeze({
  runtimeRecords: () => [
    {
      entry: { moduleId: registeredPackage.moduleId, engineId: registeredPackage.engineId, version: registeredPackage.version, packageSha256: registeredPackage.packageSha256 },
      abiDescriptors: {
        engine: { engineId: registeredPackage.engineId, parameterCount: 1, maxPolyphony: 8 },
        parameters: [{ key: "cutoff", abiId: 0x0202, unit: "Hz", groupKey: "filter", plainMin: 30, plainMax: 18000, plainStep: 0 }],
      },
    },
    // An engine that predates the descriptor calls reports nothing. It must be
    // absent from the response rather than crossing as an empty parameter set,
    // which the main thread would be entitled to believe.
    { entry: { moduleId: newEnginePackage.moduleId, engineId: newEnginePackage.engineId, version: newEnginePackage.version, packageSha256: newEnginePackage.packageSha256 }, abiDescriptors: null },
  ],
});

renderProcessor.port.onmessage({ data: { type: "production-engine-descriptors-request", requestId: "abi-3" } });
const descriptorResponse = messages.find((message) => message.type === "production-engine-descriptors");
assert.ok(descriptorResponse, "processor must answer a descriptor probe");
assert.equal(descriptorResponse.requestId, "abi-3", "descriptor response must correlate with its request");
assert.equal(descriptorResponse.engines.length, 1, "only engines that actually reported descriptors may cross");
assert.equal(descriptorResponse.engines[0].engineId, registeredPackage.engineId, "descriptors must carry the engine they came from");
assert.equal(
  descriptorResponse.engines[0].packageSha256,
  registeredPackage.packageSha256,
  "descriptors must carry full package identity so ranges cannot be attached to another engine's controls",
);
assert.equal(descriptorResponse.engines[0].parameters[0].unit, "Hz", "the unit must survive the crossing");
assert.equal(descriptorResponse.engines[0].parameters[0].plainMax, 18000, "the plain range must survive the crossing");
assert.equal(runtimeMessageCalls, 0, "descriptor probes must not fall through as runtime control messages");

// A host whose ABI runtime is absent entirely must answer, not throw: the
// probe is presentation truth and must never take the audio path down.
const savedAbiRuntime = globalThis.BRKTRKBrkSynthAbiV1Runtime;
globalThis.BRKTRKBrkSynthAbiV1Runtime = undefined;
renderProcessor.port.onmessage({ data: { type: "production-engine-descriptors-request", requestId: "abi-4" } });
const emptyResponse = messages.find((message) => message.type === "production-engine-descriptors" && message.requestId === "abi-4");
assert.deepEqual(emptyResponse?.engines, [], "a missing ABI runtime must answer with no engines rather than throwing");
globalThis.BRKTRKBrkSynthAbiV1Runtime = savedAbiRuntime;

renderProcessor.port.onmessage({ data: { type: "production-instruments", instruments: { 1: existingInstrument(1), 2: existingInstrument(2) } } });
assert.equal(runtimeMessageCalls, 1, "Instrument snapshots must still be owned by the production runtime");
assert.deepEqual(prepareCalls, [{ mode: "sequence", steps: renderProcessor.sequence }], "a same-package additive Instrument promoted into the active registry must immediately reprepare the authoritative current program");

renderProcessor.port.onmessage({
  data: {
    type: "production-instruments",
    instruments: {
      1: existingInstrument(1),
      2: existingInstrument(2),
      3: newEngineInstrument(3),
      4: existingInstrument(4),
    },
  },
});
assert.equal(runtimeMessageCalls, 2);
assert.equal(prepareCalls.length, 2, "a mixed snapshot must admit its same-package Instrument through the decorated runtime while the new-engine Instrument remains deferred");
assert.equal(baseStops, 0);
assert.equal(renderProcessor.playing, true);

// Capacity/performer rejection of the bounded live refresh is evidence, not a
// reason to stop the already valid current transport. The full snapshot remains
// pending for the stopped boundary and there is exactly one refresh attempt.
prepareMustFail = true;
renderProcessor.port.onmessage({
  data: {
    type: "production-instruments",
    instruments: {
      1: existingInstrument(1),
      2: existingInstrument(2),
      3: newEngineInstrument(3),
      4: existingInstrument(4),
      5: existingInstrument(5),
    },
  },
});
assert.equal(runtimeMessageCalls, 3);
assert.equal(prepareCalls.length, 3, "live promotion must make one bounded decorated refresh attempt");
assert.equal(baseStops, 0, "rejected live Instrument admission must not stop the current transport");
assert.equal(renderProcessor.playing, true);
assert.ok(messages.some((message) =>
  message.type === "production-transport-rejected"
  && message.code === "engine-registry-refresh-boundary"
  && message.stoppedTransport === false
), "non-fatal live-admission rejection must remain observable");
prepareMustFail = false;

// If addModule has already moved the registered runtime set beyond the active
// registry, even the compatible addition waits for Stop; no wrapper may refresh
// against mixed registry generations.
registerNewRuntimeOnSnapshot = true;
renderProcessor.port.onmessage({
  data: {
    type: "production-instruments",
    instruments: {
      1: existingInstrument(1),
      2: existingInstrument(2),
      3: newEngineInstrument(3),
      4: existingInstrument(4),
      5: existingInstrument(5),
      6: newEngineInstrument(6),
      7: existingInstrument(7),
    },
  },
});
assert.equal(runtimeMessageCalls, 4);
assert.equal(prepareCalls.length, 3, "registered-runtime drift must retain the stopped-boundary rule");
assert.equal(baseStops, 0);
assert.equal(renderProcessor.playing, true);

const left = new Float32Array(2);
const right = new Float32Array(2);
assert.equal(renderProcessor.process([], [[left, right]]), true);
const renderRecord = runtimeRecords[0];
assert.equal(beginCalls, 1);
assert.equal(endCalls, 1);
assert.deepEqual(renderRecord.begin, { startFrame: 0, frameCount: 2 });
assert.equal(renderRecord.renderedTrackMix, renderProcessor.trackMix, "registered production processor must pass the live Track Mix object to renderInto");
assert.equal(renderRecord.endCount, 1, "successful production render must close the same block");
assert.deepEqual([...left], [2, 0.25], "host must not clamp, saturate or otherwise color the production Track-bus signal");
assert.deepEqual([...right], [-1.5, 0.5], "linear host output must preserve signed production samples exactly");
assert.ok(left.some((value) => value !== 0) && right.some((value) => value !== 0), "production render result must reach the registered processor output");
assert.equal(messages.some((message) => message.type === "production-engine-error"), false);

mode = "cleanup-error";
assert.doesNotThrow(() => renderProcessor.stop(renderProcessor.transportIdentity));
assert.equal(baseStops, 1, "base transport stop must run even when production performer cleanup fails");
assert.equal(renderProcessor.playing, false);
assert.ok(messages.some((message) => message.type === "production-engine-error" && message.code === "fixture-destroy-failed"));
assert.ok(messages.some((message) => message.type === "transport-stopped"), "transport stop acknowledgement must remain observable");

console.log("M5A production processor decorated live Instrument refresh + mixed new-engine deferral + non-fatal capacity fallback + linear-output + teardown + Track Mix render wiring passed");