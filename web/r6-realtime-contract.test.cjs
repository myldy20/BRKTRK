const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function fakeModule() {
  const buffer = new ArrayBuffer(4 * 1024 * 1024);
  const HEAPU8 = new Uint8Array(buffer);
  const HEAPF32 = new Float32Array(buffer);
  const view = new DataView(buffer);
  let cursor = 4096;
  let nextHandle = 10;
  const seen = [];
  return {
    HEAPU8,
    HEAPF32,
    seen,
    _malloc(size) { const ptr = cursor; cursor += Number(size); return ptr; },
    _free() {},
    _brk_abi_version() { return 0x00010000; },
    _brk_instance_create() { return ++nextHandle; },
    _brk_instance_prepare() { return 0; },
    _brk_instance_activate() { return 0; },
    _brk_instance_deactivate() { return 0; },
    _brk_instance_reset() { return 0; },
    _brk_instance_destroy() { return 0; },
    _brk_instance_state_read() { return 0; },
    _brk_instance_process(_handle, processPtr) {
      const frames = view.getUint32(processPtr + 4, true);
      const audioSpanPtr = view.getUint32(processPtr + 8, true);
      const eventPtr = view.getUint32(processPtr + 12, true);
      const eventCount = view.getUint32(processPtr + 20, true);
      let offset = eventPtr;
      for (let index = 0; index < eventCount; index += 1) {
        const size = view.getUint16(offset, true);
        seen.push({
          type: view.getUint16(offset + 2, true),
          frameOffset: view.getUint32(offset + 4, true),
          parameterId: size >= 24 ? view.getUint32(offset + 12, true) : null,
        });
        offset += size;
      }
      const outputPtr = view.getUint32(audioSpanPtr + 4, true);
      const stride = view.getUint32(audioSpanPtr + 16, true);
      const base = outputPtr >>> 2;
      for (let frame = 0; frame < frames; frame += 1) {
        HEAPF32[base + frame] = 0.125;
        HEAPF32[base + stride + frame] = 0.25;
      }
      return 0;
    },
  };
}

require("./engine-package-domain.js");
require("./brk-synth-abi-v1-worklet.js");
require("./brk-synth-prepared-state-extension.js");
const r6Abi = require("./brk-synth-r6-realtime-extension.js");

const moduleFixture = fakeModule();
const manifest = {
  moduleId: "design.myldy.r6-fixture",
  engineId: "r6-fixture",
  version: "1.0.0",
  abiVersion: "0x00010000",
  stateSchemaVersion: 1,
  stateBytes: 32,
  runtime: { maxModuleInstances: 8 },
  parameters: [{ id: "cutoff", abiId: 513, defaultNormalized: 0.5 }],
};
const record = {
  entry: { moduleId: manifest.moduleId, engineId: manifest.engineId, version: manifest.version, packageSha256: "a".repeat(64) },
  manifest,
  module: moduleFixture,
};
const factory = r6Abi.createPerformerFactory(record, { maxBlockFrames: 16, maxEventsPerPerformer: 16 });
const performer = factory({ track: 0, instrumentId: 1, sampleRate: 48000, parameterSnapshot: { cutoff: 0.5 } });
const cutoffHandle = performer.parameterHandle("cutoff");
assert.equal(cutoffHandle, 0);
performer.handlePreparedParameter(cutoffHandle, 0.25, 0, 0);

const left = new Float32Array(8);
const right = new Float32Array(8);
const saved = {
  DataView: global.DataView,
  Map: global.Map,
  freeze: Object.freeze,
  from: Array.from,
  map: Array.prototype.map,
  find: Array.prototype.find,
  filter: Array.prototype.filter,
};
function forbidden(label) { return function forbiddenRealtimeAllocation() { throw new Error(`R6 realtime allocation proxy invoked: ${label}`); }; }
try {
  global.DataView = forbidden("DataView");
  global.Map = class ForbiddenRealtimeMap { constructor() { throw new Error("R6 realtime allocation proxy invoked: Map"); } };
  Object.freeze = forbidden("Object.freeze");
  Array.from = forbidden("Array.from");
  Array.prototype.map = forbidden("Array.prototype.map");
  Array.prototype.find = forbidden("Array.prototype.find");
  Array.prototype.filter = forbidden("Array.prototype.filter");
  performer.processBlock(8, left, right, false);
} finally {
  global.DataView = saved.DataView;
  global.Map = saved.Map;
  Object.freeze = saved.freeze;
  Array.from = saved.from;
  Array.prototype.map = saved.map;
  Array.prototype.find = saved.find;
  Array.prototype.filter = saved.filter;
}
assert.ok(moduleFixture.seen.some((event) => event.type === r6Abi.EVENT.PARAM_VALUE && event.parameterId === 513));
assert.ok(left.every((value) => Math.abs(value - 0.125) < 1e-6));
assert.ok(right.every((value) => Math.abs(value - 0.25) < 1e-6));
assert.equal(performer.diagnostics().r6Realtime.dataViewRefreshes, 1, "stable WASM memory must reuse the DataView primed before process()");

const runtimeSource = fs.readFileSync("web/production-r6-realtime-extension.js", "utf8");
const gatewaySource = fs.readFileSync("web/synth-gateway-r6-realtime-extension.js", "utf8");
const performerSource = fs.readFileSync("web/brk-synth-r6-realtime-extension.js", "utf8");
const flushBody = runtimeSource.match(/function flushPendingParameters\(\) \{([\s\S]*?)\n    \}\n\n    function beginBlock/)?.[1] ?? "";
const renderBody = gatewaySource.match(/function renderTrack\([^)]*\) \{([\s\S]*?)\n    \}\n\n    function endBlock/)?.[1] ?? "";
const processBody = performerSource.match(/function processBlock\([^)]*\) \{([\s\S]*?)\n      \}\n\n      function process\(/)?.[1] ?? "";
assert.ok(flushBody.includes("pendingOrder[order]"));
assert.ok(!flushBody.includes("[..."), "R6 runtime flush must not materialize Map/Set iterables");
assert.ok(!flushBody.includes("Object.freeze"), "R6 runtime flush must not freeze command objects in process()");
assert.ok(renderBody.includes("processBlock(frames, left, right, true)"));
assert.ok(!renderBody.includes("Object.freeze"), "R6 gateway render must not allocate process-context objects");
assert.ok(!renderBody.includes("forEachTrack"), "R6 gateway render must not create per-block callback closures");
for (const forbiddenMarker of ["new Map(", "Object.freeze(", "Array.from(", ".map(", ".find(", ".filter(", "const startedRamps = []"]) {
  assert.ok(!processBody.includes(forbiddenMarker), `R6 primitive process path contains forbidden allocation marker: ${forbiddenMarker}`);
}
assert.ok(performerSource.includes("if (buffer !== cachedBuffer)"));
assert.ok(performerSource.includes("dataView(); // Prime outside AudioWorkletProcessor.process()."));

const budgetSource = fs.readFileSync("web/production-timeline-bind-budget-extension.js", "utf8");
const context = {
  console,
  Object,
  Array,
  Number,
  RangeError,
  globalThis: null,
  module: { exports: {} },
  BRKTRKProductionTimelineTemplate: { bindRelativeTimeline: (_template, startFrame) => ({ startFrame }) },
};
context.globalThis = context;
vm.runInNewContext(budgetSource, context, { filename: "production-timeline-bind-budget-extension.js" });
const budget = context.BRKTRKProductionTimelineTemplate;
const cost = budget.estimateBindCost({
  sequence: null,
  tracks: [{ rowCount: 4, rows: [{}, {}, {}, {}], schedule: [{}, {}, {}, {}] }],
  tableSources: [],
  tableEvents: [],
  summary: { tracks: [{}], tableSources: [] },
});
assert.ok(cost.workUnits > 0 && cost.workUnits <= budget.MAX_BIND_WORK_UNITS);
assert.ok(cost.allocationUnits > 0 && cost.allocationUnits <= budget.MAX_BIND_ALLOCATION_UNITS);
assert.equal(budget.bindRelativeTimeline({ tracks: [], tableSources: [], tableEvents: [], summary: { tracks: [], tableSources: [] } }, 123).startFrame, 123);
assert.ok(budgetSource.includes("prepared timeline bind budget exceeded"));

require("./production-r6-live-promotion.test.cjs");

performer.destroy();
console.log("R6 zero-allocation prepared parameter/render + bounded bind + live Instrument promotion contract passed");