(() => {
  "use strict";

  const timelineDomain = globalThis.BRKTRKProductionTimelineDomain
    ?? (typeof module !== "undefined" && module.exports ? require("./production-timeline-domain.js") : null);
  const timingDomain = globalThis.BRKTRKTimingDomain
    ?? (typeof module !== "undefined" && module.exports ? require("./timing-domain.js") : null);
  const eventTraceDomain = globalThis.BRKTRKEventTraceDomain
    ?? (typeof module !== "undefined" && module.exports ? require("./event-trace-domain.js") : null);
  if (!timelineDomain || !timingDomain?.EVENT_PHASES || !eventTraceDomain?.compileRowTraceEvents) {
    throw new Error("BRKTRK prepared execution template requires production timeline + K0 timing + K4 event trace domains");
  }

  const EXECUTION_TEMPLATE_VERSION = 1;
  const KIND = Object.freeze({
    NOTE_RELEASE: 1,
    PARAMETER: 2,
    NOTE_TRIGGER: 3,
    FX_INERT: 4,
    OBSERVE_ROW: 5,
  });
  const EVENT_KIND = Object.freeze({
    "note-release": KIND.NOTE_RELEASE,
    parameter: KIND.PARAMETER,
    "note-trigger": KIND.NOTE_TRIGGER,
    "fx-inert": KIND.FX_INERT,
  });
  const VALID_KINDS = new Set(Object.values(KIND));
  const MAX_TRACKS = timelineDomain.DEFAULT_TRACK_COUNT ?? 8;
  const MAX_ROWS_PER_CYCLE = 65536;
  const MAX_RECORDS = 262144;
  const MAX_PHASE = timingDomain.EVENT_PHASES.OBSERVE;

  const safeInteger = (value, label, min = 0, max = Number.MAX_SAFE_INTEGER) => {
    const numeric = Number(value);
    if (!Number.isSafeInteger(numeric) || numeric < min || numeric > max) {
      throw new RangeError(`${label} must be a safe integer between ${min} and ${max}`);
    }
    return numeric;
  };

  function normalizedProgram(program) {
    if (!program || typeof program !== "object") throw new TypeError("prepared execution template requires a Transport program");
    if (program.mode === "track-plan") return program;
    return Object.freeze({ ...program, mode: "sequence", steps: Array.isArray(program.steps) ? program.steps : Array.isArray(program.sequence) ? program.sequence : [] });
  }

  function rationalEqual(left, right) {
    const leftNumerator = Number(left?.numerator ?? left);
    const leftDenominator = Number(left?.denominator ?? 1);
    const rightNumerator = Number(right?.numerator ?? right);
    const rightDenominator = Number(right?.denominator ?? 1);
    return Number.isFinite(leftNumerator) && Number.isFinite(leftDenominator) && leftDenominator > 0
      && Number.isFinite(rightNumerator) && Number.isFinite(rightDenominator) && rightDenominator > 0
      && leftNumerator * rightDenominator === rightNumerator * leftDenominator;
  }

  function compactRecord(event) {
    const kind = EVENT_KIND[event?.kind];
    if (!kind) throw new RangeError(`unsupported prepared execution event kind ${String(event?.kind)}`);
    const data = event.data ?? {};
    const note = Number(data.note);
    const instrumentId = Number(data.instrumentId);
    const velocity = Number(data.velocity);
    return Object.freeze({
      frameDelta: safeInteger(event.frame, "execution record frameDelta", 0),
      phase: safeInteger(event.phase, "execution record phase", 0, MAX_PHASE),
      track: safeInteger(event.track, "execution record track", 0, MAX_TRACKS - 1),
      kind,
      instrumentId: Number.isInteger(instrumentId) && instrumentId >= 0 && instrumentId <= 255 ? instrumentId : -1,
      note: Number.isFinite(note) ? note : -1,
      velocity: Number.isFinite(velocity) ? velocity : 100,
      fxLane: Number.isInteger(Number(data.fxLane)) ? Number(data.fxLane) : -1,
      retrigger: data.retrigger === true,
      resetsPhase: data.resetsPhase === true,
    });
  }

  function observeRecord(kind, track) {
    return Object.freeze({
      frameDelta: 0,
      phase: timingDomain.EVENT_PHASES.OBSERVE,
      track: kind === "sequence" ? 0 : track,
      kind: KIND.OBSERVE_ROW,
      instrumentId: -1,
      note: -1,
      velocity: 100,
      fxLane: -1,
      retrigger: false,
      resetsPhase: false,
    });
  }

  function rowTiming(timelineTemplate, cycle, row) {
    const timingRow = cycle?.timingMap?.rows?.[row];
    if (!timingRow) throw new RangeError(`prepared execution timing row ${row} is missing`);
    return Object.freeze({
      sampleRate: timelineTemplate.sampleRate,
      ppqn: timingRow.groove?.ppqn ?? 24,
      tempo: timingRow.tempo ?? timelineTemplate.tempo,
    });
  }

  function compileRow({ timelineTemplate, program, cycle, row, kind, track = -1 } = {}) {
    const sourceRow = cycle?.rows?.[row];
    if (!sourceRow) throw new RangeError(`prepared execution row ${row} is missing from the relative timeline cycle`);
    const rowEvent = Object.freeze({
      kind,
      track,
      row,
      phraseRow: safeInteger(sourceRow.phraseRow ?? row, "prepared execution phraseRow", 0),
      sourceOrder: 0,
      timing: rowTiming(timelineTemplate, cycle, row),
    });
    const records = [];
    if (kind === "sequence") {
      for (let targetTrack = 0; targetTrack < MAX_TRACKS; targetTrack += 1) {
        for (const event of eventTraceDomain.compileRowTraceEvents({ frame: 0, program, rowEvent, track: targetTrack })) {
          records.push(compactRecord(event));
        }
      }
    } else {
      for (const event of eventTraceDomain.compileRowTraceEvents({ frame: 0, program, rowEvent, track })) {
        records.push(compactRecord(event));
      }
    }
    records.push(observeRecord(kind, track));
    records.sort((left, right) => left.frameDelta - right.frameDelta
      || left.phase - right.phase
      || left.track - right.track
      || left.fxLane - right.fxLane
      || left.kind - right.kind);
    return Object.freeze(records);
  }

  function compilePreparedExecution({ timelineTemplate, program } = {}) {
    if (!timelineTemplate || typeof timelineTemplate !== "object") throw new TypeError("prepared execution requires a relative timeline template");
    const normalized = normalizedProgram(program);
    if (normalized.mode !== timelineTemplate.mode) throw new RangeError("prepared execution mode must match the relative timeline template");
    let recordCount = 0;
    const acceptRows = (cycle, kind, track = -1) => {
      const rowCount = safeInteger(cycle?.rowCount, "prepared execution rowCount", 1, MAX_ROWS_PER_CYCLE);
      const rows = new Array(rowCount);
      for (let row = 0; row < rowCount; row += 1) {
        const records = compileRow({ timelineTemplate, program: normalized, cycle, row, kind, track });
        recordCount += records.length;
        if (recordCount > MAX_RECORDS) throw new RangeError(`prepared execution template exceeds ${MAX_RECORDS} compact K4 records`);
        rows[row] = records;
      }
      return Object.freeze(rows);
    };

    let sequenceRows = null;
    const tracks = [];
    if (normalized.mode === "track-plan") {
      for (const cycle of timelineTemplate.tracks ?? []) {
        const track = safeInteger(cycle.track, "prepared execution Track", 0, MAX_TRACKS - 1);
        tracks.push(Object.freeze({ track, rows: acceptRows(cycle, "track", track) }));
      }
    } else {
      sequenceRows = acceptRows(timelineTemplate.sequence, "sequence", -1);
    }

    return Object.freeze({
      executionVersion: EXECUTION_TEMPLATE_VERSION,
      timelineVersion: timelineTemplate.timelineVersion,
      mode: normalized.mode,
      sampleRate: timelineTemplate.sampleRate,
      tempo: timelineTemplate.tempo,
      recordCount,
      sequenceRows,
      tracks: Object.freeze(tracks),
    });
  }

  function validateRecord(record, label) {
    if (!record || typeof record !== "object") throw new TypeError(`${label} must be an object`);
    safeInteger(record.frameDelta, `${label}.frameDelta`, 0);
    safeInteger(record.phase, `${label}.phase`, 0, MAX_PHASE);
    safeInteger(record.track, `${label}.track`, 0, MAX_TRACKS - 1);
    if (!VALID_KINDS.has(record.kind)) throw new RangeError(`${label}.kind is invalid`);
    safeInteger(record.instrumentId, `${label}.instrumentId`, -1, 255);
    if (!Number.isFinite(Number(record.note))) throw new TypeError(`${label}.note must be finite`);
    if (!Number.isFinite(Number(record.velocity))) throw new TypeError(`${label}.velocity must be finite`);
    safeInteger(record.fxLane, `${label}.fxLane`, -1, 255);
    return record;
  }

  function validatePreparedExecution(template, { timelineTemplate = null, mode = null, program = null } = {}) {
    if (!template || typeof template !== "object" || Number(template.executionVersion) !== EXECUTION_TEMPLATE_VERSION) {
      throw new RangeError(`prepared execution version must be ${EXECUTION_TEMPLATE_VERSION}`);
    }
    if (Number(template.timelineVersion) !== Number(timelineDomain.TIMELINE_VERSION)) throw new RangeError("prepared execution timelineVersion is invalid");
    if (!["sequence", "track-plan"].includes(template.mode)) throw new RangeError("prepared execution mode is invalid");
    if (mode && template.mode !== mode) throw new RangeError("prepared execution mode does not match Transport mode");
    if (timelineTemplate) {
      if (template.mode !== timelineTemplate.mode || Number(template.sampleRate) !== Number(timelineTemplate.sampleRate)) {
        throw new RangeError("prepared execution identity does not match the relative timeline template");
      }
      if (!rationalEqual(template.tempo, timelineTemplate.tempo)) {
        throw new RangeError("prepared execution tempo does not match the relative timeline template");
      }
    }
    const normalized = program ? normalizedProgram(program) : null;
    if (normalized && normalized.mode !== template.mode) throw new RangeError("prepared execution program mode does not match template mode");
    let count = 0;
    const validateRows = (rows, label, expectedCount = null) => {
      if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_ROWS_PER_CYCLE) throw new RangeError(`${label} rows are invalid`);
      if (Number.isInteger(expectedCount) && rows.length !== expectedCount) throw new RangeError(`${label} row count does not match the Transport program`);
      for (let row = 0; row < rows.length; row += 1) {
        const records = rows[row];
        if (!Array.isArray(records)) throw new TypeError(`${label}[${row}] must be an array`);
        for (let index = 0; index < records.length; index += 1) {
          validateRecord(records[index], `${label}[${row}][${index}]`);
          count += 1;
          if (count > MAX_RECORDS) throw new RangeError(`prepared execution template exceeds ${MAX_RECORDS} compact K4 records`);
        }
      }
    };
    if (template.mode === "sequence") {
      const steps = normalized?.steps ?? null;
      const expectedRows = steps ? steps.length : Number(timelineTemplate?.sequence?.rowCount ?? NaN);
      validateRows(template.sequenceRows, "prepared execution sequenceRows", Number.isInteger(expectedRows) ? expectedRows : null);
      if (Array.isArray(template.tracks) && template.tracks.length !== 0) throw new RangeError("sequence prepared execution cannot contain Track rows");
    } else {
      if (template.sequenceRows !== null) throw new RangeError("track-plan prepared execution cannot contain sequenceRows");
      if (!Array.isArray(template.tracks) || template.tracks.length > MAX_TRACKS) throw new RangeError("prepared execution tracks are invalid");
      const seen = new Set();
      for (let index = 0; index < template.tracks.length; index += 1) {
        const track = safeInteger(template.tracks[index]?.track, `prepared execution tracks[${index}].track`, 0, MAX_TRACKS - 1);
        if (seen.has(track)) throw new RangeError(`prepared execution Track ${track} is duplicated`);
        seen.add(track);
        const programEvents = Array.isArray(normalized?.tracks?.[track]?.events) ? normalized.tracks[track].events : null;
        const timelineCycle = Array.isArray(timelineTemplate?.tracks) ? timelineTemplate.tracks.find((cycle) => Number(cycle.track) === track) : null;
        const expectedRows = programEvents?.length ?? Number(timelineCycle?.rowCount ?? NaN);
        validateRows(template.tracks[index].rows, `prepared execution tracks[${index}].rows`, Number.isInteger(expectedRows) ? expectedRows : null);
      }
      if (normalized?.tracks) {
        const active = [];
        for (let track = 0; track < normalized.tracks.length; track += 1) {
          const candidate = normalized.tracks[track];
          if (candidate?.active === true && Array.isArray(candidate.events) && candidate.events.length > 0) active.push(track);
        }
        if (active.length !== seen.size || active.some((track) => !seen.has(track))) {
          throw new RangeError("prepared execution Track topology does not match the Transport program");
        }
      }
    }
    if (safeInteger(template.recordCount, "prepared execution recordCount", 0, MAX_RECORDS) !== count) {
      throw new RangeError("prepared execution recordCount does not match compact K4 records");
    }
    return template;
  }

  const api = Object.freeze({
    EXECUTION_TEMPLATE_VERSION,
    KIND,
    MAX_TRACKS,
    MAX_ROWS_PER_CYCLE,
    MAX_RECORDS,
    compilePreparedExecution,
    validatePreparedExecution,
  });
  globalThis.BRKTRKProductionExecutionTemplate = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
