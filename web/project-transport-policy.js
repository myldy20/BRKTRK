(() => {
  const EMPTY = -1;
  const NOTE_OFF = -2;
  const TRACKS = 8;
  const SONG_ROWS = 64;
  const CHAIN_ROWS = 16;
  const PHRASE_ROWS = 16;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const numberOr = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const objectOr = (value, fallback = {}) => value && typeof value === "object" && !Array.isArray(value) ? value : fallback;

  function productionInstrumentDomain() {
    if (globalThis.BRKTRKProductionInstrumentDomain) return globalThis.BRKTRKProductionInstrumentDomain;
    if (typeof require !== "undefined") return require("./production-instrument-domain.js");
    throw new Error("Production Instrument domain is unavailable");
  }

  function normalizeTransport(candidate = {}) {
    const value = objectOr(candidate);
    return {
      followPlayhead: value.followPlayhead === true,
      scopeLocked: value.scopeLocked === true,
      lockedScope: ["song", "chain", "phrase"].includes(value.lockedScope) ? value.lockedScope : "phrase",
    };
  }

  // Historical P3.7 structural fixture normalizer. Project lifecycle/import is
  // owned by the schema-v4 storage/file-session path; this helper must not
  // recreate the retired preview Instrument domain.
  function normalize(candidate = {}, options = {}) {
    const source = objectOr(candidate);
    const base = typeof options.makeInitialModel === "function" ? options.makeInitialModel() : {
      projectName: "UNTITLED 01",
      tempo: 120,
      song: [],
      chains: {},
      phrases: {},
      instrumentPool: {},
    };

    const song = Array.from({ length: SONG_ROWS }, (_, row) => Array.from({ length: TRACKS }, (_, track) => {
      const value = numberOr(source.song?.[row]?.[track], EMPTY);
      return clamp(Math.trunc(value), EMPTY, 255);
    }));

    const chains = {};
    for (const [rawId, rawRows] of Object.entries(objectOr(source.chains))) {
      const parsedId = Number(rawId);
      if (!Number.isInteger(parsedId) || parsedId < 0 || parsedId > 255 || !Array.isArray(rawRows)) continue;
      chains[parsedId] = Array.from({ length: CHAIN_ROWS }, (_, row) => ({
        phrase: clamp(Math.trunc(numberOr(rawRows[row]?.phrase, EMPTY)), EMPTY, 255),
        transpose: clamp(Math.trunc(numberOr(rawRows[row]?.transpose, 0)), -48, 48),
      }));
    }

    const phrases = {};
    for (const [rawId, rawRows] of Object.entries(objectOr(source.phrases))) {
      const parsedId = Number(rawId);
      if (!Number.isInteger(parsedId) || parsedId < 0 || parsedId > 255 || !Array.isArray(rawRows)) continue;
      phrases[parsedId] = Array.from({ length: PHRASE_ROWS }, (_, row) => ({
        note: clamp(Math.trunc(numberOr(rawRows[row]?.note, EMPTY)), NOTE_OFF, 127),
        velocity: clamp(Math.trunc(numberOr(rawRows[row]?.velocity, 100)), 1, 127),
        instrument: clamp(Math.trunc(numberOr(rawRows[row]?.instrument, EMPTY)), EMPTY, 255),
        fx: Array.from({ length: 3 }, (_, column) => {
          const slot = rawRows[row]?.fx?.[column] ?? 0;
          if (slot && typeof slot === "object" && !Array.isArray(slot)) {
            return {
              command: clamp(Math.trunc(numberOr(slot.command ?? slot.commandCode, 0)), 0, 255),
              value: clamp(Math.trunc(numberOr(slot.value, 0)), 0, 255),
            };
          }
          return clamp(Math.trunc(numberOr(slot, 0)), 0, 255);
        }),
      }));
    }

    const instrumentPool = productionInstrumentDomain().normalizeInstrumentPool(source.instrumentPool ?? base.instrumentPool ?? {});
    const normalized = {
      ...base,
      ...source,
      projectName: String(source.projectName ?? base.projectName ?? "UNTITLED 01").slice(0, 24).toUpperCase(),
      tempo: clamp(Math.round(numberOr(source.tempo, base.tempo ?? 120)), 30, 300),
      song,
      chains,
      phrases,
      instrumentPool,
      transport: normalizeTransport(source.transport),
    };
    delete normalized.instruments;
    delete normalized.previewInstruments;
    return normalized;
  }

  const api = Object.freeze({ EMPTY, NOTE_OFF, TRACKS, SONG_ROWS, CHAIN_ROWS, PHRASE_ROWS, normalizeTransport, normalize });
  if (typeof globalThis !== "undefined") globalThis.BRKTRKProjectTransportPolicy = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
