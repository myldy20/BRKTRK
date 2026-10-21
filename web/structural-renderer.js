(() => {
  function refreshPhoneContext() {
    globalThis.BRKTRKTouchActions?.refresh?.();
    globalThis.BRKTRKCommandBindings?.refreshNoteDock?.();
  }

  function renderSongCell(row, track) {
    const cell = document.querySelector(`[data-pane="song"][data-row="${row}"][data-col="${track}"]`);
    if (!cell) return false;
    const value = model.song?.[row]?.[track] ?? EMPTY;
    cell.textContent = value < 0 ? "--" : hex(value);
    cell.classList.toggle("empty", value < 0);
    cell.classList.toggle("value", value >= 0);
    cell.classList.toggle("linked", row === state.songRow && track === state.track && value === state.chain);
    return true;
  }

  function renderChainRow(chainId, row) {
    if (Number(state.chain) !== Number(chainId)) return false;
    const entry = model.chains?.[chainId]?.[row];
    const rowElement = document.querySelector(`[data-row-pane="chain"][data-row="${row}"]`);
    if (!entry || !rowElement) return false;
    const phraseCell = rowElement.querySelector('[data-pane="chain"][data-col="0"]');
    const transposeCell = rowElement.querySelector('[data-pane="chain"][data-col="1"]');
    if (phraseCell) {
      phraseCell.textContent = entry.phrase < 0 ? "--" : hex(entry.phrase);
      phraseCell.classList.toggle("empty", entry.phrase < 0);
      phraseCell.classList.toggle("value", entry.phrase >= 0);
      phraseCell.classList.toggle("linked", row === state.chainRow && entry.phrase === state.phrase);
    }
    if (transposeCell) {
      transposeCell.textContent = entry.transpose >= 0 ? `+${entry.transpose}` : String(entry.transpose);
      transposeCell.classList.toggle("value", entry.transpose !== 0);
    }
    return true;
  }

  function refreshLinkedEditors(changeSet) {
    if (changeSet.subtype === "song.chainRef") {
      const row = Number(changeSet.path?.[1]);
      const track = Number(changeSet.path?.[2]);
      renderSongCell(row, track);
      if (row === state.songRow && track === state.track) {
        const reference = Number(changeSet.after);
        if (reference >= 0 && Object.hasOwn(model.chains, reference)) {
          state.chain = reference;
          state.lastChain = reference;
        }
        if (typeof renderChain === "function") renderChain();
        if (typeof renderPhrase === "function") renderPhrase();
      }
    }
    if (changeSet.subtype === "chain.phraseRef" || changeSet.subtype === "chain.transpose") {
      const chainId = Number(changeSet.path?.[1]);
      const row = Number(changeSet.path?.[2]);
      renderChainRow(chainId, row);
      if (chainId === state.chain && row === state.chainRow && changeSet.subtype === "chain.phraseRef") {
        const reference = Number(changeSet.after);
        if (reference >= 0 && Object.hasOwn(model.phrases, reference)) {
          state.phrase = reference;
          state.lastPhrase = reference;
        }
        if (typeof renderPhrase === "function") renderPhrase();
      }
    }
    // UX0-03 (#373): duplicate-and-repoint moves one reference onto a fresh
    // copy. Only that cell changed, plus the editors linked to it, so it is
    // drawn the same targeted way every other structural reference change is.
    if (changeSet.transaction?.operation === "duplicate-and-repoint") {
      const { objectKind, freshId, occurrence = {} } = changeSet.transaction;
      if (objectKind === "chain") {
        // The occurrence the domain actually moved, not wherever the cursor
        // happens to be: a command can carry its own cursor.
        const row = Number(occurrence.songRow ?? state.songRow);
        const track = Number(occurrence.track ?? state.track);
        renderSongCell(row, track);
        if (row === state.songRow && track === state.track) {
          state.chain = freshId;
          state.lastChain = freshId;
          if (typeof renderChain === "function") renderChain();
          if (typeof renderPhrase === "function") renderPhrase();
        }
      } else if (objectKind === "phrase") {
        const chainId = Number(occurrence.chainId ?? state.chain);
        const row = Number(occurrence.chainRow ?? state.chainRow);
        renderChainRow(chainId, row);
        if (chainId === Number(state.chain) && row === Number(state.chainRow)
          && Number(state.phrase) === Number(changeSet.transaction.sourceId)) {
          state.phrase = freshId;
          state.lastPhrase = freshId;
          if (typeof renderPhrase === "function") renderPhrase();
        }
      }
    }

    // UX0-02 (#373): the SHARED marker is a count, so it goes stale on any
    // change that adds or removes a reference - linking a second cell to a
    // Chain, unlinking one, or moving one occurrence onto a copy - not only
    // on the duplicate. Transpose changes no reference and is left out.
    if (changeSet.subtype === "song.chainRef"
      || changeSet.subtype === "chain.phraseRef"
      || changeSet.transaction?.operation === "duplicate-and-repoint"
      || changeSet.transaction?.operation === "detach") {
      if (typeof renderSongContextLine === "function") renderSongContextLine();
      if (typeof renderPatternContextLine === "function") renderPatternContextLine();
    }

    // A restored snapshot can delete the very object navigation is standing
    // on - Undo of a duplicate-and-repoint removes the copy the cursor
    // followed. The broad render that history runs next would then ask for
    // chain(state.chain) with its default create=true and quietly allocate the
    // identity back as an empty orphan, which is exactly the silent allocation
    // #364 closed. Clamp first: the publish that brings us here runs before
    // that render.
    if (changeSet.subtype === "history.undo" || changeSet.subtype === "history.redo") {
      // The restore change set carries history metadata, not the object ids,
      // so the answer comes from the restored project itself: the cell the
      // cursor is standing on names the reference that survived the restore.
      const lowest = (pool) => {
        const ids = Object.keys(pool ?? {}).map(Number).filter(Number.isInteger).sort((a, b) => a - b);
        return ids.length ? ids[0] : null;
      };
      if (!Object.hasOwn(model.chains ?? {}, state.chain)) {
        const atCursor = Number(model.song?.[state.songRow]?.[state.track] ?? EMPTY);
        const restored = atCursor >= 0 && Object.hasOwn(model.chains ?? {}, atCursor)
          ? atCursor
          : lowest(model.chains);
        if (restored != null) {
          state.chain = restored;
          state.lastChain = restored;
        }
      }
      if (!Object.hasOwn(model.phrases ?? {}, state.phrase)) {
        const atCursor = Number(model.chains?.[state.chain]?.[state.chainRow]?.phrase ?? EMPTY);
        const restored = atCursor >= 0 && Object.hasOwn(model.phrases ?? {}, atCursor)
          ? atCursor
          : lowest(model.phrases);
        if (restored != null) {
          state.phrase = restored;
          state.lastPhrase = restored;
        }
      }
    }

    if (changeSet.transaction?.operation === "detach") {
      const object = changeSet.transaction.objectKind?.toUpperCase() ?? "OBJECT";
      // UX0-04 (#373): "DETACHED" reads as "separated from the others", which
      // is what duplicate-and-repoint does, not what this does. This clears
      // one reference and leaves the object where it was. "HERE" is the word
      // that carries the difference.
      setStatus(`${object} UNLINKED HERE · OBJECT KEPT`);
    }
    refreshPhoneContext();
    if (typeof renderPlayheads === "function") renderPlayheads();
    return true;
  }

  const api = Object.freeze({ renderSongCell, renderChainRow, refreshLinkedEditors });
  globalThis.BRKTRKStructuralRenderer = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
