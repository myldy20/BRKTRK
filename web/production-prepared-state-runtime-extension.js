(() => {
  "use strict";

  const baseDomain = globalThis.BRKTRKProductionAudioRuntime;
  const queueDomain = globalThis.BRKTRKPreparedInstrumentStateWorkletDomain;
  const gatewayCapture = globalThis.BRKTRKPreparedStateGatewayCapture;
  if (!baseDomain?.createProductionAudioRuntime || !queueDomain?.createQueue || !gatewayCapture?.beginCapture || !gatewayCapture?.finishCapture) {
    throw new Error("production prepared-state runtime extension requires ProductionAudioRuntime + prepared queue + gateway capture");
  }

  let nextCaptureId = 1;

  function createProductionAudioRuntime(options = {}) {
    const externalPostMessage = typeof options.postMessage === "function" ? options.postMessage : () => {};
    let queue = queueDomain.createQueue();
    let currentGateway = null;
    const stagedCommits = new Map();
    const latestCommitted = new Map();
    let preparedMessages = 0;
    let preparedMessageFailures = 0;
    let syntheticParameterWrites = 0;
    let blockApplyAttempts = 0;
    let blockApplyFailures = 0;
    let reconciliations = 0;
    let supersededPreparedParameters = 0;

    const preparedSnapshot = () => Object.freeze({
      ...queue.snapshot(),
      preparedMessages,
      preparedMessageFailures,
      syntheticParameterWrites,
      blockApplyAttempts,
      blockApplyFailures,
      reconciliations,
      supersededPreparedParameters,
      stagedInstruments: stagedCommits.size,
      retainedCommittedInstruments: latestCommitted.size,
      gateway: currentGateway?.preparedStateDiagnostics?.() ?? null,
    });

    const augmentDiagnostics = (snapshot) => Object.freeze({
      ...(snapshot && typeof snapshot === "object" ? snapshot : {}),
      preparedState: preparedSnapshot(),
    });

    const basePostMessage = (message) => {
      if (message?.type === "production-diagnostics") {
        externalPostMessage(Object.freeze({ ...message, snapshot: augmentDiagnostics(message.snapshot) }));
        return;
      }
      externalPostMessage(message);
    };

    function captureCall(call) {
      const token = `prepared-runtime-${nextCaptureId++}`;
      gatewayCapture.beginCapture(token);
      let result;
      let error = null;
      try { result = call(); }
      catch (caught) { error = caught; }
      let capturedGateway = null;
      try { capturedGateway = gatewayCapture.finishCapture(token); }
      catch (captureError) { if (!error) error = captureError; }
      if (capturedGateway) currentGateway = capturedGateway;
      if (error) throw error;
      return result;
    }

    const runtime = captureCall(() => baseDomain.createProductionAudioRuntime({ ...options, postMessage: basePostMessage }));
    if (!currentGateway) throw new Error("prepared-state runtime could not capture authoritative SynthGateway");

    function status(state, commit, details = {}) {
      externalPostMessage(Object.freeze({
        type: "production-prepared-state-status",
        state,
        instrumentId: Number(commit?.instrumentId),
        commitId: Number(commit?.commitId),
        desiredPresetId: commit?.desiredPresetId ?? null,
        ...details,
      }));
    }

    function staleSeenCommitId(instrumentId) {
      const row = queue.snapshot().lastSeen.find((item) => item.instrumentId === Number(instrumentId));
      return Number(row?.commitId ?? 0);
    }

    // A retained commit exists so that performers prepared *after* it still
    // receive its opaque engine state. Its parameter values, however, are only
    // a snapshot of what was current when it was applied. Re-asserting them
    // verbatim let a structural prepare pull an Instrument back toward the
    // factory preset after the user had already edited it — the parameter half
    // of the commit must therefore follow current runtime desired state, which
    // queueParameter() already maintains in MessagePort order for both
    // prepared-state synthetic writes and later live writes.
    function reconcilableCommit(commit) {
      let effective = null;
      for (let index = 0; index < commit.parameterIds.length; index += 1) {
        const current = runtime.instrumentParameterValue(commit.instrumentId, commit.parameterIds[index]);
        if (current === undefined || current === commit.parameterValues[index]) continue;
        if (!effective) effective = { ...commit, parameterValues: [...commit.parameterValues] };
        effective.parameterValues[index] = current;
        supersededPreparedParameters += 1;
      }
      return effective ?? commit;
    }

    function refreshGatewayState() {
      if (!currentGateway) return;
      for (const commit of latestCommitted.values()) {
        currentGateway.reconcilePreparedState(reconcilableCommit(commit));
        reconciliations += 1;
      }
      for (const commit of stagedCommits.values()) currentGateway.stagePreparedState(commit);
    }

    function resetPreparedTracking() {
      queue = queueDomain.createQueue();
      stagedCommits.clear();
      latestCommitted.clear();
      currentGateway?.clearPreparedState?.();
    }

    function assertPreparedParameterCapacity(normalized) {
      const capacity = Number(baseDomain.MAX_PENDING_PARAMETERS);
      const pending = Number(runtime.diagnostics().pendingLiveParameters ?? 0);
      const demand = normalized.parameterIds.length;
      if (!Number.isSafeInteger(capacity) || capacity < 1) {
        throw new queueDomain.PreparedStateQueueError("parameter-capacity-policy", "Prepared state requires the production live-parameter queue capacity contract");
      }
      // This is deliberately conservative. The base queue coalesces stable keys,
      // but it does not expose those keys. Requiring room for the complete
      // prepared snapshot before the first synthetic write guarantees a failed
      // commit can never leave a partial parameter snapshot queued for audio.
      if (pending + demand > capacity) {
        throw new queueDomain.PreparedStateQueueError("parameter-capacity-preflight", `Prepared state needs room for ${demand} complete parameter values with ${pending}/${capacity} live queue slots already occupied`, {
          instrumentId: normalized.instrumentId,
          commitId: normalized.commitId,
          pending,
          demand,
          capacity,
        });
      }
    }

    function stagePreparedMessage(data) {
      preparedMessages += 1;
      const normalized = queueDomain.normalizeCommit(data);
      const seen = staleSeenCommitId(normalized.instrumentId);
      if (normalized.commitId <= seen) {
        throw new queueDomain.PreparedStateQueueError("stale-commit", `Prepared state commit ${normalized.commitId} is not newer than ${seen} for Instrument ${normalized.instrumentId}`, {
          instrumentId: normalized.instrumentId,
          commitId: normalized.commitId,
          lastSeenCommitId: seen,
        });
      }
      if (!runtime.hasInstrument(normalized.instrumentId)) {
        throw new queueDomain.PreparedStateQueueError("instrument-unavailable", `Prepared state Instrument ${normalized.instrumentId} is not active in the production runtime`);
      }
      assertPreparedParameterCapacity(normalized);

      currentGateway.stagePreparedState(normalized);
      try {
        // The complete prepared parameter snapshot is written into the existing
        // stable-key pending parameter queue on the Worklet control plane. This
        // gives MessagePort order explicit causality without a second queue:
        // older live values are superseded by this commit, while later live
        // values supersede these writes before the same block flush.
        for (let index = 0; index < normalized.parameterIds.length; index += 1) {
          const accepted = runtime.queueParameter({
            instrumentId: normalized.instrumentId,
            parameterId: normalized.parameterIds[index],
            value: normalized.parameterValues[index],
            rampFrames: 0,
          });
          if (!accepted) throw new Error(`Prepared parameter ${normalized.parameterIds[index]} was not accepted by active Instrument ${normalized.instrumentId}`);
          syntheticParameterWrites += 1;
        }
        const queued = queue.stage(normalized);
        stagedCommits.set(normalized.instrumentId, normalized);
        status("queued", normalized, { supersededCommitId: queued.supersededCommitId ?? null });
        return queued;
      } catch (error) {
        currentGateway.discardPreparedState(normalized.instrumentId, normalized.commitId);
        throw error;
      }
    }

    function applyOnePreparedCommit() {
      const applying = queue.beginNext();
      if (!applying) return null;
      blockApplyAttempts += 1;
      status("applying", applying);
      try {
        const applied = currentGateway.applyStagedState(applying.instrumentId, applying.commitId);
        const result = queue.finishApplied(applying.instrumentId, applying.commitId);
        latestCommitted.set(applying.instrumentId, applying);
        if (stagedCommits.get(applying.instrumentId)?.commitId === applying.commitId) stagedCommits.delete(applying.instrumentId);
        status("applied", applying, { appliedPerformers: applied.appliedPerformers });
        return result;
      } catch (error) {
        blockApplyFailures += 1;
        currentGateway.discardPreparedState(applying.instrumentId, applying.commitId);
        if (stagedCommits.get(applying.instrumentId)?.commitId === applying.commitId) stagedCommits.delete(applying.instrumentId);
        try { queue.finishFailed(applying.instrumentId, applying.commitId, error?.code ?? error?.message ?? "prepared-state-apply-failed"); } catch {}
        status("failed", applying, { code: error?.code ?? "prepared-state-apply-failed", reason: String(error?.message ?? error) });
        throw error;
      }
    }

    function configureInstruments(snapshot) {
      const result = captureCall(() => runtime.configureInstruments(snapshot));
      // A full production-instruments snapshot is still the authoritative
      // structural/stop-only path. It supersedes transient same-topology state.
      resetPreparedTracking();
      return result;
    }

    function prepareProgram(program) {
      const result = captureCall(() => runtime.prepareProgram(program));
      refreshGatewayState();
      return result;
    }

    function queueAudition(input) {
      const result = captureCall(() => runtime.queueAudition(input));
      refreshGatewayState();
      return result;
    }

    function beginBlock(startFrame, frameCount) {
      // Exactly one Instrument commit is admitted per render block. One commit
      // can fan out only to the bounded Track count, so a burst across many
      // Instruments cannot turn into an unbounded single-block state-read loop.
      // The commit occurs while SynthGateway is still inactive; the base
      // beginBlock then opens the authoritative block and flushes ordered live
      // parameter traffic before K0–K4 lifecycle routing begins.
      applyOnePreparedCommit();
      return runtime.beginBlock(startFrame, frameCount);
    }

    function stop() {
      const structuralPending = runtime.diagnostics().pendingInstrumentSync === true;
      const result = captureCall(() => runtime.stop());
      if (structuralPending) resetPreparedTracking();
      return result;
    }

    function diagnostics() {
      return augmentDiagnostics(runtime.diagnostics());
    }

    function postDiagnostics() {
      runtime.postDiagnostics();
    }

    function handleMessage(data) {
      if (data?.type === "production-prepared-state") {
        try { stagePreparedMessage(data); }
        catch (error) {
          preparedMessageFailures += 1;
          const failed = {
            instrumentId: Number(data?.instrumentId),
            commitId: Number(data?.commitId),
            desiredPresetId: data?.desiredPresetId ?? null,
          };
          status("failed", failed, { code: error?.code ?? "prepared-state-stage-failed", reason: String(error?.message ?? error) });
        }
        return true;
      }
      // The base MessagePort handler calls its closure-local configureInstruments,
      // which may rebuild EngineRegistry/PerformerRegistry/SynthGateway. Route the
      // structural message through the wrapped method so prepared-state ownership
      // captures that exact new gateway rather than retaining a stale registry.
      if (data?.type === "production-instruments") {
        configureInstruments(data.instruments);
        runtime.postDiagnostics();
        return true;
      }
      return runtime.handleMessage(data);
    }

    return Object.freeze({
      ...runtime,
      configureInstruments,
      prepareProgram,
      queueAudition,
      beginBlock,
      stop,
      diagnostics,
      postDiagnostics,
      handleMessage,
      stagePreparedMessage,
    });
  }

  globalThis.BRKTRKProductionAudioRuntime = Object.freeze({ ...baseDomain, createProductionAudioRuntime });
  if (typeof module !== "undefined" && module.exports) module.exports = globalThis.BRKTRKProductionAudioRuntime;
})();