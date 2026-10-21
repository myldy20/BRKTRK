(() => {
  const EMPTY = -1;
  const NOTE_OFF = -2;
  const PHRASE_ROWS = 16;

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const numberOr = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const padSigned = (value) => {
    const number = Math.trunc(numberOr(value, 0));
    return `${number >= 0 ? "+" : "-"}${Math.abs(number).toString().padStart(2, "0")}`;
  };

  function annotate(sequence, origin = {}) {
    return {
      ...sequence,
      origin: Object.freeze({
        songRow: numberOr(origin.songRow, 0),
        track: numberOr(origin.track, 0),
        chainId: numberOr(origin.chainId, EMPTY),
        chainRow: numberOr(origin.chainRow, 0),
        phraseId: numberOr(origin.phraseId, EMPTY),
      }),
    };
  }

  function segmentAt(sequence, index) {
    return sequence?.segments?.find((item) => index >= item.start && index < item.end)
      ?? sequence?.segments?.at?.(-1)
      ?? null;
  }

  function resolve({ sequence, index, track = 0, model }) {
    if (!sequence || index < 0 || !model) return null;
    const segment = segmentAt(sequence, index);
    const origin = sequence.origin ?? {};
    const local = index - numberOr(segment?.start, 0);
    const phraseRow = ((local % PHRASE_ROWS) + PHRASE_ROWS) % PHRASE_ROWS;
    const resolvedTrack = sequence.scope === "song" ? track : numberOr(origin.track, track);

    let songRow = numberOr(origin.songRow, 0);
    let chainId = numberOr(origin.chainId, EMPTY);
    let chainRow = numberOr(origin.chainRow, 0);
    let phraseId = numberOr(origin.phraseId, EMPTY);
    let transpose = 0;

    if (sequence.scope === "song") {
      songRow = numberOr(segment?.songRow, songRow);
      chainRow = Math.max(0, Math.floor(local / PHRASE_ROWS));
      chainId = numberOr(model.song?.[songRow]?.[resolvedTrack], EMPTY);
      const entry = chainId >= 0 ? model.chains?.[chainId]?.[chainRow] : null;
      phraseId = numberOr(entry?.phrase, EMPTY);
      transpose = numberOr(entry?.transpose, 0);
    } else if (sequence.scope === "chain") {
      chainRow = numberOr(segment?.chainRow, chainRow);
      const entry = chainId >= 0 ? model.chains?.[chainId]?.[chainRow] : null;
      phraseId = numberOr(segment?.phrase, numberOr(entry?.phrase, EMPTY));
      transpose = numberOr(entry?.transpose, 0);
    }

    const step = phraseId >= 0 ? model.phrases?.[phraseId]?.[phraseRow] : null;
    const sourceNote = numberOr(step?.note, EMPTY);
    const effectiveNote = sourceNote >= 0 ? clamp(sourceNote + transpose, 0, 127) : sourceNote;

    return Object.freeze({
      step: index,
      scope: sequence.scope,
      track: resolvedTrack,
      songRow,
      chainId,
      chainRow,
      phraseId,
      phraseRow,
      transpose,
      sourceNote,
      effectiveNote,
      noteOff: sourceNote === NOTE_OFF,
      silent: false,
      occurrenceKey: `${songRow}:${resolvedTrack}:${chainId}:${chainRow}:${phraseId}`,
    });
  }

  function format(context, helpers = {}) {
    if (!context) return "";
    if (context.silent) return `PLAY T${context.track + 1} · SILENT · NO LOOP BLOCK`;
    const hex = helpers.hex ?? ((value) => Math.max(0, Number(value) || 0).toString(16).toUpperCase().padStart(2, "0"));
    const noteName = helpers.noteName ?? ((value) => String(value));
    const chain = context.chainId < 0 ? "--" : hex(context.chainId);
    const phrase = context.phraseId < 0 ? "--" : hex(context.phraseId);
    const source = context.sourceNote === NOTE_OFF ? "OFF" : context.sourceNote >= 0 ? noteName(context.sourceNote) : "---";
    const output = context.effectiveNote === NOTE_OFF ? "OFF" : context.effectiveNote >= 0 ? noteName(context.effectiveNote) : "---";
    return `PLAY T${context.track + 1} · S${hex(context.songRow)} · C${chain}:${hex(context.chainRow)} · P${phrase}:${hex(context.phraseRow)} · TSP ${padSigned(context.transpose)} · SRC ${source.padEnd(3, " ")} · OUT ${output.padEnd(3, " ")}`;
  }

  const api = Object.freeze({ EMPTY, NOTE_OFF, PHRASE_ROWS, annotate, resolve, format, padSigned });
  if (typeof globalThis !== "undefined") globalThis.BRKTRKPlaybackContextPolicy = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
