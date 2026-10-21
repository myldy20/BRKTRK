const timingDomain = globalThis.BRKTRKTimingDomain;
if (!timingDomain) throw new Error("BRKTRK AudioWorklet requires the K0 timing domain");
const noteLifecycleDomain = globalThis.BRKTRKNoteLifecycleDomain;
if (!noteLifecycleDomain) throw new Error("BRKTRK AudioWorklet requires the K2 note lifecycle domain");
const productionTimelineDomain = globalThis.BRKTRKProductionTimelineDomain ?? null;
const eventTraceDomain = globalThis.BRKTRKEventTraceDomain;
if (!eventTraceDomain) throw new Error("BRKTRK AudioWorklet requires the K4A event trace domain");
const realtimeEventWindowDomain = globalThis.BRKTRKRealtimeEventWindowDomain;
if (!realtimeEventWindowDomain) throw new Error("BRKTRK AudioWorklet requires the K4B realtime event window domain");
const MAX_TIMELINE_ROWS = productionTimelineDomain?.MAX_SAME_FRAME_ROWS ?? 4096;
const EVENT_TRACE_RUNTIME_VERSION = 3;

function createLifecycleSlot() {
  return {
    present: false,
    forceRelease: false,
    intent: noteLifecycleDomain.INTENTS.EMPTY,
    note: null,
  };
}

// The structural playback scopes a transport identity may declare.
const SCOPES = ["song", "chain", "phrase"];

function createTimelineRowSlot() {
  return { kind: "sequence", track: -1, row: -1, phraseRow: -1, sourceOrder: 0, sampleRate: 0, ppqn: 0, tempo: null };
}

class BrktrkLifecycleVoice {
  constructor() {
    this.note = -1;
    this.active = false;
  }

  triggerNote(note) {
    this.note = note;
    this.active = true;
  }

  release() {
    this.active = false;
    this.note = -1;
  }
}

class BrktrkAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.voices = Array.from({ length: 8 }, () => new BrktrkLifecycleVoice());
    this.lifecycleSlots = Array.from({ length: 8 }, () => createLifecycleSlot());
    this.mode = "sequence";
    this.sequence = [];
    this.trackPrograms = Array.from({ length: 8 }, () => ({ active: false, events: [], position: 0 }));
    this.trackMix = Array.from({ length: 8 }, () => ({ gain: 1, mute: false, pan: 0 }));
    this.trackMixRevision = 0;
    this.tempo = 120;
    this.playing = false;
    this.stepIndex = 0;
    this.globalStep = 0;
    this.rowClock = null;
    this.rowClockStep = 0;
    this.rowClockTempo = null;
    this.nextStepFrame = null;
    this.schedulePending = false;
    this.fallbackRenderFrame = 0;
    this.lastAppliedStepFrame = -1;
    this.lastLifecycleFrame = -1;
    this.meterCounter = 0;
    this.transportIdentity = null;

    this.timelineMode = false;
    this.timelineRequest = null;
    this.timelineCompiled = null;
    this.timelineSequenceCursor = null;
    this.timelineTrackCursors = Array(this.voices.length).fill(null);
    this.timelineTableIndex = 0;
    this.timelinePendingEvents = [];
    this.timelineNextFrame = null;
    this.timelineRebuildPending = false;
    this.timelineRebuildReason = null;
    this.timelineGeneration = 0;
    this.timelineDiagnostics = false;
    this.timelineTrackPositions = Array(this.voices.length).fill(-1);
    this.timelineRows = Array.from({ length: MAX_TIMELINE_ROWS }, () => createTimelineRowSlot());
    this.timelineRowCount = 0;
    this.lastEventTracePacket = null;
    this.realtimeWindow = realtimeEventWindowDomain.createRealtimeEventWindow();

    this.port.onmessage = ({ data }) => {
      if (data.type === "play") {
        this.startSequence(data.sequence, data.tempo, data.transport, data.timeline);
      } else if (data.type === "play-plan") {
        this.startPlan(data.plan, data.tempo, data.transport);
      } else if (data.type === "update-sequence") {
        this.updateSequence(data.sequence, data.transport, data.timeline);
      } else if (data.type === "update-plan") {
        this.updatePlan(data.plan, data.transport);
      } else if (data.type === "track-mix") {
        this.setTrackMix(data.tracks, data.revision);
      } else if (data.type === "stop") {
        this.stop(data.transport);
      } else if (data.type === "tempo") {
        this.setTempo(data.value);
      }
    };
    this.port.postMessage({ type: "transport-ready" });
  }

  normalizeTempo(value, fallback = 120) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.max(30, Math.min(300, numeric)) : fallback;
  }

  normalizeTransportIdentity(candidate, mode = this.mode) {
    if (!candidate || typeof candidate !== "object") return null;
    const version = Number.isInteger(candidate.version) ? candidate.version : 0;
    const id = typeof candidate.id === "string" && candidate.id ? candidate.id : `transport-${version}`;
    const scope = SCOPES.includes(candidate.scope) ? candidate.scope : "phrase";
    return Object.freeze({ id, version, mode: mode === "track-plan" ? "track-plan" : "sequence", scope });
  }

  normalizeTrackMix(candidate, fallback = { gain: 1, mute: false, pan: 0 }) {
    const source = candidate && typeof candidate === "object" ? candidate : {};
    const gain = Number(source.gain);
    const pan = Number(source.pan);
    return {
      gain: Number.isFinite(gain) ? Math.max(0, Math.min(1, gain)) : fallback.gain,
      mute: Object.hasOwn(source, "mute") ? source.mute === true : fallback.mute === true,
      pan: Number.isFinite(pan) ? Math.max(-1, Math.min(1, pan)) : fallback.pan,
    };
  }

  setTrackMix(candidate, revision = this.trackMixRevision + 1) {
    const tracks = Array.isArray(candidate) ? candidate : [];
    this.trackMix = Array.from({ length: this.voices.length }, (_, track) => this.normalizeTrackMix(tracks[track], this.trackMix[track]));
    if (Number.isInteger(revision) && revision >= this.trackMixRevision) this.trackMixRevision = revision;
    this.port.postMessage({ type: "track-mix-applied", revision: this.trackMixRevision, tracks: this.trackMix.map((mix) => ({ ...mix })) });
  }

  mixTrackSample(track, sample, sourcePan = 0) {
    const mix = this.trackMix[track] ?? { gain: 1, mute: false, pan: 0 };
    if (mix.mute || mix.gain <= 0) return { left: 0, right: 0 };
    const pan = Math.max(-1, Math.min(1, (sourcePan ?? 0) + mix.pan));
    const amplitude = sample * mix.gain;
    return { left: amplitude * Math.sqrt((1 - pan) * 0.5), right: amplitude * Math.sqrt((1 + pan) * 0.5) };
  }

  appliedTrackPositions() {
    if (this.mode !== "track-plan") return Array(this.voices.length).fill(-1);
    return this.trackPrograms.map((program) => program.active ? program.position : -1);
  }

  postApplied() {
    if (!this.transportIdentity) return;
    this.port.postMessage({ type: "transport-applied", transport: this.transportIdentity, playing: this.playing, trackPositions: this.appliedTrackPositions() });
  }

  currentBlockStartFrame() {
    const authoritative = typeof currentFrame === "number" ? currentFrame : NaN;
    if (Number.isSafeInteger(authoritative) && authoritative >= 0) return authoritative;
    return this.fallbackRenderFrame;
  }

  resetTimelineSchedule() {
    this.timelineCompiled = null;
    this.timelineSequenceCursor = null;
    this.timelineTrackCursors = Array(this.voices.length).fill(null);
    this.timelineTableIndex = 0;
    this.timelinePendingEvents = [];
    this.timelineNextFrame = null;
    this.timelineRebuildPending = false;
    this.timelineRebuildReason = null;
    this.timelineTrackPositions = Array(this.voices.length).fill(-1);
    this.timelineRowCount = 0;
    this.lastEventTracePacket = null;
    this.realtimeWindow.resetContinuity();
  }

  resetStepSchedule() {
    this.rowClock = null;
    this.rowClockStep = 0;
    this.rowClockTempo = null;
    this.nextStepFrame = null;
    this.lastAppliedStepFrame = -1;
    this.resetTimelineSchedule();
    this.schedulePending = this.playing;
  }

  createRowClock(startFrame, tempo = this.tempo) {
    this.rowClockTempo = this.normalizeTempo(tempo, this.tempo);
    this.rowClock = timingDomain.createMusicalFrameClock({ sampleRate, tempo: this.rowClockTempo, stepUnits: timingDomain.TRACKER_ROW_UNITS, startFrame });
    this.rowClockStep = 0;
    this.nextStepFrame = this.rowClock.frameAt(0);
    this.schedulePending = false;
  }

  createTimelineCursor(cycle, startFrame) {
    if (!cycle || !Array.isArray(cycle.schedule) || cycle.schedule.length === 0) return null;
    return { cycle, pointer: 0, cycleStartFrame: startFrame };
  }

  timelineCursorFrame(cursor) {
    if (!cursor) return null;
    const event = cursor.cycle.schedule[cursor.pointer];
    return cursor.cycleStartFrame + event.frameOffset;
  }

  advanceTimelineCursor(cursor) {
    cursor.pointer += 1;
    if (cursor.pointer < cursor.cycle.schedule.length) return;
    cursor.pointer = 0;
    cursor.cycleStartFrame += cursor.cycle.cycleFrames;
  }

  timelineProgramSnapshot() {
    if (this.mode === "track-plan") {
      return { mode: "track-plan", tracks: this.trackPrograms.map((program) => ({ active: program.active, events: program.events, startIndex: program.position })) };
    }
    return { mode: "sequence", steps: this.sequence, startIndex: this.stepIndex };
  }

  tableSourcesActive() {
    return Array.isArray(this.timelineRequest?.tableSources) && this.timelineRequest.tableSources.length > 0;
  }

  postTimelineError(error, reason = "timeline") {
    this.port.postMessage({ type: "timeline-error", reason, message: String(error?.message ?? error), transport: this.transportIdentity });
  }

  beginRealtimeWindow(startFrame, frameCount) {
    this.realtimeWindow.begin(startFrame, frameCount);
    if (this.realtimeWindow.lastUnderrunFrames > 0 || this.realtimeWindow.lastRenderOverlapFrames > 0) {
      this.port.postMessage({ type: "realtime-window-diagnostic", reason: this.realtimeWindow.lastUnderrunFrames > 0 ? "underrun" : "render-overlap", diagnostics: this.realtimeWindow.diagnosticSnapshot(), transport: this.transportIdentity });
    }
  }

  postRealtimeWindowError(error) {
    this.port.postMessage({ type: "realtime-window-error", code: typeof error?.code === "string" ? error.code : "realtime-window-error", message: String(error?.message ?? error), details: error?.details ?? null, budget: this.realtimeWindow.budgetSnapshot(), diagnostics: this.realtimeWindow.diagnosticSnapshot(), transport: this.transportIdentity });
  }

  handleRealtimeWindowError(error) {
    if (!(error instanceof realtimeEventWindowDomain.RealtimeWindowError)) return false;
    this.postRealtimeWindowError(error);
    this.stop(this.transportIdentity);
    return true;
  }

  compileTimeline(startFrame) {
    if (!productionTimelineDomain) throw new Error("K3C production timeline domain is not loaded");
    const compiled = productionTimelineDomain.compileProductionTimeline({ sampleRate, startFrame, tempo: this.tempo, program: this.timelineProgramSnapshot(), request: this.timelineRequest });
    this.timelineCompiled = compiled;
    this.timelineDiagnostics = compiled.summary.diagnostics === true;
    this.timelineGeneration += 1;
    this.timelineSequenceCursor = compiled.sequence ? this.createTimelineCursor(compiled.sequence, startFrame) : null;
    this.timelineTrackCursors = Array.from({ length: this.voices.length }, (_, track) => {
      const cycle = compiled.tracks.find((candidate) => candidate.track === track);
      return cycle ? this.createTimelineCursor(cycle, startFrame) : null;
    });
    this.timelineTableIndex = 0;
    this.timelinePendingEvents = [];
    this.timelineTrackPositions = this.trackPrograms.map((program) => !program.active || program.events.length === 0 ? -1 : (program.position - 1 + program.events.length) % program.events.length);
    this.timelineRebuildPending = false;
    this.timelineRebuildReason = null;
    this.schedulePending = false;
    this.timelineNextFrame = this.computeTimelineNextFrame();
    this.nextStepFrame = this.timelineNextFrame;
    this.port.postMessage({ type: "timeline-applied", timeline: { ...compiled.summary, generation: this.timelineGeneration }, transport: this.transportIdentity });
    this.port.postMessage({ type: "event-trace-applied", trace: { version: eventTraceDomain.TRACE_VERSION, runtimeVersion: EVENT_TRACE_RUNTIME_VERSION, generation: this.timelineGeneration, windowVersion: realtimeEventWindowDomain.WINDOW_VERSION }, transport: this.transportIdentity });
    this.port.postMessage({ type: "realtime-budget-applied", budget: this.realtimeWindow.budgetSnapshot(), transport: this.transportIdentity });
    return Number.isSafeInteger(this.timelineNextFrame);
  }

  armStepSchedule(startFrame) {
    if (!this.playing) return false;
    if (this.timelineMode) {
      try { return this.compileTimeline(startFrame); }
      catch (error) { this.postTimelineError(error, "compile"); this.stop(this.transportIdentity); return false; }
    }
    this.createRowClock(startFrame, this.tempo);
    return true;
  }

  scheduleFollowingStep(appliedFrame) {
    if (!this.playing) { this.nextStepFrame = null; return; }
    if (!this.rowClock || this.rowClockTempo !== this.tempo) {
      this.createRowClock(appliedFrame, this.tempo);
      this.rowClockStep = 1;
      this.nextStepFrame = this.rowClock.frameAt(this.rowClockStep);
      return;
    }
    this.rowClockStep += 1;
    this.nextStepFrame = this.rowClock.frameAt(this.rowClockStep);
  }

  requestTimelineRebuild(reason) {
    if (!this.timelineMode || !this.playing) return false;
    if (this.tableSourcesActive()) { this.postTimelineError(new Error("live timeline rebuild with active Table sources is unresolved"), reason); return false; }
    this.timelineRebuildPending = true;
    this.timelineRebuildReason = reason;
    return true;
  }

  setTempo(value) {
    const next = this.normalizeTempo(value, this.tempo);
    if (next === this.tempo) return;
    if (this.timelineMode && this.tableSourcesActive()) { this.postTimelineError(new Error("live tempo change with active Table sources is unresolved"), "tempo"); return; }
    this.tempo = next;
    if (this.timelineMode) this.requestTimelineRebuild("tempo");
  }

  normalizeTrackProgram(candidate, previousPosition = null) {
    const events = Array.isArray(candidate?.events) ? candidate.events : [];
    const active = candidate?.active === true && events.length > 0;
    const requested = Number.isInteger(previousPosition) ? previousPosition : Number.isInteger(candidate?.startIndex) ? candidate.startIndex : 0;
    const position = active ? ((requested % events.length) + events.length) % events.length : 0;
    return { active, events, position };
  }

  resetLifecycleSlots() {
    for (const slot of this.lifecycleSlots) {
      slot.present = false;
      slot.forceRelease = false;
      slot.intent = noteLifecycleDomain.INTENTS.EMPTY;
      slot.note = null;
    }
  }

  stageLifecycleValues(track, note, forceRelease = false, { retrigger = true } = {}) {
    const slot = this.lifecycleSlots[track];
    if (!slot) return null;
    slot.present = true;
    slot.forceRelease = forceRelease === true;
    slot.note = note;
    const intent = noteLifecycleDomain.classifyIntent(note, false, slot.forceRelease);
    // K2 already models "an active voice carries, without a new attack" as
    // CARRY/EMPTY. Re-establishing state after a program replacement is exactly
    // that: the row was already heard, so re-attacking it puts an extra note on
    // at the seam that belongs to no step.
    slot.intent = retrigger === false && intent === noteLifecycleDomain.INTENTS.TRIGGER
      ? noteLifecycleDomain.INTENTS.EMPTY
      : intent;
    return slot;
  }

  applyTrackEvent(track, event, options = undefined) {
    const source = event && typeof event === "object" ? event : {};
    return this.stageLifecycleValues(track, source.note, false, options);
  }

  applyPreparedLifecycle(frame = this.nextStepFrame ?? 0) {
    for (let track = 0; track < this.lifecycleSlots.length; track += 1) {
      const slot = this.lifecycleSlots[track];
      if (!slot.present || slot.intent !== noteLifecycleDomain.INTENTS.RELEASE) continue;
      this.voices[track].release();
    }
    for (let track = 0; track < this.lifecycleSlots.length; track += 1) {
      const slot = this.lifecycleSlots[track];
      if (!slot.present || slot.intent !== noteLifecycleDomain.INTENTS.TRIGGER) continue;
      this.voices[track].triggerNote(slot.note);
    }
    this.lastLifecycleFrame = frame;
  }

  startSequence(sequence, tempo, transport = null, timeline = null) {
    this.mode = "sequence";
    this.transportIdentity = this.normalizeTransportIdentity(transport, this.mode);
    this.sequence = Array.isArray(sequence) ? sequence : [];
    this.tempo = this.normalizeTempo(tempo, this.tempo);
    this.stepIndex = 0;
    this.globalStep = 0;
    this.timelineRequest = timeline && typeof timeline === "object" ? timeline : null;
    this.timelineMode = this.timelineRequest !== null;
    this.playing = this.sequence.length > 0;
    this.resetStepSchedule();
    if (this.timelineMode) this.port.postMessage({ type: "timeline-requested", timeline: this.timelineRequest, transport: this.transportIdentity });
    this.postApplied();
  }

  startPlan(plan, tempo, transport = null) {
    this.mode = "track-plan";
    this.transportIdentity = this.normalizeTransportIdentity(transport, this.mode);
    this.sequence = [];
    this.tempo = this.normalizeTempo(tempo, this.tempo);
    this.trackPrograms = Array.from({ length: this.voices.length }, (_, track) => this.normalizeTrackProgram(plan?.tracks?.[track]));
    this.stepIndex = 0;
    this.globalStep = 0;
    this.timelineRequest = plan?.timeline && typeof plan.timeline === "object" ? plan.timeline : null;
    this.timelineMode = this.timelineRequest !== null;
    this.playing = this.trackPrograms.some((program) => program.active);
    this.resetStepSchedule();
    this.voices.forEach((voice, track) => { if (!this.trackPrograms[track].active) voice.release(); });
    if (this.timelineMode) this.port.postMessage({ type: "timeline-requested", timeline: this.timelineRequest, transport: this.transportIdentity });
    this.postApplied();
  }

  updateSequence(sequence, transport = null, timeline = null) {
    const next = Array.isArray(sequence) ? sequence : [];
    if (next.length === 0) { this.stop(transport); return; }
    if (this.timelineMode && this.tableSourcesActive()) { this.postTimelineError(new Error("live sequence replacement with active Table sources is unresolved"), "update-sequence"); return; }
    this.mode = "sequence";
    this.transportIdentity = this.normalizeTransportIdentity(transport, this.mode) ?? this.transportIdentity;
    const previousLength = this.sequence.length;
    const lastApplied = previousLength > 0 ? (this.stepIndex - 1 + previousLength) % previousLength : 0;
    this.sequence = next;
    this.stepIndex = this.stepIndex % next.length;
    this.playing = true;
    if (timeline && typeof timeline === "object") { this.timelineRequest = timeline; this.timelineMode = true; }
    this.updateCurrentVoices(Math.min(lastApplied, next.length - 1));
    if (this.timelineMode) this.requestTimelineRebuild("update-sequence");
    this.postApplied();
  }

  updatePlan(plan, transport = null) {
    if (this.timelineMode && this.tableSourcesActive()) { this.postTimelineError(new Error("live plan replacement with active Table sources is unresolved"), "update-plan"); return; }
    // #467: an edit to the running program preserves its phase, but a scope
    // transition REPLACES it - and there the outgoing position means nothing in
    // the incoming plan. song-transport-policy computes that plan's startIndex
    // deliberately; carrying the old position over discarded it and bound Song
    // wherever Phrase happened to be. The transport identity already carries
    // scope, so the two cases are distinguishable without a protocol change.
    // Read the DECLARED scope, not the normalized one: normalizeTransportIdentity
    // defaults an absent or unrecognised scope to "phrase", so an identity that
    // simply omits it would read as a transition away from Song and jump the
    // playhead on what is really an ordinary edit. A replacement has to say so.
    const declaredScope = SCOPES.includes(transport?.scope) ? transport.scope : null;
    const replacesProgram = Boolean(
      declaredScope && this.transportIdentity && declaredScope !== this.transportIdentity.scope,
    );
    const next = Array.from({ length: this.voices.length }, (_, track) => this.normalizeTrackProgram(
      plan?.tracks?.[track],
      replacesProgram ? null : (this.trackPrograms[track]?.position ?? 0),
    ));
    if (!next.some((program) => program.active)) { this.stop(transport); return; }
    this.mode = "track-plan";
    this.transportIdentity = this.normalizeTransportIdentity(transport, this.mode) ?? this.transportIdentity;
    this.sequence = [];
    this.trackPrograms = next;
    this.playing = true;
    if (plan?.timeline && typeof plan.timeline === "object") { this.timelineRequest = plan.timeline; this.timelineMode = true; }
    this.resetLifecycleSlots();
    this.voices.forEach((voice, track) => {
      const program = next[track];
      if (!program.active) { this.stageLifecycleValues(track, null, true); return; }
      const last = (program.position - 1 + program.events.length) % program.events.length;
      this.applyTrackEvent(track, program.events[last], { retrigger: false });
    });
    this.applyPreparedLifecycle(this.lastAppliedStepFrame >= 0 ? this.lastAppliedStepFrame : 0);
    if (this.timelineMode) this.requestTimelineRebuild("update-plan");
    this.postApplied();
  }

  updateCurrentVoices(index) {
    const event = this.sequence[index];
    if (!event) return;
    this.resetLifecycleSlots();
    for (let track = 0; track < this.voices.length; track += 1) this.stageLifecycleValues(track, event.notes?.[track], false);
    this.applyPreparedLifecycle(this.lastAppliedStepFrame >= 0 ? this.lastAppliedStepFrame : 0);
  }

  stop(transport = null) {
    const stoppedIdentity = this.normalizeTransportIdentity(transport, this.mode) ?? this.transportIdentity;
    this.playing = false;
    this.mode = "sequence";
    this.sequence = [];
    this.trackPrograms = Array.from({ length: this.voices.length }, () => ({ active: false, events: [], position: 0 }));
    this.stepIndex = 0;
    this.globalStep = 0;
    this.timelineMode = false;
    this.timelineRequest = null;
    this.resetStepSchedule();
    this.resetLifecycleSlots();
    this.voices.forEach((voice) => voice.release());
    this.transportIdentity = null;
    this.port.postMessage(stoppedIdentity ? { type: "transport-stopped", transport: stoppedIdentity } : { type: "stopped" });
  }

  applySequenceStep(frame = this.nextStepFrame ?? 0) {
    const event = this.sequence[this.stepIndex];
    if (!event) return;
    this.resetLifecycleSlots();
    for (let track = 0; track < this.voices.length; track += 1) this.stageLifecycleValues(track, event.notes?.[track], false);
    this.applyPreparedLifecycle(frame);
    this.port.postMessage({ type: "step", index: this.stepIndex, frame, transport: this.transportIdentity });
    this.stepIndex = (this.stepIndex + 1) % this.sequence.length;
  }

  applyPlanStep(frame = this.nextStepFrame ?? 0) {
    const trackSteps = Array(this.voices.length).fill(-1);
    this.resetLifecycleSlots();
    for (let track = 0; track < this.trackPrograms.length; track += 1) {
      const program = this.trackPrograms[track];
      if (!program.active || program.events.length === 0) { this.stageLifecycleValues(track, null, true); continue; }
      const applied = program.position;
      trackSteps[track] = applied;
      this.applyTrackEvent(track, program.events[applied]);
    }
    this.applyPreparedLifecycle(frame);
    for (let track = 0; track < this.trackPrograms.length; track += 1) {
      const program = this.trackPrograms[track];
      if (!program.active || program.events.length === 0) continue;
      program.position = (program.position + 1) % program.events.length;
    }
    this.port.postMessage({ type: "step", index: this.globalStep, frame, trackSteps, transport: this.transportIdentity });
    this.globalStep += 1;
  }

  applyStep(frame = this.nextStepFrame ?? 0) {
    if (!this.playing) return false;
    if (this.mode === "track-plan") {
      if (!this.trackPrograms.some((program) => program.active)) return false;
      this.applyPlanStep(frame);
    } else {
      if (this.sequence.length === 0) return false;
      this.applySequenceStep(frame);
    }
    this.lastAppliedStepFrame = frame;
    this.scheduleFollowingStep(frame);
    return true;
  }

  computeTimelineNextFrame() {
    let next = null;
    const accept = (candidate) => { if (Number.isSafeInteger(candidate) && (next === null || candidate < next)) next = candidate; };
    accept(this.timelineCursorFrame(this.timelineSequenceCursor));
    for (const cursor of this.timelineTrackCursors) accept(this.timelineCursorFrame(cursor));
    accept(this.timelineCompiled?.tableEvents?.[this.timelineTableIndex]?.frame);
    accept(this.timelinePendingEvents[0]?.frame);
    return next;
  }

  pushTimelineRow(kind, track, event, cursor) {
    if (this.timelineRowCount >= this.timelineRows.length) throw new RangeError(`K3C exceeded ${this.timelineRows.length} same-frame rows`);
    const slot = this.timelineRows[this.timelineRowCount];
    const timingRow = cursor?.cycle?.timingMap?.rows?.[event.row] ?? null;
    slot.kind = kind;
    slot.track = track;
    slot.row = event.row;
    slot.phraseRow = event.phraseRow;
    slot.sourceOrder = event.sourceOrder;
    slot.sampleRate = sampleRate;
    slot.ppqn = timingRow?.groove?.ppqn ?? 24;
    slot.tempo = timingRow?.tempo ?? this.tempo;
    this.timelineRowCount += 1;
  }

  collectTimelineRows(frame) {
    this.timelineRowCount = 0;
    while (this.timelineSequenceCursor && this.timelineCursorFrame(this.timelineSequenceCursor) === frame) {
      const event = this.timelineSequenceCursor.cycle.schedule[this.timelineSequenceCursor.pointer];
      this.pushTimelineRow("sequence", -1, event, this.timelineSequenceCursor);
      this.advanceTimelineCursor(this.timelineSequenceCursor);
    }
    for (let track = 0; track < this.timelineTrackCursors.length; track += 1) {
      const cursor = this.timelineTrackCursors[track];
      while (cursor && this.timelineCursorFrame(cursor) === frame) {
        const event = cursor.cycle.schedule[cursor.pointer];
        this.pushTimelineRow("track", track, event, cursor);
        this.advanceTimelineCursor(cursor);
      }
    }
  }

  timelineSource(rowEntry, track) {
    if (rowEntry.kind === "sequence") {
      const step = this.sequence[rowEntry.row];
      if (!step) return null;
      return { note: step.notes?.[track], velocity: step.velocities?.[track], instrumentId: step.instrumentIds?.[track], fx: step.fx?.[track] ?? null };
    }
    if (rowEntry.track !== track) return null;
    return this.trackPrograms[track]?.events?.[rowEntry.row] ?? null;
  }

  timelineRowEvents() {
    return Array.from({ length: this.timelineRowCount }, (_, index) => {
      const row = this.timelineRows[index];
      return Object.freeze({ kind: row.kind, track: row.track, row: row.row, phraseRow: row.phraseRow, sourceOrder: row.sourceOrder, timing: Object.freeze({ sampleRate: row.sampleRate, ppqn: row.ppqn, tempo: row.tempo }) });
    });
  }

  processTimelineLifecycle(frame, packet = null) {
    const tracePacket = packet ?? eventTraceDomain.buildFramePacket({ frame, program: this.timelineProgramSnapshot(), rowEvents: this.timelineRowEvents(), trackCount: this.voices.length });
    this.lastEventTracePacket = tracePacket;
    let appliedLifecycle = false;
    for (const event of tracePacket.events) {
      const voice = this.voices[event.track];
      if (!voice) continue;
      if (event.kind === "note-release") { voice.release(); appliedLifecycle = true; continue; }
      if (event.kind === "note-trigger") { voice.triggerNote(event.data.note); appliedLifecycle = true; }
    }
    if (appliedLifecycle) this.lastLifecycleFrame = frame;
    return tracePacket;
  }

  applyTimelineFrame(frame) {
    if (!this.timelineCompiled) return false;
    const tableEvents = [];
    while (this.timelineCompiled.tableEvents[this.timelineTableIndex]?.frame === frame) {
      this.realtimeWindow.assertSameFrameDemand(tableEvents.length + 1, frame);
      tableEvents.push(this.timelineCompiled.tableEvents[this.timelineTableIndex]);
      this.timelineTableIndex += 1;
    }
    const scheduledEvents = eventTraceDomain.takeScheduledEvents(this.timelinePendingEvents, frame);
    this.collectTimelineRows(frame);
    const rowEvents = this.timelineRowEvents();
    const tracePacket = eventTraceDomain.buildFramePacket({ frame, program: this.timelineProgramSnapshot(), tableEvents, rowEvents, scheduledEvents, trackCount: this.voices.length });
    eventTraceDomain.enqueueScheduledEvents(this.timelinePendingEvents, tracePacket.futureEvents);
    this.realtimeWindow.push(tracePacket);
    this.lastEventTracePacket = tracePacket;
    this.processTimelineLifecycle(frame, tracePacket);

    const trackEvents = [];
    const sequenceEvents = [];
    for (let index = 0; index < this.timelineRowCount; index += 1) {
      const row = this.timelineRows[index];
      if (row.kind === "sequence") {
        sequenceEvents.push({ row: row.row, phraseRow: row.phraseRow, sourceOrder: row.sourceOrder });
        this.stepIndex = (row.row + 1) % this.sequence.length;
      } else {
        const program = this.trackPrograms[row.track];
        if (program?.active && program.events.length > 0) program.position = (row.row + 1) % program.events.length;
        this.timelineTrackPositions[row.track] = row.row;
        trackEvents.push({ track: row.track, row: row.row, phraseRow: row.phraseRow, sourceOrder: row.sourceOrder });
      }
    }

    if (this.timelineRowCount > 0) {
      const message = { type: "step", index: this.mode === "track-plan" ? this.globalStep : sequenceEvents.at(-1)?.row ?? this.stepIndex, frame, transport: this.transportIdentity, timelineGeneration: this.timelineGeneration };
      if (this.mode === "track-plan") { message.trackSteps = [...this.timelineTrackPositions]; message.trackEvents = trackEvents; this.globalStep += 1; }
      else message.sequenceEvents = sequenceEvents;
      this.port.postMessage(message);
      this.lastAppliedStepFrame = frame;
    }

    if (this.timelineDiagnostics && (tableEvents.length > 0 || scheduledEvents.length > 0 || this.timelineRowCount > 0)) {
      this.port.postMessage({
        type: "timeline-frame",
        frame,
        generation: this.timelineGeneration,
        traceVersion: tracePacket.version,
        traceEvents: tracePacket.events.map((event) => ({ frame: event.frame, phase: event.phase, track: event.track, sourceOrder: event.sourceOrder, ordinal: event.ordinal, kind: event.kind, source: event.source, data: event.data })),
        tableEvents: tableEvents.map((event) => ({ phase: event.phase, track: event.track, sourceOrder: event.sourceOrder, kind: event.kind, source: event.source, data: event.data })),
        scheduledEvents: scheduledEvents.map((event) => ({ phase: event.phase, track: event.track, sourceOrder: event.sourceOrder, kind: event.kind, source: event.source, data: event.data })),
        trackEvents,
        sequenceEvents,
        transport: this.transportIdentity,
      });
    }

    this.timelineNextFrame = this.computeTimelineNextFrame();
    this.nextStepFrame = this.timelineNextFrame;
    if (this.timelineNextFrame !== null && this.timelineNextFrame <= frame) throw new Error("K4A shared event trace did not advance after draining a frame");
    return true;
  }

  processTimelineUntil(absoluteFrame) {
    const ownsWindow = !this.realtimeWindow.active;
    if (ownsWindow) {
      const firstDueFrame = Number.isSafeInteger(this.timelineNextFrame) ? Math.min(this.timelineNextFrame, absoluteFrame) : absoluteFrame;
      this.realtimeWindow.begin(firstDueFrame, Math.max(1, absoluteFrame - firstDueFrame + 1));
    }
    try {
      while (this.playing && Number.isSafeInteger(this.timelineNextFrame) && this.timelineNextFrame <= absoluteFrame) {
        const dueFrame = this.timelineNextFrame;
        if (this.timelineRebuildPending) {
          try { this.compileTimeline(dueFrame); }
          catch (error) { this.postTimelineError(error, this.timelineRebuildReason ?? "rebuild"); this.stop(this.transportIdentity); return false; }
          continue;
        }
        if (!this.applyTimelineFrame(dueFrame)) return false;
      }
      return true;
    } finally {
      if (ownsWindow) this.realtimeWindow.finish();
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const left = output[0];
    const right = output[1] ?? output[0];
    const blockStartFrame = this.currentBlockStartFrame();

    if (this.timelineMode && this.playing && left.length > 0) {
      try { this.beginRealtimeWindow(blockStartFrame, left.length); }
      catch (error) { if (!this.handleRealtimeWindowError(error)) throw error; }
    }
    if (this.playing && this.schedulePending) this.armStepSchedule(blockStartFrame);

    for (let frame = 0; frame < left.length; frame += 1) {
      const absoluteFrame = blockStartFrame + frame;
      if (this.timelineMode) {
        try { this.processTimelineUntil(absoluteFrame); }
        catch (error) { if (!this.handleRealtimeWindowError(error)) throw error; }
      } else {
        while (this.playing && Number.isSafeInteger(this.nextStepFrame) && this.nextStepFrame <= absoluteFrame) {
          const dueFrame = this.nextStepFrame;
          if (!this.applyStep(dueFrame)) break;
          if (this.nextStepFrame !== null && this.nextStepFrame <= dueFrame) throw new Error("AudioWorklet timing clock did not advance");
        }
      }
      left[frame] = 0;
      right[frame] = 0;
    }

    if (this.realtimeWindow.active) this.realtimeWindow.finish();
    this.fallbackRenderFrame = blockStartFrame + left.length;
    this.meterCounter += 1;
    if (this.meterCounter >= 12) {
      this.meterCounter = 0;
      this.port.postMessage({ type: "meter", left: 0, right: 0 });
    }
    return true;
  }
}

const RegisteredBrktrkAudioProcessor = globalThis.BRKTRKProductionAudioProcessorExtension?.extendProcessor?.(BrktrkAudioProcessor) ?? BrktrkAudioProcessor;
registerProcessor("brktrk-audio", RegisteredBrktrkAudioProcessor);