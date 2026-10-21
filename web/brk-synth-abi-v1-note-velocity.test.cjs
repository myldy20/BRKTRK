const assert = require("node:assert/strict");
const abi = require("./brk-synth-abi-v1-worklet.js");

// Owner physical report 2026-09-21 on candidate c740c5a: note velocity had no
// audible effect. The host turned out to encode it correctly, but nothing in
// this repository proved that, so a host-side regression that zeroed or
// constant-ed velocity would have shipped green and been indistinguishable
// from the engine ignoring it.
//
// The existing ABI tests decode NOTE_ON events for type/frameOffset/noteId and
// never read the velocity field, so this covers the value itself.

const VELOCITY_OFFSET = 20;
const PITCH_OFFSET = 16;

let harnessSeq = 0;
function harness() {
  harnessSeq += 1;
  const buffer = new ArrayBuffer(2 * 1024 * 1024);
  const HEAPU8 = new Uint8Array(buffer);
  const HEAPF32 = new Float32Array(buffer);
  const notes = [];
  let cursor = 4096;
  let nextHandle = 1;
  const wasm = {
    HEAPU8,
    HEAPF32,
    notes,
    _malloc(size) { const ptr = cursor; cursor += Number(size); return ptr; },
    _free() {},
    _brk_abi_version() { return abi.ABI_VERSION; },
    _brk_instance_create() { return nextHandle++; },
    _brk_instance_prepare() { return 0; },
    _brk_instance_activate() { return 0; },
    _brk_instance_deactivate() { return 0; },
    _brk_instance_reset() { return 0; },
    _brk_instance_destroy() { return 0; },
    _brk_instance_state_read() { return 0; },
    _brk_instance_process(_handle, processPtr) {
      const dv = new DataView(buffer);
      const frames = dv.getUint32(processPtr + 4, true);
      const audioSpanPtr = dv.getUint32(processPtr + 8, true);
      const eventPtr = dv.getUint32(processPtr + 12, true);
      const eventCount = dv.getUint32(processPtr + 20, true);
      let offset = eventPtr;
      for (let index = 0; index < eventCount; index += 1) {
        const size = dv.getUint16(offset, true);
        const type = dv.getUint16(offset + 2, true);
        notes.push({
          type,
          pitch: dv.getFloat32(offset + PITCH_OFFSET, true),
          velocity: dv.getFloat32(offset + VELOCITY_OFFSET, true),
        });
        offset += size;
      }
      const outputPtr = dv.getUint32(audioSpanPtr + 4, true);
      const stride = dv.getUint32(audioSpanPtr + 16, true);
      const base = outputPtr >>> 2;
      for (let frame = 0; frame < frames; frame += 1) {
        HEAPF32[base + frame] = 0;
        HEAPF32[base + stride + frame] = 0;
      }
      return 0;
    },
  };
  const entry = {
    moduleId: `design.myldy.note-velocity-${harnessSeq}`,
    engineId: "note-velocity",
    version: "1.0.0",
    packageSha256: "a".repeat(64),
  };
  const record = abi.registerModuleRuntime({
    entry,
    manifest: {
      moduleId: entry.moduleId,
      engineId: entry.engineId,
      version: entry.version,
      abiVersion: "0x00010000",
      stateSchemaVersion: 1,
      contentSha256: "b".repeat(64),
      stateBytes: 32,
      runtime: { maxModuleInstances: 4 },
      parameters: [],
    },
    module: wasm,
  });
  const factory = abi.createPerformerFactory(record, { maxBlockFrames: 16, maxEventsPerPerformer: 8 });
  const performer = factory({ track: 0, instrumentId: 0, sampleRate: 48000, parameterSnapshot: {} });
  const render = () => performer.process({ frameCount: 8, left: new Float32Array(8), right: new Float32Array(8) });
  return { wasm, performer, render };
}

// The exact velocities from the owner's phrase 00 in the rejected candidate.
const OWNER_VELOCITIES = [58, 28, 100, 32];

const { wasm, performer, render } = harness();
for (const velocity of OWNER_VELOCITIES) {
  performer.handlePreparedLifecycle("note-on", 0, 48, velocity);
  render();
  performer.handlePreparedLifecycle("note-off", 1, 48, velocity);
  render();
}

const triggers = wasm.notes.filter((event) => event.type === abi.EVENT.NOTE_ON);
assert.equal(triggers.length, OWNER_VELOCITIES.length, "every prepared note-on must reach the engine as one NOTE_ON event");

OWNER_VELOCITIES.forEach((velocity, index) => {
  const expected = velocity / 127;
  const actual = triggers[index].velocity;
  assert.ok(
    Math.abs(actual - expected) < 1e-6,
    `NOTE_ON ${index} must carry velocity ${velocity}/127 = ${expected}, got ${actual}`,
  );
});

// The failure this guards against is not only a wrong value but a constant
// one: a host that always sent 100 would satisfy a single-velocity assertion
// while making every note sound identical, which is exactly the reported
// symptom.
const distinct = new Set(triggers.map((event) => event.velocity.toFixed(9)));
assert.equal(distinct.size, OWNER_VELOCITIES.length, "distinct musical velocities must stay distinct at the engine boundary");

// Velocity must not be quietly full-scaled either: 58/127 is well below 1.
assert.ok(triggers[0].velocity < 0.5, "a mezzo-piano velocity must not arrive at full scale");
assert.ok(triggers[2].velocity > triggers[3].velocity, "a louder musical velocity must encode above a quieter one");

// Release and retrigger carry the velocity of the note they act on; the point
// is that they are finite and in range, not that they equal the trigger.
for (const event of wasm.notes) {
  assert.ok(Number.isFinite(event.velocity), `${event.type} velocity must be finite`);
  assert.ok(event.velocity >= 0 && event.velocity <= 1, `${event.type} velocity must be normalized into 0..1`);
}

// The ABI normalizes and clamps into 0..1; it does not invent a musical floor.
// The 1..127 musical floor belongs to the gateway one layer above
// (synth-gateway-domain.js normalizedPreparedVelocity), so a raw 0 handed
// straight to the ABI legitimately encodes as 0. Asserting the real split
// keeps a future gateway regression visible instead of masked here.
const extremes = harness();
extremes.performer.handlePreparedLifecycle("note-on", 0, 60, 0);
extremes.render();
extremes.performer.handlePreparedLifecycle("note-off", 1, 60, 0);
extremes.render();
extremes.performer.handlePreparedLifecycle("note-on", 0, 60, 4096);
extremes.render();
const extremeTriggers = extremes.wasm.notes.filter((event) => event.type === abi.EVENT.NOTE_ON);
assert.equal(extremeTriggers[0].velocity, 0, "the ABI normalizes velocity without inventing a floor");
assert.equal(extremeTriggers[1].velocity, 1, "an over-range velocity must clamp to full scale, never exceed it");


console.log("BRK Synth ABI v1 note velocity reaches the engine boundary intact");
