(() => {
  const EMPTY = -1;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, Math.round(Number(value) || 0)));

  function stepSnapshot(step = {}) {
    return Object.freeze({
      note: Number.isFinite(Number(step.note)) ? Number(step.note) : EMPTY,
      velocity: clamp(step.velocity ?? 100, 1, 127),
      instrument: Number(step.instrument) < 0 ? EMPTY : clamp(step.instrument ?? EMPTY, 0, 15),
    });
  }

  function create(input = {}) {
    const phrase = clamp(input.phrase ?? 0, 0, 255);
    const row = Math.max(0, Math.round(Number(input.row) || 0));
    const before = stepSnapshot(input.before);
    const after = stepSnapshot({
      note: input.note,
      velocity: input.velocity,
      instrument: input.instrument,
    });
    return Object.freeze({
      kind: "prepared-note-entry",
      target: "phrase.step",
      phrase,
      row,
      fields: Object.freeze(["note", "velocity", "instrument"]),
      before,
      after,
    });
  }

  const api = Object.freeze({ create, stepSnapshot });
  globalThis.BRKTRKPreparedEntryTransaction = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
