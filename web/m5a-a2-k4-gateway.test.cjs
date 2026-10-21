const assert = require("node:assert/strict");

require("./timing-domain.js");
require("./note-lifecycle-domain.js");
require("./phrase-fx-domain.js");
require("./phrase-fx-runtime-domain.js");
const compiler = require("./event-plan-compiler.js");
const trace = require("./event-trace-domain.js");
const packageDomain = require("./engine-package-domain.js");
const engineRegistryDomain = require("./engine-registry-domain.js");
const performerRegistryDomain = require("./performer-registry-domain.js");
const synthGatewayDomain = require("./synth-gateway-domain.js");

const HASH = "a".repeat(64);
const ARTIFACT_HASH = "b".repeat(64);
const CONTENT_HASH = "c".repeat(64);
const engineIdentity = {
  moduleId: "design.myldy.a2-k4",
  engineId: "reference",
  version: "1.0.0",
};
const hostContract = { id: packageDomain.HOST_CONTRACT_ID, minVersion: 1, maxVersion: 1 };
const manifest = {
  schema: packageDomain.PACKAGE_FORMAT,
  ...engineIdentity,
  hostContract,
  abiVersion: "0x00010000",
  stateSchemaVersion: 1,
  parameterSchemaVersion: 1,
  contentSha256: CONTENT_HASH,
  files: [{ path: "reference.bin", kind: "test", bytes: 1, sha256: ARTIFACT_HASH }],
  parameters: [{ id: "level", type: "float", min: 0, max: 1, default: 1 }],
};
const entry = {
  ...engineIdentity,
  channel: "stable",
  hostContract,
  abiVersion: "0x00010000",
  packageUrl: "fixture://a2-k4-reference",
  packageSha256: HASH,
  stateSchemaVersion: 1,
  parameterSchemaVersion: 1,
  status: "active",
};

const EMPTY = -1;
const model = {
  phrases: {
    0: Array.from({ length: 16 }, (_, row) => ({
      note: row === 0 ? 64 : EMPTY,
      velocity: row === 0 ? 73 : 100,
      instrument: row === 0 ? 3 : EMPTY,
      fx: row === 0
        ? [{ command: 0x05, value: 0x10 }, { command: 0, value: 0 }, { command: 0, value: 0 }]
        : [{ command: 0, value: 0 }, { command: 0, value: 0 }, { command: 0, value: 0 }],
    })),
  },
};

const program = compiler.compilePhraseProgram({
  model,
  origin: { track: 2, phraseId: 0, songRow: 0, chainId: 0, chainRow: 0 },
  trackCount: 8,
});
assert.equal(program.steps[0].instrumentIds[2], 3, "canonical sequence transport must retain Instrument identity");
assert.equal(program.steps[0].velocities[2], 73, "canonical sequence transport must retain exact Velocity");

const packet = trace.buildFramePacket({
  frame: 1000,
  program,
  rowEvents: [{
    kind: "sequence",
    row: 0,
    phraseRow: 0,
    sourceOrder: 0,
    timing: { sampleRate: 48000, ppqn: 24, tempo: 120 },
  }],
  trackCount: 8,
});
const trigger = packet.events.find((event) => event.track === 2 && event.kind === "note-trigger");
assert.ok(trigger, "canonical K4 trace must emit the Note Trigger");
assert.equal(trigger.data.instrumentId, 3, "K4 Note Trigger must carry durable Instrument identity");
assert.equal(trigger.data.velocity, 73, "K4 Note Trigger must carry exact Velocity");
assert.equal(trigger.data.note, 64);
const retrigger = packet.futureEvents.find((event) => event.track === 2 && event.kind === "note-trigger" && event.data.retrigger === true);
assert.ok(retrigger, "RET must compile into a future K4 Note Trigger");
assert.equal(retrigger.data.resetsPhase, true, "RET must retain explicit phase-reset semantics at the host trace boundary");
assert.equal(retrigger.data.instrumentId, 3, "RET must retain durable Instrument identity");

const capturedActions = [];
const engineRegistry = engineRegistryDomain.createEngineRegistry({ abiVersions: ["0x00010000"] });
engineRegistry.register({ entry, manifest }, () => ({
  handleEvent(action) { capturedActions.push(action); },
  process() {},
  reset() {},
}));
const instrument = {
  id: 3,
  engineRef: { moduleId: engineIdentity.moduleId, engineId: engineIdentity.engineId, resolvedVersion: engineIdentity.version },
  patchState: { schemaVersion: 1, encoding: "json", data: {} },
  parameterSnapshot: { level: 1 },
};
const performers = performerRegistryDomain.createPerformerRegistry({
  engineRegistry,
  instrumentProvider: (id) => id === 3 ? instrument : null,
  sampleRate: 48000,
});
assert.ok(performers.prepare(2, 3));

const gateway = synthGatewayDomain.createSynthGateway({ performerRegistry: performers, sampleRate: 48000, maxEventsPerBlock: 32 });
gateway.beginBlock(1000, 1);
gateway.routeTracePacket(packet);
gateway.endBlock();
const noteOnAction = capturedActions.find((action) => action.type === "note-on");
assert.ok(noteOnAction, "real canonical K4 packet must reach the generic SynthGateway performer");
assert.equal(noteOnAction.instrumentId, 3);
assert.equal(noteOnAction.velocity, 73);
assert.equal(noteOnAction.pitch, 64);
assert.equal(noteOnAction.sampleOffset, 0);

gateway.beginBlock(retrigger.frame, 1);
gateway.routeTracePacket(Object.freeze({
  version: packet.version,
  frame: retrigger.frame,
  events: Object.freeze([{ ...retrigger, ordinal: 1 }]),
}));
gateway.endBlock();
const retriggerAction = capturedActions.find((action) => action.type === "retrigger");
assert.ok(retriggerAction, "RET must reach the generic SynthGateway performer as a retrigger action");
assert.equal(retriggerAction.instrumentId, 3);
assert.equal(retriggerAction.pitch, 64);
assert.equal(retriggerAction.sampleOffset, 0);
assert.equal(retriggerAction.resetPhase, true, "RET reset intent must survive K4 -> SynthGateway routing");

console.log("M5A A2 canonical EventPlan -> K4 -> SynthGateway path passed");
