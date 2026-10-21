(() => {
  "use strict";

  const PRESET_INDEX_SCHEMA = "brk-preset-index-v1";
  const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));

  class EnginePresetError extends Error {
    constructor(code, message, details = {}) {
      super(message);
      this.name = "EnginePresetError";
      this.code = String(code || "engine-preset-error");
      this.details = Object.freeze({ ...details });
    }
  }

  const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const text = (value, label) => {
    const result = typeof value === "string" ? value.trim() : "";
    if (!result) throw new EnginePresetError("invalid-field", `${label} must be a non-empty string`);
    return result;
  };
  const integer = (value, label, min = 0) => {
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < min) throw new EnginePresetError("invalid-field", `${label} must be an integer >= ${min}`);
    return result;
  };

  function descriptorJson(loaded, path, label) {
    const bytes = loaded?.files?.[path];
    if (!(bytes instanceof Uint8Array)) throw new EnginePresetError("preset-descriptor-missing", `${label} descriptor ${path} is absent from verified package`);
    try { return JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new EnginePresetError("preset-descriptor-json", `${label} descriptor ${path} is invalid JSON`); }
  }

  function resolvePackageRelative(indexPathValue, stateFileValue) {
    const indexPath = text(indexPathValue, "preset descriptor path");
    const stateFile = text(stateFileValue, "preset stateFile");
    if (stateFile.includes("\\") || stateFile.startsWith("/") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(stateFile)) {
      throw new EnginePresetError("preset-state-path", `preset stateFile must stay package-relative: ${stateFile}`);
    }
    const base = indexPath.split("/").slice(0, -1);
    const output = [...base];
    for (const segment of stateFile.split("/")) {
      if (!segment || segment === ".") continue;
      if (segment === "..") {
        if (!output.length) throw new EnginePresetError("preset-state-path", `preset stateFile escapes package root: ${stateFile}`);
        output.pop();
      } else output.push(segment);
    }
    if (!output.length) throw new EnginePresetError("preset-state-path", `preset stateFile resolves to package root: ${stateFile}`);
    return output.join("/");
  }

  function base64(bytes) {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("preset state must be Uint8Array");
    if (typeof Buffer !== "undefined") return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
    let binary = "";
    const chunk = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunk) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
    if (typeof btoa !== "function") throw new EnginePresetError("base64-unavailable", "browser cannot encode verified preset state");
    return btoa(binary);
  }

  function normalizeSnapshot(value, parameters, label) {
    if (!object(value)) return Object.freeze({ ready: false, reason: "parameter-snapshot-missing", snapshot: null });
    const expected = new Set(parameters.map((parameter) => String(parameter.id)));
    const snapshot = {};
    for (const [rawKey, rawValue] of Object.entries(value)) {
      const key = String(rawKey).trim();
      if (!expected.has(key)) throw new EnginePresetError("preset-parameter-unknown", `${label} contains unknown stable parameter ${key}`);
      const numeric = Number(rawValue);
      if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1) throw new EnginePresetError("preset-parameter-value", `${label}.${key} must be normalized to [0,1]`);
      snapshot[key] = numeric;
    }
    const missing = [...expected].filter((key) => !Object.hasOwn(snapshot, key));
    if (missing.length) return Object.freeze({ ready: false, reason: "parameter-snapshot-incomplete", missing: Object.freeze(missing), snapshot: null });
    return Object.freeze({ ready: true, reason: null, snapshot: Object.freeze(snapshot) });
  }

  function createLibrary(loaded) {
    const manifest = loaded?.manifest;
    const entry = loaded?.entry;
    const indexPath = String(manifest?.descriptors?.presets ?? "").trim();
    if (!indexPath) return null;
    const index = descriptorJson(loaded, indexPath, "preset index");
    if (!object(index) || index.schema !== PRESET_INDEX_SCHEMA) throw new EnginePresetError("preset-index-schema", `unsupported preset index schema ${String(index?.schema ?? "missing")}`);
    if (index.moduleId && index.moduleId !== entry?.moduleId) throw new EnginePresetError("preset-index-identity", "preset index moduleId disagrees with verified package");
    if (index.engineId && index.engineId !== entry?.engineId) throw new EnginePresetError("preset-index-identity", "preset index engineId disagrees with verified package");
    const stateSchemaVersion = integer(index.stateSchemaVersion ?? manifest.stateSchemaVersion, "preset index stateSchemaVersion");
    if (stateSchemaVersion !== Number(manifest.stateSchemaVersion)) throw new EnginePresetError("preset-state-schema", "preset index state schema disagrees with package manifest");
    const stateBytes = integer(index.stateBytes ?? manifest.stateBytes, "preset index stateBytes", 1);
    if (Number.isInteger(Number(manifest.stateBytes)) && stateBytes !== Number(manifest.stateBytes)) throw new EnginePresetError("preset-state-size", "preset index stateBytes disagrees with package manifest");
    const rows = Array.isArray(index.presets) ? index.presets : [];
    if (index.presetCount !== undefined && Number(index.presetCount) !== rows.length) throw new EnginePresetError("preset-index-count", "preset index count is inconsistent");
    const parameters = Array.isArray(manifest.parameters) ? manifest.parameters : [];
    const ids = new Set();
    const presets = rows.map((row, offset) => {
      if (!object(row)) throw new EnginePresetError("preset-index-entry", `preset ${offset} must be an object`);
      const id = text(row.id, `presets[${offset}].id`);
      if (ids.has(id)) throw new EnginePresetError("preset-index-duplicate", `duplicate preset id ${id}`);
      ids.add(id);
      const name = text(row.name ?? row.label, `presets[${offset}].name`);
      const stateFile = text(row.stateFile, `presets[${offset}].stateFile`);
      const statePath = resolvePackageRelative(indexPath, stateFile);
      const bytes = loaded?.files?.[statePath];
      if (!(bytes instanceof Uint8Array)) throw new EnginePresetError("preset-state-missing", `verified package is missing preset state ${statePath}`);
      if (bytes.byteLength !== stateBytes) throw new EnginePresetError("preset-state-size", `preset ${id} contains ${bytes.byteLength} bytes, expected ${stateBytes}`);
      const normalized = normalizeSnapshot(row.parameterSnapshot, parameters, `preset ${id} parameterSnapshot`);
      return Object.freeze({
        id,
        name,
        bank: String(row.bank ?? "Factory"),
        origin: String(row.origin ?? "engine"),
        profile: row.profile == null ? null : String(row.profile),
        readOnly: row.readOnly !== false,
        stateFile,
        statePath,
        applicable: normalized.ready,
        unavailableReason: normalized.reason,
        missingParameters: normalized.missing ?? Object.freeze([]),
        patchState: Object.freeze({ schemaVersion: stateSchemaVersion, encoding: "base64", data: base64(bytes) }),
        parameterSnapshot: normalized.snapshot,
        source: clone(row.source ?? null),
      });
    });
    return Object.freeze({
      schema: PRESET_INDEX_SCHEMA,
      stateSchemaVersion,
      stateBytes,
      presetCount: presets.length,
      presets: Object.freeze(presets),
    });
  }

  const api = Object.freeze({ PRESET_INDEX_SCHEMA, EnginePresetError, resolvePackageRelative, normalizeSnapshot, createLibrary });
  globalThis.BRKTRKEnginePresetDomain = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();