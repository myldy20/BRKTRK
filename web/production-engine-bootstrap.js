(() => {
  "use strict";

  const host = globalThis.BRKTRKProductionEngineHost;
  const audioFacade = typeof audio !== "undefined" ? audio : globalThis.audio;
  const readiness = globalThis.BRKTRKAudioReadiness;
  if (!host || !audioFacade?.init || !readiness?.registerGate || !readiness?.ensureReady) {
    throw new Error("production engine bootstrap requires ProductionEngineHost + canonical AudioReadiness");
  }

  let attachedNode = null;
  let registryRequestCounter = 0;
  let registryProofGeneration = 0;
  let lastRegistryReady = null;
  let lastRegistryFailure = null;
  let forcedRegistryReconciliations = 0;

  const currentProject = () => globalThis.BRKTRKStores?.project?.getState?.()
    ?? (typeof model !== "undefined" ? model : null);
  const normalizedSha = (value) => String(value ?? "").trim().toLowerCase();
  const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
  const delay = (milliseconds) => new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));

  function registrationError(code, message, details = null) {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    return error;
  }

  function invalidateCanonicalReadiness(source, reason) {
    readiness.invalidate?.({ source, reason, supersedeInFlight: false });
  }

  function projectPackageSignature(project) {
    const pool = project?.instrumentPool && typeof project.instrumentPool === "object"
      ? project.instrumentPool
      : {};
    const refs = new Map();
    for (const instrument of Array.isArray(pool) ? pool : Object.values(pool)) {
      const ref = instrument?.engineRef;
      if (!ref?.moduleId || !ref?.engineId) continue;
      const normalized = [
        String(ref.moduleId),
        String(ref.engineId),
        String(ref.resolvedVersion ?? ref.requestedVersion ?? ""),
        normalizedSha(ref.resolvedPackageSha256),
      ];
      refs.set(normalized.join("\u0000"), normalized);
    }
    return JSON.stringify([...refs.values()].sort((left, right) => {
      for (let index = 0; index < left.length; index += 1) {
        const order = compareText(left[index], right[index]);
        if (order !== 0) return order;
      }
      return 0;
    }));
  }

  function projectAssetSignature(project) {
    const assetHost = globalThis.BRKTRKSampleAssetHost;
    if (assetHost?.projectAssetSignature) return assetHost.projectAssetSignature(project);
    const pool = project?.instrumentPool && typeof project.instrumentPool === "object" ? project.instrumentPool : {};
    const hasAssets = (Array.isArray(pool) ? pool : Object.values(pool)).some((instrument) => Boolean(instrument?.assetRef));
    if (hasAssets) {
      throw registrationError(
        "sample-asset-host-unavailable",
        "Project requires sample assets but the sample asset Host is unavailable",
      );
    }
    return "[]";
  }

  function projectRuntimeSignature(project) {
    return JSON.stringify([projectPackageSignature(project), projectAssetSignature(project)]);
  }

  function packageRequirements(project) {
    const pool = project?.instrumentPool && typeof project.instrumentPool === "object"
      ? project.instrumentPool
      : {};
    const requirements = new Map();
    for (const instrument of Array.isArray(pool) ? pool : Object.values(pool)) {
      const ref = instrument?.engineRef;
      if (!ref?.moduleId || !ref?.engineId) continue;
      const status = host.packageStatusFor?.(ref) ?? null;
      if (!status || status.state !== "ready") {
        throw registrationError(
          "worklet-package-host-not-ready",
          `verified package is not Host-ready for ${ref.moduleId}/${ref.engineId}${status?.message ? `: ${status.message}` : ""}`,
          { engineRef: ref, status },
        );
      }
      const requirement = Object.freeze({
        moduleId: String(status.moduleId ?? ref.moduleId),
        engineId: String(status.engineId ?? ref.engineId),
        version: String(status.version ?? ref.resolvedVersion ?? ref.requestedVersion ?? ""),
        packageSha256: normalizedSha(status.packageSha256 ?? ref.resolvedPackageSha256),
        contentSha256: normalizedSha(status.contentSha256),
      });
      if (!requirement.version || !requirement.packageSha256 || !requirement.contentSha256) {
        throw registrationError(
          "worklet-package-host-identity-incomplete",
          `Host-ready package identity is incomplete for ${requirement.moduleId}/${requirement.engineId}`,
          requirement,
        );
      }
      const key = `${requirement.moduleId}\u0000${requirement.engineId}\u0000${requirement.version}\u0000${requirement.packageSha256}`;
      requirements.set(key, requirement);
    }
    return Object.freeze([...requirements.values()].sort((left, right) => {
      for (const key of ["moduleId", "engineId", "version", "packageSha256"]) {
        const order = compareText(left[key], right[key]);
        if (order !== 0) return order;
      }
      return 0;
    }));
  }

  function requirementSignature(requirements) {
    return JSON.stringify(requirements.map((entry) => [
      entry.moduleId,
      entry.engineId,
      entry.version,
      entry.packageSha256,
      entry.contentSha256,
    ]));
  }

  function registryMatches(requirements, packages) {
    if (!Array.isArray(packages)) return false;
    return requirements.every((required) => packages.some((actual) => (
      String(actual?.moduleId ?? "") === required.moduleId
      && String(actual?.engineId ?? "") === required.engineId
      && String(actual?.version ?? "") === required.version
      && normalizedSha(actual?.packageSha256) === required.packageSha256
      && normalizedSha(actual?.contentSha256) === required.contentSha256
    )));
  }

  // A required package whose registration threw in this Worklet scope. Waiting
  // cannot repair that: the same AudioWorkletGlobalScope will not evaluate the
  // module again, so the proof fails at once with the engine's own reason.
  function failedRegistrationFor(requirements, failures) {
    if (!Array.isArray(failures) || failures.length === 0) return null;
    for (const required of requirements) {
      const failure = failures.find((candidate) => (
        String(candidate?.moduleId ?? "") === required.moduleId
        && String(candidate?.engineId ?? "") === required.engineId
        && String(candidate?.version ?? "") === required.version
        && normalizedSha(candidate?.packageSha256) === required.packageSha256
      ));
      if (failure) return Object.freeze({ requirement: required, failure });
    }
    return null;
  }

  function probeWorkletRegistry(node, timeoutMs) {
    if (!node?.port?.postMessage || !node.port.addEventListener || !node.port.removeEventListener) {
      return Promise.reject(registrationError("worklet-package-registry-port-unavailable", "AudioWorkletNode MessagePort cannot prove package registration"));
    }
    const requestId = `brktrk-package-registry-${++registryRequestCounter}`;
    return new Promise((resolve) => {
      let timer = 0;
      const cleanup = () => {
        globalThis.clearTimeout(timer);
        node.port.removeEventListener("message", onMessage);
      };
      const onMessage = (event) => {
        const message = event?.data;
        if (message?.type !== "production-package-registry" || message.requestId !== requestId) return;
        cleanup();
        resolve(Object.freeze({
          requestId,
          packages: Array.isArray(message.packages) ? message.packages : [],
          pendingInstrumentSync: message.pendingInstrumentSync === true,
          transportActive: message.transportActive === true,
          registrationFailures: Array.isArray(message.registrationFailures) ? message.registrationFailures : [],
        }));
      };
      node.port.addEventListener("message", onMessage);
      node.port.start?.();
      timer = globalThis.setTimeout(() => {
        cleanup();
        resolve(null);
      }, timeoutMs);
      node.port.postMessage({ type: "production-package-registry-request", requestId });
    });
  }

  async function awaitWorkletPackages({
    node = audioFacade.node,
    project = currentProject(),
    timeoutMs = 4000,
    probeTimeoutMs = 250,
    pollMs = 20,
  } = {}) {
    const requirements = packageRequirements(project);
    const signature = requirementSignature(requirements);
    const proofGeneration = ++registryProofGeneration;
    const hadAuthoritativeProof = Boolean(lastRegistryReady) || readiness.snapshot().ready === true;
    lastRegistryReady = null;
    lastRegistryFailure = null;
    if (hadAuthoritativeProof) {
      invalidateCanonicalReadiness("production-worklet-package-proof", "worklet-package-proof-invalidated");
    }

    // A Project with no production Instruments has no package identity to prove.
    // Requiring a MessagePort acknowledgement for the empty set couples ordinary
    // browser audio lifecycle/resume to a production registry that is irrelevant
    // to that Project and can turn "0 packages required" into a false timeout.
    if (requirements.length === 0) {
      const ready = Object.freeze({
        node,
        signature,
        packages: Object.freeze([]),
        requestId: null,
        probes: 0,
        pendingInstrumentSync: false,
        reconciledActiveRegistry: false,
      });
      lastRegistryReady = ready;
      lastRegistryFailure = null;
      return ready;
    }

    if (!node?.port) throw registrationError("worklet-package-registry-port-unavailable", "AudioWorkletNode is unavailable for package registration proof");

    const totalTimeout = Math.max(50, Math.min(15000, Number(timeoutMs) || 4000));
    const probeTimeout = Math.max(20, Math.min(1000, Number(probeTimeoutMs) || 250));
    const pollDelay = Math.max(0, Math.min(250, Number(pollMs) || 20));
    const deadline = Date.now() + totalTimeout;
    let lastObserved = Object.freeze([]);
    let lastPendingInstrumentSync = false;
    let lastTransportActive = false;
    let probes = 0;
    let reconciledActiveRegistry = false;

    while (Date.now() < deadline) {
      if (proofGeneration !== registryProofGeneration) {
        throw registrationError("worklet-package-registration-superseded", "Worklet package registration proof was superseded by a newer request");
      }
      const remaining = deadline - Date.now();
      const response = await probeWorkletRegistry(node, Math.max(1, Math.min(probeTimeout, remaining)));
      probes += 1;
      if (proofGeneration !== registryProofGeneration) {
        throw registrationError("worklet-package-registration-superseded", "Worklet package registration proof was superseded by a newer request");
      }
      if (response) {
        lastObserved = Object.freeze(response.packages.map((entry) => Object.freeze({ ...entry })));
        lastPendingInstrumentSync = response.pendingInstrumentSync;
        lastTransportActive = response.transportActive;
        if (!lastPendingInstrumentSync && registryMatches(requirements, lastObserved)) {
          const ready = Object.freeze({
            node,
            signature,
            packages: lastObserved,
            requestId: response.requestId,
            probes,
            pendingInstrumentSync: false,
            reconciledActiveRegistry,
          });
          lastRegistryReady = ready;
          lastRegistryFailure = null;
          return ready;
        }

        const failedRegistration = failedRegistrationFor(requirements, response.registrationFailures);
        if (failedRegistration) {
          const { requirement, failure } = failedRegistration;
          const details = Object.freeze({
            requirements,
            observed: lastObserved,
            failedPackage: requirement,
            failure: Object.freeze({ code: String(failure.code ?? ""), message: String(failure.message ?? "") }),
            probes,
            timeoutMs: totalTimeout,
          });
          if (proofGeneration === registryProofGeneration) {
            lastRegistryReady = null;
            lastRegistryFailure = details;
          }
          throw registrationError(
            "worklet-package-registration-failed",
            `${requirement.moduleId}/${requirement.engineId}@${requirement.version} could not start in the AudioWorklet: ${String(failure.message ?? failure.code ?? "registration failed")}`,
            details,
          );
        }

        // A verified package can finish addModule() after the production runtime
        // has already built an empty EngineRegistry from the unchanged Project.
        // Waiting cannot repair that stale structural snapshot. While transport is
        // stopped, re-send the exact current Instrument snapshot once so the
        // Worklet rebuilds its active registry from the now-registered runtime.
        if (!reconciledActiveRegistry
          && !lastPendingInstrumentSync
          && !lastTransportActive) {
          reconciledActiveRegistry = true;
          host.syncProject?.(project, { force: true });
          node.port.postMessage({ type: "production-diagnostics-request" });
          forcedRegistryReconciliations += 1;
        }
      }
      if (Date.now() < deadline && pollDelay > 0) await delay(Math.min(pollDelay, Math.max(1, deadline - Date.now())));
    }

    const details = Object.freeze({
      requirements,
      observed: lastObserved,
      pendingInstrumentSync: lastPendingInstrumentSync,
      transportActive: lastTransportActive,
      probes,
      timeoutMs: totalTimeout,
      reconciledActiveRegistry,
    });
    if (proofGeneration === registryProofGeneration) {
      lastRegistryReady = null;
      lastRegistryFailure = details;
    }
    throw registrationError(
      "worklet-package-registration-timeout",
      `AudioWorklet did not acknowledge ${requirements.length} exact active production package${requirements.length === 1 ? "" : "s"} with current Instrument state within ${totalTimeout}ms`,
      details,
    );
  }

  function isWorkletReady(project = currentProject(), node = audioFacade.node) {
    try {
      const signature = requirementSignature(packageRequirements(project));
      return Boolean(lastRegistryReady && lastRegistryReady.node === node && lastRegistryReady.signature === signature);
    } catch {
      return false;
    }
  }

  function registrationSnapshot() {
    return Object.freeze({
      ready: Boolean(lastRegistryReady),
      readySignature: lastRegistryReady?.signature ?? null,
      packageCount: lastRegistryReady?.packages?.length ?? 0,
      requestId: lastRegistryReady?.requestId ?? null,
      probes: lastRegistryReady?.probes ?? 0,
      reconciledActiveRegistry: lastRegistryReady?.reconciledActiveRegistry ?? false,
      forcedRegistryReconciliations,
      failure: lastRegistryFailure,
      generation: registryProofGeneration,
    });
  }

  async function attachCurrentAudio({ maxProjectRechecks = 4 } = {}) {
    if (!audioFacade.context || !audioFacade.node) return audioFacade;
    const recheckLimit = Math.max(1, Math.min(8, Number(maxProjectRechecks) || 4));

    for (let attempt = 1; attempt <= recheckLimit; attempt += 1) {
      const project = currentProject();
      const projectSignature = projectRuntimeSignature(project);
      // Capture a one-shot processor crash even if it occurs while packages load.
      // This attaches diagnostic listeners only; attachNode still owns project sync.
      host.observeNodeFailures(audioFacade.node, audioFacade.context);
      await host.prepareContext(audioFacade.context, project);
      await host.syncProjectAssets?.(project, { node: audioFacade.node });
      if (attachedNode !== audioFacade.node) {
        host.attachNode(audioFacade.node, audioFacade.context, project);
        attachedNode = audioFacade.node;
      } else {
        // Same-node resume/readiness must not mutate structural Instrument state.
        // If prepareContext registered a newly required runtime, the correlated
        // registry proof below will observe the mismatch and perform one bounded
        // stopped-only reconciliation. A matching active registry is read-only.
        audioFacade.node.port.postMessage({ type: "production-diagnostics-request" });
      }
      await awaitWorkletPackages({ node: audioFacade.node, project });

      const latestProject = currentProject();
      const latestSignature = projectRuntimeSignature(latestProject);
      if (latestSignature === projectSignature) {
        host.registerDiagnostics();
        return audioFacade;
      }
      lastRegistryReady = null;
      invalidateCanonicalReadiness("production-project-recheck", "project-package-requirements-changed");
    }

    throw registrationError(
      "worklet-package-project-unstable",
      `Project package requirements changed during ${recheckLimit} consecutive audio readiness attempts`,
      { attempts: recheckLimit, projectSignature: projectRuntimeSignature(currentProject()) },
    );
  }

  function audition({ track, instrumentId, note = 48, velocity = 100, durationMs = 240 } = {}) {
    if (!audioFacade.ready || !readiness.snapshot().ready || !audioFacade.context || !audioFacade.node?.port) return false;
    const project = currentProject();
    const selectedTrack = Number(track);
    const selectedInstrument = Number(instrumentId);
    const pitch = Number(note);
    if (!Number.isInteger(selectedTrack) || selectedTrack < 0 || selectedTrack >= 8) throw new RangeError("production audition track must be 0..7");
    if (!Number.isInteger(selectedInstrument) || selectedInstrument < 0 || selectedInstrument > 255) throw new RangeError("production audition instrumentId must be 00–FF");
    if (!Number.isFinite(pitch) || pitch < 0 || pitch > 127) throw new RangeError("production audition note must be 0..127");
    const instrument = project?.instrumentPool?.[selectedInstrument];
    if (!instrument?.engineRef?.moduleId || !instrument?.engineRef?.engineId) return false;
    const packageStatus = host.packageStatusFor?.(instrument.engineRef) ?? null;
    if (!packageStatus || packageStatus.state !== "ready" || !isWorkletReady(project, audioFacade.node)) return false;
    const milliseconds = Math.max(40, Math.min(2000, Number(durationMs) || 240));
    const durationFrames = Math.max(1, Math.round(audioFacade.context.sampleRate * milliseconds / 1000));
    audioFacade.node.port.postMessage({
      type: "production-audition",
      track: selectedTrack,
      instrumentId: selectedInstrument,
      note: pitch,
      velocity: Math.max(1, Math.min(127, Math.round(Number(velocity) || 100))),
      durationFrames,
    });
    return Object.freeze({ track: selectedTrack, instrumentId: selectedInstrument, note: pitch, durationFrames });
  }

  const unregisterReadyGate = readiness.registerGate("production-engine-packages", async () => {
    await attachCurrentAudio();
  });

  // The production bootstrap is loaded after AudioReadiness in the ordered asset
  // chain. If a graph already exists, rerun the canonical readiness transaction
  // so the newly registered production gate can prove this exact node before UI
  // readiness or audition is exposed.
  if (audioFacade.ready && audioFacade.context && audioFacade.node) {
    readiness.ensureReady({ source: "production-engine-late-bootstrap" })
      .catch((error) => console.warn("Production engine late bootstrap failed", error));
  }

  globalThis.BRKTRKProductionEngineBootstrap = Object.freeze({
    currentProject,
    attachCurrentAudio,
    awaitWorkletPackages,
    isWorkletReady,
    packageRequirements,
    projectPackageSignature,
    projectAssetSignature,
    projectRuntimeSignature,
    registrationSnapshot,
    unregisterReadyGate,
    audition,
  });
})();