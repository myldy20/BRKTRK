(() => {
  "use strict";

  // UX0-02/03/04 (#373). Reusable Chain and Phrase identity is intentional:
  // one Phrase can appear in many Chain rows, one Chain in many Song cells,
  // and editing it changes every occurrence at once. That is the feature. The
  // surface never said so, which turns it into a trap - a musician edits what
  // looks like this row's Phrase and changes four other places.
  //
  // #364 made allocation reference-aware by asking which ids are referenced at
  // all. Telling a musician that an object is shared, and duplicating one
  // occurrence away from the rest, both need more than the set: they need the
  // places. This answers where, so the surface can say it and so
  // duplicate-and-repoint can move exactly one of them.
  //
  // Read-only. It allocates nothing, mutates nothing and holds no state.

  const MAX_OBJECT_ID = 255;

  // Strict on purpose. Number(null) is 0 and Number("") is 0, so coercing the
  // id argument would answer a question about object 00 that nobody asked -
  // and duplicate-and-repoint acts on these coordinates, so a wrong answer
  // moves the wrong cell. A stored cell value is already a number; an id
  // handed in from a caller has to be one too.
  const isObjectId = (value) => typeof value === "number"
    && Number.isInteger(value)
    && value >= 0
    && value <= MAX_OBJECT_ID;

  // Every Song cell that names this Chain, in row-major order.
  function chainReferences(model, chainId) {
    if (!isObjectId(chainId)) return Object.freeze([]);
    const id = chainId;
    const found = [];
    const song = Array.isArray(model?.song) ? model.song : [];
    for (let songRow = 0; songRow < song.length; songRow += 1) {
      const row = Array.isArray(song[songRow]) ? song[songRow] : [];
      for (let track = 0; track < row.length; track += 1) {
        if (isObjectId(row[track]) && row[track] === id) {
          found.push(Object.freeze({ kind: "chain", id, songRow, track }));
        }
      }
    }
    return Object.freeze(found);
  }

  // Every Chain row that names this Phrase. Chain ids are object keys, so they
  // are visited in ascending numeric order rather than insertion order, which
  // keeps the answer stable across sessions and project files.
  function phraseReferences(model, phraseId) {
    if (!isObjectId(phraseId)) return Object.freeze([]);
    const id = phraseId;
    const found = [];
    const chains = model?.chains && typeof model.chains === "object" ? model.chains : {};
    const chainIds = Object.keys(chains)
      .map(Number)
      .filter((value) => isObjectId(value))
      .sort((left, right) => left - right);
    for (const chainId of chainIds) {
      const chain = Array.isArray(chains[chainId]) ? chains[chainId] : [];
      for (let chainRow = 0; chainRow < chain.length; chainRow += 1) {
        if (isObjectId(chain[chainRow]?.phrase) && chain[chainRow].phrase === id) {
          found.push(Object.freeze({ kind: "phrase", id, chainId, chainRow }));
        }
      }
    }
    return Object.freeze(found);
  }

  function referencesTo(model, kind, id) {
    if (kind === "chain") return chainReferences(model, id);
    if (kind === "phrase") return phraseReferences(model, id);
    return Object.freeze([]);
  }

  function referenceCount(model, kind, id) {
    return referencesTo(model, kind, id).length;
  }

  // Shared means more than one place reaches it. One occurrence is not shared,
  // and neither is an object nothing points at - that one is unreferenced,
  // which is a different fact and the one #364's allocator cares about.
  function isShared(model, kind, id) {
    return referenceCount(model, kind, id) > 1;
  }

  function sharingSummary(model, kind, id) {
    const places = referencesTo(model, kind, id);
    return Object.freeze({
      kind: kind === "chain" ? "chain" : kind === "phrase" ? "phrase" : null,
      id: isObjectId(id) ? id : null,
      count: places.length,
      shared: places.length > 1,
      referenced: places.length > 0,
      places,
    });
  }

  const api = Object.freeze({
    MAX_OBJECT_ID,
    chainReferences,
    phraseReferences,
    referencesTo,
    referenceCount,
    isShared,
    sharingSummary,
  });
  globalThis.BRKTRKStructuralReferenceGraph = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
