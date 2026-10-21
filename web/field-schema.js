(() => {
  const EMPTY = -1;
  const NOTE_OFF = -2;

  const clampValue = (value, min, max) => Math.min(max, Math.max(min, value));
  const hex = (value) => Math.max(0, Number(value) || 0).toString(16).toUpperCase().padStart(2, "0");

  function projectStore(env) {
    const store = env.projectStore ?? globalThis.BRKTRKStores?.project;
    if (!store) throw new Error("ProjectStore is required for project fields");
    return store;
  }

  function phraseStepDomain(env) {
    const domain = projectStore(env).phraseSteps;
    if (!domain) throw new Error("ProjectStore Phrase-step domain is required for Phrase fields");
    return domain;
  }

  function navigationEntry(env) {
    return env.navigationEntry
      ?? env.navigationStore?.entryState
      ?? globalThis.BRKTRKStores?.navigation?.entryState
      ?? null;
  }

  function requiredNavigationEntry(env) {
    const entryState = navigationEntry(env);
    if (!entryState) throw new Error("NavigationStore entry state is required for prepared Note fields");
    return entryState;
  }

  function soundEditRenderer(env) {
    return env.soundEditRenderer ?? globalThis.BRKTRKSoundEditRenderer ?? null;
  }

  function selectedProductionParameter(env) {
    return soundEditRenderer(env)?.selectedParameterContext?.(
      env.state.instrument,
      env.state.p3?.soundParam ?? 0,
    ) ?? null;
  }

  function intent(direction) {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(direction)) return null;
    return {
      delta: direction === "ArrowRight" || direction === "ArrowUp" ? 1 : -1,
      magnitude: direction === "ArrowUp" || direction === "ArrowDown" ? "coarse" : "fine",
    };
  }

  function currentPitch(env) {
    const octave = navigationEntry(env)?.getPreparedEntry().octave
      ?? (Number.isInteger(env.state.p3?.noteOctave) ? env.state.p3.noteOctave : 4);
    return clampValue((octave + 1) * 12, 0, 127);
  }

  function preparedVelocity(env) {
    const value = navigationEntry(env)?.getPreparedEntry().velocity ?? env.state.p3?.nextVelocity ?? 100;
    return clampValue(Number(value), 1, 127);
  }

  function preparedInstrument(env) {
    const raw = Number(navigationEntry(env)?.getPreparedEntry().instrument ?? env.state.p3?.nextInstrument ?? env.state.instrument ?? 0);
    return raw < 0 ? EMPTY : clampValue(Math.round(raw), 0, 255);
  }

  function referenceExists(env, descriptor, value) {
    if (!descriptor.referenceKind || value < 0) return false;
    if (descriptor.referenceKind === "chain") return Object.hasOwn(env.model.chains, value);
    if (descriptor.referenceKind === "phrase") return Object.hasOwn(env.model.phrases, value);
    if (descriptor.referenceKind === "instrument") return Boolean(env.model.instrumentPool?.[value]);
    return false;
  }

  function inboundReferenceIds(env, referenceKind) {
    const referenced = new Set();
    if (referenceKind === "chain") {
      for (const row of env.model.song ?? []) {
        for (const value of row ?? []) {
          if (Number.isInteger(value) && value >= 0 && value <= 255) referenced.add(value);
        }
      }
    } else if (referenceKind === "phrase") {
      for (const chain of Object.values(env.model.chains ?? {})) {
        for (const entry of chain ?? []) {
          const value = entry?.phrase;
          if (Number.isInteger(value) && value >= 0 && value <= 255) referenced.add(value);
        }
      }
    }
    return referenced;
  }

  function firstMissingReference(collection, excluded = null, limit = 256) {
    if (!collection || typeof collection !== "object") return null;
    const blocked = excluded instanceof Set ? excluded : new Set();
    for (let id = 0; id < limit; id += 1) {
      if (!Object.hasOwn(collection, id) && !blocked.has(id)) return id;
    }
    return null;
  }

  function ensureReference(env, descriptor, value) {
    if (value < 0 || !descriptor.referenceKind) return;
    if (descriptor.referenceKind === "chain") env.chain(value, true);
    if (descriptor.referenceKind === "phrase") env.phrase(value, true);
  }

  function chainEntry(env, cursor, create = false) {
    const source = env.chain(env.state.chain, create);
    return source?.[cursor.row] ?? null;
  }

  function phraseStep(env, cursor, create = false) {
    const source = env.phrase(env.state.phrase, create);
    return source?.[cursor.row] ?? null;
  }

  function phraseCondition(env, cursor = env.state.focus) {
    return phraseStepDomain(env).read(env.state.phrase, cursor.row).condition;
  }

  function writePhraseConditionField(env, cursor, field, value, options = {}) {
    const before = phraseCondition(env, cursor);
    const mutation = phraseStepDomain(env).setCondition(
      env.state.phrase,
      cursor.row,
      { ...before, [field]: value },
      options,
    );
    return { value: mutation.after[field], mutated: mutation.mutated, changeSet: mutation.changeSet };
  }

  const descriptors = [
    {
      id: "song.chainRef", pane: "song", columns: "any", type: "reference", referenceKind: "chain",
      editorKind: "reference", radix: 16, min: 0, max: 255, fineStep: 1, coarseStep: 16,
      defaultValue: 0, emptyValue: EMPTY, changeKind: "structure", affectsPlayback: true, persistsProject: true,
      read: (env, cursor) => env.model.song[cursor.row][cursor.col],
      write(env, cursor, value, options = {}) {
        const next = value < 0 ? EMPTY : clampValue(Math.round(value), 0, 255);
        env.model.song[cursor.row][cursor.col] = next;
        if (next >= 0) {
          env.state.chain = next;
          env.state.lastChain = next;
          if (options.createMissing) ensureReference(env, this, next);
        }
        return next;
      },
      insertSeed: (env) => env.state.lastChain ?? 0,
      freshId: (env) => firstMissingReference(env.model.chains, inboundReferenceIds(env, "chain")),
    },
    {
      id: "chain.phraseRef", pane: "chain", columns: [0], type: "reference", referenceKind: "phrase",
      editorKind: "reference", radix: 16, min: 0, max: 255, fineStep: 1, coarseStep: 16,
      defaultValue: 0, emptyValue: EMPTY, changeKind: "structure", affectsPlayback: true, persistsProject: true,
      read: (env, cursor) => chainEntry(env, cursor, false)?.phrase ?? EMPTY,
      write(env, cursor, value, options = {}) {
        const entry = chainEntry(env, cursor, true);
        const next = value < 0 ? EMPTY : clampValue(Math.round(value), 0, 255);
        entry.phrase = next;
        if (next >= 0) {
          env.state.phrase = next;
          env.state.lastPhrase = next;
          if (options.createMissing) ensureReference(env, this, next);
        }
        return next;
      },
      insertSeed: (env) => env.state.lastPhrase ?? 0,
      freshId: (env) => firstMissingReference(env.model.phrases, inboundReferenceIds(env, "phrase")),
    },
    {
      id: "chain.transpose", pane: "chain", columns: [1], type: "integer", editorKind: "numeric",
      radix: 10, min: -48, max: 48, fineStep: 1, coarseStep: 12, defaultValue: 0,
      changeKind: "structure", affectsPlayback: true, persistsProject: true,
      read: (env, cursor) => chainEntry(env, cursor, false)?.transpose ?? 0,
      write: (env, cursor, value) => {
        const entry = chainEntry(env, cursor, true);
        entry.transpose = clampValue(Math.round(value), -48, 48);
        return entry.transpose;
      },
    },
    {
      id: "phrase.note", pane: "phrase", columns: [0], type: "note", editorKind: "note",
      radix: 10, min: 0, max: 127, fineStep: 1, coarseStep: 12, defaultValue: 48,
      emptyValue: EMPTY, noteOffValue: NOTE_OFF, changeKind: "note", affectsPlayback: true, persistsProject: true,
      read: (env, cursor) => phraseStep(env, cursor, false)?.note ?? EMPTY,
      write: (env, cursor, value, options = {}) => {
        const mutation = phraseStepDomain(env).setField(env.state.phrase, cursor.row, "note", value, options);
        if (mutation.after >= 0) {
          const octave = Math.floor(mutation.after / 12) - 1;
          requiredNavigationEntry(env).setPreparedValue("octave", octave, { source: options.source ?? "field-schema-note" });
        }
        return mutation;
      },
      insertSeed: currentPitch,
    },
    {
      id: "phrase.velocity", pane: "phrase", columns: [1], type: "integer", editorKind: "numeric",
      radix: 10, min: 1, max: 127, fineStep: 1, coarseStep: 10, defaultValue: 100,
      changeKind: "note", affectsPlayback: true, persistsProject: true,
      read: (env, cursor) => phraseStep(env, cursor, false)?.velocity ?? 100,
      write: (env, cursor, value, options = {}) => phraseStepDomain(env).setField(env.state.phrase, cursor.row, "velocity", value, options),
    },
    {
      id: "phrase.instrument", pane: "phrase", columns: [2], type: "reference", referenceKind: "instrument",
      editorKind: "reference", radix: 16, min: 0, max: 255, fineStep: 1, coarseStep: 16,
      defaultValue: 0, emptyValue: EMPTY, changeKind: "note", affectsPlayback: true, persistsProject: true,
      read: (env, cursor) => phraseStep(env, cursor, false)?.instrument ?? EMPTY,
      write: (env, cursor, value, options = {}) => phraseStepDomain(env).setField(env.state.phrase, cursor.row, "instrument", value, options),
      insertSeed: (env) => env.state.instrument ?? 0,
    },
    ...[0, 1, 2].map((fxIndex) => ({
      id: `phrase.fx${fxIndex + 1}`, pane: "phrase", columns: [fxIndex + 3], type: "fx-command", editorKind: "fx",
      slotIndex: fxIndex, radix: 16, min: 0, max: 255, fineStep: 1, coarseStep: 16, defaultValue: 0,
      changeKind: "parameter", affectsPlayback: false, persistsProject: true,
      read: (env, cursor) => phraseStepDomain(env).readFxSlot(env.state.phrase, cursor.row, fxIndex).command,
      write: (env, cursor, value, options = {}) => phraseStepDomain(env).setFxComponent(
        env.state.phrase,
        cursor.row,
        fxIndex,
        "command",
        value,
        options,
      ),
      readSlot: (env, cursor) => phraseStepDomain(env).readFxSlot(env.state.phrase, cursor.row, fxIndex),
      writeSlot: (env, cursor, slot, options = {}) => phraseStepDomain(env).setFxSlot(env.state.phrase, cursor.row, fxIndex, slot, options),
      readValue: (env, cursor) => phraseStepDomain(env).readFxSlot(env.state.phrase, cursor.row, fxIndex).value,
      writeValue: (env, cursor, value, options = {}) => phraseStepDomain(env).setFxComponent(
        env.state.phrase,
        cursor.row,
        fxIndex,
        "value",
        value,
        options,
      ),
    })),
  ];

  const specialDescriptors = {
    phraseConditionProbability: {
      id: "phrase.condition.probability", type: "integer", editorKind: "numeric", radix: 10,
      min: 0, max: 100, fineStep: 1, coarseStep: 10, defaultValue: 100,
      label: "PROBABILITY", resetLabel: "RESET 100%",
      specialGroup: "phrase-condition", specialTabLabel: "PROB", specialOrder: 0,
      desktopSpecial: true, cursorBound: true,
      changeKind: "parameter", affectsPlayback: true, persistsProject: true,
      read: (env, cursor) => phraseCondition(env, cursor).probability,
      write: (env, cursor, value, options = {}) => writePhraseConditionField(env, cursor, "probability", value, options),
    },
    phraseConditionEvery: {
      id: "phrase.condition.every", type: "integer", editorKind: "numeric", radix: 10,
      min: 1, max: 16, fineStep: 1, coarseStep: 4, defaultValue: 1,
      label: "ITERATION EVERY", resetLabel: "RESET EVERY 1",
      specialGroup: "phrase-condition", specialTabLabel: "EVERY", specialOrder: 1,
      desktopSpecial: true, cursorBound: true,
      changeKind: "parameter", affectsPlayback: true, persistsProject: true,
      read: (env, cursor) => phraseCondition(env, cursor).every,
      write: (env, cursor, value, options = {}) => writePhraseConditionField(env, cursor, "every", value, options),
    },
    phraseConditionOffset: {
      id: "phrase.condition.offset", type: "integer", editorKind: "numeric", radix: 10,
      min: 0, max: 15, fineStep: 1, coarseStep: 4, defaultValue: 0,
      label: "ITERATION OFFSET", resetLabel: "RESET OFFSET 0",
      specialGroup: "phrase-condition", specialTabLabel: "OFFSET", specialOrder: 2,
      desktopSpecial: true, cursorBound: true,
      changeKind: "parameter", affectsPlayback: true, persistsProject: true,
      read: (env, cursor) => phraseCondition(env, cursor).offset,
      write: (env, cursor, value, options = {}) => writePhraseConditionField(env, cursor, "offset", value, options),
    },
    projectName: {
      id: "project.identity.name", type: "text", editorKind: "text",
      changeKind: "project", affectsPlayback: false, persistsProject: true,
      read: (env) => projectStore(env).select((project) => project.projectName),
      write: (env, _cursor, value, options = {}) => projectStore(env).renameProject(value, options),
    },
    tempo: {
      id: "project.tempo", type: "integer", editorKind: "numeric", radix: 10,
      min: 30, max: 300, fineStep: 1, coarseStep: 10, defaultValue: 120,
      changeKind: "project", affectsPlayback: true, persistsProject: true,
      read: (env) => projectStore(env).select((project) => project.tempo),
      write: (env, _cursor, value, options = {}) => projectStore(env).setTempo(value, options),
    },
    soundParam: {
      id: "sound.parameter", type: "normalized", editorKind: "numeric", radix: 10,
      min: 0, max: 1, fineStep: 0.01, coarseStep: 0.1, defaultValue: 0,
      changeKind: "parameter", affectsPlayback: true, persistsProject: true,
      read: (env) => selectedProductionParameter(env)?.value ?? 0,
      write: (env, _cursor, value, options = {}) => {
        const context = selectedProductionParameter(env);
        if (!context) throw new Error("Selected production Sound parameter is unavailable");
        const renderer = soundEditRenderer(env);
        const next = renderer?.normalizeParameterInput
          ? renderer.normalizeParameterInput(context, value)
          : clampValue(Number(value) || 0, 0, 1);
        return projectStore(env).setProductionInstrumentParameter(
          context.instrumentId,
          context.parameterId,
          next,
          options,
        );
      },
    },
    nextVelocity: {
      id: "entry.nextVelocity", type: "integer", editorKind: "numeric", radix: 10,
      min: 1, max: 127, fineStep: 1, coarseStep: 10, defaultValue: 100,
      label: "NEXT VELOCITY", contextLabel: "NOTE ENTRY DEFAULT", resetLabel: "RESET 100",
      changeKind: "ui", affectsPlayback: false, persistsProject: false,
      read: (env) => preparedVelocity(env),
      write: (env, _cursor, value, options = {}) => {
        const next = clampValue(Math.round(value), 1, 127);
        const mutation = requiredNavigationEntry(env).setPreparedValue("velocity", next, { source: options.source ?? "field-schema-entry" });
        return { value: mutation.after.velocity, mutated: mutation.mutated, navigationChangeSet: mutation.navigationChangeSet };
      },
    },
    nextInstrument: {
      id: "entry.nextInstrument", type: "reference", referenceKind: "instrument", editorKind: "reference", radix: 16,
      min: 0, max: 255, fineStep: 1, coarseStep: 16, defaultValue: 0, emptyValue: EMPTY,
      label: "NEXT INSTRUMENT", contextLabel: "NOTE ENTRY DEFAULT", resetLabel: "USE FALLBACK",
      actionLabel: "SET", changeKind: "ui", affectsPlayback: false, persistsProject: false,
      read: (env) => preparedInstrument(env),
      write: (env, _cursor, value, options = {}) => {
        const next = value < 0 ? EMPTY : clampValue(Math.round(value), 0, 255);
        const mutation = requiredNavigationEntry(env).setPreparedValue("instrument", next, { source: options.source ?? "field-schema-entry" });
        return { value: mutation.after.instrument, mutated: mutation.mutated, navigationChangeSet: mutation.navigationChangeSet };
      },
      insertSeed: (env) => env.state.instrument ?? 0,
    },
  };

  function resolve(pane, col) {
    return descriptors.find((descriptor) => descriptor.pane === pane
      && (descriptor.columns === "any" || descriptor.columns.includes(Number(col)))) ?? null;
  }

  function read(env, descriptor, cursor = env.state.focus) {
    return descriptor.read(env, cursor);
  }

  function format(env, descriptor, value) {
    if (descriptor.type === "note") return env.noteName(value);
    if (descriptor.type === "reference") return value < 0 ? "--" : hex(value);
    if (descriptor.type === "fx-command") return env.fxName ? env.fxName(value) : hex(value);
    if (descriptor.type === "normalized") return `${Math.round(clampValue(Number(value) || 0, 0, 1) * 100)}%`;
    if (descriptor.id === "chain.transpose") return value >= 0 ? `+${value}` : String(value);
    return String(value);
  }

  function parse(descriptor, raw) {
    const text = String(raw ?? "").trim().toUpperCase();
    if (!text) return null;
    if (Object.hasOwn(descriptor, "emptyValue") && ["--", "EMPTY", "NONE", "FALLBACK"].includes(text)) return descriptor.emptyValue;
    const normalized = descriptor.radix === 16 ? text.replace(/^0X/, "") : text.replace(",", ".");
    const value = descriptor.radix === 16 ? Number.parseInt(normalized, 16) : Number(normalized);
    if (!Number.isFinite(value)) return null;
    if (descriptor.type === "normalized") return clampValue(value, descriptor.min, descriptor.max);
    return clampValue(Math.round(value), descriptor.min, descriptor.max);
  }

  function interactionOptions(options = {}) {
    const explicit = options.transaction && typeof options.transaction === "object" ? options.transaction : null;
    const transaction = explicit ?? globalThis.BRKTRKInputSafety?.currentContinuousTransaction?.("tracker") ?? null;
    if (!transaction) return options;
    return {
      ...options,
      source: options.source ?? transaction.inputSource ?? null,
      transaction,
    };
  }

  function write(env, descriptor, value, options = {}, cursor = env.state.focus) {
    const routedOptions = interactionOptions(options);
    const before = read(env, descriptor, cursor);
    const candidate = Number(value);
    const existedBefore = descriptor.referenceKind && candidate >= 0
      ? referenceExists(env, descriptor, candidate)
      : true;
    const output = descriptor.write(env, cursor, value, routedOptions);
    const structured = output && typeof output === "object" && Object.hasOwn(output, "value");
    const after = structured ? output.value : output;
    const existsAfter = descriptor.referenceKind && after >= 0
      ? referenceExists(env, descriptor, after)
      : true;
    const allocated = !existedBefore && existsAfter;
    return {
      descriptor,
      before,
      after,
      allocated,
      mutated: structured ? Boolean(output.mutated || allocated) : before !== after || allocated,
      projectChangeSet: structured ? output.changeSet ?? null : null,
      navigationChangeSet: structured ? output.navigationChangeSet ?? null : null,
      metadata: routedOptions,
    };
  }

  function adjust(env, descriptor, direction, cursor = env.state.focus, options = {}) {
    const edit = intent(direction);
    if (!edit) return { descriptor, before: read(env, descriptor, cursor), after: read(env, descriptor, cursor), mutated: false, metadata: interactionOptions(options) };
    let base = read(env, descriptor, cursor);
    if (descriptor.type === "note" && base < 0) base = currentPitch(env);
    else if (descriptor.type === "reference" && base < 0) base = Number(descriptor.insertSeed?.(env) ?? descriptor.defaultValue ?? 0);
    else if (!Number.isFinite(base)) base = descriptor.defaultValue ?? 0;
    const step = edit.magnitude === "coarse" ? descriptor.coarseStep : descriptor.fineStep;
    return write(env, descriptor, base + edit.delta * step, {
      ...options,
      createMissing: descriptor.type === "reference",
    }, cursor);
  }

  function insert(env, descriptor, options = {}, cursor = env.state.focus) {
    const before = read(env, descriptor, cursor);
    if (descriptor.type === "reference") {
      if (before >= 0 && !options.fresh) return { descriptor, before, after: before, mutated: false, openChild: true, metadata: interactionOptions(options) };
      if (options.fresh && typeof descriptor.freshId === "function") {
        const seed = descriptor.freshId(env);
        if (!Number.isInteger(seed) || seed < descriptor.min || seed > descriptor.max) {
          return {
            descriptor,
            before,
            after: before,
            mutated: false,
            allocated: false,
            allocationFailed: true,
            reason: "reference-capacity",
            referenceKind: descriptor.referenceKind ?? null,
            limit: Number.isInteger(descriptor.max) ? descriptor.max + 1 : 256,
            metadata: interactionOptions(options),
          };
        }
        return write(env, descriptor, seed, { ...options, createMissing: true }, cursor);
      }
      const seed = options.fresh ? descriptor.defaultValue : descriptor.insertSeed?.(env);
      return write(env, descriptor, Number(seed ?? descriptor.defaultValue ?? 0), { ...options, createMissing: true }, cursor);
    }
    if (descriptor.type === "note") {
      if (before >= 0) return { descriptor, before, after: before, mutated: false, preview: true, metadata: interactionOptions(options) };
      return write(env, descriptor, descriptor.insertSeed?.(env) ?? descriptor.defaultValue, options, cursor);
    }
    if (before === descriptor.emptyValue || !Number.isFinite(before)) return write(env, descriptor, descriptor.defaultValue, options, cursor);
    return write(env, descriptor, before + descriptor.fineStep, options, cursor);
  }

  function clear(env, descriptor, cursor = env.state.focus) {
    const before = read(env, descriptor, cursor);
    let next = descriptor.defaultValue ?? 0;
    if (descriptor.type === "note") next = before >= 0 ? EMPTY : before === EMPTY ? NOTE_OFF : EMPTY;
    else if (Object.hasOwn(descriptor, "emptyValue")) next = descriptor.emptyValue;
    return write(env, descriptor, next, {}, cursor);
  }

  function reset(env, descriptor, cursor = env.state.focus) {
    const next = descriptor.type === "note" ? EMPTY
      : Object.hasOwn(descriptor, "emptyValue") ? descriptor.emptyValue
        : descriptor.defaultValue ?? 0;
    return write(env, descriptor, next, {}, cursor);
  }

  const api = Object.freeze({
    EMPTY, NOTE_OFF, descriptors: Object.freeze(descriptors), specialDescriptors: Object.freeze(specialDescriptors),
    resolve, read, write, adjust, insert, clear, reset, format, parse, intent, referenceExists, inboundReferenceIds, firstMissingReference,
  });

  globalThis.BRKTRKFieldSchema = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();