(() => {
  "use strict";

  const commands = globalThis.BRKTRKCommands;
  const dock = globalThis.BRKTRKValueDock;
  const presentation = globalThis.BRKTRKPhraseConditionPresentation;
  if (!commands?.installed || !dock || !presentation) {
    throw new Error("Phrase condition surface requires Commands, Value Dock and condition presentation");
  }

  function selectedRow() {
    return state.focus?.pane === "phrase" ? Number(state.focus.row) : Number(state.phraseRow ?? 0);
  }

  function conditionAt(row = selectedRow()) {
    return model.phrases?.[state.phrase]?.[row]?.condition ?? presentation.DEFAULT;
  }

  function refresh() {
    const button = document.querySelector("#phraseConditionEdit");
    if (!button) return false;
    const row = selectedRow();
    const condition = conditionAt(row);
    const active = presentation.active(condition);
    button.dataset.conditionActive = String(active);
    button.dataset.phraseRow = String(row);
    button.title = `Phrase ${hex(state.phrase)} · row ${hex(row)} · ${presentation.title(condition)}`;
    button.setAttribute("aria-label", `Edit Phrase row ${hex(row)} condition · ${presentation.title(condition)}`);
    return true;
  }

  async function openRow(rowValue, source = "phrase-condition-open") {
    const row = Math.max(0, Math.min(15, Math.round(Number(rowValue) || 0)));
    const selected = await commands.dispatch({
      type: "cursor.select",
      pane: "phrase",
      row,
      col: 0,
      focus: false,
      source: `${source}.select`,
    });
    if (!selected || selected.ok === false) return false;
    const opened = dock.openSpecial("phraseConditionProbability", { source, desktop: true });
    refresh();
    return opened;
  }

  document.addEventListener("click", (event) => {
    const marker = event.target?.closest?.(".condition-badge[data-phrase-condition-row]");
    if (!marker) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void openRow(Number(marker.dataset.phraseConditionRow), "phrase-condition-badge");
  }, true);

  document.querySelector("#phraseConditionEdit")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void openRow(selectedRow(), "phrase-condition-header");
  });

  commands.subscribe(() => refresh());
  globalThis.BRKTRKStores?.project?.subscribe?.("render", () => refresh());
  globalThis.BRKTRKRenderRuntime?.registerAfterRender?.("phrase-condition-surface", refresh);
  refresh();

  globalThis.BRKTRKPhraseConditionSurface = Object.freeze({ refresh, openRow, conditionAt });
})();
