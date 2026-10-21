(() => {
  const timelineDomain = globalThis.BRKTRKProductionTimelineDomain
    ?? (typeof module !== "undefined" && module.exports ? require("./production-timeline-domain.js") : null);
  if (!timelineDomain) throw new Error("BRKTRK relative timeline requires the production timeline domain");

  const TEMPLATE_VERSION = 1;
  const MAX_TEMPLATE_TRACKS = timelineDomain.DEFAULT_TRACK_COUNT ?? 8;
  const MAX_TEMPLATE_ROWS_PER_CYCLE = 65536;
  const MAX_TEMPLATE_TABLE_SOURCES = 4096;
  const MAX_TEMPLATE_TABLE_EVENTS = 262144;
  const MAX_TEMPLATE_COLUMNS_PER_SOURCE = 64;

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

  function assertArray(value, name, maxLength) {
    if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
    if (value.length > maxLength) throw new RangeError(`${name} exceeds bounded capacity ${maxLength}`);
    return value;
  }

  function normalizeIndex(value, length) {
    if (length <= 0) return 0;
    const numeric = Number.isInteger(value) ? value : 0;
    return ((numeric % length) + length) % length;
  }

  function addFrameOffset(startFrame, offset, name) {
    const relative = assertSafeInteger(offset, `${name} offset`, { min: 0 });
    return assertSafeInteger(startFrame + relative, name, { min: 0 });
  }

  function copyWithout(value, omitted) {
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      if (!omitted.has(key)) result[key] = entry;
    }
    return result;
  }

  function relativeEvent(event) {
    return Object.freeze({
      ...copyWithout(event, new Set(["frame"])),
      frameOffset: event.frame,
    });
  }

  function relativeColumn(column) {
    return Object.freeze({
      ...copyWithout(column, new Set(["startFrame", "endFrame", "events"])),
      startOffsetFrames: column.startFrame,
      endOffsetFrames: column.endFrame,
      events: Object.freeze(column.events.map(relativeEvent)),
    });
  }

  function relativeTableSource(source) {
    return Object.freeze({
      ...copyWithout(source, new Set(["startFrame", "endFrame", "columns", "events"])),
      startOffsetFrames: source.startFrame,
      endOffsetFrames: source.endFrame,
      columns: Object.freeze(Object.fromEntries(
        Object.entries(source.columns).map(([name, column]) => [name, relativeColumn(column)]),
      )),
      events: Object.freeze(source.events.map(relativeEvent)),
    });
  }

  function relativeSummary(summary) {
    return Object.freeze({
      ...copyWithout(summary, new Set(["startFrame", "tableSources"])),
      tableSources: Object.freeze(summary.tableSources.map((source) => Object.freeze({
        ...copyWithout(source, new Set(["startFrame", "endFrame"])),
        startOffsetFrames: source.startFrame,
        endOffsetFrames: source.endFrame,
      }))),
    });
  }

  function compileRelativeTimeline({ sampleRate, tempo = 120, program, request = null } = {}) {
    const compiled = timelineDomain.compileProductionTimeline({
      sampleRate,
      startFrame: 0,
      tempo,
      program,
      request,
    });
    if (compiled.startFrame !== 0 || compiled.summary.startFrame !== 0) {
      throw new Error("relative timeline control-plane compile must use transport origin zero");
    }
    return Object.freeze({
      templateVersion: TEMPLATE_VERSION,
      timelineVersion: compiled.version,
      mode: compiled.mode,
      sampleRate: compiled.sampleRate,
      tempo: compiled.tempo,
      request: compiled.request,
      sequence: compiled.sequence,
      tracks: compiled.tracks,
      tableSources: Object.freeze(compiled.tableSources.map(relativeTableSource)),
      tableEvents: Object.freeze(compiled.tableEvents.map(relativeEvent)),
      summary: relativeSummary(compiled.summary),
    });
  }

  function validateEvent(event, name) {
    if (!isPlainObject(event)) throw new TypeError(`${name} must be an object`);
    assertSafeInteger(event.frameOffset, `${name}.frameOffset`, { min: 0 });
    return event;
  }

  function validateCycle(cycle, name, expected = {}) {
    if (!isPlainObject(cycle)) throw new TypeError(`${name} must be an object`);
    const rowCount = assertSafeInteger(cycle.rowCount, `${name}.rowCount`, { min: 1, max: MAX_TEMPLATE_ROWS_PER_CYCLE });
    const schedule = assertArray(cycle.schedule, `${name}.schedule`, MAX_TEMPLATE_ROWS_PER_CYCLE);
    if (schedule.length !== rowCount) throw new RangeError(`${name}.schedule length must equal rowCount`);
    const rows = assertArray(cycle.rows, `${name}.rows`, MAX_TEMPLATE_ROWS_PER_CYCLE);
    if (rows.length !== rowCount) throw new RangeError(`${name}.rows length must equal rowCount`);
    const cycleFrames = assertSafeInteger(cycle.cycleFrames, `${name}.cycleFrames`, { min: 1 });
    const startIndex = assertSafeInteger(cycle.startIndex, `${name}.startIndex`, { min: 0, max: rowCount - 1 });
    if (!isPlainObject(cycle.timingMap) || Number(cycle.timingMap.startFrame) !== 0) {
      throw new RangeError(`${name}.timingMap must remain anchored at relative frame zero`);
    }
    const timingRows = assertArray(cycle.timingMap.rows, `${name}.timingMap.rows`, MAX_TEMPLATE_ROWS_PER_CYCLE);
    if (timingRows.length !== rowCount) throw new RangeError(`${name}.timingMap.rows length must equal rowCount`);
    let durationSum = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (!isPlainObject(row)) throw new TypeError(`${name}.rows[${index}] must be an object`);
      if (assertSafeInteger(row.row, `${name}.rows[${index}].row`, { min: 0, max: rowCount - 1 }) !== index) {
        throw new RangeError(`${name}.rows[${index}].row must preserve canonical row identity`);
      }
      const duration = assertSafeInteger(row.durationFrames, `${name}.rows[${index}].durationFrames`, { min: 0, max: cycleFrames });
      assertSafeInteger(row.microOffsetFrames, `${name}.rows[${index}].microOffsetFrames`, {
        min: -cycleFrames,
        max: cycleFrames,
      });
      durationSum = assertSafeInteger(durationSum + duration, `${name}.durationSum`, { min: 0, max: cycleFrames });
    }
    if (durationSum !== cycleFrames) throw new RangeError(`${name}.rows must preserve exact cycle duration`);
    for (let index = 0; index < schedule.length; index += 1) {
      const event = schedule[index];
      if (!isPlainObject(event)) throw new TypeError(`${name}.schedule[${index}] must be an object`);
      assertSafeInteger(event.frameOffset, `${name}.schedule[${index}].frameOffset`, { min: 0, max: cycleFrames - 1 });
      assertSafeInteger(event.row, `${name}.schedule[${index}].row`, { min: 0, max: rowCount - 1 });
    }
    if (Number.isInteger(expected.rowCount) && rowCount !== expected.rowCount) {
      throw new RangeError(`${name}.rowCount does not match the Transport program`);
    }
    if (expected.enforceStartIndex !== false && Number.isInteger(expected.startIndex) && startIndex !== normalizeIndex(expected.startIndex, rowCount)) {
      throw new RangeError(`${name}.startIndex does not match the Transport program start row`);
    }
    if (Number.isInteger(expected.track) && Number(cycle.track) !== expected.track) {
      throw new RangeError(`${name}.track does not match the Transport program`);
    }
    return cycle;
  }

  function validateTableSource(source, name) {
    if (!isPlainObject(source)) throw new TypeError(`${name} must be an object`);
    const start = assertSafeInteger(source.startOffsetFrames, `${name}.startOffsetFrames`, { min: 0 });
    const end = assertSafeInteger(source.endOffsetFrames, `${name}.endOffsetFrames`, { min: start });
    const events = assertArray(source.events, `${name}.events`, MAX_TEMPLATE_TABLE_EVENTS);
    events.forEach((event, index) => validateEvent(event, `${name}.events[${index}]`));
    if (!isPlainObject(source.columns)) throw new TypeError(`${name}.columns must be an object`);
    const columns = Object.entries(source.columns);
    if (columns.length > MAX_TEMPLATE_COLUMNS_PER_SOURCE) {
      throw new RangeError(`${name}.columns exceeds bounded capacity ${MAX_TEMPLATE_COLUMNS_PER_SOURCE}`);
    }
    for (const [columnName, column] of columns) {
      if (!isPlainObject(column)) throw new TypeError(`${name}.columns.${columnName} must be an object`);
      assertSafeInteger(column.startOffsetFrames, `${name}.columns.${columnName}.startOffsetFrames`, { min: start, max: end });
      assertSafeInteger(column.endOffsetFrames, `${name}.columns.${columnName}.endOffsetFrames`, { min: start, max: end });
      const columnEvents = assertArray(column.events, `${name}.columns.${columnName}.events`, MAX_TEMPLATE_TABLE_EVENTS);
      columnEvents.forEach((event, index) => validateEvent(event, `${name}.columns.${columnName}.events[${index}]`));
    }
    return source;
  }

  function validateRelativeTimeline(template, { sampleRate = null, mode = null, program = null, enforceStartIndex = true } = {}) {
    if (!isPlainObject(template) || Number(template.templateVersion) !== TEMPLATE_VERSION) {
      throw new RangeError(`relative timeline templateVersion must be ${TEMPLATE_VERSION}`);
    }
    if (Number(template.timelineVersion) !== Number(timelineDomain.TIMELINE_VERSION)) {
      throw new RangeError(`relative timeline timelineVersion must be ${timelineDomain.TIMELINE_VERSION}`);
    }
    if (![timelineDomain.MODES.SEQUENCE, timelineDomain.MODES.TRACK_PLAN].includes(template.mode)) {
      throw new RangeError("relative timeline mode is invalid");
    }
    if (mode && template.mode !== mode) throw new RangeError("relative timeline mode does not match Transport mode");
    const rate = assertSafeInteger(template.sampleRate, "relative timeline sampleRate", { min: 1 });
    if (sampleRate !== null && rate !== assertSafeInteger(sampleRate, "expected sampleRate", { min: 1 })) {
      throw new RangeError("relative timeline sampleRate does not match the runtime sampleRate");
    }
    const tracks = assertArray(template.tracks, "relative timeline tracks", MAX_TEMPLATE_TRACKS);
    const tableSources = assertArray(template.tableSources, "relative timeline tableSources", MAX_TEMPLATE_TABLE_SOURCES);
    const tableEvents = assertArray(template.tableEvents, "relative timeline tableEvents", MAX_TEMPLATE_TABLE_EVENTS);
    if (!isPlainObject(template.summary)) throw new TypeError("relative timeline summary must be an object");
    if (Number(template.summary.version) !== Number(timelineDomain.TIMELINE_VERSION)
        || template.summary.mode !== template.mode
        || Number(template.summary.sampleRate) !== rate) {
      throw new RangeError("relative timeline summary identity does not match the template");
    }
    assertSafeInteger(template.summary.maxSameFrameRows, "relative timeline summary.maxSameFrameRows", {
      min: 0,
      max: timelineDomain.MAX_SAME_FRAME_ROWS,
    });
    if (Number(template.summary.tableEventCount) !== tableEvents.length) {
      throw new RangeError("relative timeline summary.tableEventCount does not match tableEvents");
    }

    if (template.mode === timelineDomain.MODES.SEQUENCE) {
      if (tracks.length !== 0) throw new RangeError("sequence relative timeline cannot contain Track cycles");
      const steps = Array.isArray(program?.steps) ? program.steps : Array.isArray(program?.sequence) ? program.sequence : null;
      const expected = steps
        ? {
            rowCount: steps.length,
            startIndex: program?.startIndex ?? program?.stepIndex ?? 0,
            enforceStartIndex,
          }
        : {};
      validateCycle(template.sequence, "relative timeline sequence", expected);
    } else {
      if (template.sequence !== null) throw new RangeError("track-plan relative timeline cannot contain a sequence cycle");
      const seenTracks = new Set();
      for (let index = 0; index < tracks.length; index += 1) {
        const cycle = tracks[index];
        const track = assertSafeInteger(cycle?.track, `relative timeline tracks[${index}].track`, { min: 0, max: MAX_TEMPLATE_TRACKS - 1 });
        if (seenTracks.has(track)) throw new RangeError(`relative timeline Track ${track} is duplicated`);
        seenTracks.add(track);
        const candidate = program?.tracks?.[track];
        const events = Array.isArray(candidate?.events) ? candidate.events : null;
        validateCycle(cycle, `relative timeline tracks[${index}]`, events ? {
          track,
          rowCount: events.length,
          startIndex: candidate?.startIndex ?? candidate?.position ?? 0,
          enforceStartIndex,
        } : { track });
      }
      if (program?.tracks) {
        const activeTracks = program.tracks
          .map((candidate, track) => candidate?.active === true && Array.isArray(candidate.events) && candidate.events.length > 0 ? track : -1)
          .filter((track) => track >= 0);
        if (activeTracks.length !== tracks.length || activeTracks.some((track) => !seenTracks.has(track))) {
          throw new RangeError("relative timeline Track cycles do not match the active Transport program");
        }
      }
    }

    tableSources.forEach((source, index) => validateTableSource(source, `relative timeline tableSources[${index}]`));
    tableEvents.forEach((event, index) => validateEvent(event, `relative timeline tableEvents[${index}]`));
    return template;
  }

  function bindEvent(event, startFrame) {
    return Object.freeze({
      ...copyWithout(event, new Set(["frameOffset"])),
      frame: addFrameOffset(startFrame, event.frameOffset, "relative timeline event frame"),
    });
  }

  function rotateCycle(cycle, requestedStartIndex, name) {
    if (!cycle) return null;
    const rowCount = assertSafeInteger(cycle.rowCount, `${name}.rowCount`, { min: 1, max: MAX_TEMPLATE_ROWS_PER_CYCLE });
    const startIndex = normalizeIndex(requestedStartIndex ?? cycle.startIndex, rowCount);
    if (startIndex === cycle.startIndex) return cycle;
    const rows = assertArray(cycle.rows, `${name}.rows`, MAX_TEMPLATE_ROWS_PER_CYCLE);
    if (rows.length !== rowCount) throw new RangeError(`${name}.rows length must equal rowCount`);
    const cycleFrames = assertSafeInteger(cycle.cycleFrames, `${name}.cycleFrames`, { min: 1 });
    let boundaryOffset = 0;
    const schedule = [];
    for (let sourceOrder = 0; sourceOrder < rowCount; sourceOrder += 1) {
      const rowIndex = (startIndex + sourceOrder) % rowCount;
      const row = rows[rowIndex];
      const durationFrames = assertSafeInteger(row?.durationFrames, `${name}.rows[${rowIndex}].durationFrames`, { min: 0, max: cycleFrames });
      const microOffsetFrames = assertSafeInteger(row?.microOffsetFrames, `${name}.rows[${rowIndex}].microOffsetFrames`, {
        min: -cycleFrames,
        max: cycleFrames,
      });
      const frameOffset = boundaryOffset + microOffsetFrames;
      if (!Number.isSafeInteger(frameOffset) || frameOffset < 0) {
        throw new RangeError(`${name} exact start row ${rowIndex} resolves negative micro-time before the Transport anchor`);
      }
      if (frameOffset >= cycleFrames) {
        throw new RangeError(`${name} exact start row ${rowIndex} crosses the repeating cycle boundary`);
      }
      schedule.push(Object.freeze({
        frameOffset,
        boundaryOffset,
        row: rowIndex,
        phraseRow: row.phraseRow,
        sourceOrder,
      }));
      boundaryOffset = assertSafeInteger(boundaryOffset + durationFrames, `${name}.boundaryOffset`, { min: 0, max: cycleFrames });
    }
    if (boundaryOffset !== cycleFrames) throw new Error(`${name} exact rotation did not preserve cycle duration`);
    schedule.sort((left, right) => left.frameOffset - right.frameOffset || left.sourceOrder - right.sourceOrder);
    return Object.freeze({ ...cycle, startIndex, schedule: Object.freeze(schedule) });
  }

  function maximumRowsAtOneOffset(cycles) {
    const counts = new Map();
    let maximum = 0;
    for (const cycle of cycles) {
      if (!cycle) continue;
      for (const event of cycle.schedule) {
        const next = (counts.get(event.frameOffset) ?? 0) + 1;
        counts.set(event.frameOffset, next);
        if (next > maximum) maximum = next;
      }
    }
    return maximum;
  }

  function bindColumn(column, startFrame) {
    return Object.freeze({
      ...copyWithout(column, new Set(["startOffsetFrames", "endOffsetFrames", "events"])),
      startFrame: addFrameOffset(startFrame, column.startOffsetFrames, "relative Table column startFrame"),
      endFrame: addFrameOffset(startFrame, column.endOffsetFrames, "relative Table column endFrame"),
      events: Object.freeze(column.events.map((event) => bindEvent(event, startFrame))),
    });
  }

  function bindTableSource(source, startFrame) {
    return Object.freeze({
      ...copyWithout(source, new Set(["startOffsetFrames", "endOffsetFrames", "columns", "events"])),
      startFrame: addFrameOffset(startFrame, source.startOffsetFrames, "relative Table source startFrame"),
      endFrame: addFrameOffset(startFrame, source.endOffsetFrames, "relative Table source endFrame"),
      columns: Object.freeze(Object.fromEntries(
        Object.entries(source.columns).map(([name, column]) => [name, bindColumn(column, startFrame)]),
      )),
      events: Object.freeze(source.events.map((event) => bindEvent(event, startFrame))),
    });
  }

  function bindSummary(summary, startFrame, sequence, tracks, maxSameFrameRows) {
    return Object.freeze({
      ...copyWithout(summary, new Set(["sequence", "tracks", "tableSources", "maxSameFrameRows"])),
      startFrame,
      sequence: sequence ? Object.freeze({
        ...summary.sequence,
        startIndex: sequence.startIndex,
      }) : null,
      tracks: Object.freeze(tracks.map((cycle) => Object.freeze({
        ...(summary.tracks.find((entry) => entry.track === cycle.track) ?? {}),
        track: cycle.track,
        rowCount: cycle.rowCount,
        cycleFrames: cycle.cycleFrames,
        startIndex: cycle.startIndex,
      }))),
      tableSources: Object.freeze(summary.tableSources.map((source) => Object.freeze({
        ...copyWithout(source, new Set(["startOffsetFrames", "endOffsetFrames"])),
        startFrame: addFrameOffset(startFrame, source.startOffsetFrames, "relative summary Table source startFrame"),
        endFrame: addFrameOffset(startFrame, source.endOffsetFrames, "relative summary Table source endFrame"),
      }))),
      maxSameFrameRows,
    });
  }

  function bindRelativeTimeline(template, startFrame = 0, position = null) {
    if (!isPlainObject(template) || Number(template.templateVersion) !== TEMPLATE_VERSION) {
      throw new RangeError(`relative timeline templateVersion must be ${TEMPLATE_VERSION}`);
    }
    if (!Array.isArray(template.tracks) || !Array.isArray(template.tableSources) || !Array.isArray(template.tableEvents)) {
      throw new TypeError("relative timeline template arrays are invalid");
    }
    const origin = assertSafeInteger(startFrame, "startFrame", { min: 0 });
    const requested = isPlainObject(position) ? position : {};
    const sequence = template.sequence
      ? rotateCycle(template.sequence, requested.sequenceStartIndex, "relative timeline sequence")
      : null;
    const trackStartIndices = Array.isArray(requested.trackStartIndices) ? requested.trackStartIndices : [];
    const tracks = Object.freeze(template.tracks.map((cycle) => rotateCycle(
      cycle,
      Number.isInteger(trackStartIndices[cycle.track]) && trackStartIndices[cycle.track] >= 0
        ? trackStartIndices[cycle.track]
        : cycle.startIndex,
      `relative timeline Track ${cycle.track}`,
    )));
    const maxSameFrameRows = maximumRowsAtOneOffset(sequence ? [sequence] : tracks);
    if (maxSameFrameRows > timelineDomain.MAX_SAME_FRAME_ROWS) {
      throw new RangeError(`relative timeline exact bind has ${maxSameFrameRows} rows at one frame; maximum is ${timelineDomain.MAX_SAME_FRAME_ROWS}`);
    }
    return Object.freeze({
      version: template.timelineVersion,
      mode: template.mode,
      sampleRate: template.sampleRate,
      startFrame: origin,
      tempo: template.tempo,
      request: template.request,
      sequence,
      tracks,
      tableSources: Object.freeze(template.tableSources.map((source) => bindTableSource(source, origin))),
      tableEvents: Object.freeze(template.tableEvents.map((event) => bindEvent(event, origin))),
      summary: bindSummary(template.summary, origin, sequence, tracks, maxSameFrameRows),
    });
  }

  function canonicalize(value, seen = new Set()) {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
      throw new TypeError("unsupported relative timeline value");
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new TypeError("relative timeline values must be finite");
      return Object.is(value, -0) ? 0 : value;
    }
    if (Array.isArray(value)) {
      if (seen.has(value)) throw new TypeError("relative timeline values must not contain cycles");
      seen.add(value);
      const result = value.map((entry) => canonicalize(entry, seen));
      seen.delete(value);
      return result;
    }
    if (isPlainObject(value)) {
      if (seen.has(value)) throw new TypeError("relative timeline values must not contain cycles");
      seen.add(value);
      const result = {};
      for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key], seen);
      seen.delete(value);
      return result;
    }
    throw new TypeError("relative timeline values must contain only JSON-compatible data");
  }

  function serializeRelativeTimeline(value) {
    return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
  }

  const api = Object.freeze({
    TEMPLATE_VERSION,
    MAX_TEMPLATE_TRACKS,
    MAX_TEMPLATE_ROWS_PER_CYCLE,
    MAX_TEMPLATE_TABLE_SOURCES,
    MAX_TEMPLATE_TABLE_EVENTS,
    compileRelativeTimeline,
    validateRelativeTimeline,
    bindRelativeTimeline,
    serializeRelativeTimeline,
  });

  if (typeof globalThis !== "undefined") globalThis.BRKTRKProductionTimelineTemplate = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();