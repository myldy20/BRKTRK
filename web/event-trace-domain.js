(() => {
  const timingDomain = globalThis.BRKTRKTimingDomain
    ?? (typeof module !== "undefined" && module.exports ? require("./timing-domain.js") : null);
  const noteLifecycleDomain = globalThis.BRKTRKNoteLifecycleDomain
    ?? (typeof module !== "undefined" && module.exports ? require("./note-lifecycle-domain.js") : null);
  const phraseFxRuntimeDomain = globalThis.BRKTRKPhraseFxRuntimeDomain
    ?? (typeof module !== "undefined" && module.exports ? require("./phrase-fx-runtime-domain.js") : null);
  if (!timingDomain || !noteLifecycleDomain || !phraseFxRuntimeDomain) {
    throw new Error("BRKTRK event trace requires K0 timing, K2 lifecycle and M4.1C Phrase FX runtime domains");
  }

  const TRACE_VERSION = 2;
  const DEFAULT_TRACK_COUNT = 8;
  const DEFAULT_MAX_PACKETS = 65536;
  const DEFAULT_MAX_PENDING_EVENTS = 131072;

  const isPlainObject = (value) => value !== null
    && typeof value === "object"
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

  function assertSafeInteger(value, name, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
    const numeric = Number(value);
    if (!Number.isSafeInteger(numeric) || numeric < min || numeric > max) {
      throw new RangeError(`${name} must be a safe integer between ${min} and ${max}`);
    }
    return numeric;
  }

  function compareCodeUnits(left, right) {
    const a = String(left);
    const b = String(right);
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function cloneJson(value, name = "value") {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (error) {
      throw new TypeError(`${name} must contain JSON-compatible data`);
    }
  }

  function normalizeProgram(program) {
    if (!program || typeof program !== "object") throw new TypeError("event trace program must be an object");
    const mode = program.mode === "track-plan" ? "track-plan" : "sequence";
    if (mode === "track-plan") {
      const tracks = Array.isArray(program.tracks) ? program.tracks : [];
      return Object.freeze({ mode, tracks });
    }
    const steps = Array.isArray(program.steps) ? program.steps
      : Array.isArray(program.sequence) ? program.sequence
        : [];
    return Object.freeze({ mode, steps });
  }

  function normalizeRowTiming(candidate, index) {
    if (candidate === undefined || candidate === null) return null;
    if (!candidate || typeof candidate !== "object") throw new TypeError(`rowEvents[${index}].timing must be an object`);
    const sampleRate = assertSafeInteger(candidate.sampleRate, `rowEvents[${index}].timing.sampleRate`, { min: 1 });
    const ppqn = assertSafeInteger(candidate.ppqn, `rowEvents[${index}].timing.ppqn`, { min: 1 });
    timingDomain.unitsPerTick(ppqn);
    const tempo = timingDomain.normalizePositiveRational(candidate.tempo ?? 120, `rowEvents[${index}].timing.tempo`);
    return Object.freeze({ sampleRate, ppqn, tempo });
  }

  function normalizeRowEvent(candidate, index) {
    if (!candidate || typeof candidate !== "object") throw new TypeError(`rowEvents[${index}] must be an object`);
    const kind = candidate.kind === "track" ? "track" : "sequence";
    const track = kind === "track"
      ? assertSafeInteger(candidate.track, `rowEvents[${index}].track`, { min: 0 })
      : -1;
    return Object.freeze({
      kind,
      track,
      row: assertSafeInteger(candidate.row, `rowEvents[${index}].row`, { min: 0 }),
      phraseRow: assertSafeInteger(candidate.phraseRow ?? candidate.row, `rowEvents[${index}].phraseRow`, { min: 0 }),
      sourceOrder: assertSafeInteger(candidate.sourceOrder ?? index, `rowEvents[${index}].sourceOrder`, { min: 0 }),
      timing: normalizeRowTiming(candidate.timing, index),
    });
  }

  function sourceForRow(program, rowEvent, track) {
    if (rowEvent.kind === "sequence") {
      const step = program.steps[rowEvent.row];
      if (!step) return null;
      return Object.freeze({
        note: step.notes?.[track] ?? null,
        wave: step.waves?.[track] ?? null,
        gain: step.gains?.[track] ?? null,
        pan: step.pans?.[track] ?? null,
        mute: step.mutes?.[track] === true,
        velocity: step.velocities?.[track] ?? 100,
        instrumentId: step.instrumentIds?.[track] ?? 0,
        fx: step.fx?.[track] ?? null,
      });
    }
    if (rowEvent.track !== track) return null;
    const source = program.tracks[track]?.events?.[rowEvent.row];
    if (!source) return null;
    return Object.freeze({
      note: source.note ?? null,
      wave: source.wave ?? null,
      gain: source.gain ?? null,
      pan: source.pan ?? null,
      mute: source.mute === true,
      velocity: source.velocity ?? 100,
      instrumentId: source.instrumentId ?? 0,
      fx: source.fx ?? null,
    });
  }

  function lifecycleData(rowEvent, source, intent, extra = {}) {
    return Object.freeze({
      rowKind: rowEvent.kind,
      row: rowEvent.row,
      phraseRow: rowEvent.phraseRow,
      intent,
      note: source.note,
      wave: source.wave,
      gain: source.gain,
      pan: source.pan,
      mute: source.mute,
      velocity: source.velocity,
      instrumentId: source.instrumentId,
      ...extra,
    });
  }

  function rawTraceEvent({ frame, phase, track, sourceOrder, kind, source, data }) {
    return Object.freeze({
      frame: assertSafeInteger(frame, `${kind}.frame`, { min: 0 }),
      phase: assertSafeInteger(phase, `${kind}.phase`, { min: timingDomain.EVENT_PHASES.CLOCK, max: timingDomain.EVENT_PHASES.OBSERVE }),
      track: assertSafeInteger(track, `${kind}.track`, { min: 0 }),
      sourceOrder: assertSafeInteger(sourceOrder, `${kind}.sourceOrder`, { min: 0 }),
      kind: String(kind),
      source: source ?? null,
      data: Object.freeze(cloneJson(data ?? {}, `${kind}.data`)),
    });
  }

  function compileRowTraceEvents({ frame, program, rowEvent, track } = {}) {
    const source = sourceForRow(program, rowEvent, track);
    if (!source) return Object.freeze([]);
    const analysis = phraseFxRuntimeDomain.analyze(source.fx ?? []);
    const needsTiming = analysis.delayTicks > 0 || analysis.cuts.length > 0 || analysis.retriggers.length > 0;
    if (needsTiming && !rowEvent.timing) {
      throw new Error(`Phrase FX timing metadata is required for ${rowEvent.kind} row ${rowEvent.row}`);
    }
    const timing = needsTiming
      ? phraseFxRuntimeDomain.compileTiming(source.fx ?? [], { frame, ...rowEvent.timing })
      : Object.freeze({ originFrame: frame, executionFrame: frame, delayTicks: 0, cuts: Object.freeze([]), retriggers: Object.freeze([]), inert: analysis.inert });
    const intent = noteLifecycleDomain.classifyIntent(source.note, source.mute, false);
    const identity = `${rowEvent.kind}:${rowEvent.track}:${rowEvent.row}`;
    const events = [];

    if (intent === noteLifecycleDomain.INTENTS.RELEASE) {
      events.push(rawTraceEvent({
        frame: timing.executionFrame,
        phase: timingDomain.EVENT_PHASES.NOTE_RELEASE,
        track,
        sourceOrder: rowEvent.sourceOrder,
        kind: "note-release",
        source: identity,
        data: lifecycleData(rowEvent, source, intent, { delayedByTicks: timing.delayTicks, fx: null }),
      }));
    } else {
      events.push(rawTraceEvent({
        frame: timing.executionFrame,
        phase: timingDomain.EVENT_PHASES.PARAMETER,
        track,
        sourceOrder: rowEvent.sourceOrder,
        kind: "parameter",
        source: identity,
        data: lifecycleData(rowEvent, source, intent, { delayedByTicks: timing.delayTicks, fx: null }),
      }));
      if (intent === noteLifecycleDomain.INTENTS.TRIGGER) {
        events.push(rawTraceEvent({
          frame: timing.executionFrame,
          phase: timingDomain.EVENT_PHASES.NOTE_TRIGGER,
          track,
          sourceOrder: rowEvent.sourceOrder,
          kind: "note-trigger",
          source: identity,
          data: lifecycleData(rowEvent, source, intent, { delayedByTicks: timing.delayTicks, resetsPhase: false, fx: null }),
        }));
      }
    }

    for (const cut of timing.cuts) {
      events.push(rawTraceEvent({
        frame: cut.frame,
        phase: timingDomain.EVENT_PHASES.NOTE_RELEASE,
        track,
        sourceOrder: rowEvent.sourceOrder,
        kind: "note-release",
        source: identity,
        data: lifecycleData(rowEvent, source, noteLifecycleDomain.INTENTS.RELEASE, {
          fx: "cut",
          fxLane: cut.lane,
          fxTicks: cut.ticks,
        }),
      }));
    }

    if (intent === noteLifecycleDomain.INTENTS.TRIGGER) {
      for (const retrigger of timing.retriggers) {
        events.push(rawTraceEvent({
          frame: retrigger.frame,
          phase: timingDomain.EVENT_PHASES.PARAMETER,
          track,
          sourceOrder: rowEvent.sourceOrder,
          kind: "parameter",
          source: identity,
          data: lifecycleData(rowEvent, source, intent, {
            fx: "retrigger",
            fxLane: retrigger.lane,
            fxTicks: retrigger.ticks,
            retrigger: true,
          }),
        }));
        events.push(rawTraceEvent({
          frame: retrigger.frame,
          phase: timingDomain.EVENT_PHASES.NOTE_TRIGGER,
          track,
          sourceOrder: rowEvent.sourceOrder,
          kind: "note-trigger",
          source: identity,
          data: lifecycleData(rowEvent, source, intent, {
            fx: "retrigger",
            fxLane: retrigger.lane,
            fxTicks: retrigger.ticks,
            retrigger: true,
            resetsPhase: true,
          }),
        }));
      }
    }

    for (const inert of timing.inert) {
      events.push(rawTraceEvent({
        frame,
        phase: timingDomain.EVENT_PHASES.OBSERVE,
        track,
        sourceOrder: rowEvent.sourceOrder,
        kind: "fx-inert",
        source: identity,
        data: {
          rowKind: rowEvent.kind,
          row: rowEvent.row,
          phraseRow: rowEvent.phraseRow,
          ...inert,
        },
      }));
    }

    events.sort((left, right) => left.frame - right.frame
      || left.phase - right.phase
      || left.track - right.track
      || left.sourceOrder - right.sourceOrder
      || Number(left.data?.fxLane ?? -1) - Number(right.data?.fxLane ?? -1));
    return Object.freeze(events);
  }

  function normalizeScheduledEvent(candidate, index, frame = null) {
    if (!candidate || typeof candidate !== "object") throw new TypeError(`scheduledEvents[${index}] must be an object`);
    const event = rawTraceEvent(candidate);
    if (frame !== null && event.frame !== frame) throw new RangeError(`scheduledEvents[${index}].frame must equal frame`);
    return event;
  }

  function compareScheduled(left, right) {
    return left.frame - right.frame
      || left.phase - right.phase
      || left.track - right.track
      || left.sourceOrder - right.sourceOrder
      || Number(left.data?.fxLane ?? -1) - Number(right.data?.fxLane ?? -1)
      || compareCodeUnits(left.kind, right.kind);
  }

  function enqueueScheduledEvents(queue, candidates, maxPending = DEFAULT_MAX_PENDING_EVENTS) {
    if (!Array.isArray(queue)) throw new TypeError("scheduled-event queue must be an array");
    const limit = assertSafeInteger(maxPending, "maxPending", { min: 1 });
    for (let index = 0; index < (candidates?.length ?? 0); index += 1) {
      queue.push(normalizeScheduledEvent(candidates[index], index));
      if (queue.length > limit) throw new RangeError(`Phrase FX scheduled-event queue exceeded ${limit}`);
    }
    queue.sort(compareScheduled);
    return queue.length;
  }

  function takeScheduledEvents(queue, frame) {
    if (!Array.isArray(queue)) throw new TypeError("scheduled-event queue must be an array");
    const absoluteFrame = assertSafeInteger(frame, "frame", { min: 0 });
    if (queue[0] && queue[0].frame < absoluteFrame) throw new Error("scheduled Phrase FX event became late");
    const due = [];
    while (queue[0]?.frame === absoluteFrame) due.push(queue.shift());
    return Object.freeze(due);
  }

  function buildFramePacket({ frame, program, tableEvents = [], rowEvents = [], scheduledEvents = [], trackCount = DEFAULT_TRACK_COUNT } = {}) {
    const absoluteFrame = assertSafeInteger(frame, "frame", { min: 0 });
    const normalizedProgram = normalizeProgram(program);
    const tracks = assertSafeInteger(trackCount, "trackCount", { min: 1 });
    const rows = Object.freeze(Array.from(rowEvents, normalizeRowEvent));
    const rawEvents = [];
    const futureEvents = [];

    for (let index = 0; index < scheduledEvents.length; index += 1) {
      rawEvents.push(normalizeScheduledEvent(scheduledEvents[index], index, absoluteFrame));
    }

    for (let index = 0; index < tableEvents.length; index += 1) {
      const source = tableEvents[index];
      if (!source || typeof source !== "object") throw new TypeError(`tableEvents[${index}] must be an object`);
      if (Number(source.frame) !== absoluteFrame) throw new RangeError(`tableEvents[${index}].frame must equal frame`);
      rawEvents.push(rawTraceEvent({
        frame: absoluteFrame,
        phase: assertSafeInteger(source.phase, `tableEvents[${index}].phase`, { min: timingDomain.EVENT_PHASES.SOURCE_CONTROL, max: timingDomain.EVENT_PHASES.TABLE }),
        track: assertSafeInteger(source.track, `tableEvents[${index}].track`, { min: 0 }),
        sourceOrder: assertSafeInteger(source.sourceOrder ?? index, `tableEvents[${index}].sourceOrder`, { min: 0 }),
        kind: String(source.kind ?? "table-event"),
        source: source.source ?? null,
        data: source.data ?? {},
      }));
    }

    for (let track = 0; track < tracks; track += 1) {
      for (const rowEvent of rows) {
        for (const event of compileRowTraceEvents({ frame: absoluteFrame, program: normalizedProgram, rowEvent, track })) {
          if (event.frame === absoluteFrame) rawEvents.push(event);
          else if (event.frame > absoluteFrame) futureEvents.push(event);
          else throw new Error("Phrase FX generated an event before its source row frame");
        }
      }
    }

    for (const rowEvent of rows) {
      rawEvents.push(rawTraceEvent({
        frame: absoluteFrame,
        phase: timingDomain.EVENT_PHASES.OBSERVE,
        track: Math.max(0, rowEvent.track),
        sourceOrder: rowEvent.sourceOrder,
        kind: "observe-row",
        source: `${rowEvent.kind}:${rowEvent.track}:${rowEvent.row}`,
        data: {
          rowKind: rowEvent.kind,
          row: rowEvent.row,
          phraseRow: rowEvent.phraseRow,
        },
      }));
    }

    rawEvents.sort(compareScheduled);
    futureEvents.sort(compareScheduled);
    const events = Object.freeze(rawEvents.map((event, index) => Object.freeze({ ...event, ordinal: index + 1 })));

    return Object.freeze({
      version: TRACE_VERSION,
      frame: absoluteFrame,
      tableEvents: Object.freeze(events.filter((event) => event.phase <= timingDomain.EVENT_PHASES.TABLE)),
      rowEvents: rows,
      events,
      futureEvents: Object.freeze(futureEvents),
    });
  }

  function createCycleCursor(cycle, startFrame) {
    if (!cycle || !Array.isArray(cycle.schedule) || cycle.schedule.length === 0) return null;
    return { cycle, pointer: 0, cycleStartFrame: startFrame };
  }

  function cursorFrame(cursor) {
    if (!cursor) return null;
    return cursor.cycleStartFrame + cursor.cycle.schedule[cursor.pointer].frameOffset;
  }

  function advanceCursor(cursor) {
    cursor.pointer += 1;
    if (cursor.pointer < cursor.cycle.schedule.length) return;
    cursor.pointer = 0;
    cursor.cycleStartFrame += cursor.cycle.cycleFrames;
  }

  function rowTiming(timeline, cursor, event) {
    const timingRow = cursor?.cycle?.timingMap?.rows?.[event.row];
    if (!timingRow) return null;
    return Object.freeze({
      sampleRate: timeline.sampleRate,
      ppqn: timingRow.groove.ppqn,
      tempo: timingRow.tempo,
    });
  }

  function compileOfflineEventTrace({ timeline, program, endFrame, maxPackets = DEFAULT_MAX_PACKETS } = {}) {
    if (!timeline || typeof timeline !== "object") throw new TypeError("timeline must be a compiled production timeline");
    const origin = assertSafeInteger(timeline.startFrame, "timeline.startFrame", { min: 0 });
    const finalFrame = assertSafeInteger(endFrame, "endFrame", { min: origin });
    const packetLimit = assertSafeInteger(maxPackets, "maxPackets", { min: 1 });
    const normalizedProgram = normalizeProgram(program);
    if (normalizedProgram.mode !== timeline.mode) throw new RangeError("offline event trace program mode must match timeline mode");

    const sequenceCursor = createCycleCursor(timeline.sequence, origin);
    const trackCursors = Array.from({ length: DEFAULT_TRACK_COUNT }, (_, track) => {
      const cycle = Array.isArray(timeline.tracks) ? timeline.tracks.find((entry) => entry.track === track) : null;
      return createCycleCursor(cycle, origin);
    });
    let tableIndex = 0;
    const pending = [];
    const packets = [];

    const nextFrame = () => {
      let result = null;
      const accept = (candidate) => {
        if (!Number.isSafeInteger(candidate)) return;
        if (result === null || candidate < result) result = candidate;
      };
      accept(cursorFrame(sequenceCursor));
      for (const cursor of trackCursors) accept(cursorFrame(cursor));
      accept(timeline.tableEvents?.[tableIndex]?.frame);
      accept(pending[0]?.frame);
      return result;
    };

    while (true) {
      const frame = nextFrame();
      if (!Number.isSafeInteger(frame) || frame > finalFrame) break;
      if (packets.length >= packetLimit) throw new RangeError(`offline event trace exceeded ${packetLimit} packets`);

      const tableEvents = [];
      while (timeline.tableEvents?.[tableIndex]?.frame === frame) {
        tableEvents.push(timeline.tableEvents[tableIndex]);
        tableIndex += 1;
      }
      const scheduledEvents = takeScheduledEvents(pending, frame);
      const rowEvents = [];
      while (sequenceCursor && cursorFrame(sequenceCursor) === frame) {
        const event = sequenceCursor.cycle.schedule[sequenceCursor.pointer];
        rowEvents.push({ kind: "sequence", track: -1, ...event, timing: rowTiming(timeline, sequenceCursor, event) });
        advanceCursor(sequenceCursor);
      }
      for (let track = 0; track < trackCursors.length; track += 1) {
        const cursor = trackCursors[track];
        while (cursor && cursorFrame(cursor) === frame) {
          const event = cursor.cycle.schedule[cursor.pointer];
          rowEvents.push({ kind: "track", track, ...event, timing: rowTiming(timeline, cursor, event) });
          advanceCursor(cursor);
        }
      }

      const packet = buildFramePacket({
        frame,
        program: normalizedProgram,
        tableEvents,
        rowEvents,
        scheduledEvents,
        trackCount: DEFAULT_TRACK_COUNT,
      });
      enqueueScheduledEvents(pending, packet.futureEvents);
      packets.push(packet);
    }

    return Object.freeze({
      version: TRACE_VERSION,
      startFrame: origin,
      endFrame: finalFrame,
      mode: timeline.mode,
      packets: Object.freeze(packets),
      events: Object.freeze(packets.flatMap((packet) => packet.events)),
    });
  }

  function canonicalize(value, seen = new Set()) {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
      throw new TypeError("unsupported event trace value");
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new TypeError("event trace values must be finite");
      return Object.is(value, -0) ? 0 : value;
    }
    if (Array.isArray(value)) {
      if (seen.has(value)) throw new TypeError("event trace values must not contain cycles");
      seen.add(value);
      const result = value.map((entry) => canonicalize(entry, seen));
      seen.delete(value);
      return result;
    }
    if (isPlainObject(value)) {
      if (seen.has(value)) throw new TypeError("event trace values must not contain cycles");
      seen.add(value);
      const result = {};
      for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key], seen);
      seen.delete(value);
      return result;
    }
    throw new TypeError("event trace values must contain only JSON-compatible data");
  }

  function serializeEventTrace(value) {
    return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
  }

  const api = Object.freeze({
    TRACE_VERSION,
    DEFAULT_TRACK_COUNT,
    DEFAULT_MAX_PACKETS,
    DEFAULT_MAX_PENDING_EVENTS,
    compileRowTraceEvents,
    enqueueScheduledEvents,
    takeScheduledEvents,
    buildFramePacket,
    compileOfflineEventTrace,
    serializeEventTrace,
  });

  if (typeof globalThis !== "undefined") globalThis.BRKTRKEventTraceDomain = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();