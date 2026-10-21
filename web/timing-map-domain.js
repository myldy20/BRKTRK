(() => {
  const timingDomain = globalThis.BRKTRKTimingDomain
    ?? (typeof module !== "undefined" && module.exports ? require("./timing-domain.js") : null);
  if (!timingDomain) throw new Error("BRKTRK timing maps require the K0 timing domain");

  const GROOVE_ROWS = 16;
  const GROOVE_ENTRY_MAX = 0xff;
  const DEFAULT_GROOVE = Object.freeze({ ppqn: 24, rows: Object.freeze([6, 6]) });
  const CURSOR_POLICIES = Object.freeze({ RESET: "reset", PRESERVE: "preserve" });

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

  function gcdBigInt(a, b) {
    let left = a < 0n ? -a : a;
    let right = b < 0n ? -b : b;
    while (right !== 0n) {
      const next = left % right;
      left = right;
      right = next;
    }
    return left || 1n;
  }

  function normalizeSignedFraction(numerator, denominator = 1n) {
    let n = typeof numerator === "bigint" ? numerator : BigInt(numerator);
    let d = typeof denominator === "bigint" ? denominator : BigInt(denominator);
    if (d === 0n) throw new RangeError("fraction denominator must not be zero");
    if (d < 0n) { n = -n; d = -d; }
    if (n === 0n) return Object.freeze({ numerator: 0n, denominator: 1n });
    const divisor = gcdBigInt(n, d);
    return Object.freeze({ numerator: n / divisor, denominator: d / divisor });
  }

  function addFractions(left, right) {
    return normalizeSignedFraction(
      left.numerator * right.denominator + right.numerator * left.denominator,
      left.denominator * right.denominator,
    );
  }

  function roundNonNegativeRatio(numerator, denominator) {
    if (numerator < 0n || denominator <= 0n) throw new RangeError("frame ratio must be non-negative");
    return (2n * numerator + denominator) / (2n * denominator);
  }

  function safeNumberFromBigInt(value, name) {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new RangeError(`${name} exceeds JavaScript safe-integer range`);
    }
    return Number(value);
  }

  function serializeRational(value, name) {
    const rational = timingDomain.normalizePositiveRational(value, name);
    return Object.freeze({
      numerator: assertSafeInteger(rational.numerator, `${name}.numerator`, { min: 1 }),
      denominator: assertSafeInteger(rational.denominator, `${name}.denominator`, { min: 1 }),
    });
  }

  function frameFractionForUnits(units, sampleRate, tempo) {
    const amount = assertSafeInteger(units, "musical units");
    const rate = assertSafeInteger(sampleRate, "sampleRate", { min: 1 });
    return normalizeSignedFraction(
      BigInt(amount) * BigInt(rate) * 60n * BigInt(tempo.denominator),
      BigInt(timingDomain.MUSICAL_UNITS_PER_QUARTER) * BigInt(tempo.numerator),
    );
  }

  function absoluteFrame(startFrame, offset) {
    const numerator = BigInt(startFrame) * offset.denominator + offset.numerator;
    if (numerator < 0n) throw new RangeError("timing-map event resolves before frame zero");
    return safeNumberFromBigInt(roundNonNegativeRatio(numerator, offset.denominator), "timing-map frame");
  }

  function isEmptyGrooveEntry(value) {
    return value === null || value === undefined || value === "--";
  }

  function normalizeGroove(candidate = DEFAULT_GROOVE, name = "groove") {
    const source = isPlainObject(candidate) ? candidate : {};
    const ppqn = assertSafeInteger(source.ppqn ?? DEFAULT_GROOVE.ppqn, `${name}.ppqn`, { min: 1 });
    if (!timingDomain.SUPPORTED_M8_GROOVE_PPQN.includes(ppqn)) {
      throw new RangeError(`${name}.ppqn must be one of ${timingDomain.SUPPORTED_M8_GROOVE_PPQN.join(", ")}`);
    }
    const rows = Array.isArray(source.rows) ? source.rows : DEFAULT_GROOVE.rows;
    if (rows.length < 1 || rows.length > GROOVE_ROWS) {
      throw new RangeError(`${name}.rows must contain between 1 and ${GROOVE_ROWS} entries`);
    }
    const active = [];
    for (let index = 0; index < rows.length; index += 1) {
      const value = rows[index];
      if (isEmptyGrooveEntry(value)) break;
      active.push(assertSafeInteger(value, `${name}.rows[${index}]`, { min: 0, max: GROOVE_ENTRY_MAX }));
    }
    if (active.length === 0) throw new RangeError(`${name} must have at least one active row before the first empty entry`);
    return Object.freeze({
      ppqn,
      rows: Object.freeze(active),
      length: active.length,
      unitsPerTick: timingDomain.unitsPerTick(ppqn),
      unitsPerSubtick: timingDomain.unitsPerSubtick(ppqn, 8),
    });
  }

  function normalizeCursorPolicy(value, name) {
    if (value === CURSOR_POLICIES.RESET || value === CURSOR_POLICIES.PRESERVE) return value;
    if (Number.isSafeInteger(Number(value)) && Number(value) >= 0) return Number(value);
    throw new RangeError(`${name} must be reset, preserve, or a non-negative explicit cursor`);
  }

  function normalizeSegments(segments, rowCount) {
    if (!Array.isArray(segments)) throw new TypeError("segments must be an array");
    if (rowCount === 1 && segments.length > 0) throw new RangeError("segments cannot start after the only compiled row");
    const normalized = segments.map((segment, index) => {
      if (!isPlainObject(segment)) throw new TypeError(`segments[${index}] must be an object`);
      const startRow = assertSafeInteger(segment.startRow, `segments[${index}].startRow`, { min: 1, max: rowCount - 1 });
      const hasTempo = Object.hasOwn(segment, "tempo");
      const hasGroove = Object.hasOwn(segment, "groove");
      if (!hasTempo && !hasGroove) throw new RangeError(`segments[${index}] must change tempo or groove`);
      if (!hasGroove && Object.hasOwn(segment, "cursor")) throw new RangeError(`segments[${index}].cursor requires a groove change`);
      const tempo = hasTempo ? serializeRational(segment.tempo, `segments[${index}].tempo`) : null;
      const groove = hasGroove ? normalizeGroove(segment.groove, `segments[${index}].groove`) : null;
      const cursor = hasGroove ? normalizeCursorPolicy(segment.cursor, `segments[${index}].cursor`) : null;
      return Object.freeze({ startRow, tempo, groove, cursor });
    }).sort((left, right) => left.startRow - right.startRow);
    for (let index = 1; index < normalized.length; index += 1) {
      if (normalized[index - 1].startRow === normalized[index].startRow) {
        throw new RangeError(`segments must not contain duplicate startRow ${normalized[index].startRow}`);
      }
    }
    return Object.freeze(normalized);
  }

  function normalizeMicroTime(values, rowCount) {
    if (values === undefined) return Object.freeze(Array(rowCount).fill(0));
    if (!Array.isArray(values)) throw new TypeError("microTimeSubticks must be an array");
    return Object.freeze(Array.from({ length: rowCount }, (_, row) => assertSafeInteger(values[row] ?? 0, `microTimeSubticks[${row}]`)));
  }

  function normalizePhraseRows(values, rowCount) {
    if (values === undefined) return Object.freeze(Array.from({ length: rowCount }, (_, row) => row % GROOVE_ROWS));
    if (!Array.isArray(values)) throw new TypeError("phraseRows must be an array");
    return Object.freeze(Array.from({ length: rowCount }, (_, row) => assertSafeInteger(values[row] ?? row % GROOVE_ROWS, `phraseRows[${row}]`, { min: 0, max: GROOVE_ROWS - 1 })));
  }

  function applySegment(state, segment) {
    if (segment.tempo) state.tempo = segment.tempo;
    if (!segment.groove) return;
    const previousCursor = state.grooveCursor;
    state.groove = segment.groove;
    if (segment.cursor === CURSOR_POLICIES.RESET) state.grooveCursor = 0;
    else if (segment.cursor === CURSOR_POLICIES.PRESERVE) state.grooveCursor = previousCursor % state.groove.length;
    else state.grooveCursor = segment.cursor % state.groove.length;
    state.grooveSegment += 1;
  }

  function compileTrackTimingMap({
    sampleRate,
    startFrame = 0,
    track = 0,
    rowCount,
    tempo = 120,
    groove = DEFAULT_GROOVE,
    segments = [],
    microTimeSubticks,
    phraseRows,
  } = {}) {
    const rate = assertSafeInteger(sampleRate, "sampleRate", { min: 1 });
    const origin = assertSafeInteger(startFrame, "startFrame", { min: 0 });
    const trackId = assertSafeInteger(track, "track", { min: 0 });
    const count = assertSafeInteger(rowCount, "rowCount", { min: 1 });
    const initialTempo = serializeRational(tempo, "tempo");
    const initialGroove = normalizeGroove(groove);
    const changes = normalizeSegments(segments, count);
    const micro = normalizeMicroTime(microTimeSubticks, count);
    const phrase = normalizePhraseRows(phraseRows, count);
    const state = {
      tempo: initialTempo,
      groove: initialGroove,
      grooveCursor: 0,
      tempoSegment: 0,
      grooveSegment: 0,
    };
    let segmentIndex = 0;
    let elapsed = normalizeSignedFraction(0n, 1n);
    let positionUnits = 0;
    const rows = [];

    for (let row = 0; row < count; row += 1) {
      while (segmentIndex < changes.length && changes[segmentIndex].startRow === row) {
        const change = changes[segmentIndex];
        if (change.tempo) state.tempoSegment += 1;
        applySegment(state, change);
        segmentIndex += 1;
      }

      const grooveIndex = state.grooveCursor % state.groove.length;
      const ticks = state.groove.rows[grooveIndex];
      const durationUnits = ticks * state.groove.unitsPerTick;
      const subticks = micro[row];
      if (subticks < 0 && phrase[row] === 0) {
        throw new RangeError(`negative micro-time is not valid on first Phrase row at track row ${row}`);
      }
      const microUnits = subticks * state.groove.unitsPerSubtick;
      const eventOffset = addFractions(elapsed, frameFractionForUnits(microUnits, rate, state.tempo));
      const nextElapsed = addFractions(elapsed, frameFractionForUnits(durationUnits, rate, state.tempo));
      rows.push(Object.freeze({
        track: trackId,
        row,
        phraseRow: phrase[row],
        positionUnits,
        boundaryFrame: absoluteFrame(origin, elapsed),
        eventFrame: absoluteFrame(origin, eventOffset),
        nextBoundaryFrame: absoluteFrame(origin, nextElapsed),
        tempo: state.tempo,
        tempoSegment: state.tempoSegment,
        groove: Object.freeze({
          ppqn: state.groove.ppqn,
          index: grooveIndex,
          ticks,
          length: state.groove.length,
          segment: state.grooveSegment,
        }),
        durationUnits,
        skipped: ticks === 0,
        microTime: Object.freeze({ subticks, units: microUnits }),
      }));
      elapsed = nextElapsed;
      positionUnits = assertSafeInteger(positionUnits + durationUnits, "timing-map positionUnits", { min: 0 });
      state.grooveCursor = (state.grooveCursor + 1) % state.groove.length;
    }

    return Object.freeze({
      version: 1,
      sampleRate: rate,
      startFrame: origin,
      track: trackId,
      rowCount: count,
      initialTempo,
      initialGroove,
      segments: changes,
      rows: Object.freeze(rows),
      endFrame: absoluteFrame(origin, elapsed),
      endPositionUnits: positionUnits,
    });
  }

  function compileTrackTimingMaps({ sampleRate, startFrame = 0, tracks = [] } = {}) {
    if (!Array.isArray(tracks)) throw new TypeError("tracks must be an array");
    const compiled = tracks.map((trackSpec, index) => compileTrackTimingMap({
      ...trackSpec,
      sampleRate,
      startFrame: trackSpec?.startFrame ?? startFrame,
      track: trackSpec?.track ?? index,
    })).sort((left, right) => left.track - right.track);
    for (let index = 1; index < compiled.length; index += 1) {
      if (compiled[index - 1].track === compiled[index].track) {
        throw new RangeError(`tracks must not contain duplicate Track ${compiled[index].track}`);
      }
    }
    return Object.freeze(compiled);
  }

  function compileTimingMapTrace(maps) {
    const source = Array.isArray(maps) ? maps : [maps];
    const events = [];
    for (const map of source) {
      if (!map || !Array.isArray(map.rows)) throw new TypeError("timing map trace requires compiled maps");
      for (const row of map.rows) {
        events.push({
          kind: "track-row-boundary",
          source: "groove-map",
          sourceOrder: row.row,
          track: row.track,
          phase: timingDomain.EVENT_PHASES.CLOCK,
          position: { clock: timingDomain.CLOCK_DOMAINS.FRAME, frame: row.boundaryFrame },
          data: {
            row: row.row,
            phraseRow: row.phraseRow,
            ticks: row.groove.ticks,
            ppqn: row.groove.ppqn,
            skipped: row.skipped,
          },
        });
        if (row.microTime.subticks !== 0) {
          events.push({
            kind: "track-row-micro-time",
            source: "micro-time-map",
            sourceOrder: row.row,
            track: row.track,
            phase: timingDomain.EVENT_PHASES.SOURCE_CONTROL,
            position: { clock: timingDomain.CLOCK_DOMAINS.FRAME, frame: row.eventFrame },
            data: { row: row.row, phraseRow: row.phraseRow, subticks: row.microTime.subticks },
          });
        }
      }
    }
    return timingDomain.compileTimingTrace({ sampleRate: 1, tempo: 120, events });
  }

  function canonicalize(value, seen = new Set()) {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
      throw new TypeError("unsupported timing-map value");
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new TypeError("timing-map values must be finite");
      return Object.is(value, -0) ? 0 : value;
    }
    if (Array.isArray(value)) {
      if (seen.has(value)) throw new TypeError("timing-map values must not contain cycles");
      seen.add(value);
      const result = value.map((entry) => canonicalize(entry, seen));
      seen.delete(value);
      return result;
    }
    if (isPlainObject(value)) {
      if (seen.has(value)) throw new TypeError("timing-map values must not contain cycles");
      seen.add(value);
      const result = {};
      for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key], seen);
      seen.delete(value);
      return result;
    }
    throw new TypeError("timing-map values must contain only JSON-compatible data");
  }

  function serializeTimingMap(value) {
    return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
  }

  const api = Object.freeze({
    GROOVE_ROWS,
    GROOVE_ENTRY_MAX,
    DEFAULT_GROOVE,
    CURSOR_POLICIES,
    normalizeGroove,
    compileTrackTimingMap,
    compileTrackTimingMaps,
    compileTimingMapTrace,
    serializeTimingMap,
    serializeTimingMapTrace: timingDomain.serializeTimingTrace,
  });

  if (typeof globalThis !== "undefined") globalThis.BRKTRKTimingMapDomain = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
