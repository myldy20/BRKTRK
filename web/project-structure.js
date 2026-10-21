(() => {
  const storeTypes = globalThis.BRKTRKStoreTypes
    ?? (typeof require === "function" ? require("./stores.js") : null);
  if (!storeTypes) throw new Error("ProjectStore types are required for structural ownership");

  const EMPTY = -1;
  const TRACKS = 8;
  const CHAIN_ROWS = 16;
  const PHRASE_ROWS = 16;
  const MAX_OBJECT_ID = 255;
  const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const integer = (value, label) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) throw new TypeError(`${label} must be numeric`);
    return Math.round(numeric);
  };
  const emptyChainStep = () => ({ phrase: EMPTY, transpose: 0 });
  const emptyFxSlot = () => ({ command: 0, value: 0 });
  const emptyPhraseStep = () => ({
    note: EMPTY,
    velocity: 100,
    instrument: EMPTY,
    fx: Array.from({ length: 3 }, emptyFxSlot),
    condition: { probability: 100, every: 1, offset: 0 },
  });

  function normalizeObjectId(value) {
    const numeric = integer(value, "Object ID");
    return numeric < 0 ? EMPTY : clamp(numeric, 0, MAX_OBJECT_ID);
  }

  function normalizeSongRow(value, project) {
    return clamp(integer(value, "Song row"), 0, Math.max(0, (project.song?.length ?? 1) - 1));
  }

  function normalizeTrack(value, project) {
    const width = project.song?.[0]?.length ?? TRACKS;
    return clamp(integer(value, "Track"), 0, Math.max(0, width - 1));
  }

  function normalizeChainRow(value) {
    return clamp(integer(value, "Chain row"), 0, CHAIN_ROWS - 1);
  }

  function normalizeChainColumn(value) {
    return clamp(integer(value, "Chain column"), 0, 1);
  }

  function normalizeTranspose(value) {
    return clamp(integer(value, "Transpose"), -48, 48);
  }

  function ensureChain(project, chainId) {
    if (chainId < 0) throw new RangeError("Cannot create an Empty Chain ID");
    const key = String(chainId);
    if (Array.isArray(project.chains?.[key])) return false;
    project.chains ??= {};
    project.chains[key] = Array.from({ length: CHAIN_ROWS }, emptyChainStep);
    return true;
  }

  function ensurePhrase(project, phraseId) {
    if (phraseId < 0) throw new RangeError("Cannot create an Empty Phrase ID");
    const key = String(phraseId);
    if (Array.isArray(project.phrases?.[key])) return false;
    project.phrases ??= {};
    project.phrases[key] = Array.from({ length: PHRASE_ROWS }, emptyPhraseStep);
    return true;
  }

  // UX0-03 (#373). Reusable identity is the feature; the trap is that editing
  // a shared Chain or Phrase changes every occurrence with no way to say "this
  // one only". Duplicate-and-repoint copies the object and moves exactly one
  // reference onto the copy, leaving every other occurrence pointing at the
  // original.
  //
  // Allocation follows #364's contract: prefer an id that is both absent from
  // the pool and unreferenced by the inbound graph, never recycle a
  // content-empty object something still points at, and fail closed rather
  // than fall back to 00.
  function inboundReferenceIds(project, kind) {
    const referenced = new Set();
    if (kind === "chain") {
      for (const row of project.song ?? []) {
        for (const value of row ?? []) if (Number.isInteger(value) && value >= 0 && value <= MAX_OBJECT_ID) referenced.add(value);
      }
      return referenced;
    }
    for (const chain of Object.values(project.chains ?? {})) {
      for (const entry of chain ?? []) {
        const value = entry?.phrase;
        if (Number.isInteger(value) && value >= 0 && value <= MAX_OBJECT_ID) referenced.add(value);
      }
    }
    return referenced;
  }

  function safeFreshId(project, kind) {
    const pool = (kind === "chain" ? project.chains : project.phrases) ?? {};
    const referenced = inboundReferenceIds(project, kind);
    for (let id = 0; id <= MAX_OBJECT_ID; id += 1) {
      if (!Object.hasOwn(pool, String(id)) && !Object.hasOwn(pool, id) && !referenced.has(id)) return id;
    }
    return null;
  }

  function publish(projectStore, changeSet) {
    projectStore.publish(changeSet, ["project", "persistence", "audio", "render"]);
  }

  function transaction(operation, objectKind, objectId, created, metadata = {}) {
    return Object.freeze({
      operation,
      objectKind,
      objectId,
      objectCreated: Boolean(created),
      objectPreserved: operation === "detach",
      source: metadata.source ?? null,
    });
  }

  function rectangleMatrix(value, label) {
    if (!Array.isArray(value) || value.length === 0 || !Array.isArray(value[0]) || value[0].length === 0) {
      throw new TypeError(`${label} requires a non-empty rectangular matrix`);
    }
    const width = value[0].length;
    if (!value.every((row) => Array.isArray(row) && row.length === width)) {
      throw new TypeError(`${label} rows must have a consistent width`);
    }
    return value;
  }

  function createDomain(projectStore) {
    if (!projectStore || projectStore.owner !== "project") throw new TypeError("Structural domain requires ProjectStore");
    const project = projectStore.getState();

    function setSongChainRef(rowValue, trackValue, value, metadata = {}) {
      const row = normalizeSongRow(rowValue, project);
      const track = normalizeTrack(trackValue, project);
      const before = normalizeObjectId(project.song[row][track]);
      const after = normalizeObjectId(value);
      const created = Boolean(metadata.createMissing && after >= 0 && ensureChain(project, after));
      const operation = after < 0 ? "detach" : created && before === after ? "repair" : created ? "create-link" : "link";
      const changeSet = storeTypes.createProjectChangeSet({
        kind: "structure",
        subtype: "song.chainRef",
        target: "structure.song.chainRef",
        path: ["song", row, track],
        before,
        after,
        affectsPlayback: true,
        persistsProject: true,
        renderTargets: [`song.cell.${row}.${track}`, "structure.song.context"],
        source: metadata.source,
        transaction: transaction(operation, "chain", before >= 0 && after < 0 ? before : after, created, metadata),
      });
      if (before === after && !created) {
        return { value: after, before, after, mutated: false, allocated: false, created: false, changeSet, metadata: clone(metadata), row, track };
      }
      project.song[row][track] = after;
      publish(projectStore, changeSet);
      return { value: after, before, after, mutated: true, allocated: created, created, changeSet, metadata: clone(metadata), row, track };
    }

    function setChainPhraseRef(chainIdValue, rowValue, value, metadata = {}) {
      const chainId = normalizeObjectId(chainIdValue);
      if (chainId < 0 || !Array.isArray(project.chains?.[chainId])) throw new RangeError(`Chain ${chainIdValue} does not exist`);
      const row = normalizeChainRow(rowValue);
      const entry = project.chains[chainId][row];
      const before = normalizeObjectId(entry.phrase);
      const after = normalizeObjectId(value);
      const created = Boolean(metadata.createMissing && after >= 0 && ensurePhrase(project, after));
      const operation = after < 0 ? "detach" : created && before === after ? "repair" : created ? "create-link" : "link";
      const changeSet = storeTypes.createProjectChangeSet({
        kind: "structure",
        subtype: "chain.phraseRef",
        target: "structure.chain.phraseRef",
        path: ["chains", chainId, row, "phrase"],
        before,
        after,
        affectsPlayback: true,
        persistsProject: true,
        renderTargets: [`chain.row.${chainId}.${row}`, "structure.chain.context"],
        source: metadata.source,
        transaction: transaction(operation, "phrase", before >= 0 && after < 0 ? before : after, created, metadata),
      });
      if (before === after && !created) {
        return { value: after, before, after, mutated: false, allocated: false, created: false, changeSet, metadata: clone(metadata), chainId, row };
      }
      entry.phrase = after;
      publish(projectStore, changeSet);
      return { value: after, before, after, mutated: true, allocated: created, created, changeSet, metadata: clone(metadata), chainId, row };
    }

    function setChainTranspose(chainIdValue, rowValue, value, metadata = {}) {
      const chainId = normalizeObjectId(chainIdValue);
      if (chainId < 0 || !Array.isArray(project.chains?.[chainId])) throw new RangeError(`Chain ${chainIdValue} does not exist`);
      const row = normalizeChainRow(rowValue);
      const entry = project.chains[chainId][row];
      const before = normalizeTranspose(entry.transpose);
      const after = normalizeTranspose(value);
      const changeSet = storeTypes.createProjectChangeSet({
        kind: "structure",
        subtype: "chain.transpose",
        target: "structure.chain.transpose",
        path: ["chains", chainId, row, "transpose"],
        before,
        after,
        affectsPlayback: true,
        persistsProject: true,
        renderTargets: [`chain.row.${chainId}.${row}`],
        source: metadata.source,
      });
      if (before === after) return { value: after, before, after, mutated: false, changeSet, metadata: clone(metadata), chainId, row };
      entry.transpose = after;
      publish(projectStore, changeSet);
      return { value: after, before, after, mutated: true, changeSet, metadata: clone(metadata), chainId, row };
    }

    function readSongCell(rowValue, trackValue) {
      const row = normalizeSongRow(rowValue, project);
      const track = normalizeTrack(trackValue, project);
      return normalizeObjectId(project.song[row][track]);
    }

    function replaceSongRectangle(startRowValue, startTrackValue, values, metadata = {}) {
      const matrix = rectangleMatrix(values, "Song range replacement");
      const startRow = normalizeSongRow(startRowValue, project);
      const startTrack = normalizeTrack(startTrackValue, project);
      const maxRows = project.song.length - startRow;
      const maxCols = (project.song[0]?.length ?? TRACKS) - startTrack;
      const rowCount = Math.min(matrix.length, maxRows);
      const colCount = Math.min(matrix[0].length, maxCols);
      const before = [];
      const after = [];
      for (let r = 0; r < rowCount; r += 1) {
        const beforeRow = [];
        const afterRow = [];
        for (let c = 0; c < colCount; c += 1) {
          beforeRow.push(readSongCell(startRow + r, startTrack + c));
          afterRow.push(normalizeObjectId(matrix[r][c]));
        }
        before.push(beforeRow);
        after.push(afterRow);
      }
      const changeSet = storeTypes.createProjectChangeSet({
        kind: "structure",
        subtype: "song.range",
        target: "structure.song.range",
        path: ["song", startRow, rowCount, startTrack, colCount],
        before,
        after,
        affectsPlayback: true,
        persistsProject: true,
        renderTargets: ["structure.song.range", "structure.song.context"],
        source: metadata.source,
        transaction: metadata.transaction ?? {
          operation: metadata.operation ?? "range-replace",
          referenceSemantics: "shared",
          rowCount,
          colCount,
        },
      });
      if (JSON.stringify(before) === JSON.stringify(after)) {
        return {
          value: clone(after), before, after, mutated: false, changeSet, metadata: clone(metadata),
          startRow, startCol: startTrack, rowCount, colCount,
          requestedRowCount: matrix.length, requestedColCount: matrix[0].length,
          clipped: rowCount !== matrix.length || colCount !== matrix[0].length,
        };
      }
      for (let r = 0; r < rowCount; r += 1) {
        for (let c = 0; c < colCount; c += 1) project.song[startRow + r][startTrack + c] = after[r][c];
      }
      publish(projectStore, changeSet);
      return {
        value: clone(after), before, after, mutated: true, changeSet, metadata: clone(metadata),
        startRow, startCol: startTrack, rowCount, colCount,
        requestedRowCount: matrix.length, requestedColCount: matrix[0].length,
        clipped: rowCount !== matrix.length || colCount !== matrix[0].length,
      };
    }

    function clearSongRectangle(startRowValue, startTrackValue, rowCountValue, colCountValue, metadata = {}) {
      const rowCount = Math.max(1, integer(rowCountValue, "Song range row count"));
      const colCount = Math.max(1, integer(colCountValue, "Song range column count"));
      return replaceSongRectangle(
        startRowValue,
        startTrackValue,
        Array.from({ length: rowCount }, () => Array(colCount).fill(EMPTY)),
        { ...metadata, operation: metadata.operation ?? "range-clear" },
      );
    }

    function chainFor(chainIdValue) {
      const chainId = normalizeObjectId(chainIdValue);
      if (chainId < 0 || !Array.isArray(project.chains?.[chainId])) throw new RangeError(`Chain ${chainIdValue} does not exist`);
      return { chainId, chain: project.chains[chainId] };
    }

    function readChainCell(chainIdValue, rowValue, colValue) {
      const { chainId, chain } = chainFor(chainIdValue);
      const row = normalizeChainRow(rowValue);
      const col = normalizeChainColumn(colValue);
      const value = col === 0 ? normalizeObjectId(chain[row].phrase) : normalizeTranspose(chain[row].transpose);
      return { chainId, row, col, value };
    }

    function replaceChainRectangle(chainIdValue, startRowValue, startColValue, values, metadata = {}) {
      const matrix = rectangleMatrix(values, "Chain range replacement");
      const { chainId, chain } = chainFor(chainIdValue);
      const startRow = normalizeChainRow(startRowValue);
      const startCol = normalizeChainColumn(startColValue);
      const rowCount = Math.min(matrix.length, CHAIN_ROWS - startRow);
      const colCount = Math.min(matrix[0].length, 2 - startCol);
      const before = [];
      const after = [];
      for (let r = 0; r < rowCount; r += 1) {
        const beforeRow = [];
        const afterRow = [];
        for (let c = 0; c < colCount; c += 1) {
          const col = startCol + c;
          beforeRow.push(readChainCell(chainId, startRow + r, col).value);
          afterRow.push(col === 0 ? normalizeObjectId(matrix[r][c]) : normalizeTranspose(matrix[r][c]));
        }
        before.push(beforeRow);
        after.push(afterRow);
      }
      const changeSet = storeTypes.createProjectChangeSet({
        kind: "structure",
        subtype: "chain.range",
        target: "structure.chain.range",
        path: ["chains", chainId, startRow, rowCount, startCol, colCount],
        before,
        after,
        affectsPlayback: true,
        persistsProject: true,
        renderTargets: ["structure.chain.range", "structure.chain.context"],
        source: metadata.source,
        transaction: metadata.transaction ?? {
          operation: metadata.operation ?? "range-replace",
          referenceSemantics: "shared",
          chainId,
          rowCount,
          colCount,
        },
      });
      if (JSON.stringify(before) === JSON.stringify(after)) {
        return {
          value: clone(after), before, after, mutated: false, changeSet, metadata: clone(metadata),
          chainId, startRow, startCol, rowCount, colCount,
          requestedRowCount: matrix.length, requestedColCount: matrix[0].length,
          clipped: rowCount !== matrix.length || colCount !== matrix[0].length,
        };
      }
      for (let r = 0; r < rowCount; r += 1) {
        for (let c = 0; c < colCount; c += 1) {
          const col = startCol + c;
          if (col === 0) chain[startRow + r].phrase = after[r][c];
          else chain[startRow + r].transpose = after[r][c];
        }
      }
      publish(projectStore, changeSet);
      return {
        value: clone(after), before, after, mutated: true, changeSet, metadata: clone(metadata),
        chainId, startRow, startCol, rowCount, colCount,
        requestedRowCount: matrix.length, requestedColCount: matrix[0].length,
        clipped: rowCount !== matrix.length || colCount !== matrix[0].length,
      };
    }

    function clearChainRectangle(chainIdValue, startRowValue, startColValue, rowCountValue, colCountValue, metadata = {}) {
      const rowCount = Math.max(1, integer(rowCountValue, "Chain range row count"));
      const colCount = Math.max(1, integer(colCountValue, "Chain range column count"));
      const startCol = normalizeChainColumn(startColValue);
      const values = Array.from({ length: rowCount }, () => Array.from({ length: colCount }, (_, offset) => (
        startCol + offset === 0 ? EMPTY : 0
      )));
      return replaceChainRectangle(
        chainIdValue,
        startRowValue,
        startCol,
        values,
        { ...metadata, operation: metadata.operation ?? "range-clear" },
      );
    }

    // One atomic change: the copy is created and the single occurrence is
    // repointed in the same published change set, so Undo restores both
    // together and never leaves an orphaned copy behind or a cell pointing at
    // an object that no longer exists.
    function duplicateAndRepoint(request = {}, metadata = {}) {
      const kind = request.kind === "chain" ? "chain" : request.kind === "phrase" ? "phrase" : null;
      if (!kind) throw new TypeError("duplicateAndRepoint requires kind 'chain' or 'phrase'");

      const occurrence = kind === "chain"
        ? { songRow: normalizeSongRow(request.songRow, project), track: normalizeTrack(request.track, project) }
        : { chainId: normalizeObjectId(request.chainId), chainRow: normalizeChainRow(request.chainRow) };

      // readSongCell answers with the id; readChainCell answers with a cell
      // record whose value is the id.
      const sourceId = kind === "chain"
        ? readSongCell(occurrence.songRow, occurrence.track)
        : readChainCell(occurrence.chainId, occurrence.chainRow, 0).value;

      const refuse = (reason) => Object.freeze({
        kind, occurrence: clone(occurrence), sourceId, freshId: null,
        mutated: false, allocationFailed: reason === "pool-full", reason, changeSet: null,
      });

      // Nothing to duplicate, and an Empty cell is not an occurrence.
      if (!Number.isInteger(sourceId) || sourceId < 0) return refuse("empty-occurrence");
      const pool = (kind === "chain" ? project.chains : project.phrases) ?? {};
      if (!Object.hasOwn(pool, String(sourceId)) && !Object.hasOwn(pool, sourceId)) return refuse("missing-object");

      const freshId = safeFreshId(project, kind);
      // Fail closed. #364's contract: no silent fallback to 00, and the graph
      // is left exactly as it was.
      if (freshId === null) return refuse("pool-full");

      const before = clone(project);
      if (kind === "chain") {
        project.chains ??= {};
        project.chains[String(freshId)] = clone(project.chains[String(sourceId)] ?? project.chains[sourceId]);
        project.song[occurrence.songRow][occurrence.track] = freshId;
      } else {
        project.phrases ??= {};
        project.phrases[String(freshId)] = clone(project.phrases[String(sourceId)] ?? project.phrases[sourceId]);
        const chain = project.chains?.[String(occurrence.chainId)] ?? project.chains?.[occurrence.chainId];
        chain[occurrence.chainRow] = { ...chain[occurrence.chainRow], phrase: freshId };
      }

      const changeSet = storeTypes.createProjectChangeSet({
        kind: "structure",
        subtype: `${kind}.duplicate-repoint`,
        target: `structure.${kind}.duplicate-repoint`,
        path: ["structure", kind, freshId],
        before: clone(before),
        after: clone(project),
        affectsPlayback: true,
        persistsProject: true,
        renderTargets: ["structure.song.range", "structure.song.context", "structure.chain.range", "structure.chain.context"],
        source: metadata.source,
        transaction: metadata.transaction ?? Object.freeze({
          operation: "duplicate-and-repoint",
          objectKind: kind,
          sourceId,
          freshId,
          // The renderer has to know which cell moved. `after` is the whole
          // project, so reading the coordinates off the cursor would draw the
          // wrong cell for a command issued with an explicit one.
          occurrence: clone(occurrence),
          // The point of the operation: every other occurrence keeps pointing
          // at the original.
          repointedOccurrences: 1,
          referenceSemantics: "unshared-copy",
        }),
      });
      publish(projectStore, changeSet);
      return Object.freeze({
        kind, occurrence: clone(occurrence), sourceId, freshId,
        mutated: true, allocationFailed: false, reason: null, changeSet,
      });
    }

    return Object.freeze({
      setSongChainRef,
      setChainPhraseRef,
      setChainTranspose,
      readSongCell,
      replaceSongRectangle,
      clearSongRectangle,
      readChainCell,
      replaceChainRectangle,
      clearChainRectangle,
      duplicateAndRepoint,
      ensureChain: (id) => ensureChain(project, normalizeObjectId(id)),
      ensurePhrase: (id) => ensurePhrase(project, normalizeObjectId(id)),
      constants: Object.freeze({ EMPTY, TRACKS, CHAIN_ROWS, PHRASE_ROWS, MAX_OBJECT_ID }),
    });
  }

  function install(projectStore) {
    if (projectStore.structure) return projectStore.structure;
    const domain = createDomain(projectStore);
    Object.defineProperty(projectStore, "structure", {
      value: domain,
      configurable: false,
      enumerable: true,
      writable: false,
    });
    return domain;
  }

  const api = Object.freeze({ install, createDomain, normalizeObjectId, normalizeTranspose });
  globalThis.BRKTRKProjectStructure = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();