(() => {
  "use strict";

  const packageDomain = globalThis.BRKTRKEnginePackageDomain
    ?? (typeof module !== "undefined" && module.exports ? require("./engine-package-domain.js") : null);
  if (!packageDomain?.moduleInstanceCapability) throw new Error("BRK Synth ABI-v1 runtime requires engine package capability policy");

  const ABI_VERSION = 0x00010000;
  const BRK_OK = 0;
  const EVENT = Object.freeze({ NOTE_ON: 1, NOTE_OFF: 2, NOTE_CHOKE: 3, RETRIGGER: 4, PARAM_VALUE: 5, PARAM_RAMP: 6, ALL_NOTES_OFF: 7, RESET: 8 });
  const EVENT_SIZE = Object.freeze({ NOTE: 28, PARAM_VALUE: 24, PARAM_RAMP: 32, HEADER: 12 });
  const PRIORITY = Object.freeze({ reset: 0, "all-notes-off": 1, kill: 2, "note-off": 3, parameter: 5, "note-on": 7, retrigger: 8 });
  const PREPARED_ACTION = Object.freeze({ "note-off": 1, "note-on": 2, retrigger: 3 });
  const PREPARED_ACTION_TYPE = Object.freeze([null, "note-off", "note-on", "retrigger"]);
  const DEFAULT_MAX_BLOCK_FRAMES = 2048;
  const DEFAULT_MAX_EVENTS_PER_PERFORMER = 2048;
  const DEFAULT_REALTIME_MEMORY_LIMIT_BYTES = 128 * 1024;
  const MAX_NOTE_ID = 0x7fffffff;

  class BrkSynthAbiError extends Error {
    constructor(code, message, details = {}) {
      super(message);
      this.name = "BrkSynthAbiError";
      this.code = String(code || "brk-synth-abi-error");
      this.details = Object.freeze({ ...details });
    }
  }

  const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, finite(value, min)));
  const runtimeKey = (entry) => `${String(entry?.moduleId ?? "")}\u0000${String(entry?.engineId ?? "")}\u0000${String(entry?.version ?? "")}`;

  function base64Bytes(value) {
    const text = String(value ?? "").replace(/\s+/g, "");
    if (!text) return new Uint8Array(0);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    if (text.length % 4 !== 0) throw new BrkSynthAbiError("invalid-base64", "patch state base64 length is invalid");
    const out = [];
    for (let offset = 0; offset < text.length; offset += 4) {
      const group = text.slice(offset, offset + 4);
      const values = [...group].map((char) => char === "=" ? 0 : alphabet.indexOf(char));
      if (values.some((item, index) => item < 0 && group[index] !== "=")) throw new BrkSynthAbiError("invalid-base64", "patch state contains invalid base64 data");
      const triple = (values[0] << 18) | (values[1] << 12) | (values[2] << 6) | values[3];
      out.push((triple >> 16) & 0xff);
      if (group[2] !== "=") out.push((triple >> 8) & 0xff);
      if (group[3] !== "=") out.push(triple & 0xff);
    }
    return Uint8Array.from(out);
  }

  function patchBytes(patchState) {
    if (!patchState || typeof patchState !== "object" || patchState.data == null) return null;
    const encoding = String(patchState.encoding ?? "").toLowerCase();
    if (!["base64", "brk-state-v1-base64", "application/octet-stream;base64"].includes(encoding)) return null;
    return base64Bytes(patchState.data);
  }

  function parameterMap(manifest) {
    const map = new Map();
    for (const parameter of Array.isArray(manifest?.parameters) ? manifest.parameters : []) {
      const key = String(parameter.id ?? parameter.key ?? "").trim();
      const abiId = Number(parameter.abiId ?? parameter.numericId ?? parameter.parameterId);
      if (!key || !Number.isSafeInteger(abiId) || abiId < 0) continue;
      map.set(key, Object.freeze({ key, abiId, defaultValue: clamp(parameter.defaultNormalized ?? parameter.normalized_default ?? parameter.default ?? 0, 0, 1) }));
    }
    return map;
  }

  function assertResult(result, operation) {
    const numeric = Number(result);
    if (numeric === BRK_OK) return;
    throw new BrkSynthAbiError("abi-call-failed", `${operation} failed with BRK result ${numeric}`, { operation, result: numeric });
  }

  function allocate(module, size, label) {
    const ptr = Number(module?._malloc?.(size) ?? 0);
    if (!Number.isSafeInteger(ptr) || ptr <= 0) throw new BrkSynthAbiError("abi-out-of-memory", `could not allocate ${label} (${size} bytes)`);
    return ptr;
  }

  const view = (module) => new DataView(module.HEAPU8.buffer);

  function writeHeader(target, offset, size, type, frameOffset) {
    target.setUint16(offset + 0, size, true);
    target.setUint16(offset + 2, type, true);
    target.setUint32(offset + 4, frameOffset >>> 0, true);
    target.setUint32(offset + 8, 0, true);
  }

  function writeNote(target, offset, type, frameOffset, noteId, pitch, velocity, tuningSemitones = 0) {
    writeHeader(target, offset, EVENT_SIZE.NOTE, type, frameOffset);
    target.setUint32(offset + 12, noteId >>> 0, true);
    target.setInt16(offset + 16, Math.round(clamp(pitch, 0, 127)), true);
    target.setInt16(offset + 18, 0, true);
    target.setFloat32(offset + 20, clamp(velocity ?? 0, 0, 1), true);
    target.setFloat32(offset + 24, finite(tuningSemitones, 0), true);
    return EVENT_SIZE.NOTE;
  }

  function writeParameter(target, offset, frameOffset, parameter, value) {
    writeHeader(target, offset, EVENT_SIZE.PARAM_VALUE, EVENT.PARAM_VALUE, frameOffset);
    target.setUint32(offset + 12, parameter.abiId >>> 0, true);
    target.setFloat32(offset + 16, clamp(value, 0, 1), true);
    target.setUint32(offset + 20, 0, true);
    return EVENT_SIZE.PARAM_VALUE;
  }

  function writeRamp(target, offset, frameOffset, parameter, startValue, endValue, durationFrames) {
    writeHeader(target, offset, EVENT_SIZE.PARAM_RAMP, EVENT.PARAM_RAMP, frameOffset);
    target.setUint32(offset + 12, parameter.abiId >>> 0, true);
    target.setFloat32(offset + 16, clamp(startValue, 0, 1), true);
    target.setFloat32(offset + 20, clamp(endValue, 0, 1), true);
    target.setUint32(offset + 24, Math.max(1, Math.round(durationFrames)) >>> 0, true);
    target.setUint32(offset + 28, 0, true);
    return EVENT_SIZE.PARAM_RAMP;
  }

  const actionPriority = (action) => action?.type === "parameter"
    ? (Number(action.rampFrames) > 0 ? 6 : 5)
    : PRIORITY[action?.type] ?? 99;

  function sortActionsInPlace(actions) {
    for (let index = 1; index < actions.length; index += 1) {
      const value = actions[index];
      const valueOffset = Number(value?.sampleOffset ?? 0);
      const valuePriority = actionPriority(value);
      const valueOrder = Number(value?.__r2Order ?? index);
      let cursor = index - 1;
      while (cursor >= 0) {
        const candidate = actions[cursor];
        const candidateOffset = Number(candidate?.sampleOffset ?? 0);
        const candidatePriority = actionPriority(candidate);
        const candidateOrder = Number(candidate?.__r2Order ?? cursor);
        if (candidateOffset < valueOffset
          || (candidateOffset === valueOffset && (candidatePriority < valuePriority
            || (candidatePriority === valuePriority && candidateOrder <= valueOrder)))) break;
        actions[cursor + 1] = candidate;
        cursor -= 1;
      }
      actions[cursor + 1] = value;
    }
    return actions;
  }

  const sortActions = (actions) => sortActionsInPlace(Array.from(actions));

  const ASSET_EXT_V1 = 0x00010000;
  const ASSET_ARENA_DESCRIPTOR_BYTES = 48;
  const ASSET_BINDING_BYTES = 64;
  const ASSET_FORMAT_PCM_S16_INTERLEAVED = 1;
  const ASSET_ARENA_HOST_WRITABLE = 1;
  const ASSET_ARENA_STOPPED_ONLY = 2;

  function pcmAssetBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return null;
  }

  function alignUp(value, alignment) {
    return Math.ceil(value / alignment) * alignment;
  }

  function createPerformerFactory(record, options = {}) {
    if (!record?.module || !record?.manifest || !record?.entry) throw new TypeError("BRK Synth ABI-v1 factory requires a registered module runtime record");
    const module = record.module;
    const manifest = record.manifest;
    const params = parameterMap(manifest);
    const maxBlockFrames = Number.isInteger(options.maxBlockFrames) ? options.maxBlockFrames : DEFAULT_MAX_BLOCK_FRAMES;
    const maxEvents = Number.isInteger(options.maxEventsPerPerformer) ? options.maxEventsPerPerformer : DEFAULT_MAX_EVENTS_PER_PERFORMER;
    const realtimeMemoryLimitBytes = Number.isInteger(options.realtimeMemoryLimitBytes) ? options.realtimeMemoryLimitBytes : DEFAULT_REALTIME_MEMORY_LIMIT_BYTES;
    const assetExtensionVersion = Number(manifest?.runtime?.assetExtensionVersion ?? 0);
    let livePerformers = 0;
    let assetArena = null;
    let assetCursor = 0;
    let assetBytesStored = 0;
    const assetSpans = new Map();
    const capability = packageDomain.moduleInstanceCapability(manifest);
    const declaredInstances = capability.capacity;
    const stateCapacity = Math.max(256, Number(manifest?.stateBytes ?? manifest?.runtime?.stateBytes ?? 4096));
    const stagingBytesPerPerformer = 48 + 72 + 24 + 64 + (maxEvents * EVENT_SIZE.PARAM_RAMP) + (maxBlockFrames * 2 * 4) + stateCapacity
      + (assetExtensionVersion ? ASSET_BINDING_BYTES : 0);

    function ensureAssetArena() {
      if (!assetExtensionVersion) return null;
      if (assetExtensionVersion !== ASSET_EXT_V1) {
        throw new BrkSynthAbiError("asset-extension-version", `unsupported Asset Extension ${assetExtensionVersion}`);
      }
      if (assetArena) return assetArena;
      for (const name of ["_brk_asset_ext_version","_brk_asset_arena_descriptor","_brk_instance_asset_bind","_brk_instance_asset_unbind"]) {
        if (typeof module?.[name] !== "function") throw new BrkSynthAbiError("asset-extension-missing", `package declares Asset Extension but export ${name} is missing`);
      }
      if (Number(module._brk_asset_ext_version()) !== ASSET_EXT_V1) {
        throw new BrkSynthAbiError("asset-extension-version", "module Asset Extension version disagrees with package manifest");
      }
      const scratch = allocate(module, ASSET_ARENA_DESCRIPTOR_BYTES, "asset arena descriptor");
      try {
        const required = Number(module._brk_asset_arena_descriptor(scratch, ASSET_ARENA_DESCRIPTOR_BYTES));
        if (required !== ASSET_ARENA_DESCRIPTOR_BYTES) throw new BrkSynthAbiError("asset-arena-descriptor", `asset arena descriptor size ${required} is invalid`);
        const data = view(module);
        const structSize = data.getUint32(scratch + 0, true);
        const dataOffset = data.getUint32(scratch + 4, true);
        const byteCapacity = data.getUint32(scratch + 8, true);
        const alignment = data.getUint32(scratch + 12, true);
        const flags = data.getUint32(scratch + 16, true);
        if (structSize !== ASSET_ARENA_DESCRIPTOR_BYTES || dataOffset <= 0 || byteCapacity <= 0
            || alignment <= 0 || (alignment & (alignment - 1)) !== 0
            || (flags & ASSET_ARENA_HOST_WRITABLE) === 0 || (flags & ASSET_ARENA_STOPPED_ONLY) === 0
            || dataOffset + byteCapacity > module.HEAPU8.byteLength) {
          throw new BrkSynthAbiError("asset-arena-descriptor", "module returned an invalid Asset Extension arena");
        }
        const manifestBytes = Number(manifest?.runtime?.assetArenaBytes ?? byteCapacity);
        if (!Number.isSafeInteger(manifestBytes) || manifestBytes !== byteCapacity) {
          throw new BrkSynthAbiError("asset-arena-contract", "module asset arena capacity disagrees with package manifest");
        }
        assetArena = Object.freeze({ dataOffset, byteCapacity, alignment, flags });
        assetCursor = dataOffset;
        return assetArena;
      } finally {
        try { module._free?.(scratch); } catch {}
      }
    }

    function spanForAsset(assetRef, asset) {
      const arena = ensureAssetArena();
      if (!arena) {
        if (assetRef || asset) throw new BrkSynthAbiError("asset-extension-unavailable", "Instrument carries asset data but engine package has no Asset Extension");
        return null;
      }
      if (!assetRef) throw new BrkSynthAbiError("asset-required", "Asset Extension engine requires Instrument assetRef");
      if (!asset?.ref) throw new BrkSynthAbiError("asset-unavailable", `sample asset ${String(assetRef.sha256 ?? "")} is not loaded in the Worklet`);
      const sha = String(assetRef.sha256 ?? "").trim().toLowerCase();
      const assetSha = String(asset.ref.sha256 ?? "").trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(sha) || sha !== assetSha) throw new BrkSynthAbiError("asset-identity", "loaded sample asset identity does not match Instrument assetRef");
      for (const field of ["format","sampleRateHz","channelCount","frameCount","byteSize"]) {
        if (asset.ref[field] !== assetRef[field]) throw new BrkSynthAbiError("asset-metadata", `loaded sample asset ${field} does not match Instrument assetRef`);
      }
      if (assetRef.format !== "pcm-s16-interleaved") throw new BrkSynthAbiError("asset-format", `unsupported sample asset format ${String(assetRef.format)}`);
      const bytes = pcmAssetBytes(asset.pcmBytes);
      if (!bytes || bytes.byteLength !== Number(assetRef.byteSize)
          || Number(assetRef.byteSize) !== Number(assetRef.frameCount) * Number(assetRef.channelCount) * 2) {
        throw new BrkSynthAbiError("asset-bytes", "loaded sample PCM bytes do not match assetRef");
      }
      const existing = assetSpans.get(sha);
      if (existing) return existing;
      const offset = alignUp(assetCursor, arena.alignment);
      const end = offset + bytes.byteLength;
      if (!Number.isSafeInteger(end) || end > arena.dataOffset + arena.byteCapacity) {
        throw new BrkSynthAbiError("asset-arena-full", `sample assets exceed module arena capacity ${arena.byteCapacity}`);
      }
      module.HEAPU8.set(bytes, offset);
      const span = Object.freeze({ sha256: sha, offset, byteSize: bytes.byteLength, ref: Object.freeze({ ...assetRef, sha256: sha }) });
      assetSpans.set(sha, span);
      assetCursor = end;
      assetBytesStored += bytes.byteLength;
      return span;
    }

    function makePerformer({ track, instrumentId, sampleRate, patchState, parameterSnapshot, assetRef = null, asset = null } = {}) {
      if (livePerformers >= declaredInstances) throw new BrkSynthAbiError("module-instance-capacity", `engine module instance capacity ${declaredInstances} exceeded`, {
        capacity: declaredInstances,
        demand: livePerformers + 1,
        capabilitySource: capability.source,
        capabilityExplicit: capability.explicit,
        moduleId: manifest.moduleId,
        engineId: manifest.engineId,
        version: manifest.version,
      });
      const pointers = [];
      let handle = 0;
      const owned = (size, label) => {
        const ptr = allocate(module, size, label);
        pointers.push(ptr);
        return ptr;
      };
      try {
      const createPtr = owned(48, "brk_create_info");
      const preparePtr = owned(72, "brk_prepare_info");
      const audioSpanPtr = owned(24, "brk_audio_span");
      const processPtr = owned(64, "brk_process_info");
      const eventPtr = owned(maxEvents * EVENT_SIZE.PARAM_RAMP, "BRK event buffer");
      const outputPtr = owned(maxBlockFrames * 2 * 4, "BRK stereo output buffer");
      const statePtr = owned(stateCapacity, "BRK state buffer");

      let data = view(module);
      for (let index = 0; index < 48; index += 1) data.setUint8(createPtr + index, 0);
      data.setUint32(createPtr + 0, 48, true);
      data.setUint32(createPtr + 8, Number(manifest?.engineIndex ?? 0) >>> 0, true);
      handle = Number(module._brk_instance_create(Number(manifest?.engineIndex ?? 0), createPtr));
      if (!Number.isSafeInteger(handle) || handle <= 0) throw new BrkSynthAbiError("instance-create-failed", `brk_instance_create failed with ${handle}`);

      data = view(module);
      for (let index = 0; index < 72; index += 1) data.setUint8(preparePtr + index, 0);
      data.setUint32(preparePtr + 0, 72, true);
      data.setFloat64(preparePtr + 8, finite(sampleRate, 48000), true);
      data.setUint32(preparePtr + 16, maxBlockFrames >>> 0, true);
      data.setUint32(preparePtr + 20, maxEvents >>> 0, true);
      data.setUint32(preparePtr + 24, 2, true);
      data.setUint32(preparePtr + 28, realtimeMemoryLimitBytes >>> 0, true);
      data.setUint32(preparePtr + 32, ((Number(track) + 1) * 2654435761) >>> 0, true);
      data.setUint32(preparePtr + 36, ((Number(instrumentId) + 1) * 2246822519) >>> 0, true);
      assertResult(module._brk_instance_prepare(handle, preparePtr), "brk_instance_prepare");

      const initialPatch = patchBytes(patchState);
      if (initialPatch?.byteLength) {
        if (initialPatch.byteLength > stateCapacity) throw new BrkSynthAbiError("state-too-large", `patch state exceeds ${stateCapacity} byte buffer`);
        module.HEAPU8.set(initialPatch, statePtr);
        assertResult(module._brk_instance_state_read(handle, statePtr, initialPatch.byteLength, Number(patchState.schemaVersion ?? manifest.stateSchemaVersion)), "brk_instance_state_read");
      }

      let boundAsset = null;
      if (assetExtensionVersion || assetRef || asset) {
        const span = spanForAsset(assetRef, asset);
        const bindingPtr = owned(ASSET_BINDING_BYTES, "asset binding");
        data = view(module);
        for (let index = 0; index < ASSET_BINDING_BYTES; index += 1) data.setUint8(bindingPtr + index, 0);
        data.setUint32(bindingPtr + 0, ASSET_BINDING_BYTES, true);
        data.setUint32(bindingPtr + 4, 0, true);
        data.setUint32(bindingPtr + 8, ASSET_FORMAT_PCM_S16_INTERLEAVED, true);
        data.setUint32(bindingPtr + 12, 0, true);
        data.setUint32(bindingPtr + 16, span.offset, true);
        data.setUint32(bindingPtr + 20, span.byteSize, true);
        data.setUint32(bindingPtr + 24, Number(span.ref.frameCount) >>> 0, true);
        data.setUint32(bindingPtr + 28, Number(span.ref.channelCount) >>> 0, true);
        data.setUint32(bindingPtr + 32, Number(span.ref.sampleRateHz) >>> 0, true);
        assertResult(module._brk_instance_asset_bind(handle, bindingPtr), "brk_instance_asset_bind");
        boundAsset = span;
      }
      assertResult(module._brk_instance_activate(handle), "brk_instance_activate");
      livePerformers += 1;

      const pending = [];
      const preparedType = new Uint8Array(maxEvents);
      const preparedOffset = new Uint32Array(maxEvents);
      const preparedPitch = new Float64Array(maxEvents);
      const preparedVelocity = new Float64Array(maxEvents);
      let preparedCount = 0;
      let preparedHighWater = 0;
      let actionOrder = 0;
      const parameterValues = new Map();
      const activeParameterRamps = new Map();
      const deferredParameters = new Map();
      let parameterEventsEncoded = 0;
      let parameterRampEventsEncoded = 0;
      let parameterEventsDeferred = 0;
      let parameterEventsCoalesced = 0;
      let nextNoteId = 1;
      let currentNoteId = 0;
      let currentNotePitch = 0;
      let currentNoteVelocity = 0;
      let destroyed = false;
      const emptyStartedRamps = Object.freeze([]);
      const preparedEncoded = { count: 0, byteLength: 0, startedRamps: emptyStartedRamps };

      const deferredParameterKey = (action) => `${String(action.parameterId ?? "")}\u0000${Number(action.sampleOffset ?? 0)}`;

      function deferParameterAction(action) {
        const key = deferredParameterKey(action);
        if (deferredParameters.has(key)) parameterEventsCoalesced += 1;
        deferredParameters.set(key, action);
        parameterEventsDeferred += 1;
      }

      function discardDeferredParameterActions(parameterId) {
        let discarded = 0;
        for (const [key, action] of deferredParameters) {
          if (String(action.parameterId ?? "") !== parameterId) continue;
          deferredParameters.delete(key);
          discarded += 1;
        }
        parameterEventsCoalesced += discarded;
        return discarded;
      }

      function pendingParameterIndex(parameterId, sampleOffset) {
        const key = String(parameterId ?? "");
        const offset = Number(sampleOffset ?? 0);
        return pending.findIndex((candidate) => candidate?.type === "parameter"
          && candidate.__snapshot !== true
          && String(candidate.parameterId ?? "") === key
          && Number(candidate.sampleOffset ?? 0) === offset);
      }

      function promoteEligibleDeferredParameters(frameCount) {
        for (const [deferredKey, action] of deferredParameters) {
          const key = String(action.parameterId ?? "");
          const remaining = Number(activeParameterRamps.get(key) ?? 0);
          const sampleOffset = Number(action.sampleOffset ?? 0);
          if (!Number.isInteger(sampleOffset) || sampleOffset < 0 || sampleOffset >= frameCount) continue;
          if (remaining > sampleOffset) continue;
          deferredParameters.delete(deferredKey);
          if (pendingParameterIndex(key, sampleOffset) >= 0) {
            parameterEventsCoalesced += 1;
            continue;
          }
          queueParameterAction(action);
        }
      }

      function withOrder(action) {
        const next = Object.freeze({ ...action, __r2Order: actionOrder });
        actionOrder += 1;
        return next;
      }

      function queueParameterAction(action) {
        const key = String(action.parameterId ?? "");
        const next = withOrder({ ...action, parameterId: key });
        const sampleOffset = Number(next.sampleOffset ?? 0);
        if (Number(activeParameterRamps.get(key) ?? 0) > sampleOffset) {
          deferParameterAction(next);
          return false;
        }
        const existing = pendingParameterIndex(key, sampleOffset);
        if (existing >= 0) {
          pending[existing] = next;
          parameterEventsCoalesced += 1;
        } else {
          const snapshot = pending.findIndex((candidate) => candidate?.type === "parameter"
            && candidate.__snapshot === true
            && String(candidate.parameterId ?? "") === key
            && Number(candidate.sampleOffset ?? 0) === sampleOffset);
          if (snapshot >= 0 && Number(next.rampFrames) <= 0) {
            pending[snapshot] = next;
            parameterEventsCoalesced += 1;
          } else pending.push(next);
        }
        return true;
      }

      function enqueueParameterSnapshot(snapshot, initial = false) {
        if (!snapshot || typeof snapshot !== "object") return 0;
        let count = 0;
        for (const [key, value] of Object.entries(snapshot)) {
          const parameter = params.get(String(key));
          if (!parameter) continue;
          const normalized = clamp(value, 0, 1);
          parameterValues.set(parameter.key, normalized);
          queueParameterAction({ type: "parameter", parameterId: parameter.key, value: normalized, rampFrames: 0, sampleOffset: 0, __snapshot: true, __initial: initial });
          count += 1;
        }
        return count;
      }

      enqueueParameterSnapshot(parameterSnapshot, true);

      const allocateNoteId = () => {
        const result = nextNoteId;
        nextNoteId = nextNoteId >= MAX_NOTE_ID ? 1 : nextNoteId + 1;
        return result;
      };

      function handleEvent(action) {
        if (destroyed) throw new BrkSynthAbiError("performer-destroyed", "cannot send events to a destroyed performer");
        if (action?.type === "parameter") queueParameterAction(action);
        else pending.push(withOrder(action));
      }

      function preparedPriority(typeCode) {
        return PRIORITY[PREPARED_ACTION_TYPE[typeCode]] ?? 99;
      }

      function preflightPreparedLifecycle(type, sampleOffset, pitch, velocity = 100) {
        if (destroyed) throw new BrkSynthAbiError("performer-destroyed", "cannot send prepared lifecycle to a destroyed performer");
        const typeCode = PREPARED_ACTION[type] ?? 0;
        if (typeCode === 0) throw new BrkSynthAbiError("prepared-lifecycle-type", `unsupported prepared lifecycle action ${String(type)}`);
        const offset = Math.round(Number(sampleOffset));
        if (!Number.isInteger(offset) || offset < 0 || offset >= maxBlockFrames) throw new BrkSynthAbiError("event-offset", `prepared lifecycle sample offset ${String(sampleOffset)} outside 0..${maxBlockFrames - 1}`);
        const note = Number(pitch);
        if (!Number.isFinite(note) || (type !== "note-off" && (note < 0 || note > 127))) throw new BrkSynthAbiError("prepared-lifecycle-pitch", `prepared lifecycle pitch ${String(pitch)} is invalid`);
        const normalizedVelocity = Number(velocity);
        if (!Number.isFinite(normalizedVelocity)) throw new BrkSynthAbiError("prepared-lifecycle-velocity", "prepared lifecycle velocity must be finite");
        if (preparedCount >= maxEvents) throw new BrkSynthAbiError("event-capacity", `performer prepared lifecycle capacity ${maxEvents} exceeded`, { count: preparedCount + 1 });
        if (preparedCount > 0) {
          const previous = preparedCount - 1;
          const previousOffset = preparedOffset[previous];
          const previousPriority = preparedPriority(preparedType[previous]);
          const nextPriority = preparedPriority(typeCode);
          if (offset < previousOffset || (offset === previousOffset && nextPriority < previousPriority)) {
            throw new BrkSynthAbiError("prepared-lifecycle-order", "prepared lifecycle must arrive in non-decreasing sampleOffset/priority order", {
              previousOffset,
              previousPriority,
              offset,
              priority: nextPriority,
            });
          }
        }
        return true;
      }

      function handlePreparedLifecycle(type, sampleOffset, pitch, velocity = 100) {
        preflightPreparedLifecycle(type, sampleOffset, pitch, velocity);
        const index = preparedCount;
        preparedType[index] = PREPARED_ACTION[type];
        preparedOffset[index] = Math.round(Number(sampleOffset));
        preparedPitch[index] = Number(pitch);
        preparedVelocity[index] = Number(velocity);
        preparedCount += 1;
        if (preparedCount > preparedHighWater) preparedHighWater = preparedCount;
        return preparedCount;
      }

      function encodePreparedAt(index, frameCount, cursor) {
        const frameOffset = preparedOffset[index];
        if (frameOffset >= frameCount) throw new BrkSynthAbiError("event-offset", `prepared lifecycle sample offset ${frameOffset} outside block ${frameCount}`);
        const type = PREPARED_ACTION_TYPE[preparedType[index]];
        if (type === "note-on") {
          currentNoteId = allocateNoteId();
          currentNotePitch = clamp(preparedPitch[index], 0, 127);
          currentNoteVelocity = clamp(Number(preparedVelocity[index] ?? 100) / 127, 0, 1);
          return cursor + writeNote(data, cursor, EVENT.NOTE_ON, frameOffset, currentNoteId, currentNotePitch, currentNoteVelocity, 0);
        }
        if (type === "note-off") {
          if (currentNoteId === 0) return cursor;
          return cursor + writeNote(data, cursor, EVENT.NOTE_OFF, frameOffset, currentNoteId, currentNotePitch, currentNoteVelocity, 0);
        }
        if (type === "retrigger") {
          if (currentNoteId === 0) return cursor;
          return cursor + writeNote(data, cursor, EVENT.RETRIGGER, frameOffset, currentNoteId, currentNotePitch, currentNoteVelocity, 0);
        }
        throw new BrkSynthAbiError("prepared-lifecycle-type", `unsupported prepared lifecycle action ${String(type)}`);
      }

      function encodePreparedOnly(frameCount) {
        data = view(module);
        let cursor = eventPtr;
        let count = 0;
        for (let index = 0; index < preparedCount; index += 1) {
          const previous = cursor;
          cursor = encodePreparedAt(index, frameCount, cursor);
          if (cursor !== previous) count += 1;
        }
        preparedEncoded.count = count;
        preparedEncoded.byteLength = cursor - eventPtr;
        return preparedEncoded;
      }

      function preparedBeforeAction(preparedIndex, action) {
        const preparedFrame = preparedOffset[preparedIndex];
        const actionFrame = Math.round(Number(action?.sampleOffset ?? 0));
        if (preparedFrame !== actionFrame) return preparedFrame < actionFrame;
        return preparedPriority(preparedType[preparedIndex]) <= actionPriority(action);
      }

      function encodeActions(frameCount) {
        if (pending.length === 0 && activeParameterRamps.size === 0 && deferredParameters.size === 0) {
          return encodePreparedOnly(frameCount);
        }
        promoteEligibleDeferredParameters(frameCount);
        if (pending.length + preparedCount > maxEvents) {
          throw new BrkSynthAbiError("event-capacity", `performer event capacity ${maxEvents} exceeded`, { count: pending.length + preparedCount });
        }
        sortActionsInPlace(pending);
        data = view(module);
        let cursor = eventPtr;
        let count = 0;
        let pendingIndex = 0;
        let preparedIndex = 0;
        const startedRamps = [];
        const currentBlockRampEnds = new Map(activeParameterRamps);
        while (pendingIndex < pending.length || preparedIndex < preparedCount) {
          const action = pending[pendingIndex] ?? null;
          if (preparedIndex < preparedCount && (action === null || preparedBeforeAction(preparedIndex, action))) {
            const previous = cursor;
            cursor = encodePreparedAt(preparedIndex, frameCount, cursor);
            if (cursor !== previous) count += 1;
            preparedIndex += 1;
            continue;
          }

          pendingIndex += 1;
          const frameOffset = Math.round(Number(action?.sampleOffset ?? 0));
          if (!Number.isInteger(frameOffset) || frameOffset < 0 || frameOffset >= frameCount) throw new BrkSynthAbiError("event-offset", `event sample offset ${frameOffset} outside block ${frameCount}`);
          if (action.type === "note-on") {
            currentNoteId = allocateNoteId();
            currentNotePitch = clamp(action.pitch, 0, 127);
            currentNoteVelocity = clamp(Number(action.velocity ?? 100) / 127, 0, 1);
            cursor += writeNote(data, cursor, EVENT.NOTE_ON, frameOffset, currentNoteId, currentNotePitch, currentNoteVelocity, 0);
          } else if (action.type === "note-off") {
            if (currentNoteId === 0) continue;
            cursor += writeNote(data, cursor, EVENT.NOTE_OFF, frameOffset, currentNoteId, currentNotePitch, currentNoteVelocity, 0);
          } else if (action.type === "retrigger") {
            if (currentNoteId === 0) continue;
            cursor += writeNote(data, cursor, EVENT.RETRIGGER, frameOffset, currentNoteId, currentNotePitch, currentNoteVelocity, 0);
          } else if (action.type === "kill") {
            if (currentNoteId === 0) continue;
            cursor += writeNote(data, cursor, EVENT.NOTE_CHOKE, frameOffset, currentNoteId, currentNotePitch, currentNoteVelocity, 0);
            currentNoteId = 0;
          } else if (action.type === "all-notes-off") {
            writeHeader(data, cursor, EVENT_SIZE.HEADER, EVENT.ALL_NOTES_OFF, frameOffset);
            cursor += EVENT_SIZE.HEADER;
            currentNoteId = 0;
          } else if (action.type === "reset") {
            writeHeader(data, cursor, EVENT_SIZE.HEADER, EVENT.RESET, frameOffset);
            cursor += EVENT_SIZE.HEADER;
            currentNoteId = 0;
          } else if (action.type === "parameter") {
            const parameter = params.get(String(action.parameterId));
            if (!parameter) throw new BrkSynthAbiError("unknown-parameter", `unknown stable parameter id ${action.parameterId}`);
            if (Number(currentBlockRampEnds.get(parameter.key) ?? 0) > frameOffset) {
              deferParameterAction(action);
              continue;
            }
            discardDeferredParameterActions(parameter.key);
            const next = clamp(action.value, 0, 1);
            const previous = parameterValues.has(parameter.key) ? parameterValues.get(parameter.key) : parameter.defaultValue;
            if (Number(action.rampFrames) > 0) {
              const durationFrames = Math.max(1, Math.round(Number(action.rampFrames)));
              cursor += writeRamp(data, cursor, frameOffset, parameter, previous, next, durationFrames);
              parameterRampEventsEncoded += 1;
              startedRamps.push(Object.freeze({ key: parameter.key, frameOffset, durationFrames }));
              currentBlockRampEnds.set(parameter.key, frameOffset + durationFrames);
            } else cursor += writeParameter(data, cursor, frameOffset, parameter, next);
            parameterEventsEncoded += 1;
            parameterValues.set(parameter.key, next);
          } else {
            throw new BrkSynthAbiError("unsupported-action", `unsupported BRK Synth action ${action.type}`);
          }
          count += 1;
        }
        return { count, byteLength: cursor - eventPtr, startedRamps };
      }

      function advanceParameterRamps(frameCount, startedRamps) {
        for (const [key, remaining] of activeParameterRamps) {
          const next = Math.max(0, Number(remaining) - frameCount);
          if (next > 0) activeParameterRamps.set(key, next);
          else activeParameterRamps.delete(key);
        }
        for (const ramp of startedRamps) {
          const rendered = Math.max(0, frameCount - ramp.frameOffset);
          const remaining = Math.max(0, ramp.durationFrames - rendered);
          if (remaining > 0) activeParameterRamps.set(ramp.key, remaining);
          else activeParameterRamps.delete(ramp.key);
        }
      }

      function process({ frameCount, left, right, accumulate = true } = {}) {
        const frames = Math.round(Number(frameCount));
        if (!Number.isInteger(frames) || frames < 1 || frames > maxBlockFrames) throw new BrkSynthAbiError("block-size", `frame count ${frames} outside 1..${maxBlockFrames}`);
        if (!(left instanceof Float32Array) || !(right instanceof Float32Array) || left.length < frames || right.length < frames) throw new TypeError("BRK performer process requires Float32Array left/right outputs");
        const encoded = encodeActions(frames);
        data = view(module);
        for (let index = 0; index < 24; index += 1) data.setUint8(audioSpanPtr + index, 0);
        data.setUint32(audioSpanPtr + 0, 24, true);
        data.setUint32(audioSpanPtr + 4, outputPtr >>> 0, true);
        data.setUint32(audioSpanPtr + 8, 2, true);
        data.setUint32(audioSpanPtr + 12, maxBlockFrames >>> 0, true);
        data.setUint32(audioSpanPtr + 16, maxBlockFrames >>> 0, true);
        for (let index = 0; index < 64; index += 1) data.setUint8(processPtr + index, 0);
        data.setUint32(processPtr + 0, 64, true);
        data.setUint32(processPtr + 4, frames >>> 0, true);
        data.setUint32(processPtr + 8, audioSpanPtr >>> 0, true);
        data.setUint32(processPtr + 12, eventPtr >>> 0, true);
        data.setUint32(processPtr + 16, encoded.byteLength >>> 0, true);
        data.setUint32(processPtr + 20, encoded.count >>> 0, true);
        data.setUint32(processPtr + 24, 0, true);
        data.setUint32(processPtr + 28, 1, true);
        assertResult(module._brk_instance_process(handle, processPtr), "brk_instance_process");
        const heap = module.HEAPF32;
        const leftStart = outputPtr >>> 2;
        const rightStart = leftStart + maxBlockFrames;
        for (let frame = 0; frame < frames; frame += 1) {
          const l = Number.isFinite(heap[leftStart + frame]) ? heap[leftStart + frame] : 0;
          const r = Number.isFinite(heap[rightStart + frame]) ? heap[rightStart + frame] : 0;
          if (accumulate) { left[frame] += l; right[frame] += r; }
          else { left[frame] = l; right[frame] = r; }
        }
        pending.length = 0;
        preparedCount = 0;
        advanceParameterRamps(frames, encoded.startedRamps);
      }

      function applyState(next = {}) {
        if (destroyed) return;
        const bytes = patchBytes(next.patchState);
        if (bytes?.byteLength) {
          if (bytes.byteLength > stateCapacity) throw new BrkSynthAbiError("state-too-large", `patch state exceeds ${stateCapacity} byte buffer`);
          assertResult(module._brk_instance_deactivate(handle), "brk_instance_deactivate");
          module.HEAPU8.set(bytes, statePtr);
          try { assertResult(module._brk_instance_state_read(handle, statePtr, bytes.byteLength, Number(next.patchState.schemaVersion ?? manifest.stateSchemaVersion)), "brk_instance_state_read"); }
          finally { assertResult(module._brk_instance_activate(handle), "brk_instance_activate"); }
          pending.length = 0;
          preparedCount = 0;
          parameterValues.clear();
          activeParameterRamps.clear();
          deferredParameters.clear();
          currentNoteId = 0;
        }
        enqueueParameterSnapshot(next.parameterSnapshot, false);
      }

      function reset() {
        if (destroyed) return;
        assertResult(module._brk_instance_reset(handle), "brk_instance_reset");
        pending.length = 0;
        preparedCount = 0;
        activeParameterRamps.clear();
        deferredParameters.clear();
        currentNoteId = 0;
      }

      function destroy() {
        if (destroyed) return;
        try { module._brk_instance_deactivate(handle); } catch {}
        if (boundAsset && typeof module._brk_instance_asset_unbind === "function") {
          assertResult(module._brk_instance_asset_unbind(handle, 0), "brk_instance_asset_unbind");
        }
        assertResult(module._brk_instance_destroy(handle), "brk_instance_destroy");
        for (const ptr of pointers) { try { module._free?.(ptr); } catch {} }
        destroyed = true;
        livePerformers = Math.max(0, livePerformers - 1);
      }

      return Object.freeze({ handleEvent, preflightPreparedLifecycle, handlePreparedLifecycle, process, applyState, reset, destroy, diagnostics: () => Object.freeze({
        handle,
        pendingEvents: pending.length,
        preparedLifecyclePending: preparedCount,
        preparedLifecycleHighWater: preparedHighWater,
        currentNoteId: currentNoteId || null,
        maxBlockFrames,
        maxEvents,
        parameterEventsEncoded,
        parameterRampEventsEncoded,
        parameterEventsDeferred,
        parameterEventsCoalesced,
        activeParameterRampCount: activeParameterRamps.size,
        deferredParameterCount: deferredParameters.size,
        parameterValues: Object.freeze(Object.fromEntries([...parameterValues.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))),
        moduleInstanceCapacity: declaredInstances,
        capabilitySource: capability.source,
        capabilityExplicit: capability.explicit,
        stagingMode: "per-performer",
        stagingBytes: stagingBytesPerPerformer,
        assetExtensionVersion: assetExtensionVersion || null,
        assetSha256: boundAsset?.sha256 ?? null,
        assetBytes: boundAsset?.byteSize ?? 0,
        wasmMemoryBytes: module.HEAPU8?.buffer?.byteLength ?? null,
      }) });
      } catch (error) {
        if (handle > 0) {
          try { module._brk_instance_deactivate?.(handle); } catch {}
          try { module._brk_instance_destroy?.(handle); } catch {}
        }
        for (const ptr of pointers) { try { module._free?.(ptr); } catch {} }
        throw error;
      }
    }
    makePerformer.diagnostics = () => Object.freeze({
      livePerformers,
      moduleInstanceCapacity: declaredInstances,
      capabilitySource: capability.source,
      capabilityExplicit: capability.explicit,
      stagingMode: "per-performer",
      stagingBytesPerPerformer,
      stagingBytesTotal: stagingBytesPerPerformer * livePerformers,
      assetExtensionVersion: assetExtensionVersion || null,
      assetSpanCount: assetSpans.size,
      assetBytesStored,
      assetArenaBytes: (assetArena?.byteCapacity ?? Number(manifest?.runtime?.assetArenaBytes ?? 0)) || null,
      wasmMemoryBytes: module.HEAPU8?.buffer?.byteLength ?? null,
    });
    return Object.freeze(makePerformer);
  }

  const records = new Map();

  // --- ABI descriptor surface ------------------------------------------------
  // BRK ABI v1 exposes brk_module_descriptor / brk_engine_descriptor /
  // brk_parameter_descriptor so a host can ask the engine binary what its
  // parameters are instead of trusting a JSON file that can drift from the DSP.
  // Nothing here read them, so BRKTRK ran engines without ever asking: a real
  // engine's cutoff carries no range and no unit in its package JSON - the
  // range lives in the binary - and the Sound surface could only print a
  // percentage. See #455.
  //
  // This reads them and records what it finds. It changes no behaviour: the
  // values are exposed on the runtime record for a later consumer, and an
  // engine that does not implement the calls is registered exactly as before.
  const STRING_REF_BYTES = 8;
  const MODULE_DESCRIPTOR_BYTES = 84;
  const ENGINE_DESCRIPTOR_BYTES = 76;
  // Fixed by the ABI, not chosen here.
  const PARAMETER_DESCRIPTOR_BYTES = 96;
  const DESCRIPTOR_SCRATCH_BYTES = 256;
// Discovery bound for an engine that reports no parameter count at all.
const PARAMETER_READ_LIMIT = 4096;

  // AudioWorkletGlobalScope has no TextDecoder. It exposes the ECMAScript
  // built-ins, WebAssembly and the worklet API and very little else - no
  // TextEncoder, atob, setTimeout or queueMicrotask either (measured in
  // Chromium; see worklet-global-scope-contract.test.cjs). Node has all of
  // them, which is how `new TextDecoder()` here passed every test while
  // throwing in every real browser: inside the try in readModuleDescriptors,
  // so the read silently returned null and no engine's descriptors ever
  // reached the Sound surface.
  //
  // This is the WHATWG UTF-8 decode algorithm, so it yields exactly what a
  // non-fatal TextDecoder would, U+FFFD replacement included. It runs once per
  // package registration over short descriptor strings, never per block.
  function decodeUtf8(bytes) {
    const codePoints = [];
    let needed = 0;
    let seen = 0;
    let codePoint = 0;
    let lower = 0x80;
    let upper = 0xbf;
    for (let index = 0; index < bytes.length; index += 1) {
      const byte = bytes[index];
      if (needed === 0) {
        if (byte <= 0x7f) codePoints.push(byte);
        else if (byte >= 0xc2 && byte <= 0xdf) { needed = 1; codePoint = byte & 0x1f; }
        else if (byte >= 0xe0 && byte <= 0xef) {
          if (byte === 0xe0) lower = 0xa0;
          if (byte === 0xed) upper = 0x9f;
          needed = 2;
          codePoint = byte & 0x0f;
        } else if (byte >= 0xf0 && byte <= 0xf4) {
          if (byte === 0xf0) lower = 0x90;
          if (byte === 0xf4) upper = 0x8f;
          needed = 3;
          codePoint = byte & 0x07;
        } else codePoints.push(0xfffd);
        continue;
      }
      if (byte < lower || byte > upper) {
        // The broken sequence becomes one replacement character and this byte
        // is read again as the start of whatever follows.
        needed = 0;
        seen = 0;
        codePoint = 0;
        lower = 0x80;
        upper = 0xbf;
        codePoints.push(0xfffd);
        index -= 1;
        continue;
      }
      lower = 0x80;
      upper = 0xbf;
      codePoint = (codePoint << 6) | (byte & 0x3f);
      seen += 1;
      if (seen === needed) {
        codePoints.push(codePoint);
        needed = 0;
        seen = 0;
        codePoint = 0;
      }
    }
    if (needed !== 0) codePoints.push(0xfffd);
    let text = "";
    for (let start = 0; start < codePoints.length; start += 4096) {
      text += String.fromCodePoint(...codePoints.slice(start, start + 4096));
    }
    return text;
  }

  // Every read re-derives the heap view rather than caching one. An Emscripten
  // module that grows its memory replaces HEAPU8 and detaches any DataView
  // built over the old buffer, so a cached view would either throw or read
  // stale bytes on a growth-enabled engine. This runs once per package
  // registration, never per audio block, so the re-derivation costs nothing
  // that matters.
  function descriptorReader(module) {
    if (typeof module?._malloc !== "function") return null;
    const heapNow = () => {
      const heap = module.HEAPU8;
      return heap instanceof Uint8Array ? heap : null;
    };
    if (!heapNow()) return null;
    const viewNow = () => new DataView(heapNow().buffer);
    return {
      u32: (offset) => viewNow().getUint32(offset, true),
      f32: (offset) => viewNow().getFloat32(offset, true),
      // brk_string_ref is {offset u32, byte_size u32} into this module's heap.
      text: (offset) => {
        const heap = heapNow();
        const view = new DataView(heap.buffer);
        const at = view.getUint32(offset, true);
        const size = view.getUint32(offset + 4, true);
        if (!size || at <= 0 || at + size > heap.length) return "";
        return decodeUtf8(heap.subarray(at, at + size));
      },
    };
  }

  // Reads what the engine says about itself. Returns null when the engine does
  // not implement the descriptor calls, which is not an error: those engines
  // keep working exactly as they did, on their package JSON alone.
  function readModuleDescriptors(module, engineIndex = 0) {
    if (typeof module?._brk_parameter_descriptor !== "function") return null;
    // A package selects its engine with manifest.engineIndex, and performers
    // are created with it. Reading engine 0 regardless would attach one
    // engine's ids, ranges and units to a runtime playing another.
    const engine = Number.isSafeInteger(Number(engineIndex)) && Number(engineIndex) >= 0 ? Number(engineIndex) : 0;
    let scratch = 0;
    try {
      // Allocate before building the reader: _malloc is what may grow memory.
      scratch = Number(module._malloc(DESCRIPTOR_SCRATCH_BYTES));
      if (!Number.isSafeInteger(scratch) || scratch <= 0) return null;
      const reader = descriptorReader(module);
      if (!reader) return null;

      let moduleDescriptor = null;
      if (typeof module._brk_module_descriptor === "function"
        && Number(module._brk_module_descriptor(scratch, DESCRIPTOR_SCRATCH_BYTES)) === MODULE_DESCRIPTOR_BYTES) {
        moduleDescriptor = Object.freeze({
          engineCount: reader.u32(scratch + 12),
          moduleId: reader.text(scratch + 16),
          displayName: reader.text(scratch + 16 + STRING_REF_BYTES),
          vendorName: reader.text(scratch + 16 + STRING_REF_BYTES * 2),
          licenseId: reader.text(scratch + 16 + STRING_REF_BYTES * 3),
        });
      }

      let engineDescriptor = null;
      if (typeof module._brk_engine_descriptor === "function"
        && Number(module._brk_engine_descriptor(engine, scratch, DESCRIPTOR_SCRATCH_BYTES)) === ENGINE_DESCRIPTOR_BYTES) {
        engineDescriptor = Object.freeze({
          engineId: reader.text(scratch + 8),
          displayName: reader.text(scratch + 8 + STRING_REF_BYTES),
          outputChannelCount: reader.u32(scratch + 24),
          parameterCount: reader.u32(scratch + 28),
          stateSchemaVersion: reader.u32(scratch + 32),
          maxPolyphony: reader.u32(scratch + 36),
        });
      }

      const parameters = [];
      // Bounded by the engine's own reported count when it gave one, so a
      // malformed descriptor cannot spin here.
      const declared = Number(engineDescriptor?.parameterCount);
      const hasDeclaredCount = Number.isSafeInteger(declared) && declared > 0;
      // An engine declaring more parameters than this reader will ever read is
      // an unsupported descriptor set, not a reason to read the first
      // PARAMETER_READ_LIMIT and call them complete: that would recreate
      // exactly the silent partial read the completeness check below exists to
      // prevent, with the truncation hidden because the declared count was
      // discarded on the way in.
      if (hasDeclaredCount && declared > PARAMETER_READ_LIMIT) return null;
      const limit = hasDeclaredCount ? declared : PARAMETER_READ_LIMIT;
      for (let index = 0; index < limit; index += 1) {
        if (Number(module._brk_parameter_descriptor(engine, index, scratch, DESCRIPTOR_SCRATCH_BYTES)) !== PARAMETER_DESCRIPTOR_BYTES) break;
        const key = reader.text(scratch + 16);
        if (!key) break;
        parameters.push(Object.freeze({
          key,
          abiId: reader.u32(scratch + 4),
          parameterType: reader.u32(scratch + 8),
          flags: reader.u32(scratch + 12),
          displayName: reader.text(scratch + 16 + STRING_REF_BYTES),
          unit: reader.text(scratch + 16 + STRING_REF_BYTES * 2),
          groupKey: reader.text(scratch + 16 + STRING_REF_BYTES * 3),
          normalizedDefault: reader.f32(scratch + 48),
          plainMin: reader.f32(scratch + 52),
          plainMax: reader.f32(scratch + 56),
          plainStep: reader.f32(scratch + 60),
          enumValueCount: reader.u32(scratch + 64),
        }));
      }
      if (!parameters.length) return null;
      // A partial read is worse than none. An engine declaring 89 parameters
      // that fails at index 40 would otherwise be recorded as having 40, and a
      // consumer treating descriptors as authoritative would silently drop the
      // rest of its controls. Take the whole set or nothing.
      if (hasDeclaredCount && parameters.length !== declared) return null;
      return Object.freeze({
        module: moduleDescriptor,
        engine: engineDescriptor,
        parameters: Object.freeze(parameters),
      });
    } catch {
      // A package that cannot describe itself must still play. Descriptors are
      // presentation truth; refusing to register the runtime over them would
      // trade sound for a label.
      return null;
    } finally {
      if (scratch && typeof module._free === "function") {
        try { module._free(scratch); } catch { /* allocator is the module's own business */ }
      }
    }
  }

  function registerModuleRuntime({ entry, manifest, module } = {}) {
    if (!entry || !manifest || !module) throw new TypeError("registerModuleRuntime requires entry, manifest and Emscripten module");
    const reportedAbi = Number(module._brk_abi_version?.());
    if (reportedAbi !== ABI_VERSION) throw new BrkSynthAbiError("abi-version", `runtime reports ABI ${reportedAbi}, expected ${ABI_VERSION}`);
    const key = runtimeKey(entry);
    if (!entry.moduleId || !entry.engineId || !entry.version) throw new BrkSynthAbiError("runtime-identity", "registered runtime requires moduleId/engineId/version");
    if (records.has(key)) throw new BrkSynthAbiError("duplicate-runtime", `runtime ${entry.moduleId}/${entry.engineId}@${entry.version} already registered`);
    const record = Object.freeze({
      key,
      entry: Object.freeze({ ...entry }),
      manifest: Object.freeze({ ...manifest }),
      module,
      // null for an engine that does not implement the descriptor calls.
      abiDescriptors: readModuleDescriptors(module, manifest?.engineIndex),
    });
    records.set(key, record);
    clearRegistrationFailure(entry);
    return record;
  }

  const runtimeRecords = () => Object.freeze([...records.values()]);
  const recordFor = (entry) => records.get(runtimeKey(entry)) ?? null;

  // A registration that throws inside the host-composed module's top-level
  // await is an uncaught Worklet exception: audioWorklet.addModule() still
  // resolves, and the host used to wait out its whole registry-proof timeout
  // and then report a generic "did not acknowledge". The composed module
  // records the engine's own reason here (production-engine-host.js,
  // buildWorkletModuleSource); the registry probe returns it so the host can
  // fail at once and say why. Keyed by full package identity, bounded, and
  // cleared when the same package later registers.
  const REGISTRATION_FAILURE_LIMIT = 16;
  const registrationFailureMap = new Map();
  const failureKey = (entry) => `${runtimeKey(entry)}\u0000${String(entry?.packageSha256 ?? "").trim().toLowerCase()}`;
  function recordRegistrationFailure(entry, error) {
    const key = failureKey(entry);
    registrationFailureMap.delete(key);
    registrationFailureMap.set(key, Object.freeze({
      moduleId: String(entry?.moduleId ?? ""),
      engineId: String(entry?.engineId ?? ""),
      version: String(entry?.version ?? ""),
      packageSha256: String(entry?.packageSha256 ?? "").trim().toLowerCase(),
      code: String(error?.code ?? error?.name ?? "engine-registration-failed"),
      message: String(error?.message ?? error),
    }));
    while (registrationFailureMap.size > REGISTRATION_FAILURE_LIMIT) {
      registrationFailureMap.delete(registrationFailureMap.keys().next().value);
    }
    return registrationFailureMap.get(key);
  }
  const clearRegistrationFailure = (entry) => registrationFailureMap.delete(failureKey(entry));
  const registrationFailures = () => Object.freeze([...registrationFailureMap.values()]);

  const api = Object.freeze({ ABI_VERSION, EVENT, EVENT_SIZE, DEFAULT_MAX_BLOCK_FRAMES, DEFAULT_MAX_EVENTS_PER_PERFORMER, BrkSynthAbiError, base64Bytes, parameterMap, sortActions, createPerformerFactory, registerModuleRuntime, runtimeRecords, recordFor, readModuleDescriptors, decodeUtf8, recordRegistrationFailure, clearRegistrationFailure, registrationFailures });
  globalThis.BRKTRKBrkSynthAbiV1Runtime = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
