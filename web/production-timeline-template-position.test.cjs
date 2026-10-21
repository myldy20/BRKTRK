const assert = require("node:assert/strict");
const timelineDomain = require("./production-timeline-domain.js");
const templateDomain = require("./production-timeline-template.js");

const plain = (value) => JSON.parse(JSON.stringify(value));
const step = (note = null) => ({ notes: [note] });
const event = (note) => ({ note });
const cycleShape = (cycle) => plain({
  track: cycle.track,
  rowCount: cycle.rowCount,
  startIndex: cycle.startIndex,
  cycleFrames: cycle.cycleFrames,
  schedule: cycle.schedule.map((entry) => ({
    frameOffset: entry.frameOffset,
    boundaryOffset: entry.boundaryOffset,
    row: entry.row,
    phraseRow: entry.phraseRow,
    sourceOrder: entry.sourceOrder,
  })),
});

const sequenceBase = {
  mode: "sequence",
  steps: [step(60), step(null), step(64), step(null)],
  contexts: Array.from({ length: 4 }, (_, row) => ({ phraseRow: row })),
  startIndex: 0,
};
const sequenceRequest = timelineDomain.createTimelineRequest(sequenceBase, {
  version: 1,
  mode: "sequence",
  sequence: { groove: { ppqn: 24, rows: [4, 8, 6, 6] } },
});
const sequenceTemplate = templateDomain.compileRelativeTimeline({
  sampleRate: 48000,
  tempo: 120,
  program: sequenceBase,
  request: sequenceRequest,
});
const sequenceBound = templateDomain.bindRelativeTimeline(sequenceTemplate, 1000, { sequenceStartIndex: 2 });
const sequenceDirect = timelineDomain.compileProductionTimeline({
  sampleRate: 48000,
  startFrame: 1000,
  tempo: 120,
  program: { ...sequenceBase, startIndex: 2 },
  request: sequenceRequest,
});
assert.deepEqual(cycleShape(sequenceBound.sequence), cycleShape(sequenceDirect.sequence));
assert.equal(sequenceBound.summary.sequence.startIndex, 2);
assert.equal(sequenceBound.summary.maxSameFrameRows, sequenceDirect.summary.maxSameFrameRows);
assert.equal(sequenceBound.sequence.schedule[0].row, 2);
assert.equal(sequenceBound.sequence.schedule[0].frameOffset, 0);

const trackBase = {
  mode: "track-plan",
  tracks: [
    {
      active: true,
      events: [event(60), event(61), event(62)],
      contexts: Array.from({ length: 3 }, (_, row) => ({ phraseRow: row })),
      startIndex: 0,
    },
    {
      active: true,
      events: [event(70), event(71), event(72), event(73)],
      contexts: Array.from({ length: 4 }, (_, row) => ({ phraseRow: row })),
      startIndex: 0,
    },
  ],
};
const trackRequest = timelineDomain.createTimelineRequest(trackBase, {
  version: 1,
  mode: "track-plan",
  tracks: [
    { track: 0, groove: { ppqn: 24, rows: [4, 8, 12] } },
    { track: 1, groove: { ppqn: 24, rows: [8, 4, 6, 6] } },
  ],
});
const trackTemplate = templateDomain.compileRelativeTimeline({
  sampleRate: 48000,
  tempo: 120,
  program: trackBase,
  request: trackRequest,
});
const exactStarts = [2, 1];
const trackBound = templateDomain.bindRelativeTimeline(trackTemplate, 5000, { trackStartIndices: exactStarts });
const positionedTracks = trackBase.tracks.map((track, index) => ({ ...track, startIndex: exactStarts[index] }));
const trackDirect = timelineDomain.compileProductionTimeline({
  sampleRate: 48000,
  startFrame: 5000,
  tempo: 120,
  program: { ...trackBase, tracks: positionedTracks },
  request: trackRequest,
});
assert.deepEqual(
  plain(trackBound.tracks.map(cycleShape)),
  plain(trackDirect.tracks.map(cycleShape)),
  "exact Worklet Track positions must rotate prepared cycles exactly like direct K3C compilation",
);
assert.deepEqual(plain(trackBound.summary.tracks.map((entry) => entry.startIndex)), exactStarts);
assert.equal(trackBound.summary.maxSameFrameRows, trackDirect.summary.maxSameFrameRows);

// Default two-argument bind remains R0-compatible: no position override means
// the template's compiled start indices are retained exactly.
const unchanged = templateDomain.bindRelativeTimeline(trackTemplate, 9000);
assert.deepEqual(plain(unchanged.summary.tracks.map((entry) => entry.startIndex)), [0, 0]);

console.log("K3 R1 exact-position relative timeline bind parity tests passed");