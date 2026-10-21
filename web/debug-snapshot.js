(() => {
  const SNAPSHOT_VERSION = 1;
  const FORMAT = "BRKTRK-DEBUG-SNAPSHOT";
  const EVENT_LIMIT = 256;
  const WORKLET_DIAGNOSTICS_MODULE = "./audio-worklet-diagnostics.js";
  const WORKLET_DIAGNOSTICS_PROCESSOR = "brktrk-runtime-diagnostics";
  const providers = new Map();
  const history = {
    commands: [],
    projectChanges: [],
    navigationChanges: [],
    transportChanges: [],
    errors: [],
  };
  let workletDiagnosticsModulePromise = null;

  const currentModel = () => typeof model !== "undefined" ? model : (globalThis.model ?? null);
  const currentState = () => typeof state !== "undefined" ? state : (globalThis.state ?? null);
  const currentAudio = () => typeof audio !== "undefined" ? audio : (globalThis.audio ?? null);
  const audioContextFor = (audioFacade) => audioFacade?.context ?? audioFacade?.ctx ?? null;

  const trimHistory = (list) => {
    if (list.length > EVENT_LIMIT) list.splice(0, list.length - EVENT_LIMIT);
  };

  const pushHistory = (list, value) => {
    list.push({ at: new Date().toISOString(), value: jsonSafe(value) });
    trimHistory(list);
  };

  function cloneJson(value) {
    if (value == null) return value;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return jsonSafe(value);
    }
  }

  function jsonSafe(value, options = {}) {
    const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : 12;
    const seen = new WeakMap();

    function visit(input, depth, path) {
      if (input == null || typeof input === "string" || typeof input === "boolean") return input;
      if (typeof input === "number") return Number.isFinite(input) ? input : String(input);
      if (typeof input === "bigint") return `${input}n`;
      if (typeof input === "function") return `[Function ${input.name || "anonymous"}]`;
      if (typeof input === "symbol") return String(input);
      if (depth > maxDepth) return `[MaxDepth ${maxDepth}]`;
      if (input instanceof Error) return { name: input.name, message: input.message, stack: input.stack ?? null };
      if (typeof Node !== "undefined" && input instanceof Node) {
        const element = input.nodeType === Node.ELEMENT_NODE ? input : input.parentElement;
        return {
          node: input.nodeName,
          id: element?.id ?? null,
          className: typeof element?.className === "string" ? element.className : null,
          text: String(element?.textContent ?? "").trim().slice(0, 200),
        };
      }
      if (seen.has(input)) return `[Circular ${seen.get(input)}]`;
      seen.set(input, path);
      if (Array.isArray(input)) return input.map((item, index) => visit(item, depth + 1, `${path}[${index}]`));
      if (input instanceof Map) return Object.fromEntries([...input.entries()].map(([key, item]) => [String(key), visit(item, depth + 1, `${path}.${String(key)}`)]));
      if (input instanceof Set) return [...input].map((item, index) => visit(item, depth + 1, `${path}[${index}]`));
      if (ArrayBuffer.isView(input)) return Array.from(input);
      if (input instanceof ArrayBuffer) return { byteLength: input.byteLength };
      const result = {};
      for (const key of Object.keys(input)) {
        try { result[key] = visit(input[key], depth + 1, `${path}.${key}`); }
        catch (error) { result[key] = `[Unreadable: ${error?.message ?? error}]`; }
      }
      return result;
    }

    return visit(value, 0, "$debug");
  }

  function apiSurface(value) {
    if (!value || (typeof value !== "object" && typeof value !== "function")) return null;
    const methods = [];
    const data = {};
    for (const key of Object.keys(value).sort()) {
      let item;
      try { item = value[key]; }
      catch (error) { data[key] = `[Unreadable: ${error?.message ?? error}]`; continue; }
      if (typeof item === "function") methods.push(key);
      else data[key] = jsonSafe(item, { maxDepth: 5 });
    }
    return { methods, data };
  }

  async function fetchJson(path) {
    try {
      const response = await fetch(path, { cache: "no-store" });
      if (!response.ok) return { available: false, status: response.status };
      return { available: true, value: await response.json() };
    } catch (error) {
      return { available: false, error: error?.message ?? String(error) };
    }
  }

  function visibleCssRelease() {
    const edition = document.querySelector(".edition");
    if (!edition) return null;
    try {
      const content = getComputedStyle(edition, "::after")?.content ?? "";
      return content.match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? null;
    } catch {
      return null;
    }
  }

  async function serviceWorkerRuntimeInfo() {
    const controller = navigator.serviceWorker?.controller;
    if (!controller || typeof MessageChannel !== "function") {
      return { available: false, reason: controller ? "message-channel-unavailable" : "no-controller" };
    }
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      const timer = window.setTimeout(() => {
        channel.port1.close();
        resolve({ available: false, reason: "timeout", scriptURL: controller.scriptURL ?? null });
      }, 1200);
      channel.port1.onmessage = ({ data }) => {
        if (data?.type !== "brktrk-release-info") return;
        window.clearTimeout(timer);
        channel.port1.close();
        resolve({ available: true, value: cloneJson(data), scriptURL: controller.scriptURL ?? null });
      };
      try {
        controller.postMessage({ type: "brktrk-release-info-request" }, [channel.port2]);
      } catch (error) {
        window.clearTimeout(timer);
        channel.port1.close();
        resolve({ available: false, reason: "post-message-failed", error: error?.message ?? String(error), scriptURL: controller.scriptURL ?? null });
      }
    });
  }

  async function audioWorkletRuntimeInfo(audioFacade) {
    const context = audioContextFor(audioFacade);
    if (!context?.audioWorklet || typeof AudioWorkletNode !== "function") {
      return { available: false, reason: context ? "audio-worklet-node-unavailable" : "audio-context-unavailable" };
    }
    try {
      workletDiagnosticsModulePromise ??= context.audioWorklet.addModule(WORKLET_DIAGNOSTICS_MODULE);
      await workletDiagnosticsModulePromise;
      return await new Promise((resolve) => {
        let node;
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          try { node?.port?.close?.(); } catch {}
          resolve(value);
        };
        const timer = window.setTimeout(() => finish({ available: false, reason: "timeout" }), 1200);
        try {
          node = new AudioWorkletNode(context, WORKLET_DIAGNOSTICS_PROCESSOR);
          node.port.onmessage = ({ data }) => {
            if (data?.type !== "brktrk-runtime-info") return;
            window.clearTimeout(timer);
            finish({ available: true, value: cloneJson(data) });
          };
        } catch (error) {
          window.clearTimeout(timer);
          finish({ available: false, reason: "node-create-failed", error: error?.message ?? String(error) });
        }
      });
    } catch (error) {
      return { available: false, reason: "module-load-failed", error: error?.message ?? String(error) };
    }
  }

  function releaseConsistency({ versionFile, deployedBuild, serviceWorkerRuntime, workletRuntime }) {
    const expected = versionFile?.available ? String(versionFile.value?.version ?? "")
      : deployedBuild?.available ? String(deployedBuild.value?.version ?? "")
        : "";
    const observed = {
      deployedBuild: deployedBuild?.available ? String(deployedBuild.value?.version ?? "") : null,
      visibleCss: visibleCssRelease(),
      k3c: globalThis.BRKTRKK3CTransportAdapter?.release ?? null,
      serviceWorker: serviceWorkerRuntime?.available ? serviceWorkerRuntime.value?.release ?? null : null,
      audioWorklet: workletRuntime?.available ? workletRuntime.value?.workletRelease ?? null : null,
      audioWorkletDiagnostics: workletRuntime?.available ? workletRuntime.value?.diagnosticsRelease ?? null : null,
    };
    const required = ["deployedBuild", "visibleCss", "k3c", "serviceWorker", "audioWorklet", "audioWorkletDiagnostics"];
    const missing = required.filter((name) => observed[name] == null || observed[name] === "");
    const mismatches = expected
      ? required.filter((name) => observed[name] != null && observed[name] !== "" && String(observed[name]) !== expected)
      : [];
    return {
      expected: expected || null,
      status: mismatches.length > 0 ? "mismatch" : missing.length > 0 ? "partial" : "coherent",
      observed,
      missing,
      mismatches,
    };
  }

  function relevantStorage() {
    const entries = {};
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key || !key.toLowerCase().startsWith("brktrk")) continue;
      const raw = localStorage.getItem(key) ?? "";
      let parsed = null;
      let parseError = null;
      try { parsed = JSON.parse(raw); }
      catch (error) { parseError = error?.message ?? String(error); }
      entries[key] = {
        bytes: new Blob([raw]).size,
        parsed: parsed == null ? undefined : parsed,
        raw: parsed == null ? raw : undefined,
        parseError,
      };
    }
    return entries;
  }

  function storeSnapshot() {
    const stores = globalThis.BRKTRKStores ?? {};
    const project = stores.project;
    const navigation = stores.navigation;
    const transport = stores.transport;
    return {
      project: project?.getState ? cloneJson(project.getState()) : null,
      navigation: navigation?.getState ? cloneJson(navigation.getState()) : null,
      transport: transport?.getState ? cloneJson(transport.getState()) : null,
      ownership: cloneJson(stores.ownership ?? null),
      transportRuntime: transport?.runtime?.snapshot ? cloneJson(transport.runtime.snapshot()) : null,
      transportProgram: transport?.runtime?.getProgram ? cloneJson(transport.runtime.getProgram()) : null,
    };
  }

  function uiSnapshot() {
    const session = currentState();
    const cell = document.querySelector("[data-pane].selected");
    const phraseHeaders = [...document.querySelectorAll("#phraseGrid .grid-header > span")].map((item) => ({
      text: item.textContent?.trim() ?? "",
      display: getComputedStyle(item).display,
    }));
    const selectedRow = session?.focus?.pane === "phrase" ? Number(session.focus.row) : null;
    const phraseCells = selectedRow == null ? [] : [...document.querySelectorAll(`#phraseGrid [data-row-pane="phrase"][data-row="${selectedRow}"] [data-pane="phrase"]`)].map((item) => ({
      col: Number(item.dataset.col),
      text: item.textContent?.trim() ?? "",
      selected: item.classList.contains("selected"),
      display: getComputedStyle(item).display,
      title: item.title || null,
    }));
    return {
      bodyDataset: { ...document.body.dataset },
      activeElement: document.activeElement ? jsonSafe(document.activeElement) : null,
      selectedCell: cell ? jsonSafe(cell) : null,
      phraseHeaders,
      phraseSelectedRow: phraseCells,
      sheets: {
        genericValueDock: document.querySelector("#p32ValueDock")?.getAttribute("aria-hidden") ?? null,
        phoneFxDock: document.querySelector("#m41bPhoneFxDock")?.getAttribute("aria-hidden") ?? null,
        noteDock: document.querySelector("#p3NoteDock")?.getAttribute("aria-hidden") ?? null,
        settingsDialogOpen: Boolean(document.querySelector("#settingsDialog")?.open),
      },
      statusLine: document.querySelector("#statusLine")?.textContent?.trim() ?? null,
      editBreadcrumb: document.querySelector("#editBreadcrumb")?.textContent?.trim() ?? null,
    };
  }

  function environmentSnapshot() {
    return {
      href: location.href,
      origin: location.origin,
      protocol: location.protocol,
      userAgent: navigator.userAgent,
      platform: navigator.platform ?? null,
      language: navigator.language,
      languages: [...(navigator.languages ?? [])],
      online: navigator.onLine,
      hardwareConcurrency: navigator.hardwareConcurrency ?? null,
      deviceMemory: navigator.deviceMemory ?? null,
      maxTouchPoints: navigator.maxTouchPoints ?? null,
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      screen: {
        width: screen.width,
        height: screen.height,
        availWidth: screen.availWidth,
        availHeight: screen.availHeight,
        colorDepth: screen.colorDepth,
        pixelDepth: screen.pixelDepth,
        orientation: screen.orientation?.type ?? null,
        angle: screen.orientation?.angle ?? null,
      },
      document: {
        visibilityState: document.visibilityState,
        hidden: document.hidden,
        readyState: document.readyState,
        referrer: document.referrer,
      },
      pwa: {
        standalone: matchMedia("(display-mode: standalone)").matches,
        fullscreen: matchMedia("(display-mode: fullscreen)").matches,
        serviceWorkerSupported: "serviceWorker" in navigator,
        serviceWorkerController: navigator.serviceWorker?.controller?.scriptURL ?? null,
        serviceWorkerState: navigator.serviceWorker?.controller?.state ?? null,
      },
      performance: {
        timeOrigin: performance.timeOrigin,
        navigation: performance.getEntriesByType?.("navigation")?.map((entry) => jsonSafe(entry.toJSON ? entry.toJSON() : entry)) ?? [],
      },
    };
  }

  function moduleSnapshot() {
    const shared = new Set([
      "BRKTRKPhraseFxRuntimeDomain",
      "BRKTRKEventTraceDomain",
    ]);
    const workletOnly = new Set([
      "BRKTRKRealtimeEventWindowDomain",
    ]);
    const names = [
      "BRKTRKCommands", "BRKTRKStoreTypes", "BRKTRKStores", "BRKTRKTransportRuntimeState",
      "BRKTRKTimingDomain", "BRKTRKTimingMapDomain", "BRKTRKTableSourceDomain", "BRKTRKProductionTimelineDomain",
      "BRKTRKPhraseFxDomain", "BRKTRKPhraseFxRuntimeDomain", "BRKTRKPhraseFxSurface", "BRKTRKPhoneFxEditor",
      "BRKTRKFieldSchema", "BRKTRKEventTraceDomain", "BRKTRKRealtimeEventWindowDomain", "BRKTRKAudioLifecycle",
      "BRKTRKAudioReadiness", "BRKTRKTrackMixDomain", "BRKTRKProjectPlaybackRefresh",
    ];
    return Object.fromEntries(names.map((name) => [name, {
      scope: shared.has(name) ? "shared" : workletOnly.has(name) ? "audio-worklet" : "window",
      loaded: globalThis[name] != null,
      surface: apiSurface(globalThis[name]),
    }]));
  }

  function registerSection(name, provider) {
    const key = String(name ?? "").trim();
    if (!key) throw new TypeError("Diagnostic section name is required");
    if (typeof provider !== "function") throw new TypeError(`Diagnostic provider ${key} must be a function`);
    providers.set(key, provider);
    return () => providers.delete(key);
  }

  async function buildSnapshot() {
    const liveModel = currentModel();
    const liveState = currentState();
    const audioFacade = currentAudio();
    const [versionFile, deployedBuild, storageEstimate, serviceWorkerRuntime, workletRuntime] = await Promise.all([
      fetchJson("./version.json"),
      fetchJson("./build.json"),
      navigator.storage?.estimate?.().catch((error) => ({ error: error?.message ?? String(error) })) ?? Promise.resolve(null),
      serviceWorkerRuntimeInfo(),
      audioWorkletRuntimeInfo(audioFacade),
    ]);

    const custom = {};
    const customErrors = {};
    for (const [name, provider] of [...providers.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      try { custom[name] = jsonSafe(await provider()); }
      catch (error) { customErrors[name] = jsonSafe(error); }
    }

    const fxRegistry = globalThis.BRKTRKPhraseFxDomain?.registry?.().map((entry) => ({ ...entry })) ?? [];
    const transportRuntime = globalThis.BRKTRKStores?.transport?.runtime;
    const commandRuntime = globalThis.BRKTRKCommands?.runtime;
    const context = audioContextFor(audioFacade);
    const release = releaseConsistency({ versionFile, deployedBuild, serviceWorkerRuntime, workletRuntime });

    return {
      format: FORMAT,
      snapshotVersion: SNAPSHOT_VERSION,
      generatedAt: new Date().toISOString(),
      warning: "Contains the full local BRKTRK project and detailed runtime/environment state. Share only for debugging.",
      build: {
        versionFile,
        deployedBuild,
        visibleEdition: document.querySelector(".edition")?.textContent?.trim() ?? null,
        visibleCssRelease: release.observed.visibleCss,
        k3cRelease: release.observed.k3c,
        serviceWorkerController: navigator.serviceWorker?.controller?.scriptURL ?? null,
        serviceWorkerRuntime,
        releaseConsistency: release,
      },
      environment: environmentSnapshot(),
      project: {
        canonicalModel: cloneJson(liveModel),
        schemaVersion: Number(liveModel?.schemaVersion ?? 0),
        storageKey: typeof STORAGE_KEY !== "undefined" ? STORAGE_KEY : null,
      },
      persistence: {
        browserWriter: globalThis.BRKTRKBrowserWriterAuthority?.snapshot?.() ?? null,
        localStorage: relevantStorage(),
        storageEstimate: jsonSafe(storageEstimate),
      },
      session: {
        legacyState: cloneJson(liveState),
        stores: storeSnapshot(),
      },
      transport: {
        runtimeSnapshot: transportRuntime?.snapshot ? cloneJson(transportRuntime.snapshot()) : null,
        program: transportRuntime?.getProgram ? cloneJson(transportRuntime.getProgram()) : null,
        requestedIdentity: transportRuntime?.getRequestedIdentity ? cloneJson(transportRuntime.getRequestedIdentity()) : null,
        appliedIdentity: transportRuntime?.getAppliedIdentity ? cloneJson(transportRuntime.getAppliedIdentity()) : null,
      },
      audio: {
        legacyAdapter: jsonSafe(audioFacade, { maxDepth: 8 }),
        audioContext: context ? {
          state: context.state,
          sampleRate: context.sampleRate,
          baseLatency: context.baseLatency ?? null,
          outputLatency: context.outputLatency ?? null,
          currentTime: context.currentTime,
        } : null,
        workletRuntime,
        lifecycle: apiSurface(globalThis.BRKTRKAudioLifecycle),
        readiness: apiSurface(globalThis.BRKTRKAudioReadiness),
      },
      commands: {
        installed: Boolean(globalThis.BRKTRKCommands?.installed),
        runtime: jsonSafe(commandRuntime, { maxDepth: 8 }),
        lastBodyCommandId: document.body.dataset.commandId ?? null,
        lastBodyCommandType: document.body.dataset.commandType ?? null,
      },
      fx: {
        registry: cloneJson(fxRegistry),
        runtimeVersion: workletRuntime?.available ? workletRuntime.value?.phraseFxRuntimeVersion ?? null : null,
        traceVersion: workletRuntime?.available ? workletRuntime.value?.traceVersion ?? null : null,
        runtimeProtocol: workletRuntime?.available ? workletRuntime.value?.runtimeProtocol ?? null : null,
      },
      modules: moduleSnapshot(),
      ui: uiSnapshot(),
      history: cloneJson(history),
      registeredSections: [...providers.keys()].sort(),
      custom,
      customErrors,
    };
  }

  function safeProjectName() {
    return String(currentModel()?.projectName ?? "brktrk-project")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "brktrk-project";
  }

  async function download() {
    const snapshot = await buildSnapshot();
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${safeProjectName()}.brktrk-debug.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (typeof setStatus === "function") setStatus("DEBUG SNAPSHOT EXPORTED");
    return snapshot;
  }

  function installUi() {
    const actions = document.querySelector("#settingsDialog .settings-actions");
    if (!actions || document.querySelector("#debugExportButton")) return;
    const button = document.createElement("button");
    button.id = "debugExportButton";
    button.type = "button";
    button.textContent = "EXPORT DEBUG JSON";
    const projectExport = document.querySelector("#exportButton");
    if (projectExport?.parentElement === actions) projectExport.insertAdjacentElement("afterend", button);
    else actions.prepend(button);
    const note = document.createElement("small");
    note.id = "debugExportNotice";
    note.textContent = "Debug JSON contains the full project plus runtime, transport, audio, timing, storage and device diagnostics.";
    note.style.gridColumn = "1 / -1";
    note.style.color = "var(--muted)";
    note.style.lineHeight = "1.4";
    actions.append(note);
    button.addEventListener("click", () => {
      void download().catch((error) => {
        console.error("Debug snapshot export failed", error);
        pushHistory(history.errors, error);
        if (typeof setStatus === "function") setStatus("DEBUG EXPORT FAILED", "danger");
      });
    });
  }

  function installHistoryObservers() {
    globalThis.BRKTRKCommands?.subscribe?.((record) => pushHistory(history.commands, {
      id: record?.id ?? null,
      command: record?.command ?? null,
      changeSet: record?.changeSet ?? record?.result?.changeSet ?? null,
      result: record?.result ?? null,
    }));
    globalThis.BRKTRKStores?.project?.subscribe?.("project", (changeSet) => pushHistory(history.projectChanges, changeSet));
    globalThis.BRKTRKStores?.navigation?.subscribe?.("navigation", (changeSet) => pushHistory(history.navigationChanges, changeSet));
    globalThis.BRKTRKStores?.transport?.subscribe?.("transport", (changeSet) => pushHistory(history.transportChanges, changeSet));
    window.addEventListener("error", (event) => pushHistory(history.errors, {
      type: "error",
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      error: event.error,
    }));
    window.addEventListener("unhandledrejection", (event) => pushHistory(history.errors, {
      type: "unhandledrejection",
      reason: event.reason,
    }));
  }

  const api = Object.freeze({ FORMAT, SNAPSHOT_VERSION, EVENT_LIMIT, registerSection, buildSnapshot, download, jsonSafe });
  globalThis.BRKTRKDiagnostics = api;
  installUi();
  installHistoryObservers();
})();
