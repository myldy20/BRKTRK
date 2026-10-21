const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const timing = require("./timing-domain.js");

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "../docs/fixtures/k0-timing-golden.json"), "utf8"));

assert.equal(timing.MUSICAL_UNITS_PER_QUARTER, 1536);
assert.equal(timing.TRACKER_ROW_UNITS, 384);
assert.equal(timing.MIDI_CLOCK_UNITS, 64);
assert.equal(timing.TABLE_DETACHED_HZ, 200);
assert.equal(timing.ROUNDING_MODE, "nearest-ties-up");
assert.deepEqual(timing.SUPPORTED_M8_GROOVE_PPQN, [24, 48, 96, 192]);

for (const ppqn of timing.SUPPORTED_M8_GROOVE_PPQN) {
  assert.equal(timing.MUSICAL_UNITS_PER_QUARTER % ppqn, 0, `${ppqn} PPQN must divide the canonical quarter exactly`);
  assert.equal(timing.unitsPerTick(ppqn) * ppqn, timing.MUSICAL_UNITS_PER_QUARTER);
  assert.equal(timing.unitsPerSubtick(ppqn, 8) * ppqn * 8, timing.MUSICAL_UNITS_PER_QUARTER,
    `${ppqn} PPQN M8 micro-time eighth-ticks must remain exact`);
}
assert.equal(timing.TRACKER_ROW_UNITS / timing.unitsPerTick(24), 6, "a default M8 row must remain six 24-PPQN ticks");
assert.equal(timing.MIDI_CLOCK_UNITS * 24, timing.MUSICAL_UNITS_PER_QUARTER);

for (const [sampleRate, byTempo] of Object.entries(fixture.rows)) {
  for (const [tempo, expected] of Object.entries(byTempo)) {
    const actual = Array.from({ length: expected.length }, (_, row) => timing.musicalPositionToFrame({
      positionUnits: row * timing.TRACKER_ROW_UNITS,
      sampleRate: Number(sampleRate),
      tempo: Number(tempo),
    }));
    assert.deepEqual(actual, expected, `row trace mismatch at ${sampleRate} Hz / ${tempo} BPM`);
    assert.ok(actual.every((frame, index) => index === 0 || frame > actual[index - 1]), "row frames must be strictly monotonic");
  }
}

for (const [sampleRate, expected] of Object.entries(fixture.detached200Hz)) {
  const actual = Array.from({ length: expected.length }, (_, step) => timing.detachedRateStepToFrame({
    step,
    sampleRate: Number(sampleRate),
    rate: timing.TABLE_DETACHED_HZ,
  }));
  assert.deepEqual(actual, expected, `200 Hz detached clock mismatch at ${sampleRate} Hz`);
  assert.ok(actual.every((frame, index) => index === 0 || frame > actual[index - 1]), "detached-rate frames must be strictly monotonic");
}

assert.deepEqual(
  Array.from({ length: fixture.musicalResolution.midiClockAt44100_120.length }, (_, tick) => timing.musicalPositionToFrame({
    positionUnits: tick * timing.MIDI_CLOCK_UNITS,
    sampleRate: 44100,
    tempo: 120,
  })),
  fixture.musicalResolution.midiClockAt44100_120,
  "MIDI-clock boundaries must be an exact subdivision of the canonical musical clock",
);

for (const [ppqn, expected] of Object.entries(fixture.musicalResolution.grooveTicksAt48000_120)) {
  assert.deepEqual(
    Array.from({ length: expected.length }, (_, tick) => timing.musicalPositionToFrame({
      positionUnits: tick * timing.unitsPerTick(Number(ppqn)),
      sampleRate: 48000,
      tempo: 120,
    })),
    expected,
    `${ppqn} PPQN groove trace mismatch`,
  );
}
assert.deepEqual(
  Array.from({ length: fixture.musicalResolution.microticks192At48000_120.length }, (_, tick) => timing.musicalPositionToFrame({
    positionUnits: tick * timing.unitsPerSubtick(192, 8),
    sampleRate: 48000,
    tempo: 120,
  })),
  fixture.musicalResolution.microticks192At48000_120,
  "192 PPQN eighth-tick micro-time must map exactly into the canonical clock",
);

assert.equal(
  timing.musicalPositionToFrame({ positionUnits: 1536, sampleRate: 48000, tempo: "120.5" }),
  timing.musicalPositionToFrame({ positionUnits: 1536, sampleRate: 48000, tempo: { numerator: 241, denominator: 2 } }),
  "decimal and rational tempo forms must compile identically",
);

for (const sampleRate of [44100, 48000, 96000]) {
  for (const tempo of [30, 120, 300]) {
    const clock = timing.createMusicalFrameClock({ sampleRate, tempo, stepUnits: timing.TRACKER_ROW_UNITS });
    for (let row = 0; row < 4096; row += 1) {
      const direct = timing.musicalPositionToFrame({
        positionUnits: row * timing.TRACKER_ROW_UNITS,
        sampleRate,
        tempo,
      });
      assert.equal(clock.next(), direct, `clock/direct mismatch at row ${row}, ${sampleRate} Hz / ${tempo} BPM`);
      const ideal = row * timing.TRACKER_ROW_UNITS * sampleRate * 60 / (timing.MUSICAL_UNITS_PER_QUARTER * tempo);
      assert.ok(Math.abs(direct - ideal) <= 0.5, "absolute-frame rounding error must stay within half a sample");
    }
  }
}

const longPositionUnits = 24 * 60 * 60 / 2 * timing.MUSICAL_UNITS_PER_QUARTER;
const longFrame = timing.musicalPositionToFrame({ positionUnits: longPositionUnits, sampleRate: 96000, tempo: 30 });
assert.equal(longFrame, 24 * 60 * 60 * 96000, "24-hour trace must not accumulate drift");
assert.ok(Number.isSafeInteger(longFrame));

const detachedClock = timing.createDetachedRateFrameClock({ sampleRate: 44100, rate: 200 });
assert.deepEqual(
  Array.from({ length: 17 }, () => detachedClock.next()),
  fixture.detached200Hz[44100],
  "detached-rate clock cursor must match absolute conversion",
);

const simultaneous = [
  { kind: "note-on", source: "phrase", phase: timing.EVENT_PHASES.NOTE_TRIGGER, track: 0, position: { clock: "musical", units: 0 }, data: { note: 60 } },
  { kind: "observe", source: "transport", phase: timing.EVENT_PHASES.OBSERVE, track: -1, position: { clock: "frame", frame: 0 } },
  { kind: "parameter", source: "table:fx1", phase: timing.EVENT_PHASES.PARAMETER, track: 0, sourceOrder: 1, position: { clock: "musical", units: 0 }, data: { value: 12, parameter: "pitch" } },
  { kind: "table-row", source: "instrument-table", phase: timing.EVENT_PHASES.TABLE, track: 0, position: { clock: "musical", units: 0 }, data: { row: 0 } },
  { kind: "release", source: "phrase", phase: timing.EVENT_PHASES.NOTE_RELEASE, track: 0, position: { clock: "musical", units: 0 }, data: {} },
  { kind: "table-select", source: "phrase:fx", phase: timing.EVENT_PHASES.SOURCE_CONTROL, track: 0, position: { clock: "musical", units: 0 }, data: { table: 4 } },
  { kind: "clock", source: "tempo-map", phase: timing.EVENT_PHASES.CLOCK, track: -1, position: { clock: "musical", units: 0 }, data: { bpm: 120 } },
];
const trace = timing.compileTimingTrace({ sampleRate: 48000, tempo: 120, events: simultaneous });
assert.deepEqual(
  trace.map((event) => event.kind),
  ["clock", "table-select", "table-row", "release", "parameter", "note-on", "observe"],
  "same-frame ordering must follow the explicit phase contract",
);
assert.ok(trace.every((event) => event.frame === 0));

const tableAndRateTrace = timing.compileTimingTrace({
  sampleRate: 44100,
  tempo: 120,
  events: [
    { kind: "phrase-row", source: "phrase", phase: timing.EVENT_PHASES.SOURCE_CONTROL, track: 2, position: { clock: "musical", units: timing.TRACKER_ROW_UNITS }, data: { z: 1, a: 2 } },
    { kind: "table-200hz", source: "table:ff", phase: timing.EVENT_PHASES.TABLE, track: 2, position: { clock: "rate", step: 1, rate: 200 }, data: { row: 1 } },
  ],
});
assert.equal(tableAndRateTrace[0].kind, "table-200hz");
assert.equal(tableAndRateTrace[0].frame, 221);
assert.equal(tableAndRateTrace[1].frame, 5513);

const canonicalA = timing.serializeTimingTrace(timing.compileTimingTrace({
  sampleRate: 48000,
  tempo: 120,
  events: [{ kind: "parameter", source: "engine", position: { clock: "frame", frame: 10 }, data: { beta: 2, alpha: { y: 1, x: 0 } } }],
}));
const canonicalB = timing.serializeTimingTrace(timing.compileTimingTrace({
  sampleRate: 48000,
  tempo: 120,
  events: [{ kind: "parameter", source: "engine", position: { frame: 10, clock: "frame" }, data: { alpha: { x: 0, y: 1 }, beta: 2 } }],
}));
assert.equal(canonicalA, canonicalB, "trace serialization must not depend on object key insertion order");
assert.equal(canonicalA.endsWith("\n"), true);

assert.throws(() => timing.unitsPerTick(100), /does not divide/);
assert.throws(() => timing.unitsPerSubtick(192, 7), /do not divide/);
assert.throws(() => timing.musicalPositionToFrame({ positionUnits: -1, sampleRate: 48000, tempo: 120 }), /positionUnits/);
assert.throws(() => timing.detachedRateStepToFrame({ step: 0, sampleRate: 48000, rate: 0 }), /positive/);
assert.throws(() => timing.compileTimingTrace({ sampleRate: 48000, events: [{ source: "x", position: { clock: "frame", frame: 0 } }] }), /kind is required/);

console.log("K0 deterministic timing-domain tests passed");
