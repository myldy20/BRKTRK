(() => {
  const SMALL = "small";
  const LARGE = "large";

  function editIntent(code) {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(code)) return null;
    return {
      delta: code === "ArrowRight" || code === "ArrowUp" ? 1 : -1,
      magnitude: code === "ArrowUp" || code === "ArrowDown" ? LARGE : SMALL,
    };
  }

  function fieldStep(pane, col, magnitude) {
    const large = magnitude === LARGE;
    if (pane === "song") return large ? 16 : 1;
    if (pane === "chain") {
      if (col === 0) return large ? 16 : 1;
      return large ? 12 : 1;
    }
    if (pane === "phrase") {
      if (col === 0) return large ? 12 : 1;
      if (col === 1) return large ? 10 : 1;
      if (col === 2) return large ? 16 : 1;
      return large ? 4 : 1;
    }
    return large ? 10 : 1;
  }

  function moveWithin(pane, row, col, code, limits) {
    const target = { pane, row, col };
    if (code === "ArrowUp") target.row -= 1;
    if (code === "ArrowDown") target.row += 1;
    if (code === "ArrowLeft") target.col -= 1;
    if (code === "ArrowRight") target.col += 1;
    target.row = Math.max(0, Math.min(limits.rows - 1, target.row));
    target.col = Math.max(0, Math.min(limits.cols - 1, target.col));
    return target;
  }

  function nextNoteSpecial(value, empty, noteOff) {
    if (value >= 0) return empty;
    if (value === empty) return noteOff;
    return empty;
  }

  function noteFromPitchClass(octave, pitchClass) {
    return Math.max(0, Math.min(127, (octave + 1) * 12 + pitchClass));
  }

  const api = {
    SMALL,
    LARGE,
    editIntent,
    fieldStep,
    moveWithin,
    nextNoteSpecial,
    noteFromPitchClass,
  };

  globalThis.BRKTRKP3 = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
