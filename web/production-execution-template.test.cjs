const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const timingDomain = require("./timing-domain.js");
require("./phrase-fx-domain.js");
require("./phrase-fx-runtime-domain.js");
const eventTraceDomain = require("./event-trace-domain.js");
const timelineDomain = require("./production-timeline-domain.js");
const relativeDomain = require("./production-timeline-template.js");
const executionDomain = require("./production-execution-template.js");
const queueDomain = require("./realtime-execution-queue.js");
const realtimeWindowDomain = require("./realtime-event-window-domain.js");

const queueSource = readFileSync(require.resolve("./realtime-execution-queue.js"), "utf8");
assert.doesNotMatch(queueSource, /\.sort\s*\(/, "R2 realtime execution queue must not sort on the render path");
assert.doesNotMatch(queueSource, /\.shift\s*\(/, "R2 realtime execution queue must not shift on the render path");
assert.doesNotMatch(queueSource, /new Map\s*\(/, "R2 realtime execution queue frame counts must stay preallocated");

const trackFx = (slots = []) => Array.from({ length: 8 }, (_, track) => track === 0 ? slots : []);
const step = (note, slots = []) => ({
  notes: Array.from({ length: 8 }, (_, track) => track === 0 ? note : null),
  velocities: Array(8).fill(100),
  instrumentIds: Array(8).fill(0),
  fx: trackFx(slots),
});
const slot = (command, value) => ({ command, value });
const program = {
  mode: "sequence",
  steps: [
    step(60, [slot("delay", 2), slot("cut", 2)]),
    step(null),
    step(64, [slot("retrigger", 0x20)]),
    step(-2),
  ],
  contexts: Array.from({ length: 4 }, (_, phraseRow) => ({ phraseRow })),
};
const request = timelineDomain.createTimelineRequest(program, {
  version: 1,
  mode: "sequence",
  diagnostics: true,
  sequence: { groove: { ppqn: 24, rows: [5, 7, 6, 6] } },
});
const compiled = timelineDomain.compileProductionTimeline({ sampleRate: 48000, startFrame: 0, tempo: 120, program, request });
const relative = relativeDomain.compileRelativeTimeline({ sampleRate: 48000, tempo: 120, program, request });
const prepared = executionDomain.compilePreparedExecution({ timelineTemplate: relative, program });
executionDomain.validatePreparedExecution(prepared, { timelineTemplate: relative, mode: "sequence", program });
assert.equal(prepared.sequenceRows.length, program.steps.length);
assert.ok(prepared.recordCount > 0);

const queue = queueDomain.createRealtimeExecutionQueue({ capacity: 256 });
for (const scheduledRow of relative.sequence.schedule) {
  const records = prepared.sequenceRows[scheduledRow.row];
  for (const record of records) {
    const frame = scheduledRow.frameOffset + record.frameDelta;
    if (frame >= relative.sequence.cycleFrames) continue;
    queue.push(
      frame,
      record.phase,
      record.track,
      scheduledRow.sourceOrder,
      record.kind,
      record.instrumentId,
      record.note,
      record.velocity,
      record.fxLane,
      record.retrigger,
      record.resetsPhase,
    );
  }
}
const realtime = [];
while (queue.size() > 0) {
  const frame = queue.peekFrame();
  assert.ok(queue.countFrame(frame) > 0, "typed frame index must expose due-frame demand without scanning the heap");
  queue.drainFrame(frame, (eventFrame, phase, track, sourceOrder, kind, instrumentId, note, velocity, fxLane, retrigger, resetsPhase) => {
    realtime.push({ eventFrame, phase, track, sourceOrder, kind, instrumentId, note, velocity, fxLane, retrigger, resetsPhase });
  });
  assert.equal(queue.countFrame(frame), 0);
}

const kindForOffline = (event) => {
  if (event.kind === "note-release") return executionDomain.KIND.NOTE_RELEASE;
  if (event.kind === "parameter") return executionDomain.KIND.PARAMETER;
  if (event.kind === "note-trigger") return executionDomain.KIND.NOTE_TRIGGER;
  if (event.kind === "fx-inert") return executionDomain.KIND.FX_INERT;
  if (event.kind === "observe-row") return executionDomain.KIND.OBSERVE_ROW;
  throw new Error(`unexpected offline K4 event kind ${event.kind}`);
};
const offline = eventTraceDomain.compileOfflineEventTrace({
  timeline: compiled,
  program,
  endFrame: compiled.sequence.cycleFrames - 1,
}).events.map((event) => ({
  eventFrame: event.frame,
  phase: event.phase,
  track: event.track,
  sourceOrder: event.sourceOrder,
  kind: kindForOffline(event),
  instrumentId: Number.isInteger(Number(event.data?.instrumentId)) ? Number(event.data.instrumentId) : -1,
  note: Number.isFinite(Number(event.data?.note)) ? Number(event.data.note) : -1,
  velocity: Number.isFinite(Number(event.data?.velocity)) ? Number(event.data.velocity) : 100,
  fxLane: Number.isInteger(Number(event.data?.fxLane)) ? Number(event.data.fxLane) : -1,
  retrigger: event.data?.retrigger === true,
  resetsPhase: event.data?.resetsPhase === true,
}));
assert.deepEqual(realtime, offline, "prepared R2 compact records must preserve authoritative K4 order, event classes and exact frames");

const sameFrame = queueDomain.createRealtimeExecutionQueue({ capacity: 8 });
sameFrame.push(100, timingDomain.EVENT_PHASES.NOTE_TRIGGER, 1, 0, executionDomain.KIND.NOTE_TRIGGER, 0, 70, 100, -1, false, false);
sameFrame.push(100, timingDomain.EVENT_PHASES.NOTE_RELEASE, 1, 4, executionDomain.KIND.NOTE_RELEASE, 0, -2, 100, -1, false, false);
sameFrame.push(100, timingDomain.EVENT_PHASES.NOTE_RELEASE, 0, 9, executionDomain.KIND.NOTE_RELEASE, 0, -2, 100, -1, false, false);
assert.equal(sameFrame.countFrame(100), 3);
const ordered = [];
sameFrame.drainFrame(100, (_frame, phase, track, sourceOrder) => ordered.push([phase, track, sourceOrder]));
assert.deepEqual(ordered, [
  [timingDomain.EVENT_PHASES.NOTE_RELEASE, 0, 9],
  [timingDomain.EVENT_PHASES.NOTE_RELEASE, 1, 4],
  [timingDomain.EVENT_PHASES.NOTE_TRIGGER, 1, 0],
]);

const bounded = queueDomain.createRealtimeExecutionQueue({ capacity: 2 });
bounded.push(1, 300, 0, 0, 1, 0, -2, 100);
bounded.push(2, 500, 0, 1, 3, 0, 60, 100);
assert.throws(() => bounded.push(3, 500, 0, 2, 3, 0, 61, 100), /exceeded 2/);
assert.equal(bounded.size(), 2, "overflow must fail before partial queue mutation");
assert.throws(() => queueDomain.createRealtimeExecutionQueue({ capacity: 2 }).push(1, 500, 0, 0, 3, 0, Number.NaN, 100), /finite/);

const primitiveWindow = realtimeWindowDomain.createRealtimeEventWindow({ packetCapacity: 2, eventCapacity: 5, sameFrameEventCapacity: 4 });
primitiveWindow.begin(100, 8);
assert.equal(primitiveWindow.reserveFrame(100, 3), 3);
assert.equal(primitiveWindow.reserveFrame(103, 2), 2);
assert.deepEqual(
  { packets: primitiveWindow.diagnosticSnapshot().packetCount, events: primitiveWindow.diagnosticSnapshot().eventCount },
  { packets: 2, events: 5 },
  "primitive R2 reservation must retain K4B packet/event accounting",
);
primitiveWindow.finish();
const rejectedWindow = realtimeWindowDomain.createRealtimeEventWindow({ packetCapacity: 2, eventCapacity: 5, sameFrameEventCapacity: 2 });
rejectedWindow.begin(200, 8);
assert.throws(() => rejectedWindow.reserveFrame(200, 3), /same-frame event demand/);
assert.equal(rejectedWindow.diagnosticSnapshot().packetCount, 0, "primitive budget rejection must happen before packet counter mutation");
assert.equal(rejectedWindow.diagnosticSnapshot().eventCount, 0, "primitive budget rejection must happen before event counter mutation");

console.log("K3 R2 complete compact-K4 parity + frame-indexed heap + primitive K4B budget tests passed");
