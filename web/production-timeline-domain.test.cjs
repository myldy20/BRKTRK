const assert = require("node:assert/strict");
const timingDomain = require("./timing-domain.js");
const timelineDomain = require("./production-timeline-domain.js");

const step = (note = null) => Object.freeze({
  notes: Object.freeze([note, null, null, null, null, null, null, null]),
  waves: Object.freeze(Array(8).fill(0)),
  gains: Object.freeze(Array(8).fill(0.1)),
  pans: Object.freeze(Array(8).fill(0)),
  mutes: Object.freeze(Array(8).fill(false)),
});
const event = (note = null) => Object.freeze({ note, wave: 0, gain: 0.1, pan: 0, mute: false });

for (const sampleRate of [44100, 48000, 96000]) {
  for (const tempo of [30, 120, 300]) {
    const program = {
      mode: "sequence",
      steps: Array.from({ length: 64 }, (_, row) => step(row === 0 ? 60 : null)),
      contexts: Array.from({ length: 64 }, (_, row) => ({ phraseRow: row % 16 })),
    };
    const request = timelineDomain.createTimelineRequest(program);
    const timeline = timelineDomain.compileProductionTimeline({ sampleRate, startFrame: 500, tempo, program, request });
    const clock = timingDomain.createMusicalFrameClock({
      sampleRate,
      tempo,
      stepUnits: timingDomain.TRACKER_ROW_UNITS,
      startFrame: 0,
    });
    assert.deepEqual(
      timeline.sequence.schedule.map((entry) => entry.frameOffset),
      Array.from({ length: 64 }, (_, row) => clock.frameAt(row)),
      `default production timeline must match K1 at ${sampleRate} Hz / ${tempo} BPM`,
    );
    assert.equal(timeline.sequence.cycleFrames, clock.frameAt(64));
    assert.equal(timeline.summary.startFrame, 500);
  }
}

const rotatedProgram = {
  mode: "sequence",
  steps: Array.from({ length: 4 }, (_, row) => step(60 + row)),
  startIndex: 2,
};
const rotated = timelineDomain.compileProductionTimeline({
  sampleRate: 48000,
  startFrame: 100,
  tempo: 120,
  program: rotatedProgram,
});
assert.deepEqual(rotated.sequence.schedule.map((entry) => entry.row), [2, 3, 0, 1]);
assert.deepEqual(rotated.sequence.schedule.map((entry) => entry.frameOffset), [0, 6000, 12000, 18000]);

const trackProgram = {
  mode: "track-plan",
  tracks: [
    { active: true, events: Array.from({ length: 4 }, (_, row) => event(60 + row)), contexts: Array.from({ length: 4 }, (_, row) => ({ phraseRow: row })), startIndex: 0 },
    { active: true, events: Array.from({ length: 4 }, (_, row) => event(70 + row)), contexts: Array.from({ length: 4 }, (_, row) => ({ phraseRow: row })), startIndex: 1 },
  ],
};
const independentRequest = timelineDomain.createTimelineRequest(trackProgram, {
  version: 1,
  mode: "track-plan",
  tracks: [
    { track: 0, groove: { ppqn: 24, rows: [6, 6] } },
    { track: 1, groove: { ppqn: 24, rows: [8, 8] } },
  ],
});
const independent = timelineDomain.compileProductionTimeline({
  sampleRate: 48000,
  startFrame: 0,
  tempo: 120,
  program: trackProgram,
  request: independentRequest,
});
assert.deepEqual(independent.tracks[0].schedule.map((entry) => entry.frameOffset), [0, 6000, 12000, 18000]);
assert.deepEqual(independent.tracks[1].schedule.map((entry) => entry.row), [1, 2, 3, 0]);
assert.deepEqual(independent.tracks[1].schedule.map((entry) => entry.frameOffset), [0, 8000, 16000, 24000]);
assert.equal(independent.tracks[0].cycleFrames, 24000);
assert.equal(independent.tracks[1].cycleFrames, 32000);

const skipRequest = timelineDomain.createTimelineRequest({
  mode: "sequence",
  steps: [step(60), step(61), step(62)],
}, {
  version: 1,
  mode: "sequence",
  sequence: { groove: { ppqn: 24, rows: [6, 0, 6] } },
  diagnostics: true,
});
const skipped = timelineDomain.compileProductionTimeline({
  sampleRate: 48000,
  startFrame: 0,
  tempo: 120,
  program: { mode: "sequence", steps: [step(60), step(61), step(62)] },
  request: skipRequest,
});
assert.deepEqual(skipped.sequence.schedule.map((entry) => entry.frameOffset), [0, 6000, 6000]);
assert.deepEqual(skipped.sequence.schedule.map((entry) => entry.row), [0, 1, 2]);
assert.equal(skipped.summary.maxSameFrameRows, 2);
assert.equal(skipped.summary.diagnostics, true);

assert.throws(() => timelineDomain.compileProductionTimeline({
  sampleRate: 48000,
  startFrame: 0,
  tempo: 120,
  program: { mode: "sequence", steps: [step(60), step(61)] },
  request: timelineDomain.createTimelineRequest({ mode: "sequence", steps: [step(60), step(61)] }, {
    version: 1,
    mode: "sequence",
    sequence: { groove: { ppqn: 24, rows: [0] } },
  }),
}), /zero-length repeating cycle/);

const microProgram = { mode: "sequence", steps: [step(60), step(61), step(62)] };
const micro = timelineDomain.compileProductionTimeline({
  sampleRate: 48000,
  startFrame: 0,
  tempo: 120,
  program: microProgram,
  request: timelineDomain.createTimelineRequest(microProgram, {
    version: 1,
    mode: "sequence",
    sequence: {
      groove: { ppqn: 192, rows: [48, 48] },
      microTimeSubticks: [0, 1, -1],
      phraseRows: [0, 1, 2],
    },
  }),
});
assert.deepEqual(micro.sequence.schedule.map((entry) => entry.frameOffset), [0, 6016, 11984]);

const tableProgram = { mode: "sequence", steps: [step(60), step(null)] };
const tableRequest = timelineDomain.createTimelineRequest(tableProgram, {
  version: 1,
  mode: "sequence",
  diagnostics: true,
  tableSources: [{
    track: 0,
    sourceKind: "instrument",
    sourceId: 3,
    table: 4,
    instance: 0,
    startOffsetFrames: 0,
    endOffsetFrames: 1000,
    columns: {
      noteVolume: {
        tic: "00",
        cursorRows: [0, 1],
        initialCursor: 0,
        emissionPolicy: "emit-then-advance",
        triggerOffsets: [0, 0, 100],
      },
    },
  }],
});
const tableTimeline = timelineDomain.compileProductionTimeline({
  sampleRate: 48000,
  startFrame: 2000,
  tempo: 120,
  program: tableProgram,
  request: tableRequest,
});
assert.deepEqual(tableTimeline.tableSources[0].events.map((entry) => entry.frame), [2000, 2000, 2100]);
assert.deepEqual(tableTimeline.tableSources[0].events.map((entry) => entry.tableRow), [0, 1, 0]);
const atStart = tableTimeline.tableEvents.filter((entry) => entry.frame === 2000);
assert.deepEqual(atStart.map((entry) => [entry.phase, entry.kind]), [
  [timingDomain.EVENT_PHASES.SOURCE_CONTROL, "table-source-start"],
  [timingDomain.EVENT_PHASES.TABLE, "table-row-evaluate"],
  [timingDomain.EVENT_PHASES.TABLE, "table-row-evaluate"],
]);
assert.equal(tableTimeline.tableEvents.at(-1).frame, 3000);
assert.equal(tableTimeline.tableEvents.at(-1).kind, "table-source-end");

assert.throws(() => timelineDomain.createTimelineRequest({ mode: "sequence", steps: [step(60)] }, {
  version: 1,
  mode: "track-plan",
}), /mode must match/);
assert.throws(() => timelineDomain.compileProductionTimeline({
  sampleRate: 48000,
  program: tableProgram,
  request: timelineDomain.createTimelineRequest(tableProgram, {
    version: 1,
    mode: "sequence",
    tableSources: [{
      track: 0,
      sourceKind: "instrument",
      sourceId: 0,
      table: 0,
      startFrame: 0,
      endOffsetFrames: 100,
      columns: { noteVolume: { tic: "00", emissionPolicy: "emit-then-advance", triggerOffsets: [0] } },
    }],
  }),
}), /absolute; use offset fields/);

const firstSerialization = timelineDomain.serializeProductionTimeline(tableTimeline);
const secondSerialization = timelineDomain.serializeProductionTimeline(timelineDomain.compileProductionTimeline({
  sampleRate: 48000,
  startFrame: 2000,
  tempo: 120,
  program: tableProgram,
  request: tableRequest,
}));
assert.equal(firstSerialization, secondSerialization, "same production timeline must serialize byte-identically");

console.log("K3C production timeline domain tests passed");
