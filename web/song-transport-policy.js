(() => {
  const EMPTY = -1;
  const NOTE_OFF = -2;
  const TRACKS = 8;
  const SONG_ROWS = 64;
  const CHAIN_ROWS = 16;
  const PHRASE_ROWS = 16;

  const integerOr = (value, fallback) => Number.isInteger(Number(value)) ? Number(value) : fallback;
  const isReference = (value) => Number.isInteger(Number(value)) && Number(value) >= 0;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function cell(song, row, track) {
    return song?.[row]?.[track] ?? EMPTY;
  }

  function nextPlayableRow(song, track, fromRow = 0) {
    for (let row = clamp(integerOr(fromRow, 0), 0, Math.max(0, song.length - 1)); row < song.length; row += 1) {
      if (isReference(cell(song, row, track))) return row;
    }
    return -1;
  }

  function segmentFor(song, track, anchorRow = 0) {
    if (!Array.isArray(song) || song.length === 0) return null;
    const safeTrack = clamp(integerOr(track, 0), 0, TRACKS - 1);
    const safeAnchor = clamp(integerOr(anchorRow, 0), 0, song.length - 1);
    const entryRow = isReference(cell(song, safeAnchor, safeTrack))
      ? safeAnchor
      : nextPlayableRow(song, safeTrack, safeAnchor + 1);
    if (entryRow < 0) return null;

    let start = entryRow;
    while (start > 0 && isReference(cell(song, start - 1, safeTrack))) start -= 1;
    let end = entryRow + 1;
    while (end < song.length && isReference(cell(song, end, safeTrack))) end += 1;
    return Object.freeze({ start, end, entryRow, track: safeTrack });
  }

  function chainOccurrences(model, chainId, songRow) {
    if (!isReference(chainId)) return [];
    const source = model?.chains?.[chainId];
    if (!Array.isArray(source)) return [];
    const result = [];
    for (let chainRow = 0; chainRow < Math.min(CHAIN_ROWS, source.length); chainRow += 1) {
      const entry = source[chainRow];
      if (!entry || !isReference(entry.phrase)) break;
      result.push(Object.freeze({
        songRow,
        chainId: Number(chainId),
        chainRow,
        phraseId: Number(entry.phrase),
        transpose: integerOr(entry.transpose, 0),
      }));
    }
    return result;
  }

  function programPeriod(program) {
    return Array.isArray(program?.contexts) ? program.contexts.length : 0;
  }

  function wrapProgramIndex(programOrLength, stepIndex = 0) {
    const length = typeof programOrLength === "number"
      ? Math.max(0, integerOr(programOrLength, 0))
      : programPeriod(programOrLength);
    if (length === 0) return -1;
    const requested = integerOr(stepIndex, 0);
    return ((requested % length) + length) % length;
  }

  function normalizeProgramStart(program) {
    const wrapped = wrapProgramIndex(program, program?.startIndex ?? 0);
    return wrapped < 0 ? 0 : wrapped;
  }

  function resolveProgramStep(program, stepIndex = 0) {
    const index = wrapProgramIndex(program, stepIndex);
    if (index < 0) return null;
    const context = program.contexts[index] ?? null;
    if (!context) return null;
    return Object.freeze({
      index,
      period: programPeriod(program),
      context,
      phraseBoundary: context.phraseRow === 0,
    });
  }

  function remapProgramPosition(previousPosition, nextProgram) {
    const wrapped = wrapProgramIndex(nextProgram, previousPosition);
    return wrapped < 0 ? 0 : wrapped;
  }

  function buildTrackProgram({ model, track = 0, anchorRow = 0, startChainRow = 0 } = {}) {
    const song = model?.song;
    const segment = segmentFor(song, track, anchorRow);
    if (!segment) return Object.freeze({
      active: false,
      track,
      occurrences: Object.freeze([]),
      contexts: Object.freeze([]),
      periodRows: 0,
      startIndex: 0,
      segment: null,
    });

    const occurrences = [];
    for (let songRow = segment.start; songRow < segment.end; songRow += 1) {
      occurrences.push(...chainOccurrences(model, cell(song, songRow, track), songRow));
    }

    const contexts = [];
    let startIndex = -1;
    const requestedChainRow = Math.max(0, integerOr(startChainRow, 0));
    for (const occurrence of occurrences) {
      if (startIndex < 0
        && occurrence.songRow === segment.entryRow
        && occurrence.chainRow >= requestedChainRow) {
        startIndex = contexts.length;
      }
      for (let phraseRow = 0; phraseRow < PHRASE_ROWS; phraseRow += 1) {
        contexts.push(Object.freeze({ ...occurrence, phraseRow }));
      }
    }

    const frozenOccurrences = Object.freeze(occurrences);
    const frozenContexts = Object.freeze(contexts);
    if (frozenContexts.length === 0) {
      return Object.freeze({
        active: false,
        track: segment.track,
        occurrences: frozenOccurrences,
        contexts: frozenContexts,
        periodRows: 0,
        startIndex: 0,
        segment,
      });
    }

    if (startIndex < 0) {
      const firstAtOrAfterEntry = frozenContexts.findIndex((context) => context.songRow >= segment.entryRow);
      startIndex = firstAtOrAfterEntry >= 0 ? firstAtOrAfterEntry : 0;
    }

    const program = {
      active: true,
      track: segment.track,
      occurrences: frozenOccurrences,
      contexts: frozenContexts,
      periodRows: frozenContexts.length,
      startIndex,
      segment,
    };
    program.startIndex = normalizeProgramStart(program);
    return Object.freeze(program);
  }

  function contextAt(program, stepIndex) {
    return resolveProgramStep(program, stepIndex)?.context ?? null;
  }

  function phraseBoundary(program, stepIndex) {
    return resolveProgramStep(program, stepIndex)?.phraseBoundary === true;
  }

  function normalizeTransport(candidate = {}) {
    const scope = ["song", "chain", "phrase"].includes(candidate.lockedScope) ? candidate.lockedScope : "phrase";
    return Object.freeze({
      followPlayhead: candidate.followPlayhead === true,
      scopeLocked: candidate.scopeLocked === true,
      lockedScope: scope,
    });
  }

  const api = Object.freeze({
    EMPTY,
    NOTE_OFF,
    TRACKS,
    SONG_ROWS,
    CHAIN_ROWS,
    PHRASE_ROWS,
    isReference,
    nextPlayableRow,
    segmentFor,
    chainOccurrences,
    programPeriod,
    wrapProgramIndex,
    normalizeProgramStart,
    resolveProgramStep,
    remapProgramPosition,
    buildTrackProgram,
    contextAt,
    phraseBoundary,
    normalizeTransport,
  });
  if (typeof globalThis !== "undefined") globalThis.BRKTRKSongTransportPolicy = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();