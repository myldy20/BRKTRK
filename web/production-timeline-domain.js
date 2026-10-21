(() => {
  const timingDomain = globalThis.BRKTRKTimingDomain
    ?? (typeof module !== "undefined" && module.exports ? require("./timing-domain.js") : null);
  const timingMapDomain = globalThis.BRKTRKTimingMapDomain
    ?? (typeof module !== "undefined" && module.exports ? require("./timing-map-domain.js") : null);
  const tableSourceDomain = globalThis.BRKTRKTableSourceDomain
    ?? (typeof module !== "undefined" && module.exports ? require("./table-source-domain.js") : null);
  if (!timingDomain || !timingMapDomain || !tableSourceDomain) {
    throw new Error("BRKTRK production timeline requires K0, K3A and K3B domains");
  }

  const TIMELINE_VERSION = 1;
  const DEFAULT_TRACK_COUNT = 8;
  const MAX_SAME_FRAME_ROWS = 4096;
  const MODES = Object.freeze({ SEQUENCE: "sequence", TRACK_PLAN: "track-plan" });
  const DEFAULT_GROOVE = Object.freeze({ ppqn: 24, rows: Object.freeze([6, 6]) });

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

  function freezeArray(value) {
    return Object.freeze(Array.from(value ?? []));
  }

  function normalizeMode(value) {
    return value === MODES.TRACK_PLAN ? MODES.TRACK_PLAN : MODES.SEQUENCE;
  }

  function cloneJson(value, name = "value") {
    if (value === undefined) return undefined;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (error) {
      throw new TypeError(`${name} must contain JSON-compatible data`);
    }
  }

  function phraseRowsFromContexts(contexts, rowCount) {
    const source = Array.isArray(contexts) ? contexts : [];
    return Object.freeze(Array.from({ length: rowCount }, (_, row) => {
      const value = Number(source[row]?.phraseRow);
      return Number.isInteger(value) && value >= 0 && value < 16 ? value : row % 16;
    }));
  }

  function normalizeTimingRequest(candidate, { track, rowCount, contexts, name }) {
    const source = isPlainObject(candidate) ? candidate : {};
    if (Object.hasOwn(source, "rowCount") && Number(source.rowCount) !== rowCount) {
      throw new RangeError(`${name}.rowCount must match the playable program length`);
    }
    if (Object.hasOwn(source, "track") && Number(source.track) !== track) {
      throw new RangeError(`${name}.track must match its program Track`);
    }
    const result = {
      track,
      rowCount,
      phraseRows: Object.hasOwn(source, "phraseRows")
        ? freezeArray(source.phraseRows)
        : phraseRowsFromContexts(contexts, rowCount),
    };
    for (const key of ["tempo", "groove", "segments", "microTimeSubticks"]) {
      if (Object.hasOwn(source, key)) result[key] = cloneJson(source[key], `${name}.${key}`);
    }
    return Object.freeze(result);
  }

  function explicitTrackRequest(candidate, track) {
    const tracks = Array.isArray(candidate?.tracks) ? candidate.tracks : [];
    return tracks.find((entry) => Number(entry?.track) === track) ?? null;
  }

  function createTimelineRequest(program, override = null) {
    if (!program || typeof program !== "object") throw new TypeError("timeline program must be an object");
    const requested = isPlainObject(override) ? override : isPlainObject(program.timeline) ? program.timeline : {};
    const mode = normalizeMode(program.mode);
    if (Object.hasOwn(requested, "version") && Number(requested.version) !== TIMELINE_VERSION) {
      throw new RangeError(`timeline version must be ${TIMELINE_VERSION}`);
    }
    if (Object.hasOwn(requested, "mode") && normalizeMode(requested.mode) !== mode) {
      throw new RangeError("timeline mode must match the Transport program mode");
    }

    let sequence = null;
    let tracks = Object.freeze([]);
    if (mode === MODES.TRACK_PLAN) {
      const sourceTracks = Array.isArray(program.tracks) ? program.tracks : [];
      tracks = Object.freeze(sourceTracks.map((trackProgram, track) => {
        const events = Array.isArray(trackProgram?.events) ? trackProgram.events : [];
        if (trackProgram?.active !== true || events.length === 0) return null;
        return normalizeTimingRequest(explicitTrackRequest(requested, track), {
          track,
          rowCount: events.length,
          contexts: trackProgram.contexts,
          name: `timeline.tracks[${track}]`,
        });
      }).filter(Boolean));
      if (tracks.length === 0) throw new RangeError("track-plan timeline requires at least one active Track");
    } else {
      const steps = Array.isArray(program.steps) ? program.steps : Array.isArray(program.sequence) ? program.sequence : [];
      if (steps.length === 0) throw new RangeError("sequence timeline requires at least one step");
      sequence = normalizeTimingRequest(requested.sequence, {
        track: 0,
        rowCount: steps.length,
        contexts: program.contexts,
        name: "timeline.sequence",
      });
    }

    const tableSources = Object.freeze(cloneJson(requested.tableSources ?? [], "timeline.tableSources") ?? []);
    if (!Array.isArray(tableSources)) throw new TypeError("timeline.tableSources must be an array");

    return Object.freeze({
      version: TIMELINE_VERSION,
      mode,
      diagnostics: requested.diagnostics === true,
      sequence,
      tracks,
      tableSources,
    });
  }

  function compileCycle({ sampleRate, tempo, timingRequest, startIndex = 0, name }) {
    const rowCount = assertSafeInteger(timingRequest.rowCount, `${name}.rowCount`, { min: 1 });
    const track = assertSafeInteger(timingRequest.track, `${name}.track`, { min: 0 });
    const index = assertSafeInteger(startIndex, `${name}.startIndex`, { min: 0 }) % rowCount;
    const map = timingMapDomain.compileTrackTimingMap({
      sampleRate,
      startFrame: 0,
      track,
      rowCount,
      tempo: timingRequest.tempo ?? tempo,
      groove: timingRequest.groove ?? DEFAULT_GROOVE,
      segments: timingRequest.segments ?? [],
      microTimeSubticks: timingRequest.microTimeSubticks,
      phraseRows: timingRequest.phraseRows,
    });
    const cycleFrames = map.endFrame;
    if (!Number.isSafeInteger(cycleFrames) || cycleFrames <= 0) {
      throw new RangeError(`${name} has a zero-length repeating cycle; production playback would starve`);
    }

    const rows = Object.freeze(map.rows.map((row) => Object.freeze({
      row: row.row,
      phraseRow: row.phraseRow,
      boundaryFrame: row.boundaryFrame,
      eventFrame: row.eventFrame,
      nextBoundaryFrame: row.nextBoundaryFrame,
      durationFrames: row.nextBoundaryFrame - row.boundaryFrame,
      microOffsetFrames: row.eventFrame - row.boundaryFrame,
      ticks: row.groove.ticks,
      ppqn: row.groove.ppqn,
      skipped: row.skipped,
    })));

    let boundaryOffset = 0;
    const schedule = [];
    for (let sourceOrder = 0; sourceOrder < rowCount; sourceOrder += 1) {
      const rowIndex = (index + sourceOrder) % rowCount;
      const row = rows[rowIndex];
      const eventOffset = boundaryOffset + row.microOffsetFrames;
      if (eventOffset < 0) {
        throw new RangeError(`${name} starts on a row whose negative micro-time resolves before the Transport anchor`);
      }
      if (eventOffset >= cycleFrames) {
        throw new RangeError(`${name} row ${rowIndex} event crosses the repeating cycle boundary`);
      }
      schedule.push(Object.freeze({
        frameOffset: eventOffset,
        boundaryOffset,
        row: rowIndex,
        phraseRow: row.phraseRow,
        sourceOrder,
      }));
      boundaryOffset += row.durationFrames;
    }
    if (boundaryOffset !== cycleFrames) throw new Error(`${name} rotated cycle does not preserve its exact duration`);
    schedule.sort((left, right) => left.frameOffset - right.frameOffset || left.sourceOrder - right.sourceOrder);

    return Object.freeze({
      version: TIMELINE_VERSION,
      track,
      rowCount,
      startIndex: index,
      cycleFrames,
      timingMap: map,
      rows,
      schedule: Object.freeze(schedule),
    });
  }

  function rebaseTableColumn(column, sourceStartFrame, name) {
    if (!isPlainObject(column)) throw new TypeError(`${name} must be an object`);
    for (const forbidden of ["triggerFrames", "startFrame", "endFrame"]) {
      if (Object.hasOwn(column, forbidden)) throw new RangeError(`${name}.${forbidden} is absolute K3B input; K3C requires explicit relative offsets`);
    }
    const result = cloneJson(column, name);
    if (Object.hasOwn(result, "triggerOffsets")) {
      if (!Array.isArray(result.triggerOffsets)) throw new TypeError(`${name}.triggerOffsets must be an array`);
      result.triggerFrames = result.triggerOffsets.map((offset, index) => sourceStartFrame
        + assertSafeInteger(offset, `${name}.triggerOffsets[${index}]`, { min: 0 }));
      delete result.triggerOffsets;
    }
    if (Object.hasOwn(result, "mappedEvents")) {
      if (!Array.isArray(result.mappedEvents)) throw new TypeError(`${name}.mappedEvents must be an array`);
      result.mappedEvents = result.mappedEvents.map((event, index) => {
        if (!isPlainObject(event)) throw new TypeError(`${name}.mappedEvents[${index}] must be an object`);
        if (Object.hasOwn(event, "frame")) throw new RangeError(`${name}.mappedEvents[${index}].frame is absolute; use frameOffset`);
        const frameOffset = assertSafeInteger(event.frameOffset, `${name}.mappedEvents[${index}].frameOffset`, { min: 0 });
        const rebased = { ...event, frame: sourceStartFrame + frameOffset };
        delete rebased.frameOffset;
        return rebased;
      });
    }
    return result;
  }

  function rebaseTableSource(source, { startFrame, tempo, index }) {
    if (!isPlainObject(source)) throw new TypeError(`timeline.tableSources[${index}] must be an object`);
    for (const forbidden of ["startFrame", "endFrame"]) {
      if (Object.hasOwn(source, forbidden)) throw new RangeError(`timeline.tableSources[${index}].${forbidden} is absolute; use offset fields`);
    }
    const startOffset = assertSafeInteger(source.startOffsetFrames ?? 0, `timeline.tableSources[${index}].startOffsetFrames`, { min: 0 });
    const endOffset = assertSafeInteger(source.endOffsetFrames, `timeline.tableSources[${index}].endOffsetFrames`, { min: startOffset + 1 });
    if (!isPlainObject(source.columns)) throw new TypeError(`timeline.tableSources[${index}].columns must be an object`);
    const columns = {};
    for (const [columnName, column] of Object.entries(source.columns)) {
      columns[columnName] = rebaseTableColumn(column, startFrame + startOffset, `timeline.tableSources[${index}].columns.${columnName}`);
    }
    const result = {
      ...cloneJson(source, `timeline.tableSources[${index}]`),
      tempo: source.tempo ?? tempo,
      startFrame: startFrame + startOffset,
      endFrame: startFrame + endOffset,
      columns,
    };
    delete result.startOffsetFrames;
    delete result.endOffsetFrames;
    return result;
  }

  function compileTableRuntimeEvents(maps) {
    const events = [];
    let ordinal = 0;
    for (const map of maps) {
      const baseOrder = map.sourceOrder * 8;
      const identity = `${map.sourceKind}:${map.sourceId}:${map.instance}`;
      events.push(Object.freeze({
        frame: map.startFrame,
        phase: timingDomain.EVENT_PHASES.SOURCE_CONTROL,
        track: map.track,
        sourceOrder: baseOrder,
        ordinal: ordinal += 1,
        kind: "table-source-start",
        source: identity,
        data: Object.freeze({ sourceKind: map.sourceKind, sourceId: map.sourceId, table: map.table, instance: map.instance }),
      }));
      for (const event of map.events) {
        events.push(Object.freeze({
          frame: event.frame,
          phase: timingDomain.EVENT_PHASES.TABLE,
          track: event.track,
          sourceOrder: baseOrder + event.columnOrder,
          ordinal: ordinal += 1,
          kind: "table-row-evaluate",
          source: identity,
          data: Object.freeze({
            sourceKind: event.sourceKind,
            sourceId: event.sourceId,
            table: event.table,
            instance: event.instance,
            column: event.column,
            tic: event.tic.hex,
            clockClass: event.tic.clockClass,
            tableRow: event.tableRow,
            cursorBefore: event.cursorBefore,
            cursorAfter: event.cursorAfter,
            carrierValue: event.carrierValue,
          }),
        }));
      }
      events.push(Object.freeze({
        frame: map.endFrame,
        phase: timingDomain.EVENT_PHASES.SOURCE_CONTROL,
        track: map.track,
        sourceOrder: baseOrder + 7,
        ordinal: ordinal += 1,
        kind: "table-source-end",
        source: identity,
        data: Object.freeze({ sourceKind: map.sourceKind, sourceId: map.sourceId, table: map.table, instance: map.instance }),
      }));
    }
    events.sort((left, right) => left.frame - right.frame
      || left.phase - right.phase
      || left.track - right.track
      || left.sourceOrder - right.sourceOrder
      || left.ordinal - right.ordinal);
    return Object.freeze(events);
  }

  function maximumRowsAtOneOffset(cycles) {
    const counts = new Map();
    for (const cycle of cycles) {
      for (const event of cycle.schedule) {
        counts.set(event.frameOffset, (counts.get(event.frameOffset) ?? 0) + 1);
      }
    }
    return Math.max(0, ...counts.values());
  }

  function compileProductionTimeline({ sampleRate, startFrame = 0, tempo = 120, program, request = null } = {}) {
    const rate = assertSafeInteger(sampleRate, "sampleRate", { min: 1 });
    const origin = assertSafeInteger(startFrame, "startFrame", { min: 0 });
    const timelineRequest = request ? createTimelineRequest(program, request) : createTimelineRequest(program);
    const mode = timelineRequest.mode;
    let sequence = null;
    let tracks = Object.freeze([]);

    if (mode === MODES.TRACK_PLAN) {
      const sourceTracks = Array.isArray(program.tracks) ? program.tracks : [];
      tracks = Object.freeze(timelineRequest.tracks.map((timingRequest) => {
        const trackProgram = sourceTracks[timingRequest.track];
        if (trackProgram?.active !== true || !Array.isArray(trackProgram.events) || trackProgram.events.length === 0) {
          throw new RangeError(`timeline Track ${timingRequest.track} is no longer active`);
        }
        return compileCycle({
          sampleRate: rate,
          tempo,
          timingRequest,
          startIndex: trackProgram.startIndex ?? trackProgram.position ?? 0,
          name: `timeline.tracks[${timingRequest.track}]`,
        });
      }));
    } else {
      const steps = Array.isArray(program.steps) ? program.steps : Array.isArray(program.sequence) ? program.sequence : [];
      sequence = compileCycle({
        sampleRate: rate,
        tempo,
        timingRequest: timelineRequest.sequence,
        startIndex: program.startIndex ?? program.stepIndex ?? 0,
        name: "timeline.sequence",
      });
      if (steps.length !== sequence.rowCount) throw new RangeError("sequence timing rows must match the sequence length");
    }

    const rebasedSources = timelineRequest.tableSources.map((source, index) => rebaseTableSource(source, {
      startFrame: origin,
      tempo,
      index,
    }));
    const tableSources = rebasedSources.length > 0
      ? tableSourceDomain.compileTableSourceMaps({ sampleRate: rate, sources: rebasedSources })
      : Object.freeze([]);
    const tableEvents = compileTableRuntimeEvents(tableSources);
    const cycles = mode === MODES.TRACK_PLAN ? tracks : [sequence];
    const maxSameFrameRows = maximumRowsAtOneOffset(cycles);
    if (maxSameFrameRows > MAX_SAME_FRAME_ROWS) {
      throw new RangeError(`timeline has ${maxSameFrameRows} rows at one frame; maximum is ${MAX_SAME_FRAME_ROWS}`);
    }

    const summary = Object.freeze({
      version: TIMELINE_VERSION,
      mode,
      sampleRate: rate,
      startFrame: origin,
      sequence: sequence ? Object.freeze({ rowCount: sequence.rowCount, cycleFrames: sequence.cycleFrames, startIndex: sequence.startIndex }) : null,
      tracks: Object.freeze(tracks.map((track) => Object.freeze({
        track: track.track,
        rowCount: track.rowCount,
        cycleFrames: track.cycleFrames,
        startIndex: track.startIndex,
      }))),
      tableSources: Object.freeze(tableSources.map((source) => Object.freeze({
        track: source.track,
        sourceKind: source.sourceKind,
        sourceId: source.sourceId,
        table: source.table,
        instance: source.instance,
        eventCount: source.events.length,
        startFrame: source.startFrame,
        endFrame: source.endFrame,
      }))),
      tableEventCount: tableEvents.length,
      maxSameFrameRows,
      diagnostics: timelineRequest.diagnostics,
    });

    return Object.freeze({
      version: TIMELINE_VERSION,
      mode,
      sampleRate: rate,
      startFrame: origin,
      tempo: timingDomain.normalizePositiveRational(tempo, "tempo"),
      request: timelineRequest,
      sequence,
      tracks,
      tableSources,
      tableEvents,
      summary,
    });
  }

  function canonicalize(value, seen = new Set()) {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
      throw new TypeError("unsupported production timeline value");
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new TypeError("production timeline values must be finite");
      return Object.is(value, -0) ? 0 : value;
    }
    if (Array.isArray(value)) {
      if (seen.has(value)) throw new TypeError("production timeline values must not contain cycles");
      seen.add(value);
      const result = value.map((entry) => canonicalize(entry, seen));
      seen.delete(value);
      return result;
    }
    if (isPlainObject(value)) {
      if (seen.has(value)) throw new TypeError("production timeline values must not contain cycles");
      seen.add(value);
      const result = {};
      for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key], seen);
      seen.delete(value);
      return result;
    }
    throw new TypeError("production timeline values must contain only JSON-compatible data");
  }

  function serializeProductionTimeline(value) {
    return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
  }

  const api = Object.freeze({
    TIMELINE_VERSION,
    DEFAULT_TRACK_COUNT,
    MAX_SAME_FRAME_ROWS,
    MODES,
    DEFAULT_GROOVE,
    createTimelineRequest,
    compileProductionTimeline,
    serializeProductionTimeline,
  });

  if (typeof globalThis !== "undefined") globalThis.BRKTRKProductionTimelineDomain = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
