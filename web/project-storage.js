(() => {
  const CURRENT_SCHEMA_VERSION = 5;
  const PRODUCTION_INSTRUMENT_SCHEMA_VERSION = 4;
  const PRE_V5_PARAMETER_EVENTS_EXTENSION = "org.myldydesign.brktrk.pre-v5-phrase-parameter-events-unknown";
  const STORAGE_KEY = "brktrk-web-v2-alpha-1";
  const STAGING_KEY = `${STORAGE_KEY}:staging`;
  const RECOVERY_PREFIX = `${STORAGE_KEY}:recovery:`;
  const RETIRED_PREVIEW_EXTENSION_KEYS = Object.freeze([
    "org.myldydesign.brktrk.preview-instruments-v2",
    "org.myldydesign.brktrk.pre-v4-instrument-pool-unknown",
  ]);
  // One immutable policy for portable files and browser canonical migration.
  const RESERVED_STRUCTURAL_KEYS = Object.freeze(["__proto__", "prototype", "constructor"]);
  const RESERVED_KEY_CODE = "BRKTRK_RESERVED_STRUCTURAL_KEY";
  const RESERVED_FIELDS_EXTENSION = "org.myldydesign.brktrk.reserved-boundary-fields-v1";

  function assertNoReservedStructuralKeys(record, boundary = "project") {
    if (!record || typeof record !== "object" || Array.isArray(record)) return true;
    for (const key of RESERVED_STRUCTURAL_KEYS) {
      if (!Object.hasOwn(record, key)) continue;
      const error = new TypeError(`Reserved structural key is not allowed at the .brktrk ${boundary} boundary: ${key}`);
      error.code = RESERVED_KEY_CODE;
      error.boundary = boundary;
      error.key = key;
      throw error;
    }
    return true;
  }

  const TRACKS = 8;
  const SONG_ROWS = 64;
  const CHAIN_ROWS = 16;
  const PHRASE_ROWS = 16;
  const FX_SLOTS = 3;
  const EMPTY = -1;
  const NOTE_OFF = -2;

  const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const integerOr = (value, fallback = 0) => Number.isInteger(value) ? value : fallback;
  const objectOr = (value, fallback = {}) => value && typeof value === "object" && !Array.isArray(value) ? value : fallback;

  function productionInstrumentDomain() {
    if (globalThis.BRKTRKProductionInstrumentDomain) return globalThis.BRKTRKProductionInstrumentDomain;
    if (typeof require !== "undefined") return require("./production-instrument-domain.js");
    throw new Error("Production Instrument domain is unavailable");
  }

  function parameterEventDomain() {
    if (globalThis.BRKTRKParameterEventDomain) return globalThis.BRKTRKParameterEventDomain;
    if (typeof require !== "undefined") return require("./parameter-event-domain.js");
    throw new Error("ParameterEvent domain is unavailable");
  }

  function normalizeProjectName(value) {
    const trimmed = String(value ?? "").trim();
    return (trimmed || "UNTITLED 01").slice(0, 24).toUpperCase();
  }

  function normalizeFxSlot(value = 0) {
    const source = typeof value === "number" ? { command: value, value: 0 } : objectOr(value);
    const rawCommand = Object.hasOwn(source, "command") ? source.command
      : Object.hasOwn(source, "commandCode") ? source.commandCode
        : 0;
    const command = clamp(integerOr(rawCommand, 0), 0, 255);
    const rawValue = Object.hasOwn(source, "value") ? source.value : 0;
    return {
      command,
      value: command === 0 ? 0 : clamp(integerOr(rawValue, 0), 0, 255),
    };
  }

  function normalizeFxSlots(value) {
    const source = Array.isArray(value) ? value : [];
    return Array.from({ length: FX_SLOTS }, (_, slot) => normalizeFxSlot(source[slot] ?? 0));
  }

  function normalizeStepCondition(value) {
    const source = objectOr(value);
    const numeric = (candidate, fallback) => {
      const number = Number(candidate);
      return Number.isFinite(number) ? Math.round(number) : fallback;
    };
    const probability = clamp(numeric(source.probability, 100), 0, 100);
    const every = clamp(numeric(source.every, 1), 1, 16);
    const offset = clamp(numeric(source.offset, 0), 0, every - 1);
    return { probability, every, offset };
  }

  function normalizeTrackMix(value) {
    const source = objectOr(value);
    return {
      ...clone(source),
      gain: clamp(Number.isFinite(Number(source.gain)) ? Number(source.gain) : 1, 0, 1),
      mute: Boolean(source.mute),
      pan: clamp(Number.isFinite(Number(source.pan)) ? Number(source.pan) : 0, -1, 1),
    };
  }

  function normalizeTracks(value) {
    const source = Array.isArray(value) ? value : [];
    return Array.from({ length: TRACKS }, (_, id) => {
      const track = objectOr(source[id]);
      return { ...clone(track), id, mix: normalizeTrackMix(track.mix) };
    });
  }

  function normalizeSong(value) {
    if (!Array.isArray(value)) throw new TypeError("Project song must be an array");
    return Array.from({ length: SONG_ROWS }, (_, row) => {
      const source = Array.isArray(value[row]) ? value[row] : [];
      return Array.from({ length: TRACKS }, (_, track) => clamp(integerOr(source[track], EMPTY), EMPTY, 255));
    });
  }

  function normalizeCollection(value, kind, { sourceSchemaVersion = CURRENT_SCHEMA_VERSION } = {}) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError(`Project ${kind} must be an object`);
    }
    const output = {};
    for (const [rawId, rows] of Object.entries(value)) {
      const id = Number(rawId);
      if (!Number.isInteger(id) || id < 0 || id > 255 || !Array.isArray(rows)) {
        throw new TypeError(`Invalid ${kind} entry ${rawId}`);
      }
      if (kind === "chains") {
        output[id] = Array.from({ length: CHAIN_ROWS }, (_, row) => {
          const entry = objectOr(rows[row]);
          return {
            ...clone(entry),
            phrase: clamp(integerOr(entry.phrase, EMPTY), EMPTY, 255),
            transpose: clamp(integerOr(entry.transpose, 0), -127, 127),
          };
        });
      } else {
        output[id] = Array.from({ length: PHRASE_ROWS }, (_, row) => {
          const entry = objectOr(rows[row]);
          return {
            ...clone(entry),
            note: clamp(integerOr(entry.note, EMPTY), NOTE_OFF, 127),
            velocity: clamp(integerOr(entry.velocity, 100), 1, 127),
            instrument: clamp(integerOr(entry.instrument, EMPTY), EMPTY, 255),
            fx: normalizeFxSlots(entry.fx),
            condition: normalizeStepCondition(entry.condition),
            parameterEvents: sourceSchemaVersion >= CURRENT_SCHEMA_VERSION
              ? parameterEventDomain().serializeParameterEvents(entry.parameterEvents ?? [])
              : [],
          };
        });
      }
    }
    return output;
  }

  function retainedCompatibilityExtensions(value) {
    const extensions = clone(objectOr(value));
    for (const key of RETIRED_PREVIEW_EXTENSION_KEYS) delete extensions[key];
    return extensions;
  }

  function collectPreV5ParameterEventCollisions(phrases) {
    if (!phrases || typeof phrases !== "object" || Array.isArray(phrases)) return [];
    const collisions = [];
    for (const [rawPhraseId, rows] of Object.entries(phrases)) {
      if (!Array.isArray(rows)) continue;
      for (let row = 0; row < rows.length; row += 1) {
        const entry = rows[row];
        if (!entry || typeof entry !== "object" || Array.isArray(entry) || !Object.hasOwn(entry, "parameterEvents")) continue;
        collisions.push({ phraseId: Number(rawPhraseId), row, value: clone(entry.parameterEvents) });
      }
    }
    return collisions;
  }

  function migrateProject(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Project payload must be an object");
    const fromVersion = input.schemaVersion == null ? 0 : integerOr(input.schemaVersion, -1);
    if (fromVersion < 0 || fromVersion > CURRENT_SCHEMA_VERSION) {
      throw new RangeError(`Unsupported project schema ${input.schemaVersion}`);
    }

    // A4B2 deliberately drops only the obsolete preview-owned compatibility
    // payloads. BRKTRK is still pre-1.0 and `instrumentPool` is the only
    // Instrument owner, but unrelated unknown compatibility entries remain
    // preservation data rather than collateral damage from preview retirement.
    const productionPoolSource = fromVersion >= PRODUCTION_INSTRUMENT_SCHEMA_VERSION ? input.instrumentPool ?? {} : {};
    const compatibilityExtensions = retainedCompatibilityExtensions(input.compatibilityExtensions);
    if (fromVersion < CURRENT_SCHEMA_VERSION) {
      const collisions = collectPreV5ParameterEventCollisions(input.phrases);
      if (collisions.length > 0) {
        if (Object.hasOwn(compatibilityExtensions, PRE_V5_PARAMETER_EVENTS_EXTENSION)) {
          throw new TypeError("Pre-v5 Phrase parameterEvents migration conflicts with existing compatibility data");
        }
        compatibilityExtensions[PRE_V5_PARAMETER_EVENTS_EXTENSION] = collisions;
      }
    }
    // Older browser copies accepted these fields. Preserve their complete values
    // as nested compatibility data before any live-object installation. Portable
    // Open/Save rejects the original boundary keys before calling migration.
    const reserved = RESERVED_STRUCTURAL_KEYS.filter((key) => Object.hasOwn(input, key));
    if (reserved.length) {
      if (Object.hasOwn(compatibilityExtensions, RESERVED_FIELDS_EXTENSION)) {
        // Never overwrite an existing extension: bootstrap's verified quarantine
        // keeps the original bytes and prevents an unsavable live project.
        throw new TypeError("Reserved structural fields migration conflicts with existing compatibility data");
      }
      compatibilityExtensions[RESERVED_FIELDS_EXTENSION] = reserved.map((key) => ({ key, value: clone(input[key]) }));
    }
    const project = {
      ...clone(input),
      schemaVersion: CURRENT_SCHEMA_VERSION,
      projectName: normalizeProjectName(input.projectName),
      tempo: clamp(integerOr(input.tempo, 120), 30, 300),
      tracks: normalizeTracks(input.tracks),
      song: normalizeSong(input.song),
      chains: normalizeCollection(input.chains, "chains", { sourceSchemaVersion: fromVersion }),
      phrases: normalizeCollection(input.phrases, "phrases", { sourceSchemaVersion: fromVersion }),
      instrumentPool: productionInstrumentDomain().normalizeInstrumentPool(productionPoolSource),
    };
    for (const key of reserved) delete project[key];
    delete project.instruments;
    delete project.previewInstruments;
    delete project.transport;
    if (Object.keys(compatibilityExtensions).length > 0) project.compatibilityExtensions = compatibilityExtensions;
    else delete project.compatibilityExtensions;
    if (typeof project.sourceFormat !== "string" || !project.sourceFormat) project.sourceFormat = "brktrk";

    const before = JSON.stringify(input);
    const after = JSON.stringify(project);
    return Object.freeze({ project, fromVersion, toVersion: CURRENT_SCHEMA_VERSION, migrated: before !== after });
  }

  function phaseError(code, message, cause = null) {
    const error = new Error(message);
    error.code = code;
    if (cause) error.cause = cause;
    return error;
  }

  function writeCanonical(storage, project) {
    // Production installs authority before this module. Standalone codecs and
    // Node fixtures have no browser session; a present authority is mandatory.
    const authority = globalThis.BRKTRKBrowserWriterAuthority;
    if (authority && !authority.canWrite()) return authority.withAuthorizedWrite(() => {});
    const migrated = migrateProject(project);
    const serialized = JSON.stringify(migrated.project);
    try {
      storage.setItem(STAGING_KEY, serialized);
    } catch (error) {
      throw phaseError("BRKTRK_STAGING_WRITE_FAILED", "Project staging write failed", error);
    }
    let staged;
    try {
      staged = storage.getItem(STAGING_KEY);
    } catch (error) {
      throw phaseError("BRKTRK_STAGING_VERIFY_FAILED", "Project staging verification failed", error);
    }
    if (staged !== serialized) throw phaseError("BRKTRK_STAGING_VERIFY_FAILED", "Project staging verification failed");
    try {
      JSON.parse(staged);
    } catch (error) {
      throw phaseError("BRKTRK_STAGING_VERIFY_FAILED", "Project staging JSON verification failed", error);
    }
    try {
      storage.setItem(STORAGE_KEY, serialized);
    } catch (error) {
      throw phaseError("BRKTRK_CANONICAL_WRITE_FAILED", "Project canonical write failed", error);
    }
    try {
      storage.removeItem(STAGING_KEY);
    } catch (error) {
      throw phaseError("BRKTRK_STAGING_CLEANUP_FAILED", "Project staging cleanup failed", error);
    }
    return serialized;
  }

  function recoveryKey(now = Date.now()) {
    return `${RECOVERY_PREFIX}${Number(now)}`;
  }

  function preserveInvalidCanonical(storage, raw, error, options = {}) {
    const backupKey = recoveryKey(options.now ?? Date.now());
    try {
      globalThis.BRKTRKBrowserWriterAuthority?.withAuthorizedWrite(() => {});
      storage.setItem(backupKey, raw);
      if (storage.getItem(backupKey) !== raw) throw new Error("Recovery backup verification failed");
      storage.removeItem(STORAGE_KEY);
      return Object.freeze({ kind: "recovery", key: STORAGE_KEY, backupKey, error: String(error?.message ?? error) });
    } catch (backupError) {
      return Object.freeze({
        kind: "blocked",
        key: STORAGE_KEY,
        canonicalInstallable: false,
        error: String(error?.message ?? error),
        backupError: String(backupError?.message ?? backupError),
      });
    }
  }

  function preserveInvalidStaging(storage, raw, error, options = {}) {
    const backupKey = `${recoveryKey(options.now ?? Date.now())}:staging`;
    try {
      globalThis.BRKTRKBrowserWriterAuthority?.withAuthorizedWrite(() => {});
      storage.setItem(backupKey, raw);
      if (storage.getItem(backupKey) !== raw) throw new Error("Staging recovery backup verification failed");
      storage.removeItem(STAGING_KEY);
      return Object.freeze({
        kind: "staging-invalid-recovered",
        key: STORAGE_KEY,
        stagingKey: STAGING_KEY,
        backupKey,
        error: String(error?.message ?? error),
      });
    } catch (backupError) {
      return Object.freeze({
        kind: "staging-recovery-failed",
        key: STORAGE_KEY,
        stagingKey: STAGING_KEY,
        error: String(error?.message ?? error),
        backupError: String(backupError?.message ?? backupError),
      });
    }
  }

  function reconcileOrphanStaging(storage, options = {}) {
    let stagedRaw;
    try {
      stagedRaw = storage?.getItem?.(STAGING_KEY);
    } catch (error) {
      return Object.freeze({ kind: "staging-inspection-failed", key: STORAGE_KEY, stagingKey: STAGING_KEY, error: String(error?.message ?? error) });
    }
    if (stagedRaw == null) return null;

    let staged;
    try {
      staged = migrateProject(JSON.parse(stagedRaw));
    } catch (error) {
      return preserveInvalidStaging(storage, stagedRaw, error, options);
    }

    let canonicalBefore;
    try {
      canonicalBefore = storage?.getItem?.(STORAGE_KEY);
    } catch (error) {
      return Object.freeze({ kind: "staging-inspection-failed", key: STORAGE_KEY, stagingKey: STAGING_KEY, error: String(error?.message ?? error) });
    }
    const normalizedStaging = JSON.stringify(staged.project);
    if (canonicalBefore === stagedRaw || canonicalBefore === normalizedStaging) {
      try {
        storage.removeItem(STAGING_KEY);
        return Object.freeze({
          kind: "staging-reclaimed",
          key: STORAGE_KEY,
          stagingKey: STAGING_KEY,
          recovered: false,
        });
      } catch (error) {
        return Object.freeze({
          kind: "staging-cleanup-failed",
          key: STORAGE_KEY,
          stagingKey: STAGING_KEY,
          canonicalPreserved: true,
          stagingPresent: true,
          error: String(error?.message ?? error),
        });
      }
    }

    try {
      writeCanonical(storage, staged.project);
      return Object.freeze({
        kind: "staging-recovered",
        key: STORAGE_KEY,
        stagingKey: STAGING_KEY,
        recovered: true,
        replacedCanonical: canonicalBefore != null,
        fromVersion: staged.fromVersion,
        toVersion: staged.toVersion,
      });
    } catch (error) {
      let canonicalAfter = null;
      let stagingAfter = null;
      try { canonicalAfter = storage?.getItem?.(STORAGE_KEY); } catch {}
      try { stagingAfter = storage?.getItem?.(STAGING_KEY); } catch {}
      return Object.freeze({
        kind: error?.code === "BRKTRK_WRITER_BLOCKED" ? "blocked" : "staging-recovery-failed",
        key: STORAGE_KEY,
        stagingKey: STAGING_KEY,
        error: String(error?.message ?? error),
        errorCode: error?.code ?? null,
        canonicalPreserved: canonicalAfter === canonicalBefore,
        stagingPresent: stagingAfter != null,
      });
    }
  }

  function migrationWriteFailure(storage, raw, migrated, error) {
    let canonical = null;
    let staging = null;
    try { canonical = storage?.getItem?.(STORAGE_KEY); } catch {}
    try { staging = storage?.getItem?.(STAGING_KEY); } catch {}
    return Object.freeze({
      kind: "migration-write-failed",
      key: STORAGE_KEY,
      fromVersion: migrated.fromVersion,
      toVersion: migrated.toVersion,
      error: String(error?.message ?? error),
      errorCode: error?.code ?? null,
      canonicalPreserved: canonical === raw,
      canonicalUpdated: canonical === JSON.stringify(migrated.project),
      stagingPresent: staging != null,
    });
  }

  function bootstrapStorage(storage, options = {}) {
    const staging = reconcileOrphanStaging(storage, options);
    if (["blocked", "staging-inspection-failed", "staging-cleanup-failed", "staging-recovery-failed"].includes(staging?.kind)) {
      return staging;
    }

    let raw;
    try {
      raw = storage?.getItem?.(STORAGE_KEY);
    } catch (error) {
      return Object.freeze({ kind: "blocked", key: STORAGE_KEY, error: String(error?.message ?? error) });
    }
    if (raw == null) {
      if (staging) return Object.freeze({ ...staging, canonicalKind: "empty" });
      return Object.freeze({ kind: "empty", key: STORAGE_KEY });
    }

    let migrated;
    try {
      migrated = migrateProject(JSON.parse(raw));
    } catch (error) {
      const failure = preserveInvalidCanonical(storage, raw, error, options);
      return staging ? Object.freeze({ ...failure, stagingDisposition: staging.kind }) : failure;
    }

    if (migrated.migrated) {
      try {
        writeCanonical(storage, migrated.project);
      } catch (error) {
        if (error?.code === "BRKTRK_WRITER_BLOCKED") {
          return Object.freeze({ kind: "blocked", key: STORAGE_KEY, error: String(error.message), stagingDisposition: staging?.kind ?? null });
        }
        const failure = migrationWriteFailure(storage, raw, migrated, error);
        return staging ? Object.freeze({ ...failure, stagingDisposition: staging.kind }) : failure;
      }
    }

    const canonicalStatus = migrated.fromVersion === CURRENT_SCHEMA_VERSION && !migrated.migrated ? "ready" : "migrated";
    if (staging) {
      return Object.freeze({
        ...staging,
        canonicalKind: canonicalStatus,
        fromVersion: stagedVersion(staging, migrated.fromVersion),
        toVersion: migrated.toVersion,
      });
    }
    return Object.freeze({
      kind: canonicalStatus,
      key: STORAGE_KEY,
      fromVersion: migrated.fromVersion,
      toVersion: migrated.toVersion,
    });
  }

  function stagedVersion(staging, fallback) {
    return Number.isInteger(staging?.fromVersion) ? staging.fromVersion : fallback;
  }

  function installRuntimeProject(model) {
    const migrated = migrateProject(model);
    for (const key of Object.keys(model)) delete model[key];
    Object.assign(model, migrated.project);
    return migrated;
  }

  function applyBootNotice(root = globalThis) {
    const status = root.BRKTRKProjectStorageBoot;
    if (!status || status.kind === "empty" || status.kind === "ready") return status;
    root.document?.body?.setAttribute("data-project-storage-status", status.kind);
    if (typeof root.setStatus !== "function") return status;
    if (status.kind === "migrated") root.setStatus(`PROJECT MIGRATED TO SCHEMA V${CURRENT_SCHEMA_VERSION}`, "amber");
    else if (status.kind === "migration-write-failed") root.setStatus("PROJECT LOADED · MIGRATION SAFETY COPY FAILED", "danger");
    else if (status.kind === "staging-recovered") root.setStatus("PENDING SAFETY COPY RECOVERED", "amber");
    else if (status.kind === "staging-reclaimed") root.setStatus("STALE SAFETY STAGING RECLAIMED", "amber");
    else if (status.kind === "staging-invalid-recovered") root.setStatus("INVALID SAFETY STAGING PRESERVED · CANONICAL KEPT", "amber");
    else if (status.kind === "staging-cleanup-failed") root.setStatus("SAFETY COPY CLEANUP FAILED · PROJECT KEPT", "danger");
    else if (status.kind === "staging-recovery-failed" || status.kind === "staging-inspection-failed") root.setStatus("SAFETY COPY RECOVERY FAILED · PROJECT KEPT", "danger");
    else if (status.kind === "recovery") root.setStatus("INVALID SAVE PRESERVED AS RECOVERY COPY", "amber");
    else root.setStatus("SAVE RECOVERY BLOCKED · ORIGINAL LEFT UNTOUCHED", "danger");
    return status;
  }

  const api = Object.freeze({
    CURRENT_SCHEMA_VERSION,
    PRODUCTION_INSTRUMENT_SCHEMA_VERSION,
    PRE_V5_PARAMETER_EVENTS_EXTENSION,
    STORAGE_KEY,
    STAGING_KEY,
    RECOVERY_PREFIX,
    RETIRED_PREVIEW_EXTENSION_KEYS,
    RESERVED_STRUCTURAL_KEYS,
    RESERVED_KEY_CODE,
    RESERVED_FIELDS_EXTENSION,
    assertNoReservedStructuralKeys,
    FX_SLOTS,
    normalizeFxSlot,
    normalizeFxSlots,
    normalizeStepCondition,
    collectPreV5ParameterEventCollisions,
    retainedCompatibilityExtensions,
    migrateProject,
    writeCanonical,
    reconcileOrphanStaging,
    bootstrapStorage,
    installRuntimeProject,
    applyBootNotice,
  });

  globalThis.BRKTRKProjectStorage = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (globalThis.localStorage) globalThis.BRKTRKProjectStorageBoot = bootstrapStorage(globalThis.localStorage);
})();

