(() => {
  const FILE_FORMAT = "BRKTRK_PROJECT";
  const FILE_FORMAT_VERSION = 1;
  const KNOWN_ENVELOPE_KEYS = Object.freeze(new Set(["format", "formatVersion", "project", "producer"]));
  const FORBIDDEN_SESSION_KEYS = Object.freeze(new Set([
    "view", "dock", "scope", "playing", "live", "focus", "playhead", "currentSequence", "p3",
    "songRow", "track", "chain", "chainRow", "phrase", "phraseRow", "instrument", "lastChain", "lastPhrase",
  ]));
  const RESERVED_STRUCTURAL_KEYS = storageApi().RESERVED_STRUCTURAL_KEYS;
  const assertNoReservedStructuralKeys = storageApi().assertNoReservedStructuralKeys;
  const RESERVED_KEY_POLICY = "reject-reserved-structural-keys-at-boundary-records";
  const RESOURCE_LIMIT_CODE = "BRKTRK_PROJECT_RESOURCE_LIMIT";
  const RESOURCE_LIMITS = Object.freeze({
    maxFileBytes: 4 * 1024 * 1024,
    maxDepth: 64,
    maxContainers: 50000,
    maxEntries: 100000,
    maxArrayLength: 4096,
    maxObjectKeys: 4096,
  });
  // Compatible unknown JSON is never truncated or silently discarded. It is preserved
  // whole when the complete portable envelope fits this deterministic resource budget;
  // otherwise the entire Open/Save fails closed.
  const UNKNOWN_DATA_POLICY = "preserve-whole-within-resource-envelope";

  class ProjectResourceLimitError extends RangeError {
    constructor(kind, message, actual = null, limit = null) {
      super(`PROJECT TOO LARGE/INVALID · ${message}`);
      this.name = "ProjectResourceLimitError";
      this.code = RESOURCE_LIMIT_CODE;
      this.kind = kind;
      this.actual = actual;
      this.limit = limit;
    }
  }

  const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
  const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

  function resourceError(kind, message, actual = null, limit = null) {
    return new ProjectResourceLimitError(kind, message, actual, limit);
  }

  function isResourceLimitError(error) {
    return error?.code === RESOURCE_LIMIT_CODE;
  }

  function assertSupportedFileSize(size) {
    if (size == null) return true;
    const bytes = Number(size);
    if (!Number.isFinite(bytes) || bytes < 0) return true;
    if (bytes > RESOURCE_LIMITS.maxFileBytes) {
      throw resourceError(
        "file-bytes",
        `file is ${bytes} bytes; supported maximum is ${RESOURCE_LIMITS.maxFileBytes} bytes`,
        bytes,
        RESOURCE_LIMITS.maxFileBytes,
      );
    }
    return true;
  }

  function utf8ByteLength(text) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).byteLength;
    if (typeof Buffer !== "undefined") return Buffer.byteLength(text, "utf8");
    return unescape(encodeURIComponent(text)).length;
  }

  function assertJsonDepth(text) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === "\"") inString = false;
        continue;
      }
      if (char === "\"") {
        inString = true;
        continue;
      }
      if (char === "{" || char === "[") {
        depth += 1;
        if (depth > RESOURCE_LIMITS.maxDepth) {
          throw resourceError(
            "depth",
            `JSON nesting exceeds supported depth ${RESOURCE_LIMITS.maxDepth}`,
            depth,
            RESOURCE_LIMITS.maxDepth,
          );
        }
      } else if ((char === "}" || char === "]") && depth > 0) {
        depth -= 1;
      }
    }
    return true;
  }

  function assertSupportedText(text) {
    if (typeof text !== "string") throw new TypeError(".brktrk text must be a string");
    if (text.length > RESOURCE_LIMITS.maxFileBytes) {
      throw resourceError(
        "file-bytes",
        `file exceeds supported maximum ${RESOURCE_LIMITS.maxFileBytes} bytes`,
        text.length,
        RESOURCE_LIMITS.maxFileBytes,
      );
    }
    const bytes = utf8ByteLength(text);
    assertSupportedFileSize(bytes);
    assertJsonDepth(text);
    return bytes;
  }

  function assertSupportedStructure(value) {
    const stack = [{ value, depth: 1 }];
    let containers = 0;
    let entries = 0;
    let stringUnits = 0;

    while (stack.length) {
      const current = stack.pop();
      const node = current.value;
      if (typeof node === "string") {
        stringUnits += node.length;
        if (stringUnits > RESOURCE_LIMITS.maxFileBytes) {
          throw resourceError(
            "string-data",
            `string data exceeds supported portable budget ${RESOURCE_LIMITS.maxFileBytes}`,
            stringUnits,
            RESOURCE_LIMITS.maxFileBytes,
          );
        }
        continue;
      }
      if (!node || typeof node !== "object") continue;

      containers += 1;
      if (containers > RESOURCE_LIMITS.maxContainers) {
        throw resourceError(
          "containers",
          `container count exceeds supported maximum ${RESOURCE_LIMITS.maxContainers}`,
          containers,
          RESOURCE_LIMITS.maxContainers,
        );
      }
      if (current.depth > RESOURCE_LIMITS.maxDepth) {
        throw resourceError(
          "depth",
          `structure exceeds supported depth ${RESOURCE_LIMITS.maxDepth}`,
          current.depth,
          RESOURCE_LIMITS.maxDepth,
        );
      }

      if (Array.isArray(node)) {
        if (node.length > RESOURCE_LIMITS.maxArrayLength) {
          throw resourceError(
            "array-length",
            `array length ${node.length} exceeds supported maximum ${RESOURCE_LIMITS.maxArrayLength}`,
            node.length,
            RESOURCE_LIMITS.maxArrayLength,
          );
        }
        entries += node.length;
        if (entries > RESOURCE_LIMITS.maxEntries) {
          throw resourceError(
            "entries",
            `entry count exceeds supported maximum ${RESOURCE_LIMITS.maxEntries}`,
            entries,
            RESOURCE_LIMITS.maxEntries,
          );
        }
        for (let index = node.length - 1; index >= 0; index -= 1) {
          stack.push({ value: node[index], depth: current.depth + 1 });
        }
        continue;
      }

      const keys = Object.keys(node);
      if (keys.length > RESOURCE_LIMITS.maxObjectKeys) {
        throw resourceError(
          "object-keys",
          `object key count ${keys.length} exceeds supported maximum ${RESOURCE_LIMITS.maxObjectKeys}`,
          keys.length,
          RESOURCE_LIMITS.maxObjectKeys,
        );
      }
      entries += keys.length;
      if (entries > RESOURCE_LIMITS.maxEntries) {
        throw resourceError(
          "entries",
          `entry count exceeds supported maximum ${RESOURCE_LIMITS.maxEntries}`,
          entries,
          RESOURCE_LIMITS.maxEntries,
        );
      }
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index];
        stringUnits += key.length;
        if (stringUnits > RESOURCE_LIMITS.maxFileBytes) {
          throw resourceError(
            "string-data",
            `string data exceeds supported portable budget ${RESOURCE_LIMITS.maxFileBytes}`,
            stringUnits,
            RESOURCE_LIMITS.maxFileBytes,
          );
        }
        stack.push({ value: node[key], depth: current.depth + 1 });
      }
    }

    return Object.freeze({ containers, entries, stringUnits });
  }

  function defineOwn(target, key, value) {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  function storageApi() {
    if (globalThis.BRKTRKProjectStorage) return globalThis.BRKTRKProjectStorage;
    if (typeof require !== "undefined") return require("./project-storage.js");
    throw new Error("BRKTRK project storage codec is unavailable");
  }

  function parseJson(value) {
    if (typeof value !== "string") {
      assertSupportedStructure(value);
      return clone(value);
    }
    assertSupportedText(value);
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      throw new SyntaxError(`Invalid .brktrk JSON: ${error?.message ?? error}`);
    }
    assertSupportedStructure(parsed);
    return parsed;
  }

  function collectUnknownEnvelopeFields(envelope) {
    const unknown = {};
    for (const [key, value] of Object.entries(envelope)) {
      if (!KNOWN_ENVELOPE_KEYS.has(key)) defineOwn(unknown, key, clone(value));
    }
    return unknown;
  }

  function assertNoSessionState(project) {
    for (const key of FORBIDDEN_SESSION_KEYS) {
      if (Object.hasOwn(project, key)) throw new TypeError(`Session-only field is not allowed in .brktrk project payload: ${key}`);
    }
    return true;
  }

  function parseEnvelope(value) {
    const envelope = parseJson(value);
    if (!isObject(envelope)) throw new TypeError(".brktrk envelope must be an object");
    assertNoReservedStructuralKeys(envelope, "envelope");
    if (envelope.format !== FILE_FORMAT) throw new TypeError(`Unsupported project format: ${envelope.format ?? "missing"}`);
    if (!Number.isInteger(envelope.formatVersion) || envelope.formatVersion < 1) {
      throw new TypeError(".brktrk formatVersion must be a positive integer");
    }
    if (envelope.formatVersion > FILE_FORMAT_VERSION) {
      throw new RangeError(`Unsupported .brktrk format version ${envelope.formatVersion}`);
    }
    if (!isObject(envelope.project)) throw new TypeError(".brktrk project payload must be an object");
    assertNoReservedStructuralKeys(envelope.project, "project");
    assertNoSessionState(envelope.project);
    const hasSchemaVersion = Object.hasOwn(envelope.project, "schemaVersion");
    const schemaVersion = hasSchemaVersion ? envelope.project.schemaVersion : 0;
    if (hasSchemaVersion && (!Number.isInteger(schemaVersion) || schemaVersion < 0)) {
      throw new TypeError("project schemaVersion must be a non-negative integer");
    }
    const currentSchema = storageApi().CURRENT_SCHEMA_VERSION;
    if (schemaVersion > currentSchema) throw new RangeError(`Unsupported project schema ${schemaVersion}`);
    return Object.freeze({
      envelope: clone(envelope),
      project: clone(envelope.project),
      format: envelope.format,
      formatVersion: envelope.formatVersion,
      projectSchemaVersion: schemaVersion,
      producer: isObject(envelope.producer) ? clone(envelope.producer) : null,
      unknownEnvelope: collectUnknownEnvelopeFields(envelope),
    });
  }

  function prepareOpen(value) {
    const parsed = parseEnvelope(value);
    const migrated = storageApi().migrateProject(parsed.project);
    assertSupportedStructure(migrated.project);
    assertNoSessionState(migrated.project);
    return Object.freeze({
      format: parsed.format,
      formatVersion: parsed.formatVersion,
      sourceProjectSchemaVersion: parsed.projectSchemaVersion,
      projectSchemaVersion: migrated.toVersion,
      migrated: migrated.migrated,
      project: clone(migrated.project),
      producer: clone(parsed.producer),
      unknownEnvelope: clone(parsed.unknownEnvelope),
    });
  }

  function createEnvelope(project, options = {}) {
    if (!isObject(project)) throw new TypeError("Project payload must be an object");
    assertNoReservedStructuralKeys(project, "project");
    assertNoSessionState(project);
    const unknownEnvelope = isObject(options.unknownEnvelope) ? options.unknownEnvelope : {};
    assertNoReservedStructuralKeys(unknownEnvelope, "envelope");
    const producer = isObject(options.producer) ? options.producer : null;
    assertSupportedStructure({ project, unknownEnvelope, producer });
    const canonical = storageApi().migrateProject(project).project;
    assertSupportedStructure({ project: canonical, unknownEnvelope, producer });
    assertNoSessionState(canonical);
    if (Object.hasOwn(canonical, "instruments")) {
      throw new Error("Portable project payload must not contain preview instruments array");
    }
    const envelope = {};
    for (const [key, value] of Object.entries(unknownEnvelope)) {
      if (!KNOWN_ENVELOPE_KEYS.has(key)) defineOwn(envelope, key, clone(value));
    }
    defineOwn(envelope, "format", FILE_FORMAT);
    defineOwn(envelope, "formatVersion", FILE_FORMAT_VERSION);
    defineOwn(envelope, "project", clone(canonical));
    if (producer) defineOwn(envelope, "producer", clone(producer));
    assertSupportedStructure(envelope);
    return envelope;
  }

  function serializeProject(project, options = {}) {
    const text = `${JSON.stringify(createEnvelope(project, options), null, 2)}\n`;
    assertSupportedText(text);
    return text;
  }

  const api = Object.freeze({
    FILE_FORMAT,
    FILE_FORMAT_VERSION,
    FORBIDDEN_SESSION_KEYS,
    RESOURCE_LIMITS,
    UNKNOWN_DATA_POLICY,
    RESERVED_STRUCTURAL_KEYS,
    RESERVED_KEY_POLICY,
    assertNoReservedStructuralKeys,
    isReservedKeyError: (error) => error?.code === storageApi().RESERVED_KEY_CODE,
    ProjectResourceLimitError,
    isResourceLimitError,
    assertSupportedFileSize,
    assertSupportedText,
    assertSupportedStructure,
    collectUnknownEnvelopeFields,
    assertNoSessionState,
    parseEnvelope,
    prepareOpen,
    createEnvelope,
    serializeProject,
  });

  globalThis.BRKTRKProjectFile = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

