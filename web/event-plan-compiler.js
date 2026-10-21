(() => {
  const EMPTY = -1;
  const NOTE_OFF = -2;
  const DEFAULT_TRACK_COUNT = 8;
  const PHRASE_ROWS = 16;
  const FX_SLOTS = 3;
  const CONDITION_NAMESPACE = "phrase-condition-v1";

  const integerOr = (value, fallback = 0) => Number.isInteger(Number(value)) ? Number(value) : fallback;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const freezeArray = (value) => Object.freeze(Array.from(value));
  const byte = (value) => clamp(integerOr(value, 0), 0, 0xFF);

  function parameterEventDomain() {
    if (globalThis.BRKTRKParameterEventDomain) return globalThis.BRKTRKParameterEventDomain;
    if (typeof require === "function") return require("./parameter-event-domain.js");
    return null;
  }

  function normalizeParameterEvents(value = []) {
    const source = Array.isArray(value) ? value : [];
    if (source.length === 0) return freezeArray([]);
    const domain = parameterEventDomain();
    if (!domain) throw new Error("Authored ParameterEvents require the ParameterEvent domain");
    return freezeArray(domain.serializeParameterEvents(source).map((event) => Object.freeze({ ...event })));
  }

  function normalizeFxSlots(value = []) {
    const source = Array.isArray(value) ? value : [];
    return freezeArray(Array.from({ length: FX_SLOTS }, (_, index) => {
      const candidate = source[index] ?? 0;
      if (typeof candidate === "number") return Object.freeze({ command: byte(candidate), value: 0 });
      if (!candidate || typeof candidate !== "object") return Object.freeze({ command: 0, value: 0 });
      const command = Object.hasOwn(candidate, "command") ? candidate.command : candidate.commandCode;
      return Object.freeze({ command: byte(command), value: byte(candidate.value) });
    }));
  }

  function normalizeStepCondition(value) {
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const numeric = (candidate, fallback) => {
      const number = Number(candidate);
      return Number.isFinite(number) ? Math.round(number) : fallback;
    };
    const probability = clamp(numeric(source.probability, 100), 0, 100);
    const every = clamp(numeric(source.every, 1), 1, 16);
    const offset = clamp(numeric(source.offset, 0), 0, every - 1);
    return Object.freeze({ probability, every, offset });
  }

  function semanticOccurrenceIdentity({ scope = "phrase", track = 0, context = {} } = {}) {
    if (!["phrase", "chain", "song"].includes(scope)) throw new RangeError(`Unsupported condition scope: ${scope}`);
    return Object.freeze({
      scope,
      track: Math.max(0, integerOr(track, 0)),
      songRow: scope === "song" ? integerOr(context?.songRow, EMPTY) : EMPTY,
      chainId: scope === "phrase" ? EMPTY : integerOr(context?.chainId, EMPTY),
      chainRow: scope === "phrase" ? EMPTY : integerOr(context?.chainRow, EMPTY),
      phraseId: integerOr(context?.phraseId, EMPTY),
    });
  }

  function occurrenceIdentityKey(identity) {
    if (!identity || typeof identity !== "object") throw new TypeError("Condition occurrence identity is required");
    return [identity.scope, identity.track, identity.songRow, identity.chainId, identity.chainRow, identity.phraseId].join("|");
  }

  function normalizeOccurrenceIndex(value) {
    const numeric = Number(value);
    if (!Number.isSafeInteger(numeric) || numeric < 1) throw new RangeError("Condition occurrence index must be a positive integer");
    return numeric;
  }

  function resolveOccurrenceIndex(source, identity) {
    let candidate = source;
    if (typeof source === "function") candidate = source(identity);
    else if (source && typeof source === "object" && !Array.isArray(source)) {
      candidate = source[occurrenceIdentityKey(identity)] ?? source.default ?? 1;
    }
    return normalizeOccurrenceIndex(candidate ?? 1);
  }

  function stableSeed(value) {
    if (value == null) return "0";
    if (typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    throw new TypeError("Condition seed must be a finite number or string");
  }

  function fnv1a32(text) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      hash ^= code & 0xFF;
      hash = Math.imul(hash, 0x01000193) >>> 0;
      hash ^= (code >>> 8) & 0xFF;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
  }

  function evaluateStepCondition({
    condition,
    scope = "phrase",
    track = 0,
    context = {},
    occurrenceIndex = 1,
    seed = 0,
  } = {}) {
    const descriptor = normalizeStepCondition(condition);
    const identity = semanticOccurrenceIdentity({ scope, track, context });
    const occurrence = resolveOccurrenceIndex(occurrenceIndex, identity);
    const iterationPass = ((occurrence - 1) % descriptor.every) === descriptor.offset;
    let probabilityPass = descriptor.probability >= 100;
    let draw = null;
    if (descriptor.probability <= 0) probabilityPass = false;
    else if (descriptor.probability < 100) {
      const phraseRow = Math.max(0, integerOr(context?.phraseRow, 0));
      const address = [
        CONDITION_NAMESPACE,
        stableSeed(seed),
        identity.scope,
        identity.track,
        identity.songRow,
        identity.chainId,
        identity.chainRow,
        identity.phraseId,
        phraseRow,
        occurrence,
      ].join("|");
      draw = fnv1a32(address);
      const threshold = Math.floor((descriptor.probability / 100) * 0x100000000);
      probabilityPass = draw < threshold;
    }
    return Object.freeze({
      admitted: iterationPass && probabilityPass,
      condition: descriptor,
      identity,
      occurrenceIndex: occurrence,
      iterationPass,
      probabilityPass,
      draw,
    });
  }

  function emptyStep() {
    return Object.freeze({
      note: EMPTY,
      velocity: 100,
      instrument: EMPTY,
      fx: normalizeFxSlots(),
      condition: normalizeStepCondition(),
      parameterEvents: normalizeParameterEvents(),
    });
  }

  function explicitInstrument(step) {
    const value = Number(step?.instrument);
    return Number.isInteger(value) && value >= 0 ? clamp(value, 0, 255) : null;
  }

  function normalizedInstrumentId(value, fallback = EMPTY) {
    const numeric = Number(value);
    if (Number.isInteger(numeric) && numeric >= 0) return clamp(numeric, 0, 255);
    const fallbackNumeric = Number(fallback);
    if (Number.isInteger(fallbackNumeric) && fallbackNumeric >= 0) return clamp(fallbackNumeric, 0, 255);
    return EMPTY;
  }

  function resolveCyclicInstrumentIds(steps, fallbackInstrument = EMPTY) {
    const source = Array.isArray(steps) ? steps : [];
    let carried = normalizedInstrumentId(fallbackInstrument, EMPTY);
    for (let index = source.length - 1; index >= 0; index -= 1) {
      const explicit = explicitInstrument(source[index]);
      if (explicit !== null) {
        carried = explicit;
        break;
      }
    }
    return freezeArray(source.map((step) => {
      const explicit = explicitInstrument(step);
      if (explicit !== null) carried = explicit;
      return carried;
    }));
  }

  function contextStep(model, context) {
    return model?.phrases?.[context?.phraseId]?.[context?.phraseRow] ?? emptyStep();
  }

  function compileContexts({
    model,
    contexts,
    track = 0,
    fallbackInstrument = EMPTY,
    scope = "phrase",
    occurrenceIndex = 1,
    conditionSeed = 0,
  } = {}) {
    const sourceContexts = Array.isArray(contexts) ? contexts : [];
    const steps = sourceContexts.map((context) => contextStep(model, context));
    const admitted = sourceContexts.map((context, index) => evaluateStepCondition({
      condition: steps[index]?.condition,
      scope,
      track,
      context,
      occurrenceIndex,
      seed: conditionSeed,
    }).admitted);
    const instrumentSteps = steps.map((step, index) => admitted[index] ? step : { ...step, instrument: EMPTY });
    const instrumentIds = resolveCyclicInstrumentIds(instrumentSteps, fallbackInstrument);
    return freezeArray(sourceContexts.map((context, index) => {
      const step = steps[index] ?? emptyStep();
      const instrumentId = instrumentIds[index] ?? EMPTY;
      const transpose = integerOr(context?.transpose, 0);
      let note = null;
      if (admitted[index]) {
        if (step.note === NOTE_OFF) note = NOTE_OFF;
        else if (Number.isFinite(step.note) && step.note >= 0) note = clamp(step.note + transpose, 0, 127);
      }
      return Object.freeze({
        note,
        velocity: clamp(integerOr(step.velocity, 100), 1, 127),
        fx: admitted[index] ? normalizeFxSlots(step.fx) : normalizeFxSlots(),
        parameterEvents: admitted[index] ? normalizeParameterEvents(step.parameterEvents) : normalizeParameterEvents(),
        track,
        trackId: track,
        instrumentId,
        context,
      });
    }));
  }

  function sequenceStep(event, trackCount = DEFAULT_TRACK_COUNT) {
    const count = Math.max(1, integerOr(trackCount, DEFAULT_TRACK_COUNT));
    const notes = Array(count).fill(null);
    const velocities = Array(count).fill(100);
    const fx = Array.from({ length: count }, () => normalizeFxSlots());
    const trackIds = Array.from({ length: count }, (_, track) => track);
    const instrumentIds = Array(count).fill(EMPTY);
    const track = clamp(integerOr(event?.trackId, integerOr(event?.track, 0)), 0, count - 1);
    notes[track] = event?.note ?? null;
    velocities[track] = clamp(integerOr(event?.velocity, 100), 1, 127);
    fx[track] = normalizeFxSlots(event?.fx);
    instrumentIds[track] = normalizedInstrumentId(event?.instrumentId, EMPTY);
    return Object.freeze({
      notes: freezeArray(notes),
      velocities: freezeArray(velocities),
      fx: freezeArray(fx),
      trackIds: freezeArray(trackIds),
      instrumentIds: freezeArray(instrumentIds),
    });
  }

  function contextsToSegments(contexts) {
    const source = Array.isArray(contexts) ? contexts : [];
    const segments = [];
    let start = 0;
    while (start < source.length) {
      const first = source[start];
      let end = start + 1;
      while (end < source.length) {
        const candidate = source[end];
        if (candidate.songRow !== first.songRow
          || candidate.chainId !== first.chainId
          || candidate.chainRow !== first.chainRow
          || candidate.phraseId !== first.phraseId) break;
        end += 1;
      }
      segments.push(Object.freeze({
        start,
        end,
        songRow: integerOr(first?.songRow, 0),
        chainRow: integerOr(first?.chainRow, 0),
        phrase: integerOr(first?.phraseId, EMPTY),
      }));
      start = end;
    }
    return freezeArray(segments);
  }

  function phraseContexts({ phraseId = 0, songRow = 0, chainId = EMPTY, chainRow = 0 } = {}) {
    return freezeArray(Array.from({ length: PHRASE_ROWS }, (_, phraseRow) => Object.freeze({
      songRow: integerOr(songRow, 0),
      chainId: integerOr(chainId, EMPTY),
      chainRow: integerOr(chainRow, 0),
      phraseId: integerOr(phraseId, 0),
      phraseRow,
      transpose: 0,
    })));
  }

  function chainContexts({ model, chainId = 0, startChainRow = 0, songRow = 0 } = {}) {
    const chain = model?.chains?.[chainId];
    if (!Array.isArray(chain)) return Object.freeze([]);
    const playable = (row) => Number.isInteger(chain[row]?.phrase) && chain[row].phrase >= 0;
    let start = clamp(integerOr(startChainRow, 0), 0, Math.max(0, chain.length - 1));
    if (!playable(start)) start = chain.findIndex((entry) => Number.isInteger(entry?.phrase) && entry.phrase >= 0);
    if (start < 0) return Object.freeze([]);

    let segmentStart = start;
    while (segmentStart > 0 && playable(segmentStart - 1)) segmentStart -= 1;
    let segmentEnd = start + 1;
    while (segmentEnd < chain.length && playable(segmentEnd)) segmentEnd += 1;

    const orderedRows = [];
    for (let chainRow = start; chainRow < segmentEnd; chainRow += 1) orderedRows.push(chainRow);
    for (let chainRow = segmentStart; chainRow < start; chainRow += 1) orderedRows.push(chainRow);

    const result = [];
    for (const chainRow of orderedRows) {
      const entry = chain[chainRow];
      for (let phraseRow = 0; phraseRow < PHRASE_ROWS; phraseRow += 1) {
        result.push(Object.freeze({
          songRow: integerOr(songRow, 0),
          chainId: integerOr(chainId, 0),
          chainRow,
          phraseId: entry.phrase,
          phraseRow,
          transpose: integerOr(entry.transpose, 0),
        }));
      }
    }
    return freezeArray(result);
  }

  function compileLinearProgram({
    scope = "phrase",
    model,
    contexts,
    track = 0,
    origin = {},
    trackCount = DEFAULT_TRACK_COUNT,
    occurrenceIndex = 1,
    conditionSeed = 0,
  } = {}) {
    const events = compileContexts({ model, contexts, track, fallbackInstrument: EMPTY, scope, occurrenceIndex, conditionSeed });
    return Object.freeze({
      mode: "sequence",
      scope,
      active: events.length > 0,
      events,
      contexts: freezeArray(contexts ?? []),
      steps: freezeArray(events.map((event) => sequenceStep(event, trackCount))),
      segments: contextsToSegments(contexts),
      origin: Object.freeze({
        songRow: integerOr(origin.songRow, 0),
        track: integerOr(origin.track, track),
        chainId: integerOr(origin.chainId, EMPTY),
        chainRow: integerOr(origin.chainRow, 0),
        phraseId: integerOr(origin.phraseId, EMPTY),
      }),
    });
  }

  function compilePhraseProgram({ model, origin = {}, trackCount = DEFAULT_TRACK_COUNT, occurrenceIndex = 1, conditionSeed = 0 } = {}) {
    const track = clamp(integerOr(origin.track, 0), 0, trackCount - 1);
    const contexts = phraseContexts(origin);
    return compileLinearProgram({ scope: "phrase", model, contexts, track, origin, trackCount, occurrenceIndex, conditionSeed });
  }

  function compileChainProgram({ model, origin = {}, trackCount = DEFAULT_TRACK_COUNT, occurrenceIndex = 1, conditionSeed = 0 } = {}) {
    const track = clamp(integerOr(origin.track, 0), 0, trackCount - 1);
    const contexts = chainContexts({
      model,
      chainId: origin.chainId,
      startChainRow: origin.chainRow,
      songRow: origin.songRow,
    });
    return compileLinearProgram({ scope: "chain", model, contexts, track, origin, trackCount, occurrenceIndex, conditionSeed });
  }

  function compileTrackProgram({ model, structure, track = 0, occurrenceIndex = 1, conditionSeed = 0 } = {}) {
    const contexts = structure?.contexts ?? [];
    const events = compileContexts({ model, contexts, track, fallbackInstrument: EMPTY, scope: "song", occurrenceIndex, conditionSeed });
    return Object.freeze({
      active: structure?.active === true && events.length > 0,
      track,
      trackId: track,
      events,
      contexts: freezeArray(contexts),
      startIndex: Math.max(0, integerOr(structure?.startIndex, 0)),
      segment: structure?.segment ?? null,
    });
  }

  function compileSongPlan({ model, songPolicy, origin = {}, continueFromChain = false, trackCount = DEFAULT_TRACK_COUNT, occurrenceIndex = 1, conditionSeed = 0 } = {}) {
    if (!songPolicy?.buildTrackProgram) throw new TypeError("Song policy is required");
    const selectedTrack = clamp(integerOr(origin.track, 0), 0, trackCount - 1);
    const anchorRow = Math.max(0, integerOr(origin.songRow, 0));
    const tracks = freezeArray(Array.from({ length: trackCount }, (_, track) => {
      const structure = songPolicy.buildTrackProgram({
        model,
        track,
        anchorRow,
        startChainRow: continueFromChain && track === selectedTrack ? Math.max(0, integerOr(origin.chainRow, 0)) : 0,
      });
      return compileTrackProgram({ model, structure, track, occurrenceIndex, conditionSeed });
    }));
    return Object.freeze({
      mode: "track-plan",
      scope: "song",
      active: tracks.some((track) => track.active),
      tracks,
      selectedTrack,
      origin: Object.freeze({
        songRow: anchorRow,
        track: selectedTrack,
        chainId: integerOr(origin.chainId, EMPTY),
        chainRow: continueFromChain ? Math.max(0, integerOr(origin.chainRow, 0)) : 0,
        phraseId: integerOr(origin.phraseId, EMPTY),
      }),
    });
  }

  // A production Instrument is one the host can play: it names an engine.
  const isPlayableInstrument = (instrument) => Boolean(instrument?.engineRef?.moduleId && instrument?.engineRef?.engineId);

  // How many notes a compiled plan strikes and how many of those have nothing
  // to play them: no Instrument after cyclic resolution, or one naming a slot
  // that holds no production Instrument. Read-only - it changes nothing about
  // what plays. It exists so the transport can say why a plan is silent: a
  // fresh Project's demo notes are deliberately unassigned, and Play used to
  // report "PRODUCTION AUDIO" over silence (#511).
  function playableNoteSummary(plan, instrumentPool = {}) {
    const events = plan?.mode === "track-plan"
      ? (Array.isArray(plan.tracks) ? plan.tracks.flatMap((program) => (program?.active && Array.isArray(program.events) ? program.events : [])) : [])
      : (Array.isArray(plan?.events) ? plan.events : []);
    const pool = instrumentPool && typeof instrumentPool === "object" ? instrumentPool : {};
    let notes = 0;
    let unassigned = 0;
    let emptySlot = 0;
    for (const event of events) {
      const note = event?.note;
      if (!Number.isInteger(note) || note < 0) continue;
      notes += 1;
      const instrumentId = Number(event.instrumentId);
      if (!Number.isInteger(instrumentId) || instrumentId < 0) unassigned += 1;
      else if (!isPlayableInstrument(pool[instrumentId])) emptySlot += 1;
    }
    return Object.freeze({
      notes,
      unassigned,
      emptySlot,
      silent: unassigned + emptySlot,
      hasProductionInstrument: Object.values(pool).some(isPlayableInstrument),
    });
  }

  // What Play should add to its status when notes will be silent, or null.
  // It names the fix the musician can act on, not the mechanism.
  function silentNotesStatus(summary) {
    if (!summary || !(summary.notes > 0) || !(summary.silent > 0)) return null;
    if (!summary.hasProductionInstrument) return "SILENT · NO INSTRUMENT — SOUND ▸ CREATE";
    if (summary.silent === summary.notes) return "SILENT · NOTES HAVE NO INSTRUMENT — SET INST";
    return `${summary.silent} OF ${summary.notes} NOTES HAVE NO INSTRUMENT`;
  }

  const api = Object.freeze({
    EMPTY,
    NOTE_OFF,
    playableNoteSummary,
    silentNotesStatus,
    PHRASE_ROWS,
    FX_SLOTS,
    normalizeFxSlots,
    normalizeParameterEvents,
    normalizeStepCondition,
    semanticOccurrenceIdentity,
    occurrenceIdentityKey,
    evaluateStepCondition,
    resolveCyclicInstrumentIds,
    compileContexts,
    sequenceStep,
    phraseContexts,
    chainContexts,
    compileLinearProgram,
    compilePhraseProgram,
    compileChainProgram,
    compileTrackProgram,
    compileSongPlan,
  });

  if (typeof globalThis !== "undefined") globalThis.BRKTRKEventPlanCompiler = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
