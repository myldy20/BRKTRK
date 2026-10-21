const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const timingDomain = require("./timing-domain.js");
const maps = require("./timing-map-domain.js");

const frames = (map, key = "boundaryFrame") => map.rows.map((row) => row[key]);

for (const sampleRate of [44100, 48000, 96000]) {
  for (const tempo of [30, 120, 300]) {
    const map = maps.compileTrackTimingMap({ sampleRate, tempo, rowCount: 4096 });
    const clock = timingDomain.createMusicalFrameClock({
      sampleRate,
      tempo,
      stepUnits: timingDomain.TRACKER_ROW_UNITS,
      startFrame: 0,
    });
    const expected = Array.from({ length: 4096 }, (_, row) => clock.frameAt(row));
    assert.deepEqual(frames(map), expected, `default Groove must match K1 at ${sampleRate} Hz / ${tempo} BPM`);
    assert.equal(map.endFrame, clock.frameAt(4096));
  }
}

const equivalents = [
  { ppqn: 24, rows: [6, 6] },
  { ppqn: 48, rows: [12, 12] },
  { ppqn: 96, rows: [24, 24] },
  { ppqn: 192, rows: [48, 48] },
].map((groove) => maps.compileTrackTimingMap({ sampleRate: 48000, tempo: 120, rowCount: 64, groove }));
for (const map of equivalents.slice(1)) assert.deepEqual(frames(map), frames(equivalents[0]));

const swing = maps.compileTrackTimingMap({
  sampleRate: 48000,
  tempo: 120,
  rowCount: 6,
  groove: { ppqn: 24, rows: [7, 5] },
});
assert.deepEqual(frames(swing), [0, 7000, 12000, 19000, 24000, 31000]);
assert.equal(swing.endFrame, 36000);

const firstEmpty = maps.compileTrackTimingMap({
  sampleRate: 48000,
  tempo: 120,
  rowCount: 6,
  groove: { ppqn: 24, rows: [7, 5, null, 99] },
});
assert.deepEqual(frames(firstEmpty), frames(swing), "first empty Groove row must terminate and loop the active pattern");
assert.deepEqual(firstEmpty.initialGroove.rows, [7, 5]);

const skip = maps.compileTrackTimingMap({
  sampleRate: 48000,
  tempo: 120,
  rowCount: 7,
  groove: { ppqn: 24, rows: [6, 0, 6] },
});
assert.deepEqual(frames(skip), [0, 6000, 6000, 12000, 18000, 18000, 24000]);
assert.deepEqual(skip.rows.map((row) => row.skipped), [false, true, false, false, true, false, false]);
assert.equal(skip.rows[1].nextBoundaryFrame, skip.rows[1].boundaryFrame);

const allSkip = maps.compileTrackTimingMap({
  sampleRate: 48000,
  tempo: 120,
  rowCount: 32,
  groove: { ppqn: 24, rows: [0] },
});
assert.deepEqual([...new Set(frames(allSkip))], [0], "finite compile must preserve every zero-duration row at one frame");
assert.equal(allSkip.endFrame, 0);

const tempoChange = maps.compileTrackTimingMap({
  sampleRate: 48000,
  tempo: 120,
  rowCount: 6,
  segments: [{ startRow: 2, tempo: 60 }],
});
assert.deepEqual(frames(tempoChange), [0, 6000, 12000, 24000, 36000, 48000]);
assert.equal(tempoChange.rows[2].boundaryFrame, 12000, "tempo change must preserve the reached boundary");
assert.deepEqual(tempoChange.rows.map((row) => row.tempo.numerator), [120, 120, 60, 60, 60, 60]);

const denseTempoMap = maps.compileTrackTimingMap({
  sampleRate: 44100,
  tempo: { numerator: 241, denominator: 2 },
  rowCount: 8,
  groove: { ppqn: 192, rows: [47, 49] },
  segments: [
    { startRow: 1, tempo: { numerator: 179, denominator: 2 } },
    { startRow: 2, tempo: 137 },
    { startRow: 3, tempo: { numerator: 301, denominator: 2 } },
    { startRow: 4, tempo: 91 },
    { startRow: 5, tempo: 233 },
    { startRow: 6, tempo: { numerator: 199, denominator: 2 } },
    { startRow: 7, tempo: 127 },
  ],
});
assert.ok(denseTempoMap.rows.every((row, index, rows) => index === 0 || row.boundaryFrame >= rows[index - 1].boundaryFrame));
assert.equal(maps.serializeTimingMap(denseTempoMap), maps.serializeTimingMap(maps.compileTrackTimingMap({
  sampleRate: 44100,
  tempo: { numerator: 241, denominator: 2 },
  rowCount: 8,
  groove: { ppqn: 192, rows: [47, 49] },
  segments: [
    { startRow: 1, tempo: { numerator: 179, denominator: 2 } },
    { startRow: 2, tempo: 137 },
    { startRow: 3, tempo: { numerator: 301, denominator: 2 } },
    { startRow: 4, tempo: 91 },
    { startRow: 5, tempo: 233 },
    { startRow: 6, tempo: { numerator: 199, denominator: 2 } },
    { startRow: 7, tempo: 127 },
  ],
})), "same segmented input must serialize byte-identically");

const micro24 = maps.compileTrackTimingMap({
  sampleRate: 48000,
  tempo: 120,
  rowCount: 3,
  microTimeSubticks: [0, 1, -1],
});
assert.deepEqual(frames(micro24, "eventFrame"), [0, 6125, 11875]);
assert.deepEqual(micro24.rows.map((row) => row.microTime.units), [0, 8, -8]);

const micro192 = maps.compileTrackTimingMap({
  sampleRate: 48000,
  tempo: 120,
  rowCount: 3,
  groove: { ppqn: 192, rows: [48, 48] },
  microTimeSubticks: [0, 1, -1],
});
assert.deepEqual(frames(micro192, "eventFrame"), [0, 6016, 11984]);
assert.deepEqual(micro192.rows.map((row) => row.microTime.units), [0, 1, -1]);
assert.throws(() => maps.compileTrackTimingMap({
  sampleRate: 48000,
  rowCount: 1,
  microTimeSubticks: [-1],
}), /first Phrase row/);
assert.throws(() => maps.compileTrackTimingMap({
  sampleRate: 48000,
  rowCount: 17,
  microTimeSubticks: Array.from({ length: 17 }, (_, row) => row === 16 ? -1 : 0),
}), /first Phrase row/);

assert.throws(() => maps.compileTrackTimingMap({
  sampleRate: 48000,
  rowCount: 3,
  segments: [{ startRow: 1, groove: { ppqn: 24, rows: [6, 0, 6] } }],
}), /cursor/);
const reset = maps.compileTrackTimingMap({
  sampleRate: 48000,
  rowCount: 4,
  groove: { ppqn: 24, rows: [7, 5] },
  segments: [{ startRow: 1, groove: { ppqn: 24, rows: [6, 0, 6] }, cursor: "reset" }],
});
const preserve = maps.compileTrackTimingMap({
  sampleRate: 48000,
  rowCount: 4,
  groove: { ppqn: 24, rows: [7, 5] },
  segments: [{ startRow: 1, groove: { ppqn: 24, rows: [6, 0, 6] }, cursor: "preserve" }],
});
assert.equal(reset.rows[1].groove.index, 0);
assert.equal(reset.rows[1].groove.ticks, 6);
assert.equal(preserve.rows[1].groove.index, 1);
assert.equal(preserve.rows[1].groove.ticks, 0);
assert.equal(preserve.rows[1].boundaryFrame, preserve.rows[2].boundaryFrame);

const independent = maps.compileTrackTimingMaps({
  sampleRate: 48000,
  tracks: [
    { track: 0, rowCount: 8, groove: { ppqn: 24, rows: [6, 6] } },
    { track: 1, rowCount: 8, groove: { ppqn: 24, rows: [8, 8] } },
  ],
});
assert.deepEqual(frames(independent[0]), [0, 6000, 12000, 18000, 24000, 30000, 36000, 42000]);
assert.deepEqual(frames(independent[1]), [0, 8000, 16000, 24000, 32000, 40000, 48000, 56000]);
assert.notEqual(independent[0].endFrame, independent[1].endFrame, "Track maps must not be padded or synchronized");

const sameFrameMaps = maps.compileTrackTimingMaps({
  sampleRate: 48000,
  tracks: [
    { track: 1, rowCount: 3, groove: { ppqn: 24, rows: [6, 0, 6] } },
    { track: 0, rowCount: 3, groove: { ppqn: 24, rows: [6, 0, 6] } },
  ],
});
const trace = maps.compileTimingMapTrace(sameFrameMaps);
const at6000 = trace.filter((event) => event.frame === 6000 && event.kind === "track-row-boundary");
assert.deepEqual(at6000.map((event) => [event.track, event.data.row]), [[0, 1], [0, 2], [1, 1], [1, 2]], "same-frame rows must remain stable by Track then row source order");
assert.equal(maps.serializeTimingMapTrace(trace), maps.serializeTimingMapTrace(maps.compileTimingMapTrace(sameFrameMaps)));

assert.throws(() => maps.normalizeGroove({ ppqn: 25, rows: [6] }), /24, 48, 96, 192/);
assert.throws(() => maps.normalizeGroove({ ppqn: 24, rows: [null, 6] }), /at least one active row/);
assert.throws(() => maps.normalizeGroove({ ppqn: 24, rows: Array(17).fill(6) }), /between 1 and 16/);
assert.throws(() => maps.compileTrackTimingMap({
  sampleRate: 48000,
  rowCount: 4,
  segments: [{ startRow: 2, tempo: 90 }, { startRow: 2, tempo: 100 }],
}), /duplicate startRow/);
assert.throws(() => maps.compileTrackTimingMap({
  sampleRate: 48000,
  rowCount: 1,
  segments: [{ startRow: 1, tempo: 90 }],
}), /only compiled row/);
assert.throws(() => maps.compileTrackTimingMaps({
  sampleRate: 48000,
  tracks: [{ track: 2, rowCount: 1 }, { track: 2, rowCount: 1 }],
}), /duplicate Track 2/);
assert.throws(() => maps.serializeTimingMap({ bad: undefined }), /unsupported timing-map value/);

const golden = JSON.parse(readFileSync(require.resolve("../docs/fixtures/k3a-groove-tempo-golden.json"), "utf8"));
const compact = (map) => ({
  boundaryFrames: map.rows.map((row) => row.boundaryFrame),
  eventFrames: map.rows.map((row) => row.eventFrame),
  nextBoundaryFrames: map.rows.map((row) => row.nextBoundaryFrame),
  ticks: map.rows.map((row) => row.groove.ticks),
  skipped: map.rows.map((row) => row.skipped),
  endFrame: map.endFrame,
});
assert.deepEqual(compact(maps.compileTrackTimingMap({ sampleRate: 44100, tempo: 120, rowCount: 8 })), golden.default24);
assert.deepEqual(compact(maps.compileTrackTimingMap({ sampleRate: 48000, tempo: 120, rowCount: 8, groove: { ppqn: 24, rows: [7, 5] } })), golden.swing24);
assert.deepEqual(compact(maps.compileTrackTimingMap({ sampleRate: 48000, tempo: 120, rowCount: 8, groove: { ppqn: 24, rows: [6, 0, 6] } })), golden.skip24);
assert.deepEqual(compact(maps.compileTrackTimingMap({ sampleRate: 48000, tempo: 120, rowCount: 8, segments: [{ startRow: 2, tempo: 60 }, { startRow: 5, tempo: 180 }] })), golden.tempoSegments);
const goldenMicro = maps.compileTrackTimingMap({ sampleRate: 48000, tempo: 120, rowCount: 4, groove: { ppqn: 192, rows: [48, 48] }, microTimeSubticks: [0, 1, -1, 3] });
assert.deepEqual({ ...compact(goldenMicro), microUnits: goldenMicro.rows.map((row) => row.microTime.units) }, golden.micro192);

console.log("K3A deterministic Track-local Groove and tempo-map tests passed");
