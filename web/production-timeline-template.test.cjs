const assert = require("node:assert/strict");
const timingDomain = require("./timing-domain.js");
const timelineDomain = require("./production-timeline-domain.js");
const templateDomain = require("./production-timeline-template.js");

const step = (note = null) => Object.freeze({
  notes: Object.freeze([note, null, null, null, null, null, null, null]),
  waves: Object.freeze(Array(8).fill(0)),
  gains: Object.freeze(Array(8).fill(0.1)),
  pans: Object.freeze(Array(8).fill(0)),
  mutes: Object.freeze(Array(8).fill(false)),
});
const event = (note = null) => Object.freeze({ note, wave: 0, gain: 0.1, pan: 0, mute: false });

function assertRelativeShape(template) {
  assert.equal(Object.hasOwn(template, "startFrame"), false, "template must not contain a transport startFrame");
  assert.equal(Object.hasOwn(template.summary, "startFrame"), false, "template summary must not contain a transport startFrame");
  for (const cycle of [template.sequence, ...template.tracks].filter(Boolean)) {
    assert.equal(cycle.timingMap.startFrame, 0, "cycle-local timing maps must stay anchored at relative zero");
  }
  for (const source of template.tableSources) {
    assert.equal(Object.hasOwn(source, "startFrame"), false);
    assert.equal(Object.hasOwn(source, "endFrame"), false);
    assert.equal(Number.isSafeInteger(source.startOffsetFrames), true);
    assert.equal(Number.isSafeInteger(source.endOffsetFrames), true);
    for (const column of Object.values(source.columns)) {
      assert.equal(Object.hasOwn(column, "startFrame"), false);
      assert.equal(Object.hasOwn(column, "endFrame"), false);
      for (const tableEvent of column.events) {
        assert.equal(Object.hasOwn(tableEvent, "frame"), false);
        assert.equal(Number.isSafeInteger(tableEvent.frameOffset), true);
      }
    }
    for (const tableEvent of source.events) {
      assert.equal(Object.hasOwn(tableEvent, "frame"), false);
      assert.equal(Number.isSafeInteger(tableEvent.frameOffset), true);
    }
  }
  for (const tableEvent of template.tableEvents) {
    assert.equal(Object.hasOwn(tableEvent, "frame"), false);
    assert.equal(Number.isSafeInteger(tableEvent.frameOffset), true);
  }
  for (const source of template.summary.tableSources) {
    assert.equal(Object.hasOwn(source, "startFrame"), false);
    assert.equal(Object.hasOwn(source, "endFrame"), false);
  }
}

function assertBindParity({ sampleRate, tempo, program, request, origins }) {
  const template = templateDomain.compileRelativeTimeline({ sampleRate, tempo, program, request });
  assertRelativeShape(template);
  assert.doesNotThrow(() => structuredClone(template), "relative template must be structured-cloneable");
  for (const startFrame of origins) {
    const expected = timelineDomain.compileProductionTimeline({ sampleRate, startFrame, tempo, program, request });
    const actual = templateDomain.bindRelativeTimeline(template, startFrame);
    assert.deepEqual(actual, expected, `relative bind must match legacy production compile at frame ${startFrame}`);
  }
  return template;
}

const sequenceProgram = {
  mode: "sequence",
  steps: Array.from({ length: 4 }, (_, row) => step(60 + row)),
  contexts: Array.from({ length: 4 }, (_, row) => ({ phraseRow: row })),
  startIndex: 1,
};
const sequenceRequest = timelineDomain.createTimelineRequest(sequenceProgram, {
  version: 1,
  mode: "sequence",
  sequence: {
    groove: { ppqn: 192, rows: [47, 49] },
    microTimeSubticks: [0, 1, -1, 2],
    phraseRows: [0, 1, 2, 3],
  },
});
assertBindParity({ sampleRate: 48000, tempo: 123, program: sequenceProgram, request: sequenceRequest, origins: [500, 90500] });

const trackProgram = {
  mode: "track-plan",
  tracks: [
    { active: true, events: Array.from({ length: 4 }, (_, row) => event(60 + row)), contexts: Array.from({ length: 4 }, (_, row) => ({ phraseRow: row })), startIndex: 0 },
    { active: true, events: Array.from({ length: 4 }, (_, row) => event(70 + row)), contexts: Array.from({ length: 4 }, (_, row) => ({ phraseRow: row })), startIndex: 1 },
  ],
};
const trackRequest = timelineDomain.createTimelineRequest(trackProgram, {
  version: 1,
  mode: "track-plan",
  tracks: [
    { track: 0, groove: { ppqn: 24, rows: [6, 6] } },
    { track: 1, groove: { ppqn: 24, rows: [8, 8] } },
  ],
});
const trackTemplate = assertBindParity({ sampleRate: 48000, tempo: 120, program: trackProgram, request: trackRequest, origins: [0, 32768] });
assert.equal(trackTemplate.tracks[0].cycleFrames, 24000);
assert.equal(trackTemplate.tracks[1].cycleFrames, 32000);

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
    startOffsetFrames: 100,
    endOffsetFrames: 1100,
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
const tableTemplate = assertBindParity({ sampleRate: 48000, tempo: 120, program: tableProgram, request: tableRequest, origins: [2000, 7000] });
const boundA = templateDomain.bindRelativeTimeline(tableTemplate, 2000);
const boundB = templateDomain.bindRelativeTimeline(tableTemplate, 7000);
assert.deepEqual(
  boundB.tableEvents.map((entry, index) => entry.frame - boundA.tableEvents[index].frame),
  Array(boundA.tableEvents.length).fill(5000),
  "rebinding must shift every Table runtime event by one exact constant offset",
);
assert.equal(boundA.tableEvents[0].phase, timingDomain.EVENT_PHASES.SOURCE_CONTROL);
assert.equal(boundA.tableEvents[1].phase, timingDomain.EVENT_PHASES.TABLE);

const serializedA = templateDomain.serializeRelativeTimeline(tableTemplate);
const serializedB = templateDomain.serializeRelativeTimeline(templateDomain.compileRelativeTimeline({
  sampleRate: 48000,
  tempo: 120,
  program: tableProgram,
  request: tableRequest,
}));
assert.equal(serializedA, serializedB, "same relative template must serialize byte-identically");
assert.throws(() => templateDomain.bindRelativeTimeline(tableTemplate, -1), /startFrame/);
assert.throws(
  () => templateDomain.bindRelativeTimeline(tableTemplate, Number.MAX_SAFE_INTEGER),
  /safe integer/,
  "relative bind must reject any rebase whose absolute frame exceeds Number.MAX_SAFE_INTEGER",
);
assert.throws(
  () => timelineDomain.compileProductionTimeline({
    sampleRate: 48000,
    startFrame: Number.MAX_SAFE_INTEGER,
    tempo: 120,
    program: tableProgram,
    request: tableRequest,
  }),
  /safe integer/,
  "legacy production compile must reject the same unsafe absolute rebase",
);

console.log("K3 R0 relative timeline compile/bind tests passed");
