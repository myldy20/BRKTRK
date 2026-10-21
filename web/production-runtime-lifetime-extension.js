(() => {
  "use strict";

  const baseDomain = globalThis.BRKTRKProductionAudioRuntime
    ?? (typeof module !== "undefined" && module.exports ? require("./production-audio-runtime.js") : null);
  const abiRuntime = globalThis.BRKTRKBrkSynthAbiV1Runtime;
  if (!baseDomain?.createProductionAudioRuntime || !abiRuntime?.unregisterModuleRuntime) {
    throw new Error("Production runtime lifetime extension requires production audio + retireable BRK runtime registry");
  }

  const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
  const normalizedSha = (value) => String(value ?? "").trim().toLowerCase();
  const versionForRef = (ref) => String(ref?.resolvedVersion ?? ref?.requestedVersion ?? "").trim();
  const recordIdentity = (record) => Object.freeze({
    moduleId: String(record?.entry?.moduleId ?? ""),
    engineId: String(record?.entry?.engineId ?? ""),
    version: String(record?.entry?.version ?? ""),
    packageSha256: normalizedSha(record?.entry?.packageSha256) || null,
  });

  function projectEngineRefs(snapshot) {
    const result = [];
    for (const instrument of Object.values(snapshot && typeof snapshot === "object" ? snapshot : {})) {
      const ref = instrument?.engineRef;
      if (!ref?.moduleId || !ref?.engineId) continue;
      result.push(Object.freeze({
        moduleId: String(ref.moduleId),
        engineId: String(ref.engineId),
        version: versionForRef(ref),
        packageSha256: normalizedSha(ref.resolvedPackageSha256),
      }));
    }
    return Object.freeze(result);
  }

  function recordMatchesRef(record, ref) {
    return ref.moduleId === record?.entry?.moduleId
      && ref.engineId === record?.entry?.engineId
      && (!ref.version || ref.version === String(record?.entry?.version ?? ""));
  }

  function recordRequired(record, refs, runtimeRecords = abiRuntime.runtimeRecords()) {
    const recordSha = normalizedSha(record?.entry?.packageSha256);
    return refs.some((ref) => {
      if (!recordMatchesRef(record, ref)) return false;
      if (ref.packageSha256) return normalizedSha(ref.packageSha256) === recordSha;

      // Legacy schema-v4 Projects may contain an engineRef without an exact
      // package SHA. Preserve that runtime only while it resolves to exactly
      // one already-registered candidate. If same-semver/catalog churn leaves
      // more than one possible runtime, fail closed and let the stopped
      // structural boundary retire the ambiguous set rather than silently
      // choosing one or retaining every historical SHA forever.
      const matching = runtimeRecords.filter((candidate) => recordMatchesRef(candidate, ref));
      return matching.length === 1 && normalizedSha(matching[0]?.entry?.packageSha256) === recordSha;
    });
  }

  function createProductionAudioRuntime(options = {}) {
    const postMessage = typeof options.postMessage === "function" ? options.postMessage : () => {};
    // The base runtime posts diagnostics for transport/assets/audition too,
    // independently of this extension's structural/retirement messages.
    // Enrich EVERY outgoing diagnostic snapshot at the common MessagePort
    // boundary, or a later base-only message can erase runtimeLifetime on the
    // Host and give G7 a false "runtime still present" failure.
    let baseRuntime = null;
    const forwardMessage = (message) => {
      if (message?.type === "production-diagnostics" && baseRuntime) {
        postMessage({ ...message, snapshot: diagnostics() });
      } else {
        postMessage(message);
      }
    };
    baseRuntime = baseDomain.createProductionAudioRuntime({ ...options, postMessage: forwardMessage });
    let desiredInstruments = {};
    let retirementPasses = 0;
    let retiredRuntimeCount = 0;
    let retirementFailures = 0;
    let lastRetired = Object.freeze([]);

    function retireUnusedRuntimes(snapshot) {
      const state = baseRuntime.diagnostics?.() ?? {};
      if (state.transportActive === true || state.blockActive === true) return Object.freeze([]);
      const refs = projectEngineRefs(snapshot);
      const runtimeRecords = abiRuntime.runtimeRecords();
      const retired = [];
      for (const record of runtimeRecords) {
        if (recordRequired(record, refs, runtimeRecords)) continue;
        try {
          if (!abiRuntime.unregisterModuleRuntime(record.entry)) continue;
          retired.push(recordIdentity(record));
        } catch (error) {
          retirementFailures += 1;
          postMessage({
            type: "production-engine-error",
            code: error?.code ?? "runtime-retirement-failed",
            message: String(error?.message ?? error),
            details: error?.details ?? null,
          });
        }
      }
      retirementPasses += 1;
      retiredRuntimeCount += retired.length;
      lastRetired = Object.freeze(retired);
      if (retired.length > 0) postMessage({ type: "production-runtime-retired", packages: lastRetired });
      return lastRetired;
    }

    function rebuildWithoutRetired(snapshot, retired) {
      if (!retired?.length) return false;
      const reapplied = baseRuntime.configureInstruments(snapshot);
      if (reapplied !== true) {
        throw new baseDomain.ProductionProgramError(
          "runtime-retirement-rebuild-boundary",
          "retired runtime registry could not be rebuilt at the stopped structural boundary",
          { retired },
        );
      }
      return true;
    }

    function configureInstruments(snapshot) {
      desiredInstruments = clone(snapshot ?? {});
      const applied = baseRuntime.configureInstruments(desiredInstruments);
      if (applied !== true) return false;
      const retired = retireUnusedRuntimes(desiredInstruments);
      rebuildWithoutRetired(desiredInstruments, retired);
      return true;
    }

    function stop() {
      const result = baseRuntime.stop();
      const retired = retireUnusedRuntimes(desiredInstruments);
      rebuildWithoutRetired(desiredInstruments, retired);
      postDiagnostics();
      return result;
    }

    function diagnostics() {
      const base = baseRuntime.diagnostics?.() ?? {};
      return Object.freeze({
        ...base,
        runtimeLifetime: Object.freeze({
          registered: abiRuntime.runtimeRecords().length,
          retirementPasses,
          retiredRuntimeCount,
          retirementFailures,
          lastRetired,
          runtimes: abiRuntime.runtimeLifetimeSnapshot?.() ?? Object.freeze([]),
        }),
      });
    }

    function postDiagnostics() {
      postMessage({ type: "production-diagnostics", snapshot: diagnostics() });
    }

    function handleMessage(data) {
      if (data?.type === "production-instruments") {
        try { configureInstruments(data.instruments); }
        catch (error) {
          postMessage({ type: "production-engine-error", code: error?.code ?? "runtime-retirement-error", message: String(error?.message ?? error), details: error?.details ?? null });
        }
        postDiagnostics();
        return true;
      }
      if (data?.type === "production-diagnostics-request") {
        postDiagnostics();
        return true;
      }
      return baseRuntime.handleMessage(data);
    }

    return Object.freeze({
      ...baseRuntime,
      configureInstruments,
      stop,
      diagnostics,
      postDiagnostics,
      handleMessage,
      retireUnusedRuntimes: () => retireUnusedRuntimes(desiredInstruments),
    });
  }

  const api = Object.freeze({ ...baseDomain, projectEngineRefs, recordRequired, createProductionAudioRuntime });
  globalThis.BRKTRKProductionAudioRuntime = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
