(() => {
  "use strict";

  const storeTypes = globalThis.BRKTRKStoreTypes
    ?? (typeof require === "function" ? require("./stores.js") : null);
  const instrumentDomain = globalThis.BRKTRKProductionInstrumentDomain
    ?? (typeof require === "function" ? require("./production-instrument-domain.js") : null);
  if (!storeTypes || !instrumentDomain) throw new Error("Production Instrument preset domain requires Store + Instrument domains");

  const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));

  function normalizePresetRef(value, instrument) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Production Instrument presetRef must be an object");
    const id = String(value.id ?? "").trim();
    if (!id) throw new TypeError("Production Instrument presetRef.id must be a non-empty string");
    return Object.freeze({
      id,
      name: String(value.name ?? id).trim() || id,
      bank: value.bank == null ? null : String(value.bank),
      origin: value.origin == null ? null : String(value.origin),
      readOnly: value.readOnly === true,
      moduleId: String(value.moduleId ?? instrument.engineRef.moduleId),
      engineId: String(value.engineId ?? instrument.engineRef.engineId),
      version: String(value.version ?? instrument.engineRef.resolvedVersion ?? instrument.engineRef.requestedVersion ?? ""),
      packageSha256: String(value.packageSha256 ?? instrument.engineRef.resolvedPackageSha256 ?? "").toLowerCase() || null,
    });
  }

  function createDomain(projectStore) {
    if (!projectStore || projectStore.owner !== "project") throw new TypeError("Instrument preset domain requires ProjectStore");
    const project = projectStore.getState();

    function apply(instrumentIdValue, preset, metadata = {}) {
      const instrumentId = instrumentDomain.instrumentId(instrumentIdValue);
      const instrument = project.instrumentPool?.[instrumentId];
      if (!instrument) throw new Error(`Production Instrument ${instrumentId} does not exist`);
      if (!preset || typeof preset !== "object" || preset.applicable !== true) throw new TypeError("Only a verified applicable engine preset can be applied");
      const patchState = instrumentDomain.normalizePatchState(preset.patchState);
      const parameterSnapshot = instrumentDomain.normalizeParameterSnapshot(preset.parameterSnapshot);
      const presetRef = normalizePresetRef({
        id: preset.id,
        name: preset.name,
        bank: preset.bank,
        origin: preset.origin,
        readOnly: preset.readOnly,
        moduleId: instrument.engineRef.moduleId,
        engineId: instrument.engineRef.engineId,
        version: instrument.engineRef.resolvedVersion ?? instrument.engineRef.requestedVersion,
        packageSha256: instrument.engineRef.resolvedPackageSha256,
      }, instrument);
      const before = Object.freeze({
        patchState: clone(instrument.patchState),
        parameterSnapshot: clone(instrument.parameterSnapshot),
        presetRef: clone(instrument.presetRef),
      });
      const after = Object.freeze({ patchState: clone(patchState), parameterSnapshot: clone(parameterSnapshot), presetRef: clone(presetRef) });
      const changeSet = storeTypes.createProjectChangeSet({
        subtype: "instrument.preset",
        target: `project.instrumentPool.${instrumentId}.preset`,
        path: ["instrumentPool", instrumentId],
        before,
        after,
        affectsPlayback: true,
        persistsProject: true,
        renderTargets: ["instrument.context"],
        source: metadata.source,
        transaction: { instrumentId, presetId: preset.id, safeBoundaryRequired: true },
      });
      if (JSON.stringify(before) === JSON.stringify(after)) {
        return Object.freeze({ value: after, before, after, mutated: false, changeSet, metadata: clone(metadata) });
      }
      instrument.patchState = clone(patchState);
      instrument.parameterSnapshot = clone(parameterSnapshot);
      instrument.presetRef = clone(presetRef);
      projectStore.publish(changeSet, ["project", "persistence", "audio", "render"]);
      return Object.freeze({ value: after, before, after, mutated: true, changeSet, metadata: clone(metadata) });
    }

    return Object.freeze({ apply });
  }

  function install(projectStore) {
    if (projectStore.instrumentPresets) return projectStore.instrumentPresets;
    const domain = createDomain(projectStore);
    Object.defineProperty(projectStore, "instrumentPresets", { value: domain, configurable: false, enumerable: true, writable: false });
    return domain;
  }

  const api = Object.freeze({ install, createDomain, normalizePresetRef });
  globalThis.BRKTRKProjectInstrumentPreset = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();