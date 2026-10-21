(() => {
  const EVENTS = Object.freeze([
    "pointerdown",
    "pointerup",
    "pointercancel",
    "click",
    "dblclick",
    "input",
    "change",
    "keydown",
    "keyup",
    "touchstart",
    "touchend",
  ]);
  const KEYBOARD_EVENTS = new Set(["keydown", "keyup"]);
  // commandReadyWarnMs is the diagnostic "this took too long" line and stays
  // where it was. initialisingNoticeMs is a different question - when is the
  // musician owed an explanation - and is measured rather than picked:
  // a healthy cold start reveals the shell at ~189ms and releases input at
  // ~357ms, a ~168ms window, and #299's own Android figures are 0.16s and
  // 0.35s. 1200ms is ~7x a healthy window, so a normal start never says
  // anything, while the historical ~19.8s bootstrap this issue was opened
  // over would have been explained within the first second and a half.
  const BOOTSTRAP_BUDGETS = Object.freeze({ commandReadyWarnMs: 5000, initialisingNoticeMs: 1200 });
  const shell = document.querySelector("#appShell");
  const help = document.querySelector("#helpDialog");
  const fixtureHoldRequested = window !== window.top
    && new URLSearchParams(window.location.search).get("j2HoldBootstrap") === "1";
  const surfaceGuardEnabled = !fixtureHoldRequested;
  const startedAt = performance.now();
  let fixtureHold = fixtureHoldRequested;
  let blocked = false;
  let blockedCount = 0;
  let reason = "bootstrap";
  let releasedAt = null;
  let surfaceRevealedAt = null;
  let startupFailed = false;
  let startupFailure = null;
  let loadingSurface = null;
  let observer = null;
  let pollTimer = null;
  let watchersStopped = false;
  let startupCompleted = false;
  let initialisingNotice = null;
  let initialisingNoticeReason = null;
  let initialisingNoticeAt = null;
  const nonFatalResourceFailures = [];

  // An inert subtree is excluded from hit testing, so while the shell is inert
  // a real tap on the grid does not target the grid: measured in Chromium,
  // document.elementFromPoint over a Song cell answers HEADER before the block
  // and BODY after it. Containment alone therefore recognises synthetic events
  // and keyboard input but not the phone tap - which is the one interaction
  // the musician is owed an explanation for. A pointer that lands on the
  // document while the shell is inert is that retargeted tap.
  function retargetedFromInertShell(target) {
    if (!shell?.inert) return false;
    return target === document.body || target === document.documentElement;
  }

  function eventBelongsToApp(event) {
    if (KEYBOARD_EVENTS.has(event.type)) return true;
    const target = event.target;
    if (!target) return false;
    return Boolean(shell?.contains(target) || help?.contains(target) || retargetedFromInertShell(target));
  }

  function intercept(event) {
    if (event.target?.closest?.('#browserWriterStatus')) return;
    if (!blocked || !eventBelongsToApp(event)) return;
    blockedCount += 1;
    event.preventDefault();
    event.stopImmediatePropagation();
    // UX0-10 (#299). Swallowing this silently is the actual complaint. A tap
    // that reaches here is proof the musician is trying, which is a better
    // signal than any elapsed time, so it explains itself immediately.
    showInitialisingNotice("blocked-interaction");
  }

  function attach() {
    EVENTS.forEach((type) => document.addEventListener(type, intercept, true));
  }

  function detach() {
    EVENTS.forEach((type) => document.removeEventListener(type, intercept, true));
  }

  function ensureLoadingSurface() {
    if (!surfaceGuardEnabled) return null;
    if (!loadingSurface) loadingSurface = document.querySelector("#bootstrapLoadingSurface");
    if (loadingSurface) return loadingSurface;
    loadingSurface = document.createElement("div");
    loadingSurface.id = "bootstrapLoadingSurface";
    loadingSurface.setAttribute("role", "status");
    loadingSurface.setAttribute("aria-live", "polite");
    loadingSurface.style.position = "fixed";
    loadingSurface.style.inset = "0";
    loadingSurface.style.zIndex = "2147483647";
    loadingSurface.style.display = "grid";
    loadingSurface.style.placeItems = "center";
    loadingSurface.style.background = "#05080d";
    loadingSurface.style.color = "#dce7f2";
    loadingSurface.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    loadingSurface.style.fontSize = "12px";
    loadingSurface.style.letterSpacing = "0.16em";
    loadingSurface.style.textTransform = "uppercase";
    loadingSurface.textContent = "BRKTRK · LOADING…";
    document.body.append(loadingSurface);
    return loadingSurface;
  }

  // UX0-10 (#299). Which of the three things the release boundary waits on is
  // still outstanding. Read from the same predicates the boundary uses, so it
  // cannot drift into a second, optimistic account of readiness.
  function pendingStage() {
    if (!baseSurfaceReady()) return "renderer";
    if (!commandArchitectureReady()) return "commands";
    if (!globalThis.BRKTRKTrackMixer?.installed) return "mixer";
    if (typeof globalThis.BRKTRKSoundEditRenderer?.renderProductionSurface !== "function") return "sound";
    return null;
  }

  const STAGE_WORDS = Object.freeze({
    renderer: "BUILDING THE GRID",
    commands: "LOADING COMMANDS",
    mixer: "LOADING THE MIXER",
    sound: "LOADING SOUND",
  });

  function noticeText(reason, stage) {
    const tail = stage ? ` \u00b7 ${STAGE_WORDS[stage]}` : "";
    return reason === "blocked-interaction"
      ? `STILL STARTING \u00b7 THAT DID NOT REGISTER${tail}`
      : `STILL STARTING \u00b7 NOT TAKING INPUT YET${tail}`;
  }

  // A notice, not a surface: it must never cover the grid it is apologising
  // for, and never take the tap it is explaining.
  function showInitialisingNotice(reason) {
    if (!surfaceGuardEnabled || !blocked || startupFailed || fixtureHold) return false;
    // This gate is re-blocked after startup for reasons that have nothing to
    // do with starting up - another tab holds the writer, a Service Worker
    // update, a history restore - and #browserWriterStatus already owns
    // saying so. Telling a running app it is "still starting" would be a lie,
    // and block() clears releasedAt, so completion has to be remembered.
    if (startupCompleted) return false;
    // Before the shell is on screen the LOADING surface already says this, and
    // two things saying it at once is noise.
    if (surfaceRevealedAt == null) return false;
    const stage = pendingStage();
    if (!initialisingNotice) {
      initialisingNotice = document.createElement("div");
      initialisingNotice.id = "bootstrapInitialisingNotice";
      initialisingNotice.setAttribute("role", "status");
      initialisingNotice.setAttribute("aria-live", "polite");
      initialisingNotice.style.position = "fixed";
      initialisingNotice.style.top = "max(8px, env(safe-area-inset-top))";
      initialisingNotice.style.left = "50%";
      initialisingNotice.style.transform = "translateX(-50%)";
      initialisingNotice.style.maxWidth = "calc(100vw - 24px)";
      // One below the surfaces that own the whole screen - the loading surface,
      // the failure surface and the browser-writer panel all sit at 2147483647
      // over an opaque background - so whenever one of those is up it covers
      // this and there is only ever one voice.
      initialisingNotice.style.zIndex = "2147483646";
      initialisingNotice.style.padding = "6px 12px";
      initialisingNotice.style.borderRadius = "6px";
      initialisingNotice.style.border = "1px solid rgba(255, 184, 47, .55)";
      initialisingNotice.style.background = "rgba(10, 16, 24, .94)";
      initialisingNotice.style.color = "#ffb82f";
      initialisingNotice.style.font = "800 9px/1.3 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
      initialisingNotice.style.letterSpacing = "0.1em";
      initialisingNotice.style.textAlign = "center";
      initialisingNotice.style.whiteSpace = "nowrap";
      initialisingNotice.style.overflow = "hidden";
      initialisingNotice.style.textOverflow = "ellipsis";
      // It explains a swallowed tap; it must not swallow the next one.
      initialisingNotice.style.pointerEvents = "none";
      document.body.append(initialisingNotice);
      initialisingNoticeAt = performance.now();
    }
    // A tap is a stronger reason than a slow clock, so it is never downgraded.
    if (initialisingNoticeReason !== "blocked-interaction") initialisingNoticeReason = reason;
    // Every swallowed event of a burst arrives here. Only write when the words
    // actually change, so explaining the interception does not itself become
    // work on the interception path.
    const text = noticeText(initialisingNoticeReason, stage);
    if (initialisingNotice.textContent !== text) initialisingNotice.textContent = text;
    if (document.body.dataset.bootstrapNotice !== initialisingNoticeReason) {
      document.body.dataset.bootstrapNotice = initialisingNoticeReason;
    }
    const stageName = stage ?? "ready";
    if (document.body.dataset.bootstrapStage !== stageName) document.body.dataset.bootstrapStage = stageName;
    return true;
  }

  function hideInitialisingNotice() {
    if (initialisingNotice) initialisingNotice.remove();
    initialisingNotice = null;
    delete document.body.dataset.bootstrapNotice;
    delete document.body.dataset.bootstrapStage;
  }

  function revealFixtureSurface() {
    if (!fixtureHoldRequested) return false;
    if (shell) {
      shell.style.removeProperty("visibility");
      shell.style.removeProperty("pointer-events");
      shell.removeAttribute("aria-hidden");
    }
    loadingSurface?.remove?.();
    loadingSurface = null;
    document.body.dataset.bootstrapSurface = "fixture-visible";
    return true;
  }

  function concealSurface() {
    if (!surfaceGuardEnabled) return false;
    ensureLoadingSurface();
    if (shell) {
      shell.style.visibility = "hidden";
      shell.style.pointerEvents = "none";
      shell.setAttribute("aria-hidden", "true");
    }
    document.body.dataset.bootstrapSurface = startupFailed ? "failed" : "loading";
    return true;
  }

  function normalizeFailure(error) {
    let message = "";
    try {
      message = error instanceof Error ? error.message : String(error ?? "");
    } catch {}
    return String(message || "Unknown bootstrap failure").trim() || "Unknown bootstrap failure";
  }

  function stopWatchers() {
    if (watchersStopped) return;
    watchersStopped = true;
    observer?.disconnect?.();
    if (pollTimer != null) window.clearInterval(pollTimer);
    window.removeEventListener?.("error", onStartupError, true);
    window.removeEventListener?.("unhandledrejection", onUnhandledRejection);
  }

  function showFailureSurface(message) {
    const surface = ensureLoadingSurface();
    if (!surface) return;
    surface.style.whiteSpace = "pre-wrap";
    surface.style.textAlign = "center";
    surface.style.padding = "24px";
    surface.style.boxSizing = "border-box";
    surface.style.lineHeight = "1.6";
    surface.style.textTransform = "none";
    surface.textContent = `BRKTRK · STARTUP FAILED\n${message}`;
    surface.title = message;
  }

  function markStartupFailure(error) {
    if (!surfaceGuardEnabled || releasedAt != null || startupFailed) return false;
    startupFailed = true;
    startupFailure = normalizeFailure(error);
    hideInitialisingNotice();
    showFailureSurface(startupFailure);
    document.body.dataset.bootstrapSurface = "failed";
    document.body.dataset.bootstrapSurfaceFailure = startupFailure;
    stopWatchers();
    return true;
  }

  function commandArchitectureReady() {
    return document.body.dataset.commandArchitecture === "p3.4"
      && Boolean(globalThis.BRKTRKCommands?.installed)
      && Boolean(globalThis.BRKTRKCommandBindings);
  }

  function baseSurfaceReady() {
    return typeof renderAll === "function";
  }

  function authoritativeSurfaceReady() {
    return commandArchitectureReady()
      && Boolean(globalThis.BRKTRKTrackMixer?.installed)
      && typeof globalThis.BRKTRKSoundEditRenderer?.renderProductionSurface === "function";
  }

  function renderSurface({ focus = false } = {}) {
    if (typeof renderAll !== "function") throw new Error("Final renderer is unavailable");
    renderAll();
    if (focus && typeof focusSelectedCell === "function") focusSelectedCell();
  }

  function revealSurface({ final = false } = {}) {
    if (!surfaceGuardEnabled) return true;
    if (startupFailed || !baseSurfaceReady()) return false;
    if (final && !authoritativeSurfaceReady()) return false;
    try {
      renderSurface({ focus: final });
    } catch (error) {
      markStartupFailure(error);
      return false;
    }
    if (shell) {
      shell.style.removeProperty("visibility");
      shell.style.removeProperty("pointer-events");
      shell.removeAttribute("aria-hidden");
    }
    loadingSurface?.remove?.();
    loadingSurface = null;
    if (surfaceRevealedAt == null) surfaceRevealedAt = performance.now();
    document.body.dataset.bootstrapSurface = "ready";
    delete document.body.dataset.bootstrapSurfaceFailure;
    return true;
  }

  function syncUi() {
    if (shell) {
      shell.inert = blocked;
      shell.setAttribute("aria-busy", String(blocked));
    }
    document.body.dataset.bootstrapInput = blocked ? "blocked" : "ready";
    document.body.dataset.bootstrapInputReason = reason;
  }

  function block(nextReason = "manual") {
    reason = String(nextReason || "manual");
    releasedAt = null;
    if (!blocked) {
      blocked = true;
      attach();
    }
    syncUi();
    return true;
  }

  function release(nextReason = "command-ready") {
    if (startupFailed) return false;
    reason = String(nextReason || "command-ready");
    fixtureHold = false;
    hideInitialisingNotice();
    if (blocked) {
      blocked = false;
      detach();
    }
    releasedAt = performance.now();
    syncUi();
    return true;
  }

  // UX0-10 (#299). No new timer and no second owner: the poll that already asks
  // whether we can release also asks whether this has gone on long enough to owe
  // the musician a word. A healthy start never passes the budget, so it never
  // says anything.
  function considerInitialisingNotice() {
    if (authoritativeSurfaceReady()) return false;
    if (performance.now() - startedAt >= BOOTSTRAP_BUDGETS.initialisingNoticeMs) {
      return showInitialisingNotice("slow-start");
    }
    // Already explaining a swallowed tap: keep the stage it names current.
    if (initialisingNotice) return showInitialisingNotice(initialisingNoticeReason);
    return false;
  }

  function releaseWhenReady() {
    if (fixtureHold || startupFailed) return false;
    if (surfaceRevealedAt == null && baseSurfaceReady()) revealSurface();
    considerInitialisingNotice();
    if (!authoritativeSurfaceReady()) return false;
    if (!revealSurface({ final: true })) return false;
    release("authoritative-ui-ready");
    startupCompleted = true;
    stopWatchers();
    return true;
  }

  function resourceFailure(target) {
    let source = "";
    let tagName = "";
    let rel = "";
    try {
      source = target?.src || target?.href || target?.getAttribute?.("src") || target?.getAttribute?.("href") || "";
    } catch {}
    try { tagName = String(target?.tagName || target?.nodeName || "").toUpperCase(); } catch {}
    try { rel = String(target?.rel || target?.getAttribute?.("rel") || "").toLowerCase(); } catch {}
    // LINK rel=preload is advisory even when href ends in .js. Only the actual
    // SCRIPT element owns required script execution; stylesheet LINKs remain
    // required because there is no later execution/load step that can replace them.
    const scriptLike = tagName === "SCRIPT";
    const stylesheetLike = tagName === "LINK" && rel.split(/\s+/).includes("stylesheet");
    const critical = scriptLike || stylesheetLike;
    const message = source
      ? `Failed to load startup resource: ${source}`
      : `Startup ${tagName || "resource"} failed to load`;
    return Object.freeze({ critical, tagName, rel, source, message });
  }

  function recordNonFatalResourceFailure(failure) {
    if (nonFatalResourceFailures.length >= 8) return;
    nonFatalResourceFailures.push(Object.freeze({
      tagName: failure.tagName,
      rel: failure.rel,
      source: failure.source,
      message: failure.message,
    }));
    try { console.warn?.("BRKTRK non-fatal bootstrap resource failure", failure.message); } catch {}
  }

  function onStartupError(event) {
    if (!blocked || !surfaceGuardEnabled) return;
    const target = event?.target;
    if (target && target !== window) {
      const failure = resourceFailure(target);
      if (!failure.critical) {
        recordNonFatalResourceFailure(failure);
        return;
      }
      markStartupFailure(failure.message);
      return;
    }
    markStartupFailure(event?.error ?? event?.message ?? "Script bootstrap error");
  }

  function onUnhandledRejection(event) {
    if (blocked && surfaceGuardEnabled) markStartupFailure(event?.reason ?? "Bootstrap promise rejected");
  }

  function snapshot() {
    const now = performance.now();
    const durationMs = (releasedAt ?? now) - startedAt;
    return Object.freeze({
      version: 6,
      owner: "bootstrap-input-gate",
      blocked,
      blockedCount,
      reason,
      fixtureHoldRequested,
      surfaceGuardEnabled,
      baseSurfaceReady: baseSurfaceReady(),
      commandArchitectureReady: commandArchitectureReady(),
      authoritativeSurfaceReady: authoritativeSurfaceReady(),
      surfaceState: document.body.dataset.bootstrapSurface ?? (surfaceGuardEnabled ? "loading" : "fixture-visible"),
      surfaceRevealedAtMs: surfaceRevealedAt == null ? null : Number(surfaceRevealedAt.toFixed(3)),
      startupFailed,
      startupFailure,
      pendingStage: pendingStage(),
      startupCompleted,
      initialisingNoticeShown: initialisingNoticeReason,
      initialisingNoticeAtMs: initialisingNoticeAt == null ? null : Number(initialisingNoticeAt.toFixed(3)),
      nonFatalResourceFailures: Object.freeze([...nonFatalResourceFailures]),
      watchersStopped,
      startedAtMs: Number(startedAt.toFixed(3)),
      releasedAtMs: releasedAt == null ? null : Number(releasedAt.toFixed(3)),
      durationMs: Number(durationMs.toFixed(3)),
      budgets: BOOTSTRAP_BUDGETS,
      overBudget: !fixtureHoldRequested && durationMs > BOOTSTRAP_BUDGETS.commandReadyWarnMs,
    });
  }

  observer = new MutationObserver(releaseWhenReady);
  observer.observe(document.body, { attributes: true, attributeFilter: ["data-command-architecture"] });
  pollTimer = window.setInterval(releaseWhenReady, 50);
  window.addEventListener("error", onStartupError, true);
  window.addEventListener("unhandledrejection", onUnhandledRejection);

  globalThis.BRKTRKBootstrapInput = Object.freeze({
    block,
    release,
    revealSurface,
    markStartupFailure,
    isBlocked: () => blocked,
    blockedCount: () => blockedCount,
    reason: () => reason,
    fixtureHoldRequested: () => fixtureHoldRequested,
    baseSurfaceReady,
    commandArchitectureReady,
    authoritativeSurfaceReady,
    pendingStage,
    budgets: BOOTSTRAP_BUDGETS,
    snapshot,
  });

  if (fixtureHold) revealFixtureSurface();
  else concealSurface();
  block(fixtureHold ? "fixture-command-architecture-hold" : "authoritative-ui-loading");
  releaseWhenReady();
})();
