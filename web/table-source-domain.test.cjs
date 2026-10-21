const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const tables = require("./table-source-domain.js");

const eventFrames = (map) => map.events.map((event) => event.frame);
const eventRows = (map) => map.events.map((event) => event.tableRow);

assert.deepEqual(tables.normalizeTic("00"), { value: 0, hex: "00", clockClass: "trigger", ticksPerRow: null });
assert.equal(tables.normalizeTic("01").clockClass, tables.CLOCK_CLASSES.MUSICAL);
assert.equal(tables.normalizeTic("FB").ticksPerRow, 0xfb);
assert.equal(tables.normalizeTic("FC").clockClass, tables.CLOCK_CLASSES.OCTAVE_MAP);
assert.equal(tables.normalizeTic("FD").clockClass, tables.CLOCK_CLASSES.VELOCITY_MAP);
assert.equal(tables.normalizeTic("FE").clockClass, tables.CLOCK_CLASSES.NOTE_MAP);
assert.equal(tables.normalizeTic("FF").clockClass, tables.CLOCK_CLASSES.DETACHED);
assert.throws(() => tables.normalizeTic("GG"), /byte number/);

const base = {
  sampleRate: 48000,
  tempo: 120,
  ppqn: 24,
  track: 0,
  sourceKind: "instrument",
  sourceId: 2,
  table: 2,
  instance: 0,
  sourceOrder: 0,
  startFrame: 100,
  endFrame: 10000,
  column: "noteVolume",
  tic: "02",
  eventCount: 4,
  anchorPolicy: "at-start",
  emissionPolicy: "emit-then-advance",
};
const musical = tables.compileTableColumnMap(base);
assert.deepEqual(eventFrames(musical), [100, 2100, 4100, 6100]);
assert.deepEqual(eventRows(musical), [0, 1, 2, 3]);
assert.deepEqual(musical.events.map((event) => event.cursorAfter), [1, 2, 3, 4]);
assert.deepEqual(musical.lifetime, { startInclusive: true, endExclusive: true });

const musicalAfter = tables.compileTableColumnMap({ ...base, anchorPolicy: "after-interval" });
assert.deepEqual(eventFrames(musicalAfter), [2100, 4100, 6100, 8100]);

const detached = tables.compileTableColumnMap({
  ...base,
  sampleRate: 44100,
  startFrame: 0,
  endFrame: 2000,
  tic: "FF",
  eventCount: 4,
});
assert.deepEqual(eventFrames(detached), [0, 221, 441, 662]);

const trigger = tables.compileTableColumnMap({
  ...base,
  startFrame: 0,
  endFrame: 1000,
  tic: "00",
  triggerFrames: [100, 100, 300],
  eventCount: undefined,
  anchorPolicy: undefined,
});
assert.deepEqual(eventFrames(trigger), [100, 100, 300]);
assert.deepEqual(eventRows(trigger), [0, 1, 2]);
const triggerAdvance = tables.compileTableColumnMap({
  ...base,
  startFrame: 0,
  endFrame: 1000,
  tic: "00",
  triggerFrames: [100, 100, 300],
  eventCount: undefined,
  anchorPolicy: undefined,
  emissionPolicy: "advance-then-emit",
});
assert.deepEqual(eventRows(triggerAdvance), [1, 2, 3]);

const mappedPreserve = tables.compileTableColumnMap({
  ...base,
  startFrame: 0,
  endFrame: 1000,
  tic: "FC",
  mappedCursorPolicy: "preserve",
  mappedEvents: [
    { frame: 0, row: 7, carrierValue: 4 },
    { frame: 500, row: 4, carrierValue: 2 },
  ],
  initialCursor: 2,
  emissionPolicy: undefined,
  eventCount: undefined,
  anchorPolicy: undefined,
});
assert.deepEqual(eventRows(mappedPreserve), [7, 4]);
assert.deepEqual(mappedPreserve.events.map((event) => [event.cursorBefore, event.cursorAfter]), [[2, 2], [2, 2]]);
assert.deepEqual(mappedPreserve.events.map((event) => event.carrierValue), [4, 2]);

const mappedExplicit = tables.compileTableColumnMap({
  ...base,
  startFrame: 0,
  endFrame: 1000,
  tic: "FD",
  mappedCursorPolicy: "explicit",
  mappedEvents: [
    { frame: 0, row: 12, cursor: 5, carrierValue: 100 },
    { frame: 500, row: 3, cursor: 1, carrierValue: 20 },
  ],
  emissionPolicy: undefined,
  eventCount: undefined,
  anchorPolicy: undefined,
});
assert.deepEqual(eventRows(mappedExplicit), [12, 3]);
assert.deepEqual(mappedExplicit.events.map((event) => event.cursorAfter), [5, 1]);
assert.equal(mappedExplicit.finalCursor, 1);
assert.throws(() => tables.compileTableColumnMap({
  ...base,
  startFrame: 0,
  endFrame: 1000,
  tic: "FE",
  mappedCursorPolicy: "explicit",
  mappedEvents: [{ frame: 0, row: 1 }],
  emissionPolicy: undefined,
  eventCount: undefined,
  anchorPolicy: undefined,
}), /cursor/);

const shortened = tables.compileTableColumnMap({
  ...base,
  cursorRows: [0, 1, 2, 1],
  eventCount: 6,
});
assert.deepEqual(eventRows(shortened), [0, 1, 2, 1, 0]);
assert.equal(shortened.events.length, 5, "end-exclusive lifetime must truncate generated carriers");

const source = tables.compileTableSourceMap({
  sampleRate: 48000,
  tempo: 120,
  ppqn: 24,
  track: 0,
  sourceKind: "instrument",
  sourceId: 3,
  table: 3,
  instance: 0,
  sourceOrder: 0,
  startFrame: 0,
  endFrame: 5000,
  columns: {
    noteVolume: { tic: "01", eventCount: 4, anchorPolicy: "at-start", emissionPolicy: "emit-then-advance" },
    fx1: { tic: "02", eventCount: 3, anchorPolicy: "at-start", emissionPolicy: "emit-then-advance" },
    fx2: { tic: "00", triggerFrames: [500, 2500], emissionPolicy: "emit-then-advance" },
    fx3: { tic: "FF", eventCount: 3, anchorPolicy: "at-start", emissionPolicy: "emit-then-advance" },
  },
});
assert.deepEqual(Object.keys(source.columns), ["noteVolume", "fx1", "fx2", "fx3"]);
assert.deepEqual(source.events.filter((event) => event.frame === 0).map((event) => event.column), ["noteVolume", "fx1", "fx3"]);
assert.deepEqual(eventFrames(source.columns.noteVolume), [0, 1000, 2000, 3000]);
assert.deepEqual(eventFrames(source.columns.fx1), [0, 2000, 4000]);
assert.deepEqual(eventFrames(source.columns.fx2), [500, 2500]);
assert.deepEqual(eventFrames(source.columns.fx3), [0, 240, 480]);

const trace = tables.compileTableSourceTrace(source);
const atZero = trace.filter((event) => event.frame === 0);
assert.deepEqual(atZero.map((event) => [event.phase, event.kind, event.data.column ?? null]), [
  [100, "table-source-start", null],
  [200, "table-row-evaluate", "noteVolume"],
  [200, "table-row-evaluate", "fx1"],
  [200, "table-row-evaluate", "fx3"],
]);
assert.equal(trace.at(-1).kind, "table-source-end");
assert.equal(trace.at(-1).frame, 5000);
assert.equal(tables.serializeTableSourceTrace(trace), tables.serializeTableSourceTrace(tables.compileTableSourceTrace(source)));

const sources = tables.compileTableSourceMaps({
  sampleRate: 48000,
  sources: [
    {
      track: 1,
      sourceKind: "auxiliary",
      sourceId: 7,
      table: 12,
      instance: 2,
      sourceOrder: 1,
      startFrame: 200,
      endFrame: 3000,
      columns: { fx1: { tic: "FF", eventCount: 4, anchorPolicy: "at-start", emissionPolicy: "emit-then-advance" } },
    },
    {
      track: 0,
      sourceKind: "instrument",
      sourceId: 1,
      table: 1,
      instance: 0,
      sourceOrder: 0,
      startFrame: 0,
      endFrame: 3000,
      columns: { noteVolume: { tic: "01", eventCount: 3, anchorPolicy: "at-start", emissionPolicy: "emit-then-advance" } },
    },
  ],
});
assert.deepEqual(sources.map((map) => [map.track, map.sourceKind, map.sourceId]), [[0, "instrument", 1], [1, "auxiliary", 7]]);
assert.notEqual(sources[0].events.length, 0);
assert.notEqual(sources[1].events.length, 0);

assert.throws(() => tables.compileTableSourceMaps({
  sampleRate: 48000,
  sources: [
    { track: 0, sourceKind: "instrument", sourceId: 1, table: 1, instance: 0, sourceOrder: 0, startFrame: 0, endFrame: 1000, columns: { noteVolume: { tic: 1, eventCount: 1, anchorPolicy: "at-start", emissionPolicy: "emit-then-advance" } } },
    { track: 0, sourceKind: "auxiliary", sourceId: 2, table: 2, instance: 0, sourceOrder: 0, startFrame: 0, endFrame: 1000, columns: { noteVolume: { tic: 1, eventCount: 1, anchorPolicy: "at-start", emissionPolicy: "emit-then-advance" } } },
  ],
}), /duplicate Table sourceOrder/);
assert.throws(() => tables.compileTableSourceMap({
  sampleRate: 48000,
  track: 0,
  sourceKind: "instrument",
  sourceId: 1,
  table: 1,
  startFrame: 0,
  endFrame: 1000,
  columns: { fx1: { tic: "01", eventCount: 2, anchorPolicy: "at-start", emissionPolicy: "emit-then-advance", ticChanges: [] } },
}), /unresolved/);
assert.throws(() => tables.compileTableColumnMap({ ...base, emissionPolicy: undefined }), /emissionPolicy/);
assert.throws(() => tables.compileTableColumnMap({ ...base, anchorPolicy: undefined }), /anchorPolicy/);
assert.throws(() => tables.compileTableColumnMap({
  ...base,
  startFrame: 0,
  endFrame: 1000,
  tic: "00",
  triggerFrames: [999, 1000],
  eventCount: undefined,
  anchorPolicy: undefined,
}), /lifetime/);
assert.throws(() => tables.compileTableColumnMap({
  ...base,
  startFrame: 0,
  endFrame: 1000,
  tic: "FC",
  mappedCursorPolicy: undefined,
  mappedEvents: [{ frame: 0, row: 2 }],
  emissionPolicy: undefined,
  eventCount: undefined,
  anchorPolicy: undefined,
}), /mappedCursorPolicy/);
assert.throws(() => tables.serializeTableSourceMap({ bad: undefined }), /unsupported Table source value/);

const serialized = tables.serializeTableSourceMap(source);
assert.equal(serialized, tables.serializeTableSourceMap(tables.compileTableSourceMap({
  sampleRate: 48000,
  tempo: 120,
  ppqn: 24,
  track: 0,
  sourceKind: "instrument",
  sourceId: 3,
  table: 3,
  instance: 0,
  sourceOrder: 0,
  startFrame: 0,
  endFrame: 5000,
  columns: {
    noteVolume: { tic: "01", eventCount: 4, anchorPolicy: "at-start", emissionPolicy: "emit-then-advance" },
    fx1: { tic: "02", eventCount: 3, anchorPolicy: "at-start", emissionPolicy: "emit-then-advance" },
    fx2: { tic: "00", triggerFrames: [500, 2500], emissionPolicy: "emit-then-advance" },
    fx3: { tic: "FF", eventCount: 3, anchorPolicy: "at-start", emissionPolicy: "emit-then-advance" },
  },
})), "same Table source input must serialize byte-identically");

const golden = JSON.parse(readFileSync(require.resolve("../docs/fixtures/k3b-table-source-golden.json"), "utf8"));
const compactColumn = (map) => ({
  frames: map.events.map((event) => event.frame),
  rows: map.events.map((event) => event.tableRow),
  cursorBefore: map.events.map((event) => event.cursorBefore),
  cursorAfter: map.events.map((event) => event.cursorAfter),
  finalCursor: map.finalCursor,
});
assert.deepEqual(compactColumn(tables.compileTableColumnMap({ ...base, startFrame: 0, endFrame: 10000, tic: "02", eventCount: 5 })), golden.musical02);
assert.deepEqual(compactColumn(tables.compileTableColumnMap({ ...base, sampleRate: 44100, startFrame: 0, endFrame: 10000, tic: "FF", eventCount: 5 })), golden.detachedFF);
assert.equal(golden.contract.tableRows, tables.TABLE_ROWS);
assert.equal(golden.contract.ticClasses.FF, tables.CLOCK_CLASSES.DETACHED);

console.log("K3B deterministic Table source-map tests passed");