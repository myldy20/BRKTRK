(() => {
  "use strict";

  const packageDomain = globalThis.BRKTRKEnginePackageDomain;
  const browserDomain = globalThis.BRKTRKEnginePackageBrowser;
  if (!packageDomain || !browserDomain) throw new Error("BRKTRK production engine host requires package + browser transport domains");

  const HOST = Object.freeze({ abiVersions: Object.freeze(["0x00010000"]) });
  const DEFAULT_CATALOG_URL = "./engines/catalog-v1.json";
  const DEFAULT_ENGINE_CHANNEL = "stable";
  const PREVIEW_ENGINE_CHANNEL = "preview";

  function catalogChannels(href = globalThis.location?.href ?? "") {
    let preview = false;
    try {
      const url = new URL(href || "https://brktrk.invalid/");
      preview = url.searchParams.has("preview")
        || String(url.searchParams.get("engineChannel") ?? "").trim().toLowerCase() === PREVIEW_ENGINE_CHANNEL;
    } catch {
      preview = false;
    }
    return Object.freeze(preview
      ? [DEFAULT_ENGINE_CHANNEL, PREVIEW_ENGINE_CHANNEL]
      : [DEFAULT_ENGINE_CHANNEL]);
  }

  function requestedEngineChannel(engineRef, options = {}) {
    const channel = String(options.channel ?? engineRef?.channel ?? DEFAULT_ENGINE_CHANNEL).trim().toLowerCase()
      || DEFAULT_ENGINE_CHANNEL;
    if (!catalogChannels(options.href ?? globalThis.location?.href ?? "").includes(channel)) {
      throw new browserDomain.EnginePackageTransportError(
        "engine-channel-unavailable",
        `engine channel ${channel} is not enabled for this BRKTRK runtime`,
      );
    }
    return channel;
  }
  const MAX_RETAINED_VERIFIED_VIEWS = 4;

  const statusMap = new Map();
  const loadedMap = new Map();
  const verifiedMap = new Map();

  // A bounded record of how long each engine load actually took, broken down by
  // stage. The owner saw the Sound surface sit on "VERIFYING…" on a phone and
  // this container can neither reproduce a phone nor host a real engine package
  // (#500), so the next physical test carries the numbers out instead of a
  // guess. Observation only: nothing here decides anything.
  const LOAD_TIMING_LIMIT = 12;
  const loadTimings = [];
  const timingNow = () => (globalThis.performance?.now?.() ?? Date.now());
  const roundMs = (value) => Math.round(Number(value) * 100) / 100;

  function recordLoadTiming(record) {
    loadTimings.push(Object.freeze(record));
    while (loadTimings.length > LOAD_TIMING_LIMIT) loadTimings.shift();
  }

  function loadTimingSnapshot() {
    return Object.freeze({
      limit: LOAD_TIMING_LIMIT,
      recorded: loadTimings.length,
      // Newest first: a report is read from the top.
      loads: Object.freeze([...loadTimings].reverse()),
    });
  }
  // Failures the Worklet reports, kept on the main thread so they outlive the
  // AudioContext/Worklet that reported them. Nothing consumed
  // `production-engine-error` before: a render failure stopped playback and left
  // no trace, and a debug snapshot taken after Stop read healthy (#496 item 2).
  // Observation only: this log decides nothing; transport keeps its own owner.
  const FAILURE_LOG_LIMIT = 32;
  const FAILURE_MESSAGE_LIMIT = 2000;
  const failureLog = [];
  const failureListeners = new Set();
  const failureInstrumentedNodes = new WeakSet();
  let failureSequence = 0;
  let failureNodeGeneration = 0;

  const verifiedLoads = new Map();
  const activePackageKeys = new Set();
  const contextPackages = new WeakMap();
  const contextPackageLoads = new WeakMap();
  let node = null;
  let attachedContext = null;
  let lastInstrumentSignature = "";
  let latestWorkletDiagnostics = null;
  // What each registered engine reported about its own parameters over the
  // ABI, keyed by full package identity. Populated from the Worklet, which is
  // the only place the module instance exists. Empty for engines that predate
  // the descriptor calls, which keep using their package JSON. See #455.
  const abiDescriptorsByPackage = new Map();
  let abiDescriptorMessages = 0;
  let abiDescriptorRepliesIgnored = 0;
  const abiDescriptorListeners = new Set();
  let latestCatalog = null;
  let latestCatalogInfo = null;
  let diagnosticsRegistered = false;
  let presetDomainPromise = null;
  let liveParameterMessages = 0;
  let liveParameterRampMessages = 0;
  let liveParameterValueMessages = 0;
  let liveParameterRejections = 0;
  let instrumentSnapshotMessages = 0;
  let instrumentSnapshotJsonChars = 0;
  let assetSnapshotMessages = 0;
  let assetSnapshotBytes = 0;
  let assetSyncFailures = 0;
  let lastLiveParameter = null;
  let verifiedEvictions = 0;
  let runtimeRetirementMessages = 0;
  let runtimeRetiredPackages = 0;

  const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
  const normalizedSha = (value) => value == null ? "" : String(value).trim().toLowerCase();
  const versionForRef = (ref) => String(ref?.resolvedVersion ?? ref?.requestedVersion ?? "").trim();
  const packageIdentity = (moduleId, engineId, version = "", packageSha256 = "") => `${String(moduleId ?? "")}\u0000${String(engineId ?? "")}\u0000${String(version ?? "")}\u0000${normalizedSha(packageSha256)}`;
  const identityForRef = (ref) => packageIdentity(ref?.moduleId, ref?.engineId, versionForRef(ref), ref?.resolvedPackageSha256);
  const identityForEntry = (entry) => packageIdentity(entry?.moduleId, entry?.engineId, entry?.version, entry?.packageSha256);
  const keyFor = identityForEntry;

  function statusForRef(ref, state, details = {}) {
    return Object.freeze({
      state,
      moduleId: String(ref?.moduleId ?? ""),
      engineId: String(ref?.engineId ?? ""),
      version: versionForRef(ref) || null,
      packageSha256: normalizedSha(ref?.resolvedPackageSha256) || null,
      ...details,
    });
  }

  function statusForEntry(entry, state, details = {}) {
    return Object.freeze({
      state,
      moduleId: String(entry?.moduleId ?? ""),
      engineId: String(entry?.engineId ?? ""),
      version: String(entry?.version ?? "") || null,
      packageSha256: normalizedSha(entry?.packageSha256) || null,
      ...details,
    });
  }

  function packageStatusFor(engineRef) {
    if (!engineRef?.moduleId || !engineRef?.engineId) return null;
    const version = versionForRef(engineRef);
    const packageSha256 = normalizedSha(engineRef.resolvedPackageSha256);
    if (version && packageSha256) return statusMap.get(identityForRef(engineRef)) ?? null;
    const matches = [...statusMap.values()].filter((status) => {
      if (status.moduleId !== engineRef.moduleId || status.engineId !== engineRef.engineId) return false;
      if (version && status.version !== version) return false;
      if (packageSha256 && status.packageSha256 !== packageSha256) return false;
      return true;
    });
    return matches.length === 1 ? matches[0] : null;
  }

  function engineRefs(project) {
    const refs = [];
    const seen = new Set();
    for (const instrument of Array.isArray(project?.instrumentPool) ? project.instrumentPool : Object.values(project?.instrumentPool ?? {})) {
      const ref = instrument?.engineRef;
      if (!ref?.moduleId || !ref?.engineId) continue;
      const key = identityForRef(ref);
      if (!seen.has(key)) { seen.add(key); refs.push(ref); }
    }
    return refs;
  }

  function touchVerifiedRecord(key) {
    const record = verifiedMap.get(key) ?? null;
    if (!record) return null;
    verifiedMap.delete(key);
    verifiedMap.set(key, record);
    return record;
  }

  function compactVerifiedRecord(key) {
    const record = verifiedMap.get(key) ?? null;
    if (!record?.loaded) return record;
    const compact = Object.freeze({ loaded: null, source: record.source, view: record.view });
    verifiedMap.delete(key);
    verifiedMap.set(key, compact);
    return compact;
  }

  function pruneVerifiedMap() {
    let inactive = 0;
    for (const key of verifiedMap.keys()) if (!activePackageKeys.has(key)) inactive += 1;
    if (inactive <= MAX_RETAINED_VERIFIED_VIEWS) return 0;
    let evicted = 0;
    for (const key of [...verifiedMap.keys()]) {
      if (inactive <= MAX_RETAINED_VERIFIED_VIEWS) break;
      if (activePackageKeys.has(key)) continue;
      verifiedMap.delete(key);
      inactive -= 1;
      evicted += 1;
    }
    verifiedEvictions += evicted;
    return evicted;
  }

  function replaceActivePackageKeys(keys) {
    activePackageKeys.clear();
    for (const key of keys) if (key) activePackageKeys.add(key);
    pruneVerifiedMap();
  }

  function productionInstrumentSnapshot(project) {
    const pool = project?.instrumentPool && typeof project.instrumentPool === "object" ? project.instrumentPool : {};
    const result = {};
    for (const [idText, instrument] of Object.entries(pool)) {
      const id = Number(idText);
      if (!Number.isInteger(id) || id < 0 || id > 255 || !instrument?.engineRef?.moduleId || !instrument?.engineRef?.engineId) continue;
      result[id] = clone(instrument);
    }
    return result;
  }

  function directRuntimePaths(manifest) {
    const js = String(manifest?.runtime?.directJs ?? "").trim();
    const wasm = String(manifest?.runtime?.directWasm ?? "").trim();
    if (!js || !wasm) throw new browserDomain.EnginePackageTransportError("runtime-missing", "engine package must declare runtime.directJs + runtime.directWasm for BRK Synth ABI-v1 hosting");
    return Object.freeze({ js, wasm });
  }

  function buildWorkletModuleSource(loaded) {
    const paths = directRuntimePaths(loaded.manifest);
    const jsBytes = loaded.files?.[paths.js];
    const wasmBytes = loaded.files?.[paths.wasm];
    if (!(jsBytes instanceof Uint8Array) || !(wasmBytes instanceof Uint8Array)) throw new browserDomain.EnginePackageTransportError("runtime-missing", `verified package is missing direct runtime ${paths.js}/${paths.wasm}`);
    const js = new TextDecoder().decode(jsBytes);
    const wasmLiteral = Array.from(wasmBytes).join(",");
    // A failure below is an uncaught exception inside the Worklet's top-level
    // await, and addModule() resolves regardless. Record the engine's own
    // reason where the registry probe can return it, then rethrow so the
    // Worklet console still shows it.
    const entryLiteral = JSON.stringify(loaded.entry);
    // Catch JS glue failures as well as Module()/ABI failures; a missing
    // Worklet global may throw before Module is even defined.
    return `const __brktrkEntry=${entryLiteral};try{\n${js}\nconst __brktrkWasm=new Uint8Array([${wasmLiteral}]);const __brktrkModule=await Module({wasmBinary:__brktrkWasm});globalThis.BRKTRKBrkSynthAbiV1Runtime.registerModuleRuntime({entry:__brktrkEntry,manifest:${JSON.stringify(loaded.manifest)},module:__brktrkModule});}catch(__brktrkError){try{globalThis.BRKTRKBrkSynthAbiV1Runtime.recordRegistrationFailure?.(__brktrkEntry,__brktrkError);}catch(__brktrkIgnored){}throw __brktrkError;}\n`;
  }

  function descriptorJson(loaded, path, label) {
    if (!path) return null;
    const bytes = loaded.files?.[path];
    if (!(bytes instanceof Uint8Array)) throw new browserDomain.EnginePackageTransportError("descriptor-missing", `verified package is missing ${label} descriptor ${path}`);
    try { return JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new browserDomain.EnginePackageTransportError("descriptor-invalid", `${label} descriptor ${path} is invalid JSON`); }
  }

  async function presetDomain() {
    if (globalThis.BRKTRKEnginePresetDomain) return globalThis.BRKTRKEnginePresetDomain;
    if (!presetDomainPromise) {
      presetDomainPromise = import("./engine-preset-domain.js").then(() => {
        if (!globalThis.BRKTRKEnginePresetDomain) throw new Error("engine preset domain did not register");
        return globalThis.BRKTRKEnginePresetDomain;
      }).catch((error) => {
        presetDomainPromise = null;
        throw error;
      });
    }
    return presetDomainPromise;
  }

  function packageViewFromLoaded(loaded, presetApi = null) {
    const descriptors = loaded.manifest?.descriptors ?? {};
    const ui = descriptorJson(loaded, descriptors.ui, "UI");
    const engine = descriptorJson(loaded, descriptors.engine, "engine");
    const presets = descriptors.presets && presetApi ? presetApi.createLibrary(loaded) : null;
    return Object.freeze({
      entry: Object.freeze(clone(loaded.entry)),
      manifest: Object.freeze({
        moduleId: loaded.manifest.moduleId,
        engineId: loaded.manifest.engineId,
        version: loaded.manifest.version,
        abiVersion: loaded.manifest.abiVersion,
        stateSchemaVersion: loaded.manifest.stateSchemaVersion,
        stateBytes: Number.isInteger(Number(loaded.manifest.stateBytes)) ? Number(loaded.manifest.stateBytes) : null,
        parameterSchemaVersion: loaded.manifest.parameterSchemaVersion,
        contentSha256: loaded.manifest.contentSha256,
        runtime: Object.freeze({
          assetExtensionVersion: Number(loaded.manifest?.runtime?.assetExtensionVersion ?? 0) || 0,
          assetArenaBytes: Number(loaded.manifest?.runtime?.assetArenaBytes ?? 0) || 0,
          assetSlots: Number(loaded.manifest?.runtime?.assetSlots ?? 0) || 0,
        }),
        descriptors: Object.freeze(clone(descriptors)),
      }),
      ui: ui ? Object.freeze(clone(ui)) : null,
      engine: engine ? Object.freeze(clone(engine)) : null,
      parameters: Object.freeze(loaded.manifest.parameters.map((parameter) => Object.freeze(clone(parameter)))),
      presets,
    });
  }

  function packageSetFor(context) {
    let set = contextPackages.get(context);
    if (!set) { set = new Set(); contextPackages.set(context, set); }
    return set;
  }

  function packageLoadMapFor(context) {
    let map = contextPackageLoads.get(context);
    if (!map) { map = new Map(); contextPackageLoads.set(context, map); }
    return map;
  }

  function catalogCandidates() {
    if (!latestCatalogInfo) return Object.freeze([]);
    return Object.freeze(latestCatalogInfo.catalog.entries.map((entry) => Object.freeze({
      entry: Object.freeze(clone(entry)),
      compatibility: Object.freeze(clone(packageDomain.entryCompatibility(entry, HOST))),
    })));
  }

  function catalogEntries() {
    return Object.freeze(catalogCandidates()
      .filter((candidate) => candidate.compatibility.compatible)
      .map((candidate) => candidate.entry));
  }

  async function refreshCatalog(options = {}) {
    const catalogStartedAt = timingNow();
    const catalogInfo = await browserDomain.fetchCatalog({
      baseUrl: options.baseUrl ?? globalThis.location?.href,
      catalogUrl: options.catalogUrl ?? DEFAULT_CATALOG_URL,
      fetchImpl: options.fetchImpl,
    });
    latestCatalogInfo = catalogInfo;
    latestCatalog = Object.freeze({ url: catalogInfo.url, trust: catalogInfo.raw?.trust ?? null, entryCount: catalogInfo.catalog.entries.length });
    // The catalog is fetched `no-store`, so it is a network round trip on every
    // cold load and it blocks every verification behind it. It is timed as its
    // own load because it is the first thing to rule in or out.
    recordLoadTiming({
      at: new Date().toISOString(),
      moduleId: null,
      engineId: null,
      version: null,
      source: "catalog",
      archiveBytes: null,
      totalMs: roundMs(timingNow() - catalogStartedAt),
      stages: Object.freeze({ catalogFetch: roundMs(timingNow() - catalogStartedAt) }),
    });
    return catalogEntries();
  }

  async function ensureVerifiedEntry(entry, catalogInfo, options = {}) {
    const key = keyFor(entry);
    const requireLoaded = options.requireLoaded === true;
    const retained = touchVerifiedRecord(key);
    if (retained && (!requireLoaded || retained.loaded)) return retained;
    if (verifiedLoads.has(key)) return verifiedLoads.get(key);
    const promise = (async () => {
      const stages = {};
      const startedAt = timingNow();
      const result = await browserDomain.loadVerifiedEntry(entry, {
        root: catalogInfo.root,
        host: HOST,
        fetchImpl: options.fetchImpl,
        cacheStorage: options.cacheStorage,
        onStage: (name, elapsedMs) => {
          // A corrupt cached archive is retried through the network path, so a
          // stage can run twice. Sum rather than overwrite: the report should
          // say where the wall time went, not where it last went.
          stages[name] = roundMs((stages[name] ?? 0) + elapsedMs);
        },
      });
      const presetApi = result.loaded.manifest?.descriptors?.presets ? await presetDomain() : null;
      const record = Object.freeze({
        loaded: result.loaded,
        source: result.source,
        view: retained?.view ?? packageViewFromLoaded(result.loaded, presetApi),
      });
      verifiedMap.set(key, record);
      pruneVerifiedMap();
      recordLoadTiming({
        at: new Date().toISOString(),
        moduleId: entry.moduleId ?? null,
        engineId: entry.engineId ?? null,
        version: entry.version ?? null,
        source: result.source ?? null,
        archiveBytes: result.loaded?.packageBytes?.byteLength ?? null,
        totalMs: roundMs(timingNow() - startedAt),
        stages: Object.freeze({ ...stages }),
      });
      return record;
    })();
    verifiedLoads.set(key, promise);
    try { return await promise; }
    finally { if (verifiedLoads.get(key) === promise) verifiedLoads.delete(key); }
  }

  async function ensurePackageView(engineRef, options = {}) {
    const catalogInfo = latestCatalogInfo ?? (await refreshCatalog(options), latestCatalogInfo);
    const channel = requestedEngineChannel(engineRef, options);
    const entry = packageDomain.resolveCatalogEntry(catalogInfo.catalog, engineRef, { ...HOST, channel });
    if (!entry) throw new browserDomain.EnginePackageTransportError("package-unavailable", `engine package ${engineRef?.moduleId ?? "?"}/${engineRef?.engineId ?? "?"} is unavailable`);
    const record = await ensureVerifiedEntry(entry, catalogInfo, options);
    const view = record.view;
    compactVerifiedRecord(keyFor(entry));
    pruneVerifiedMap();
    return view;
  }

  function findVerifiedView(engineRef) {
    if (!engineRef?.moduleId || !engineRef?.engineId) return null;
    for (const [key, record] of verifiedMap.entries()) {
      const entry = record.view.entry;
      if (entry.moduleId !== engineRef.moduleId || entry.engineId !== engineRef.engineId) continue;
      if (engineRef.resolvedVersion && entry.version !== engineRef.resolvedVersion) continue;
      if (engineRef.resolvedPackageSha256 && entry.packageSha256 !== normalizedSha(engineRef.resolvedPackageSha256)) continue;
      touchVerifiedRecord(key);
      return record.view;
    }
    return null;
  }

  function interactionFor(engineRef, parameterId) {
    const view = findVerifiedView(engineRef);
    if (!view) return null;
    const id = String(parameterId ?? "").trim();
    const parameter = view.parameters.find((candidate) => candidate.id === id);
    if (!parameter) return null;
    const discrete = parameter.type === "enum" || parameter.type === "stepped" || Array.isArray(parameter.values);
    const profile = discrete ? view.ui?.interaction?.discrete : view.ui?.interaction?.continuous;
    const smoothingOverride = Number(view.ui?.smoothingMsByKey?.[id]);
    const declaredMs = Number.isFinite(smoothingOverride)
      ? Math.max(0, smoothingOverride)
      : Math.max(0, Number(profile?.defaultSmoothingMs) || 0);
    // Web Alpha must not deliver an abrupt parameter step merely because an
    // engine omits its UI smoothing profile. Ramp continuous parameters in the
    // existing Worklet/ABI path, keeping exact engine package pins untouched.
    const smoothingMs = discrete ? declaredMs : Math.max(4, declaredMs);
    // `entry` and `ui` travel with the interaction so a targeted re-render can
    // format a value exactly as the full render did. Without them the store
    // render overwrites a freshly edited ABI reading with a percentage.
    return Object.freeze({ parameter: Object.freeze(clone(parameter)), entry: view.entry, ui: view.ui ?? null, policy: String(profile?.policy ?? (discrete ? "parameter-value" : "parameter-ramp")), smoothingMs, discrete });
  }

  function acknowledgeLiveParameterSignature(instrumentId, instrument, parameterId, value) {
    if (!lastInstrumentSignature || !instrument?.engineRef) return false;
    let instruments;
    try { instruments = JSON.parse(lastInstrumentSignature); }
    catch { return false; }
    const id = String(Number(instrumentId));
    const baseline = instruments?.[id];
    if (!baseline?.engineRef || identityForRef(baseline.engineRef) !== identityForRef(instrument.engineRef)) return false;
    if (!baseline.parameterSnapshot || typeof baseline.parameterSnapshot !== "object" || Array.isArray(baseline.parameterSnapshot)) baseline.parameterSnapshot = {};
    baseline.parameterSnapshot[String(parameterId)] = clone(value);
    lastInstrumentSignature = JSON.stringify(instruments);
    return true;
  }

  function sendLiveParameter({ instrumentId, instrument, parameterId, value } = {}) {
    if (!node?.port || !attachedContext || !instrument?.engineRef) {
      liveParameterRejections += 1;
      return false;
    }
    const interaction = interactionFor(instrument.engineRef, parameterId);
    if (!interaction) {
      liveParameterRejections += 1;
      return false;
    }
    const rampFrames = interaction.policy === "parameter-ramp"
      ? Math.max(0, Math.round(attachedContext.sampleRate * interaction.smoothingMs / 1000))
      : 0;
    node.port.postMessage({
      type: "production-parameter",
      instrumentId: Number(instrumentId),
      parameterId: String(parameterId),
      value: clone(value),
      rampFrames,
    });
    acknowledgeLiveParameterSignature(instrumentId, instrument, parameterId, value);
    liveParameterMessages += 1;
    if (rampFrames > 0) liveParameterRampMessages += 1;
    else liveParameterValueMessages += 1;
    lastLiveParameter = Object.freeze({
      instrumentId: Number(instrumentId),
      parameterId: String(parameterId),
      value: clone(value),
      rampFrames,
      policy: interaction.policy,
    });
    return Object.freeze({ parameterId: String(parameterId), rampFrames, policy: interaction.policy });
  }

  async function addVerifiedPackageToWorklet(context, loaded) {
    const key = keyFor(loaded.entry);
    const contextSet = packageSetFor(context);
    if (contextSet.has(key)) return loadedMap.get(key) ?? null;
    const loadMap = packageLoadMapFor(context);
    if (loadMap.has(key)) return loadMap.get(key);
    const promise = (async () => {
      const blob = new Blob([buildWorkletModuleSource(loaded)], { type: "text/javascript" });
      const url = URL.createObjectURL(blob);
      try { await context.audioWorklet.addModule(url); }
      finally { URL.revokeObjectURL(url); }
      contextSet.add(key);
      const record = Object.freeze({ entry: loaded.entry, manifest: loaded.manifest, packageSha256: loaded.entry.packageSha256, contentSha256: loaded.manifest.contentSha256 });
      loadedMap.set(key, record);
      return record;
    })();
    loadMap.set(key, promise);
    try { return await promise; }
    finally { if (loadMap.get(key) === promise) loadMap.delete(key); }
  }

  async function prepareContext(context, project, options = {}) {
    if (!context?.audioWorklet?.addModule) throw new TypeError("production engine host requires AudioContext.audioWorklet");
    const refs = engineRefs(project);
    if (refs.length === 0) {
      replaceActivePackageKeys([]);
      return snapshot();
    }

    let catalogInfo;
    try {
      if (!latestCatalogInfo) await refreshCatalog(options);
      catalogInfo = latestCatalogInfo;
    } catch (error) {
      for (const ref of refs) statusMap.set(identityForRef(ref), statusForRef(ref, "catalog-unavailable", { message: String(error?.message ?? error) }));
      return snapshot();
    }

    const nextActivePackageKeys = new Set();
    for (const ref of refs) {
      let statusKey = identityForRef(ref);
      let statusIdentity = statusForRef(ref, "package-failed");
      let entryKey = null;
      try {
        const channel = requestedEngineChannel(ref, options);
        const entry = packageDomain.resolveCatalogEntry(catalogInfo.catalog, ref, { ...HOST, channel });
        if (!entry) { statusMap.set(statusKey, statusForRef(ref, "package-unavailable", { engineRef: clone(ref) })); continue; }
        entryKey = keyFor(entry);
        statusKey = identityForEntry(entry);
        statusIdentity = statusForEntry(entry, "package-failed");
        nextActivePackageKeys.add(entryKey);
        activePackageKeys.add(entryKey);
        const contextSet = packageSetFor(context);
        if (contextSet.has(entryKey)) {
          if (!verifiedMap.has(entryKey)) await ensureVerifiedEntry(entry, catalogInfo, { ...options, requireLoaded: false });
          else touchVerifiedRecord(entryKey);
          const existing = loadedMap.get(entryKey);
          statusMap.set(statusKey, statusForEntry(entry, "ready", { contentSha256: existing?.contentSha256 ?? verifiedMap.get(entryKey)?.view?.manifest?.contentSha256 ?? null, source: "active-context" }));
          continue;
        }
        const verified = await ensureVerifiedEntry(entry, catalogInfo, { ...options, requireLoaded: true });
        await addVerifiedPackageToWorklet(context, verified.loaded);
        statusMap.set(statusKey, statusForEntry(entry, "ready", { contentSha256: verified.loaded.manifest.contentSha256, source: verified.source }));
      } catch (error) {
        statusMap.set(statusKey, Object.freeze({ ...statusIdentity, state: "package-failed", code: error?.code ?? null, message: String(error?.message ?? error) }));
      } finally {
        // Verification may succeed while Worklet module construction or
        // audioWorklet.addModule fails. Heavy archive/WASM bytes must never be
        // retained merely because activation failed; the lightweight verified
        // view stays available for diagnostics and the next retry re-verifies
        // exact bytes on demand.
        if (entryKey) {
          compactVerifiedRecord(entryKey);
          pruneVerifiedMap();
        }
      }
    }
    replaceActivePackageKeys(nextActivePackageKeys);
    return snapshot();
  }

  function evidenceClone(value) {
    if (value == null) return null;
    try { return clone(value); }
    catch { return String(value); }
  }

  function recordFailure(source, fields = {}, nodeGeneration = failureNodeGeneration, context = attachedContext) {
    failureSequence += 1;
    const entry = Object.freeze({
      sequence: failureSequence,
      at: new Date().toISOString(),
      atMs: roundMs(timingNow()),
      source,
      type: String(fields.type ?? source),
      code: fields.code == null ? null : String(fields.code),
      message: fields.message == null ? null : String(fields.message).slice(0, FAILURE_MESSAGE_LIMIT),
      details: evidenceClone(fields.details),
      stoppedTransport: fields.stoppedTransport === true,
      transport: evidenceClone(fields.transport),
      track: Number.isInteger(fields.track) ? fields.track : null,
      instrumentId: Number.isInteger(fields.instrumentId) ? fields.instrumentId : null,
      renderFailures: Number.isSafeInteger(fields.renderFailures) ? fields.renderFailures : null,
      // Which attached AudioWorkletNode reported it. A failure from a node that
      // has since been replaced is still evidence; it just is not current.
      nodeGeneration,
      currentNode: nodeGeneration === failureNodeGeneration,
      audioContext: context ? Object.freeze({
        state: context.state ?? null,
        currentTime: Number.isFinite(Number(context.currentTime)) ? Number(context.currentTime) : null,
      }) : null,
    });
    failureLog.push(entry);
    while (failureLog.length > FAILURE_LOG_LIMIT) failureLog.shift();
    for (const listener of [...failureListeners]) {
      try { listener(entry); } catch { /* a listener cannot lose evidence */ }
    }
    return entry;
  }

  function failureLogSnapshot() {
    return Object.freeze({
      limit: FAILURE_LOG_LIMIT,
      total: failureSequence,
      recorded: failureLog.length,
      // Newest first: a report is read from the top.
      // A previously current failure becomes historical on replacement.
      entries: Object.freeze([...failureLog].reverse().map((entry) => Object.freeze({
        ...entry,
        currentNode: entry.nodeGeneration === failureNodeGeneration,
      }))),
    });
  }

  function onFailure(listener) {
    if (typeof listener !== "function") return () => false;
    failureListeners.add(listener);
    return () => failureListeners.delete(listener);
  }

  // What the status line should say about a failure, or null when it should
  // stay quiet. Only failures that ended playback or the processor speak; a
  // rejected parameter during a drag is logged, not announced.
  function failureStatus(failure = {}) {
    const reason = String(failure?.message ?? failure?.code ?? "").replace(/\s+/g, " ").trim().slice(0, 140);
    if (failure?.source === "processorerror" || failure?.type === "processorerror") {
      return Object.freeze({ text: `AUDIO PROCESSOR STOPPED${reason ? ` · ${reason}` : ""}`, tone: "danger" });
    }
    if (failure?.type === "production-engine-error" && failure?.stoppedTransport === true) {
      return Object.freeze({ text: `PLAYBACK STOPPED · ENGINE ERROR${reason ? ` · ${reason}` : ""}`, tone: "danger" });
    }
    return null;
  }

  function instrumentNodeFailures(target, context = attachedContext) {
    if (!target || failureInstrumentedNodes.has(target)) return;
    failureInstrumentedNodes.add(target);
    failureNodeGeneration += 1;
    const generation = failureNodeGeneration;
    // The context this node renders in, so a late report from a replaced node
    // describes its own AudioContext rather than the current one.
    const nodeContext = context;
    target.port?.addEventListener?.("message", (event) => {
      const message = event?.data;
      if (message?.type !== "production-engine-error" && message?.type !== "production-transport-rejected") return;
      recordFailure("worklet-message", message, generation, nodeContext);
    });
    // An exception that escapes process() ends the processor for good: from then
    // on the node outputs silence and posts nothing, so this event is the only
    // evidence that playback died rather than stopped.
    target.addEventListener?.("processorerror", (event) => {
      recordFailure("processorerror", {
        type: "processorerror",
        code: "worklet-processor-error",
        message: event?.message || event?.error?.message || "AudioWorkletProcessor stopped after an uncaught exception",
        details: { filename: event?.filename ?? null, lineno: event?.lineno ?? null, colno: event?.colno ?? null },
      }, generation, nodeContext);
    });
  }

  function sampleAssetHostDomain() {
    if (globalThis.BRKTRKSampleAssetHost) return globalThis.BRKTRKSampleAssetHost;
    if (typeof require !== "undefined") {
      try { return require("./sample-asset-host.js"); } catch {}
    }
    return null;
  }

  function projectHasAssetRefs(project) {
    const pool = project?.instrumentPool && typeof project.instrumentPool === "object" ? project.instrumentPool : {};
    return (Array.isArray(pool) ? pool : Object.values(pool)).some((instrument) => Boolean(instrument?.assetRef));
  }

  async function syncProjectAssets(project, options = {}) {
    const target = options.node ?? node;
    const assetHost = sampleAssetHostDomain();
    if (!assetHost?.syncNode) {
      if (projectHasAssetRefs(project)) {
        assetSyncFailures += 1;
        const error = new Error("Project requires sample assets but the sample asset Host is unavailable");
        error.code = "sample-asset-host-unavailable";
        throw error;
      }
      return false;
    }
    try {
      const result = await assetHost.syncNode(target, project, options);
      if (result) {
        assetSnapshotMessages += 1;
        assetSnapshotBytes += Number(result.byteCount ?? 0);
      }
      return result;
    } catch (error) {
      assetSyncFailures += 1;
      throw error;
    }
  }

  function attachNode(nextNode, context, project) {
    const previousNode = node;
    node = nextNode ?? null;
    if (previousNode && !node) failureNodeGeneration += 1;
    attachedContext = context ?? null;
    lastInstrumentSignature = "";
    instrumentNodeFailures(node);
    if (!node?.port) return;
    node.port.addEventListener?.("message", (event) => handleWorkletMessage(event.data));
    node.port.start?.();
    if (projectHasAssetRefs(project)) {
      const assetHost = sampleAssetHostDomain();
      if (!assetHost?.isNodeSynced?.(node, project)) {
        const error = new Error("Sample assets must be synchronized before attaching an asset-backed Project");
        error.code = "sample-assets-not-synchronized";
        throw error;
      }
    }
    syncProject(project, { force: true });
    node.port.postMessage({ type: "production-diagnostics-request" });
    requestEngineDescriptors();
  }

  async function activateProject(project, options = {}) {
    if (!attachedContext) return snapshot();
    await prepareContext(attachedContext, project, options);
    await syncProjectAssets(project, options);
    syncProject(project, { force: true });
    node?.port?.postMessage({ type: "production-diagnostics-request" });
    requestEngineDescriptors();
    return snapshot();
  }

  function syncProject(project, { force = false } = {}) {
    if (!node?.port) return false;
    const instruments = productionInstrumentSnapshot(project);
    const signature = JSON.stringify(instruments);
    if (!force && signature === lastInstrumentSignature) return false;
    lastInstrumentSignature = signature;
    node.port.postMessage({ type: "production-instruments", instruments });
    instrumentSnapshotMessages += 1;
    instrumentSnapshotJsonChars += signature.length;
    return true;
  }

  let engineDescriptorRequests = 0;
  // attachNode registers a message listener per node and never removes the
  // previous one, so a retired node's reply can still arrive - after the new
  // node has already answered. Without this the late reply would clear the map
  // and install the retired AudioContext's package set as current truth. Only
  // the most recent request may install a snapshot.
  let pendingDescriptorRequestId = null;
  function requestEngineDescriptors() {
    if (!node?.port) return false;
    engineDescriptorRequests += 1;
    pendingDescriptorRequestId = `abi-descriptors-${engineDescriptorRequests}`;
    node.port.postMessage({ type: "production-engine-descriptors-request", requestId: pendingDescriptorRequestId });
    return true;
  }

  // Null when the engine never reported - the caller keeps using package JSON
  // rather than treating absence as an empty parameter set.
  function abiDescriptorsFor(entry) {
    return abiDescriptorsByPackage.get(identityForEntry(entry)) ?? null;
  }

  // Re-requesting descriptors after an unchanged re-attach is normal, so
  // compare before notifying: an identical snapshot must not redraw the Sound
  // surface underneath someone dragging a control.
  function descriptorSnapshotChanged(replacement) {
    if (replacement.size !== abiDescriptorsByPackage.size) return true;
    for (const [key, value] of replacement) {
      const current = abiDescriptorsByPackage.get(key);
      if (!current) return true;
      if (JSON.stringify(current) !== JSON.stringify(value)) return true;
    }
    return false;
  }

  // The host does not reach into renderers; a consumer subscribes instead.
  function onEngineDescriptorsChanged(listener) {
    if (typeof listener !== "function") throw new TypeError("engine descriptor listener must be a function");
    abiDescriptorListeners.add(listener);
    return () => abiDescriptorListeners.delete(listener);
  }

  function notifyDescriptorListeners() {
    for (const listener of abiDescriptorListeners) {
      // One failing consumer may not stop the others from learning the ranges
      // changed, and must never propagate into the port message handler.
      try { listener(); }
      catch (error) { console.error("BRKTRK engine descriptor listener failed", error); }
    }
  }

  function handleWorkletMessage(message) {
    if (message?.type === "production-diagnostics") {
      latestWorkletDiagnostics = Object.freeze(clone(message.snapshot ?? null));
      return;
    }
    if (message?.type === "production-engine-descriptors") {
      abiDescriptorMessages += 1;
      // Matched against the LATEST request rather than consumed, so a repeat
      // answer to the current request stays valid while a superseded node's
      // reply - its listener is never removed on re-attach - is dropped.
      if (pendingDescriptorRequestId === null || message.requestId !== pendingDescriptorRequestId) {
        abiDescriptorRepliesIgnored += 1;
        return;
      }
      // Each response is a complete snapshot of what the Worklet currently
      // holds, so this replaces rather than accumulates. Merging would keep
      // reporting descriptors for a package the Worklet has retired, or that
      // an AudioContext replacement re-registered without them - stale ranges
      // presented as current truth, and one entry per retired version kept
      // alive forever.
      const replacement = new Map();
      for (const reported of Array.isArray(message.engines) ? message.engines : []) {
        if (!reported?.moduleId || !reported?.engineId) continue;
        const parameters = Array.isArray(reported.parameters) ? reported.parameters : [];
        if (!parameters.length) continue;
        replacement.set(
          packageIdentity(reported.moduleId, reported.engineId, reported.version, reported.packageSha256),
          Object.freeze({
            engine: Object.freeze(clone(reported.engine ?? null)),
            // Each descriptor is frozen individually, not just the array.
            // abiDescriptorsFor returns this cached object directly, so a
            // consumer that annotated a parameter would permanently rewrite an
            // authoritative range or unit for every later render.
            parameters: Object.freeze(clone(parameters).map((parameter) => Object.freeze(parameter))),
          }),
        );
      }
      const changed = descriptorSnapshotChanged(replacement);
      abiDescriptorsByPackage.clear();
      for (const [key, value] of replacement) abiDescriptorsByPackage.set(key, value);
      // The reply is asynchronous, so it routinely lands after the Sound
      // surface has already drawn - initializing audio while Sound is open is
      // the ordinary case. Nothing else re-renders on its own, so without this
      // every control stays on its package/percentage fallback until an
      // unrelated interaction happens to redraw it.
      if (changed) notifyDescriptorListeners();
      return;
    }
    if (message?.type !== "production-runtime-retired" || !Array.isArray(message.packages)) return;
    runtimeRetirementMessages += 1;
    const contextSet = attachedContext ? packageSetFor(attachedContext) : null;
    for (const retired of message.packages) {
      const key = packageIdentity(retired?.moduleId, retired?.engineId, retired?.version, retired?.packageSha256);
      contextSet?.delete(key);
      loadedMap.delete(key);
      statusMap.delete(key);
      runtimeRetiredPackages += 1;
    }
    pruneVerifiedMap();
  }

  function snapshot() {
    let retainedInactive = 0;
    let residentPackageBytes = 0;
    for (const [key, record] of verifiedMap.entries()) {
      if (!activePackageKeys.has(key)) retainedInactive += 1;
      residentPackageBytes += Number(record.loaded?.packageBytes?.byteLength ?? 0);
    }
    return Object.freeze({
      catalog: latestCatalog,
      packages: Object.freeze([...statusMap.entries()].map(([identity, status]) => Object.freeze({ identity, engine: `${status.moduleId}/${status.engineId}`, ...status }))),
      verified: Object.freeze([...verifiedMap.values()].map((record) => Object.freeze({ moduleId: record.view.entry.moduleId, engineId: record.view.entry.engineId, version: record.view.entry.version, packageSha256: record.view.entry.packageSha256, contentSha256: record.view.manifest.contentSha256, hasUi: Boolean(record.view.ui), presetCount: record.view.presets?.presetCount ?? 0 }))),
      loaded: Object.freeze([...loadedMap.values()].map((record) => Object.freeze({ moduleId: record.entry.moduleId, engineId: record.entry.engineId, version: record.entry.version, packageSha256: record.packageSha256, contentSha256: record.contentSha256 }))),
      retention: Object.freeze({
        verifiedViewLimit: MAX_RETAINED_VERIFIED_VIEWS,
        activePackages: activePackageKeys.size,
        retainedInactive,
        residentPackageBytes,
        verifiedEvictions,
        runtimeRetirementMessages,
        runtimeRetiredPackages,
      }),
      traffic: Object.freeze({
        liveParameterMessages,
        liveParameterRampMessages,
        liveParameterValueMessages,
        liveParameterRejections,
        instrumentSnapshotMessages,
        instrumentSnapshotJsonChars,
        assetSnapshotMessages,
        assetSnapshotBytes,
        assetSyncFailures,
        engineDescriptorRequests,
        abiDescriptorMessages,
        abiDescriptorRepliesIgnored,
        lastLiveParameter,
      }),
      worklet: latestWorkletDiagnostics,
      loadTimings: loadTimingSnapshot(),
      failures: failureLogSnapshot(),
    });
  }

  function registerDiagnostics() {
    if (diagnosticsRegistered) return true;
    const diagnostics = globalThis.BRKTRKDiagnostics;
    if (!diagnostics?.registerSection) return false;
    try { diagnostics.registerSection("productionEngines", snapshot); diagnosticsRegistered = true; return true; } catch { return false; }
  }

  const api = Object.freeze({
    HOST,
    DEFAULT_CATALOG_URL,
    MAX_RETAINED_VERIFIED_VIEWS,
    LOAD_TIMING_LIMIT,
    loadTimingSnapshot,
    FAILURE_LOG_LIMIT,
    failureLogSnapshot,
    failureStatus,
    onFailure,
    productionInstrumentSnapshot,
    buildWorkletModuleSource,
    refreshCatalog,
    catalogChannels,
    catalogCandidates,
    catalogEntries,
    ensurePackageView,
    abiDescriptorsFor,
    requestEngineDescriptors,
    onEngineDescriptorsChanged,
    packageStatusFor,
    interactionFor,
    sendLiveParameter,
    prepareContext,
    observeNodeFailures: instrumentNodeFailures,
    attachNode,
    activateProject,
    syncProjectAssets,
    syncProject,
    handleWorkletMessage,
    snapshot,
    registerDiagnostics,
  });
  globalThis.BRKTRKProductionEngineHost = api;
  registerDiagnostics();
})();
