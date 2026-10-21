(() => {
  "use strict";

  const baseRuntime = globalThis.BRKTRKBrkSynthAbiV1Runtime
    ?? (typeof module !== "undefined" && module.exports ? require("./brk-synth-abi-v1-worklet.js") : null);
  if (!baseRuntime?.createPerformerFactory || !baseRuntime?.BrkSynthAbiError) {
    throw new Error("BRK runtime lifetime extension requires BRK Synth ABI-v1 runtime");
  }

  const records = new Map();
  const livePerformers = new Map();
  const normalizedSha = (value) => String(value ?? "").trim().toLowerCase();
  const runtimeKey = (entry) => `${String(entry?.moduleId ?? "")}\u0000${String(entry?.engineId ?? "")}\u0000${String(entry?.version ?? "")}\u0000${normalizedSha(entry?.packageSha256)}`;

  function registerModuleRuntime({ entry, manifest, module: runtimeModule } = {}) {
    if (!entry || !manifest || !runtimeModule) throw new TypeError("registerModuleRuntime requires entry, manifest and Emscripten module");
    const reportedAbi = Number(runtimeModule._brk_abi_version?.());
    if (reportedAbi !== baseRuntime.ABI_VERSION) {
      throw new baseRuntime.BrkSynthAbiError("abi-version", `runtime reports ABI ${reportedAbi}, expected ${baseRuntime.ABI_VERSION}`);
    }
    if (!entry.moduleId || !entry.engineId || !entry.version) {
      throw new baseRuntime.BrkSynthAbiError("runtime-identity", "registered runtime requires moduleId/engineId/version");
    }
    const key = runtimeKey(entry);
    if (records.has(key)) {
      throw new baseRuntime.BrkSynthAbiError("duplicate-runtime", `runtime ${entry.moduleId}/${entry.engineId}@${entry.version}#${normalizedSha(entry.packageSha256) || "unqualified"} already registered`);
    }
    const record = Object.freeze({
      key,
      entry: Object.freeze({ ...entry }),
      manifest: Object.freeze({ ...manifest }),
      module: runtimeModule,
      // This extension owns registration in the production Worklet -
      // audio-worklet.js imports it straight after the base runtime and it
      // replaces the global API - so a record built here is the only record
      // the host ever sees. Reading descriptors in the base runtime alone
      // would be dead code in production. Delegated rather than reimplemented
      // so there is one reader of the ABI struct layout.
      abiDescriptors: typeof baseRuntime.readModuleDescriptors === "function"
        ? baseRuntime.readModuleDescriptors(runtimeModule, manifest?.engineIndex)
        : null,
    });
    records.set(key, record);
    livePerformers.set(key, 0);
    baseRuntime.clearRegistrationFailure?.(entry);
    return record;
  }

  function createPerformerFactory(record, options = {}) {
    if (!record?.key || records.get(record.key) !== record) {
      throw new baseRuntime.BrkSynthAbiError("runtime-unregistered", "performer factory requires a currently registered runtime record");
    }
    const baseFactory = baseRuntime.createPerformerFactory(record, options);
    const key = record.key;

    function makePerformer(args = {}) {
      if (records.get(key) !== record) {
        throw new baseRuntime.BrkSynthAbiError("runtime-unregistered", `runtime ${record.entry.moduleId}/${record.entry.engineId}@${record.entry.version} is no longer registered`);
      }
      const performer = baseFactory(args);
      livePerformers.set(key, Number(livePerformers.get(key) ?? 0) + 1);
      let destroyed = false;

      function destroy() {
        if (destroyed) return;
        performer.destroy?.();
        destroyed = true;
        livePerformers.set(key, Math.max(0, Number(livePerformers.get(key) ?? 0) - 1));
      }

      function diagnostics() {
        return Object.freeze({
          ...(performer.diagnostics?.() ?? {}),
          runtimeLivePerformers: Number(livePerformers.get(key) ?? 0),
        });
      }

      return Object.freeze({ ...performer, destroy, diagnostics });
    }

    makePerformer.diagnostics = () => Object.freeze({
      ...(baseFactory.diagnostics?.() ?? {}),
      runtimeLivePerformers: Number(livePerformers.get(key) ?? 0),
    });
    return Object.freeze(makePerformer);
  }

  function unregisterModuleRuntime(entry) {
    const key = runtimeKey(entry);
    const record = records.get(key) ?? null;
    if (!record) return false;
    const live = Number(livePerformers.get(key) ?? 0);
    if (live > 0) {
      throw new baseRuntime.BrkSynthAbiError(
        "runtime-in-use",
        `runtime ${record.entry.moduleId}/${record.entry.engineId}@${record.entry.version} still owns ${live} live performer${live === 1 ? "" : "s"}`,
        { key, livePerformers: live },
      );
    }
    records.delete(key);
    livePerformers.delete(key);
    return true;
  }

  const runtimeRecords = () => Object.freeze([...records.values()]);
  const recordFor = (entry) => records.get(runtimeKey(entry)) ?? null;
  const runtimeLifetimeSnapshot = () => Object.freeze(runtimeRecords().map((record) => Object.freeze({
    key: record.key,
    moduleId: record.entry.moduleId,
    engineId: record.entry.engineId,
    version: record.entry.version,
    packageSha256: record.entry.packageSha256 ?? null,
    livePerformers: Number(livePerformers.get(record.key) ?? 0),
    wasmMemoryBytes: record.module?.HEAPU8?.buffer?.byteLength ?? null,
  })));

  const api = Object.freeze({
    ...baseRuntime,
    registerModuleRuntime,
    createPerformerFactory,
    unregisterModuleRuntime,
    runtimeRecords,
    recordFor,
    runtimeLifetimeSnapshot,
  });
  globalThis.BRKTRKBrkSynthAbiV1Runtime = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();