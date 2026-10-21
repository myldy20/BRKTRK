const assert = require("node:assert/strict");
const timingDomain = require("./timing-domain.js");
const productionTimelineDomain = require("./production-timeline-domain.js");
const eventTraceDomain = require("./event-trace-domain.js");

const emptyFx = () => [{ command: 0, value: 0 }, { command: 0, value: 0 }, { command: 0, value: 0 }];
const sequenceStep = (notes = [], fxByTrack = []) => ({
  notes: Array.from({ length: 8 }, (_, track) => notes[track] ?? null),
  waves: Array(8).fill(0),
  gains: Array(8).fill(0.1),
  pans: Array(8).fill(0),
  mutes: Array(8).fill(false),
  fx: Array.from({ length: 8 }, (_, track) => fxByTrack[track] ?? emptyFx()),
});
const trackEvent = (note, fx = emptyFx()) => ({ note, wave: 0, gain: 0.1, pan: 0, mute: false, fx });

function compile(program, request, endFrame, startFrame = 0) {
  const timeline = productionTimelineDomain.compileProductionTimeline({
    sampleRate: 48000,
    startFrame,
    tempo: 120,
    program,
    request,
  });
  return eventTraceDomain.compileOfflineEventTrace({ timeline, program, endFrame });
}

const sequenceProgram = {
  mode: "sequence",
  steps: [sequenceStep([60]), sequenceStep([null]), sequenceStep([-2]), sequenceStep([64])],
};
const sequenceRequest = productionTimelineDomain.createTimelineRequest(sequenceProgram, {
  version: 1,
  mode: "sequence",
  diagnostics: true,
  sequence: { groove: { ppqn: 24, rows: [6, 6] } },
});
const sequenceTrace = compile(sequenceProgram, sequenceRequest, 19000, 1000);
assert.deepEqual(sequenceTrace.packets.map((packet) => packet.frame), [1000, 7000, 13000, 19000]);
const firstPacket = sequenceTrace.packets[0];
assert.equal(firstPacket.events.filter((event) => event.kind === "parameter").length, 8);
assert.equal(firstPacket.events.filter((event) => event.kind === "note-trigger").length, 1);
assert.equal(firstPacket.events.at(-1).phase, timingDomain.EVENT_PHASES.OBSERVE);
assert.equal(sequenceTrace.packets[2].events[0].kind, "note-release");
assert.equal(firstPacket.version, 2);

const sameFrameProgram = {
  mode: "sequence",
  steps: [sequenceStep([60]), sequenceStep([-2]), sequenceStep([64])],
};
const sameFrameRequest = productionTimelineDomain.createTimelineRequest(sameFrameProgram, {
  version: 1,
  mode: "sequence",
  sequence: { groove: { ppqn: 24, rows: [6, 0, 6] } },
});
const sameFrameTrace = compile(sameFrameProgram, sameFrameRequest, 6000);
const sameFramePacket = sameFrameTrace.packets.at(-1);
assert.deepEqual(sameFramePacket.rowEvents.map((entry) => entry.row), [1, 2]);
assert.deepEqual(
  sameFramePacket.events
    .filter((entry) => entry.kind === "note-release" || entry.kind === "note-trigger")
    .map((entry) => entry.kind),
  ["note-release", "note-trigger"],
);

const planProgram = {
  mode: "track-plan",
  tracks: [
    { active: true, events: [trackEvent(60), trackEvent(61), trackEvent(62), trackEvent(63)], startIndex: 0 },
    { active: true, events: [trackEvent(70), trackEvent(71), trackEvent(72), trackEvent(73)], startIndex: 1 },
  ],
};
const planRequest = productionTimelineDomain.createTimelineRequest(planProgram, {
  version: 1,
  mode: "track-plan",
  tracks: [
    { track: 0, groove: { ppqn: 24, rows: [6, 6] } },
    { track: 1, groove: { ppqn: 24, rows: [8, 8] } },
  ],
});
const planTrace = compile(planProgram, planRequest, 16000);
assert.deepEqual(planTrace.packets.map((packet) => packet.frame), [0, 6000, 8000, 12000, 16000]);
assert.deepEqual(planTrace.packets[0].rowEvents.map((entry) => [entry.track, entry.row]), [[0, 0], [1, 1]]);

const tableProgram = { mode: "sequence", steps: [sequenceStep([60]), sequenceStep([null])] };
const tableRequest = productionTimelineDomain.createTimelineRequest(tableProgram, {
  version: 1,
  mode: "sequence",
  tableSources: [{
    track: 0,
    sourceKind: "instrument",
    sourceId: 0,
    table: 1,
    startOffsetFrames: 0,
    endOffsetFrames: 1000,
    columns: {
      noteVolume: {
        tic: "00",
        cursorRows: [0, 1],
        initialCursor: 0,
        emissionPolicy: "emit-then-advance",
        triggerOffsets: [0],
      },
    },
  }],
});
const tableTrace = compile(tableProgram, tableRequest, 0);
assert.deepEqual(tableTrace.packets[0].events.slice(0, 2).map((entry) => entry.phase), [
  timingDomain.EVENT_PHASES.SOURCE_CONTROL,
  timingDomain.EVENT_PHASES.TABLE,
]);

// M4.1C: DEL delays the row lifecycle, CUT schedules host-timed release, and RET X0 schedules one explicit phase-reset retrigger.
const fxSlots = [
  { command: 0x04, value: 0x02 },
  { command: 0x01, value: 0x04 },
  { command: 0x05, value: 0x30 },
];
const fxProgram = { mode: "sequence", steps: [sequenceStep([60], [fxSlots])] };
const fxRequest = productionTimelineDomain.createTimelineRequest(fxProgram, {
  version: 1,
  mode: "sequence",
  sequence: { groove: { ppqn: 24, rows: [6] } },
});
const fxTrace = compile(fxProgram, fxRequest, 7000);
assert.deepEqual(fxTrace.packets.map((packet) => packet.frame), [0, 2000, 5000, 6000], "FX events must become first-class host trace frames between tracker rows");
assert.equal(fxTrace.packets[0].events.some((event) => event.track === 0 && event.kind === "note-trigger"), false, "DEL must suppress the source Track trigger at the nominal row frame");
assert.equal(fxTrace.packets[1].events.find((event) => event.kind === "note-trigger")?.data.delayedByTicks, 2);
const retriggerPacket = fxTrace.packets[2];
assert.deepEqual(retriggerPacket.events.filter((event) => event.data?.fx === "retrigger").map((event) => event.kind), ["parameter", "note-trigger"]);
assert.equal(retriggerPacket.events.find((event) => event.kind === "note-trigger")?.data.resetsPhase, true);
const cutPacket = fxTrace.packets[3];
assert.equal(cutPacket.events.find((event) => event.data?.fx === "cut")?.kind, "note-release");
assert.equal(cutPacket.rowEvents.length, 1, "next cycle row may share the frame with a previously scheduled CUT without losing either event");

const unresolvedRetProgram = {
  mode: "sequence",
  steps: [sequenceStep([60], [[{ command: 0x05, value: 0x31 }, { command: 0xA7, value: 0x22 }, { command: 0, value: 0 }]])],
};
const unresolvedRetRequest = productionTimelineDomain.createTimelineRequest(unresolvedRetProgram, {
  version: 1,
  mode: "sequence",
  sequence: { groove: { ppqn: 24, rows: [6] } },
});
const unresolvedTrace = compile(unresolvedRetProgram, unresolvedRetRequest, 0);
assert.deepEqual(unresolvedTrace.events.filter((event) => event.kind === "fx-inert").map((event) => event.data.kind), [
  "retrigger-ramp-unresolved",
  "unknown-command",
], "unproven RET ramp and unknown commands must remain observable-but-inert rather than guessed");

const originalLocaleCompare = String.prototype.localeCompare;
String.prototype.localeCompare = function forbiddenLocaleCompare() {
  throw new Error("K4 ordering must not consult localeCompare");
};
try {
  const queue = [];
  eventTraceDomain.enqueueScheduledEvents(queue, [
    { frame: 100, phase: timingDomain.EVENT_PHASES.OBSERVE, track: 0, sourceOrder: 0, kind: "zeta", data: {} },
    { frame: 100, phase: timingDomain.EVENT_PHASES.OBSERVE, track: 0, sourceOrder: 0, kind: "alpha", data: {} },
  ]);
  assert.deepEqual(queue.map((event) => event.kind), ["alpha", "zeta"], "final K4 tie-break must use stable code-unit ordering");
} finally {
  String.prototype.localeCompare = originalLocaleCompare;
}

const serializedA = eventTraceDomain.serializeEventTrace(planTrace);
const serializedB = eventTraceDomain.serializeEventTrace(compile(planProgram, planRequest, 16000));
assert.equal(serializedA, serializedB, "identical trace inputs must serialize byte-identically");
assert.throws(
  () => eventTraceDomain.compileOfflineEventTrace({
    timeline: productionTimelineDomain.compileProductionTimeline({
      sampleRate: 48000,
      startFrame: 1000,
      tempo: 120,
      program: sequenceProgram,
      request: sequenceRequest,
    }),
    program: sequenceProgram,
    endFrame: 19000,
    maxPackets: 2,
  }),
  /exceeded 2 packets/,
);

console.log("K4A shared event trace domain tests passed through M4.1C Phrase FX scheduling");
