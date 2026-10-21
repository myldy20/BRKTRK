(() => {
  const transportStore = globalThis.BRKTRKStores?.transport;
  const runtime = transportStore?.runtime;
  const renderRuntime = globalThis.BRKTRKRenderRuntime;
  if (!transportStore?.subscribe || !runtime || !renderRuntime?.registerAfterTransport || !renderRuntime?.registerAfterRender) {
    throw new Error("Transport state UI requires TransportStore runtime and C3 render runtime");
  }
  if (globalThis.BRKTRKTransportStateUI?.installed) return;

  function queueSnapshot() {
    const owned = globalThis.BRKTRKTransport?.queueSnapshot?.().queued ?? null;
    if (owned) return owned;
    const legacy = state.p36?.queue ?? null;
    if (!legacy) return null;
    return Object.freeze({
      scope: "song",
      legacy: true,
      request: Object.freeze({
        songRow: legacy.row,
        track: legacy.requestedTrack ?? legacy.boundaryTrack,
      }),
    });
  }

  function playbackProgram() {
    return globalThis.BRKTRKTransport?.getPlaybackProgram?.() ?? runtime.getProgram?.() ?? null;
  }

  function upper(scope) {
    return String(scope ?? "").toUpperCase();
  }

  function token(kind, text) {
    const node = document.createElement("span");
    node.className = `scope-status-token ${kind}`;
    node.dataset.kind = kind;
    node.textContent = text;
    return node;
  }

  function statusModel() {
    const snapshot = runtime.snapshot();
    const applied = snapshot.applied?.scope ?? null;
    const requested = snapshot.requested?.scope ?? null;
    const queued = queueSnapshot()?.scope ?? null;
    const selected = state.scope ?? "phrase";
    const items = [];

    if (applied) items.push({ kind: "playing", text: `PLAYING ${upper(applied)}` });
    else if (snapshot.phase === "starting" && requested) items.push({ kind: "applying", text: `STARTING ${upper(requested)}` });

    if (queued) {
      items.push({ kind: "queued", text: `UP NEXT ${upper(queued)}` });
    } else if (applied && requested && requested !== applied) {
      items.push({ kind: "applying", text: `APPLYING ${upper(requested)}` });
    }

    return { snapshot, applied, requested, queued, selected, items };
  }

  function renderStatus() {
    const scopeSwitch = document.querySelector("#scopeSwitch");
    if (!scopeSwitch) return null;
    let label = scopeSwitch.querySelector("#appliedScopeStatus");
    if (!label) {
      label = document.createElement("small");
      label.id = "appliedScopeStatus";
      label.className = "applied-scope-status";
      scopeSwitch.append(label);
    }

    const model = statusModel();
    label.replaceChildren(...model.items.map((item) => token(item.kind, item.text)));
    label.setAttribute("aria-live", "polite");
    label.setAttribute("aria-label", model.items.map((item) => item.text).join(", "));
    label.dataset.phase = model.snapshot.phase ?? "stopped";
    label.dataset.appliedScope = model.applied ?? "stopped";
    label.dataset.requestedScope = model.requested ?? "none";
    label.dataset.queuedScope = model.queued ?? "none";
    label.dataset.selectedScope = model.selected;
    label.dataset.followState = state.p35?.followHeld ? "held" : state.p35?.followPlayhead ? "following" : "off";
    return model;
  }

  function songCell(songRow, track) {
    if (!Number.isInteger(songRow) || songRow < 0 || !Number.isInteger(track) || track < 0) return null;
    return document.querySelector(`[data-pane="song"][data-row="${songRow}"][data-col="${track}"]`);
  }

  function chainCell(chainId, chainRow) {
    if (state.chain !== chainId || !Number.isInteger(chainRow) || chainRow < 0) return null;
    return document.querySelector(`[data-pane="chain"][data-row="${chainRow}"][data-col="0"]`);
  }

  function marker(cell, kind, text, title) {
    if (!cell) return;
    cell.classList.add(kind === "playing" ? "p36-playing-reference" : "p36-queued-cell");
    const node = document.createElement("span");
    node.className = kind === "playing" ? "p36-playing-marker" : "p36-queue-marker";
    node.textContent = text;
    node.title = title;
    node.setAttribute("aria-hidden", "true");
    cell.append(node);
  }

  function clearDecorations() {
    document.querySelectorAll("#scopeSwitch button").forEach((button) => {
      button.classList.remove("i1-playing-scope", "i1-queued-scope", "i1-applying-scope");
    });
    document.querySelectorAll(".p36-playing-reference, .p36-queued-cell").forEach((cell) => {
      cell.classList.remove("p36-playing-reference", "p36-queued-cell");
    });
    document.querySelectorAll(".p36-playing-marker, .p36-queue-marker").forEach((node) => node.remove());
  }

  function decorateScopeButtons(model) {
    const button = (scope) => document.querySelector(`#scopeSwitch button[data-scope="${scope}"]`);
    if (model.applied) button(model.applied)?.classList.add("i1-playing-scope");
    if (model.queued) button(model.queued)?.classList.add("i1-queued-scope");
    else if (model.requested && model.requested !== model.applied) button(model.requested)?.classList.add("i1-applying-scope");
  }

  function decoratePlayingReferences(model) {
    if (!model.applied) return;
    const program = playbackProgram();
    const origin = program?.origin ?? {};
    const context = state.playhead?.context ?? null;
    const track = Number.isInteger(context?.track) ? context.track : origin.track;
    const songRow = Number.isInteger(context?.songRow) ? context.songRow : origin.songRow;

    if (model.applied === "song" || model.applied === "chain") {
      marker(songCell(songRow, track), "playing", "▶", `Playing ${upper(model.applied)}`);
    }
    if (context?.chainId >= 0 && context?.chainRow >= 0) {
      marker(chainCell(context.chainId, context.chainRow), "playing", "▶", `Playing Phrase ${hex(context.phraseId)}`);
    } else if (model.applied === "phrase") {
      marker(chainCell(origin.chainId, origin.chainRow), "playing", "▶", `Playing Phrase ${hex(origin.phraseId)}`);
    }
  }

  function decorateQueuedReference() {
    const queued = queueSnapshot();
    if (!queued) return;
    const request = queued.request ?? {};
    let cell = null;
    if (queued.scope === "phrase") cell = chainCell(request.chainId, request.chainRow);
    else cell = songCell(request.songRow, request.track);
    marker(cell, "queued", "Q", `Queued ${upper(queued.scope)} at the next Phrase boundary`);
  }

  function renderDecorations() {
    clearDecorations();
    const model = renderStatus();
    if (!model) return;
    decorateScopeButtons(model);
    decoratePlayingReferences(model);
    decorateQueuedReference();
    document.body.dataset.transportStatusOwner = "transport-store-derived-ui";
    document.body.dataset.queuedPlaybackScope = model.queued ?? "none";
  }

  renderRuntime.registerAfterTransport("transport-state.status", renderStatus);
  renderRuntime.registerAfterRender("transport-state.decorations", renderDecorations);

  for (const channel of ["transport", "status", "position"]) {
    transportStore.subscribe(channel, () => queueMicrotask(renderDecorations));
  }

  document.addEventListener("click", (event) => {
    if (event.target.closest?.("#scopeSwitch, #p36MobilePolicyPanel, #p35FollowButton")) queueMicrotask(renderDecorations);
  });

  globalThis.BRKTRKTransportStateUI = Object.freeze({
    installed: true,
    statusModel,
    renderStatus,
    renderDecorations,
  });

  renderDecorations();
})();