(() => {
  const audioRuntime = typeof audio !== "undefined" ? audio : null;
  if (!audioRuntime || typeof audioRuntime.init !== "function") {
    throw new Error("Audio readiness requires the base BrowserAudio instance");
  }
  if (globalThis.BRKTRKAudioReadiness) return;

  const inheritedInit = audioRuntime.init.bind(audioRuntime);
  const listeners = new Set();
  const readyGates = new Map();
  const RESUME_TIMEOUT_MS = 4000;
  const RENDER_ADVANCE_TIMEOUT_MS = 1000;
  let inFlight = null;
  let inFlightInvalidationRevision = -1;
  let attempts = 0;
  let successfulInitializations = 0;
  let authoritativeContext = audioRuntime.context ?? null;
  let authoritativeNode = audioRuntime.node ?? null;
  let canonicalReady = false;
  let terminalError = null;
  let gateRevision = 0;
  let invalidationRevision = 0;

  function snapshot() {
    return Object.freeze({
      ready: audioRuntime.ready === true && canonicalReady && !terminalError,
      terminalError: terminalError?.message ?? null,
      graphReady: audioRuntime.ready === true,
      inFlight: Boolean(inFlight),
      attempts,
      successfulInitializations,
      registeredGates: readyGates.size,
      gateRevision,
      invalidationRevision,
      contextState: audioRuntime.context?.state ?? "none",
      hasContext: Boolean(audioRuntime.context),
      hasNode: Boolean(audioRuntime.node),
      authoritativeContext: audioRuntime.context === authoritativeContext || authoritativeContext == null,
      authoritativeNode: audioRuntime.node === authoritativeNode || authoritativeNode == null,
    });
  }

  function notify(type, detail = {}) {
    const event = Object.freeze({ type, ...detail, snapshot: snapshot() });
    for (const listener of [...listeners]) {
      try { listener(event); }
      catch (error) { console.warn("Audio readiness subscriber failed", error); }
    }
    try { globalThis.dispatchEvent?.(new CustomEvent("brktrk-audio-readiness", { detail: event })); }
    catch (error) { console.warn("Audio readiness DOM observer failed", error); }
  }

  function invalidate(metadata = {}) {
    const wasReady = canonicalReady === true;
    canonicalReady = false;
    // An invalidation issued by an external state owner while a proof is in
    // flight must supersede that transaction. A gate may also revoke an old
    // local proof while the canonical transaction is already unready; that
    // internal housekeeping must not invalidate its own transaction.
    if (wasReady || !inFlight || metadata.supersedeInFlight === true) invalidationRevision += 1;
    if (wasReady || metadata.notify === true) {
      notify("invalidated", {
        source: metadata.source ?? null,
        reason: metadata.reason ?? null,
      });
    }
    return snapshot();
  }

  function failTerminal(error, metadata = {}) {
    if (terminalError) return snapshot();
    terminalError = error instanceof Error ? error : new Error(String(error));
    const source = metadata.source ?? "audio-worklet-processorerror";
    invalidate({ source, reason: "terminal-processor-failure", supersedeInFlight: true, notify: true });
    notify("terminal-failed", { source, error: terminalError.message });
    return snapshot();
  }

  // The base graph installs this callback before its AudioContext starts rendering.
  // A Worklet failure during package gates must revoke readiness immediately.
  audioRuntime.onProcessorError = (event) => {
    const message = event?.message || event?.error?.message || "AudioWorkletProcessor stopped after an uncaught exception";
    failTerminal(new Error(`${message}; reload BRKTRK to restore audio`), { source: "audio-worklet-processorerror" });
  };

  function registerGate(name, gate) {
    const key = String(name ?? "").trim();
    if (!key) throw new TypeError("Audio readiness gate requires a stable name");
    if (typeof gate !== "function") throw new TypeError(`Audio readiness gate ${key} must be a function`);
    const existing = readyGates.get(key);
    if (existing && existing !== gate) throw new Error(`Audio readiness gate already registered: ${key}`);
    if (!existing) {
      readyGates.set(key, gate);
      gateRevision += 1;
      canonicalReady = false;
    }
    return () => {
      if (readyGates.get(key) !== gate) return false;
      readyGates.delete(key);
      gateRevision += 1;
      canonicalReady = false;
      return true;
    };
  }

  async function runReadyGates(metadata, kind) {
    const revision = gateRevision;
    for (const [name, gate] of [...readyGates.entries()]) {
      await gate(Object.freeze({
        name,
        kind,
        source: metadata.source ?? null,
        context: audioRuntime.context,
        node: audioRuntime.node,
        audio: audioRuntime,
      }));
      if (revision !== gateRevision) {
        throw new Error("Audio readiness gates changed during initialization");
      }
    }
  }

  async function cleanupFailedInitialGraph(previousContext) {
    if (previousContext || audioRuntime.ready) return;
    const context = audioRuntime.context;
    try {
      if (context && context.state !== "closed" && typeof context.close === "function") await context.close();
    } catch (error) {
      console.warn("Could not close failed BRKTRK AudioContext", error);
    }
    audioRuntime.context = null;
    audioRuntime.node = null;
    audioRuntime.ready = false;
  }

  async function resumeExistingContext(context) {
    if (!context || typeof context.resume !== "function") {
      throw new Error("Existing AudioContext cannot be resumed");
    }
    if (context.state === "running") return context;
    if (context.state === "closed") throw new Error("AudioContext is closed; reload BRKTRK to create a new graph");

    let resumeError = null;
    Promise.resolve()
      .then(() => context.resume())
      .catch((error) => { resumeError = error; });

    const deadline = Date.now() + RESUME_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (context.state === "running") return context;
      if (resumeError) throw resumeError;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (context.state === "running") return context;
    throw new Error(`AudioContext resume timed out in ${context.state || "unknown"} state`);
  }

  async function proveRenderClockAdvancing(context) {
    // Chrome may report `running` immediately after resume() while the realtime
    // render thread has not produced its first quantum yet. Starting transport
    // in that gap can make the first trace packet appear late. getOutputTimestamp
    // is intentionally used as the capability check so lightweight test doubles
    // that do not model a realtime render clock keep their existing semantics.
    if (!context || typeof context.getOutputTimestamp !== "function") return context;
    const baselineTime = Number(context.currentTime) || 0;
    const baselineOutputTime = Number(context.getOutputTimestamp()?.contextTime) || baselineTime;
    const sampleProgress = () => {
      if (context.state !== "running") {
        throw new Error(`AudioContext stopped while waiting for render clock (${context.state || "unknown"})`);
      }
      const currentTime = Number(context.currentTime) || 0;
      const outputTime = Number(context.getOutputTimestamp()?.contextTime) || 0;
      return currentTime > baselineTime || outputTime > baselineOutputTime;
    };
    const deadline = Date.now() + RENDER_ADVANCE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (sampleProgress()) return context;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // The final sleep may resume after the deadline even though the realtime
    // thread advanced while the main thread was delayed. Sample once more
    // before declaring failure so timer throttling cannot turn healthy audio
    // progress into a false readiness rejection.
    if (sampleProgress()) return context;
    throw new Error("AudioContext render clock did not advance after entering running state");
  }

  async function ensureReady(metadata = {}) {
    // A processorerror kills this node permanently. Do not reprove it ready
    // or silently allocate a second graph on the next Play.
    if (terminalError) throw terminalError;
    if (inFlight) {
      if (inFlightInvalidationRevision === invalidationRevision) return inFlight;
      // A caller arriving after an explicit invalidation must not join a stale
      // transaction that started against older Project/Worklet state. Let the
      // old transaction settle, then run one fresh canonical proof.
      return inFlight.catch(() => undefined).then(() => ensureReady(metadata));
    }

    const previousContext = audioRuntime.context;
    const graphAlreadyRunning = audioRuntime.ready === true && previousContext?.state === "running";
    const kind = previousContext ? (graphAlreadyRunning ? "existing" : "resume") : "init";
    attempts += 1;
    canonicalReady = false;
    const transactionInvalidationRevision = invalidationRevision;

    let releaseStart;
    const startBarrier = new Promise((resolve) => { releaseStart = resolve; });
    const transaction = (async () => {
      await startBarrier;
      try {
        if (kind === "resume" && audioRuntime.ready) await resumeExistingContext(previousContext);
        else if (kind === "init" || audioRuntime.ready !== true) await inheritedInit();
        if (!audioRuntime.context || !audioRuntime.node || audioRuntime.ready !== true) {
          throw new Error("BrowserAudio initialization completed without one ready context and node");
        }
        if (audioRuntime.context.state !== "running") {
          throw new Error(`BrowserAudio is ready but AudioContext is ${audioRuntime.context.state || "unknown"}`);
        }

        await proveRenderClockAdvancing(audioRuntime.context);
        await runReadyGates(metadata, kind);
        if (transactionInvalidationRevision !== invalidationRevision) {
          throw new Error("Audio readiness was invalidated during initialization; fresh proof required");
        }

        if (!authoritativeContext) authoritativeContext = audioRuntime.context;
        if (!authoritativeNode) authoritativeNode = audioRuntime.node;
        if (authoritativeContext !== audioRuntime.context || authoritativeNode !== audioRuntime.node) {
          throw new Error("BrowserAudio attempted to replace the authoritative audio graph");
        }
        canonicalReady = true;
        successfulInitializations += kind === "init" ? 1 : 0;
        notify("ready", { kind, source: metadata.source ?? null });
        return audioRuntime;
      } catch (error) {
        canonicalReady = false;
        await cleanupFailedInitialGraph(previousContext);
        notify(`${kind}-failed`, {
          kind,
          source: metadata.source ?? null,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        if (inFlight === transaction) {
          inFlight = null;
          inFlightInvalidationRevision = -1;
        }
      }
    })();

    // Publish the single-flight transaction before notifying synchronous
    // subscribers. A subscriber may itself request readiness in response to
    // the request event; it must join this transaction instead of starting a
    // competing gate/probe cycle. Observer failures cannot strand the barrier.
    inFlight = transaction;
    inFlightInvalidationRevision = transactionInvalidationRevision;
    try { notify(`${kind}-request`, { kind, source: metadata.source ?? null }); }
    finally { releaseStart(); }
    return transaction;
  }

  audioRuntime.init = ensureReady;
  globalThis.BRKTRKAudioReadiness = Object.freeze({
    ensureReady,
    invalidate,
    failTerminal,
    registerGate,
    snapshot,
    subscribe(listener) {
      if (typeof listener !== "function") throw new TypeError("Audio readiness subscriber must be a function");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    constants: Object.freeze({ RESUME_TIMEOUT_MS, RENDER_ADVANCE_TIMEOUT_MS }),
  });
})();
