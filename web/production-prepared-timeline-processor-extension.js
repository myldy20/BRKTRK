(() => {
  "use strict";

  const baseExtension = globalThis.BRKTRKProductionAudioProcessorExtension;
  const templateDomain = globalThis.BRKTRKProductionTimelineTemplate;
  const traceDomain = globalThis.BRKTRKEventTraceDomain;
  const realtimeWindowDomain = globalThis.BRKTRKRealtimeEventWindowDomain;
  if (!baseExtension?.extendProcessor || !templateDomain?.validateRelativeTimeline || !templateDomain?.bindRelativeTimeline || !traceDomain || !realtimeWindowDomain) {
    throw new Error("prepared timeline processor extension requires production processor + relative timeline + K4 domains");
  }

  const PREPARED_TIMELINE_ERROR = "invalid-prepared-timeline";
  const PREPARED_MESSAGE_TYPES = new Set(["play", "play-plan", "update-sequence", "update-plan", "tempo"]);
  const EVENT_TRACE_RUNTIME_VERSION = 3;

  function sequenceProgram(sequence, startIndex = 0) {
    const steps = Array.isArray(sequence) ? sequence : [];
    return Object.freeze({ mode: "sequence", steps, startIndex });
  }

  function preparedTempoNumber(value) {
    if (value && typeof value === "object" && Object.hasOwn(value, "numerator")) {
      const numerator = Number(value.numerator);
      const denominator = Number(value.denominator ?? 1);
      if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return NaN;
      return numerator / denominator;
    }
    return Number(value);
  }

  function expectedTrackPlan(processor, plan) {
    const tracks = Array.from({ length: processor.voices.length }, (_, track) => {
      const candidate = plan?.tracks?.[track];
      const events = Array.isArray(candidate?.events) ? candidate.events : [];
      const active = candidate?.active === true && events.length > 0;
      if (!active) return Object.freeze({ active: false, events: Object.freeze([]), startIndex: 0 });
      const requested = Number.isInteger(candidate?.startIndex) ? candidate.startIndex : Number.isInteger(candidate?.position) ? candidate.position : 0;
      return Object.freeze({ ...candidate, active: true, events, startIndex: ((requested % events.length) + events.length) % events.length });
    });
    return Object.freeze({ ...plan, mode: "track-plan", tracks: Object.freeze(tracks) });
  }

  function extendProcessor(BaseProcessor) {
    if (typeof BaseProcessor !== "function") throw new TypeError("prepared timeline extension requires the authoritative processor class");
    const ProductionProcessor = baseExtension.extendProcessor(BaseProcessor);

    return class BrktrkPreparedTimelineProcessor extends ProductionProcessor {
      constructor(...args) {
        super(...args);
        this.preparedTimelineTemplate = null;
        this.pendingPreparedTimelineTemplate = null;
        const baseMessageHandler = this.port.onmessage;
        this.port.onmessage = (event) => {
          const message = event?.data ?? {};
          if (!PREPARED_MESSAGE_TYPES.has(message.type)) {
            baseMessageHandler(event);
            return;
          }
          this.pendingPreparedTimelineTemplate = message.timelineTemplate ?? null;
          try {
            baseMessageHandler(event);
          } catch (error) {
            const transport = message.transport ?? this.transportIdentity;
            this.port.postMessage({
              type: "production-transport-rejected",
              code: PREPARED_TIMELINE_ERROR,
              message: String(error?.message ?? error),
              transport,
            });
          } finally {
            this.pendingPreparedTimelineTemplate = null;
          }
        };
      }

      validatePreparedTimeline(program, mode, expectedTempo = this.tempo) {
        const template = this.pendingPreparedTimelineTemplate;
        if (!template) throw new Error(`K3 R1 ${mode} requires a prepared relative timeline`);
        templateDomain.validateRelativeTimeline(template, {
          sampleRate,
          mode,
          program,
          enforceStartIndex: false,
        });
        const normalizedTempo = this.normalizeTempo(expectedTempo, this.tempo);
        const preparedTempo = preparedTempoNumber(template.tempo);
        if (!Number.isFinite(preparedTempo) || preparedTempo !== normalizedTempo) {
          throw new RangeError(`K3 R1 prepared tempo ${preparedTempo} does not match runtime tempo ${normalizedTempo}`);
        }
        return template;
      }

      commitPreparedTimeline(template) {
        this.preparedTimelineTemplate = template;
        return template;
      }

      timelineBindPosition() {
        if (this.mode === "track-plan") {
          return Object.freeze({
            trackStartIndices: Object.freeze(this.trackPrograms.map((program) => program?.active && program.events.length > 0 ? program.position : -1)),
          });
        }
        return Object.freeze({ sequenceStartIndex: Number.isInteger(this.stepIndex) ? this.stepIndex : 0 });
      }

      startSequence(sequence, tempo, transport = null, timeline = null) {
        const template = this.validatePreparedTimeline(sequenceProgram(sequence, 0), "sequence", tempo);
        super.startSequence(sequence, tempo, transport, timeline);
        if (this.playing) this.commitPreparedTimeline(template);
      }

      startPlan(plan, tempo, transport = null) {
        const template = this.validatePreparedTimeline(expectedTrackPlan(this, plan), "track-plan", tempo);
        super.startPlan(plan, tempo, transport);
        if (this.playing) this.commitPreparedTimeline(template);
      }

      updateSequence(sequence, transport = null, timeline = null) {
        const steps = Array.isArray(sequence) ? sequence : [];
        if (steps.length === 0 || (this.timelineMode && this.tableSourcesActive())) {
          super.updateSequence(sequence, transport, timeline);
          return;
        }
        const template = this.validatePreparedTimeline(sequenceProgram(steps, 0), "sequence", this.tempo);
        super.updateSequence(sequence, transport, timeline);
        if (this.playing) this.commitPreparedTimeline(template);
      }

      updatePlan(plan, transport = null) {
        if (this.timelineMode && this.tableSourcesActive()) {
          super.updatePlan(plan, transport);
          return;
        }
        const template = this.validatePreparedTimeline(expectedTrackPlan(this, plan), "track-plan", this.tempo);
        super.updatePlan(plan, transport);
        if (this.playing) this.commitPreparedTimeline(template);
      }

      setTempo(value) {
        const next = this.normalizeTempo(value, this.tempo);
        if (next === this.tempo || !this.timelineMode || this.tableSourcesActive()) {
          super.setTempo(value);
          return;
        }
        const template = this.validatePreparedTimeline(this.timelineProgramSnapshot(), this.mode, next);
        super.setTempo(value);
        if (this.timelineRebuildPending) this.commitPreparedTimeline(template);
      }

      compileTimeline(startFrame) {
        const template = this.preparedTimelineTemplate;
        if (!template) throw new Error("K3 R1 prepared timeline is missing at exact-frame bind");
        const compiled = templateDomain.bindRelativeTimeline(template, startFrame, this.timelineBindPosition());
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
        this.timelineTrackPositions = this.trackPrograms.map((program) => !program.active || program.events.length === 0
          ? -1
          : (program.position - 1 + program.events.length) % program.events.length);
        this.timelineRebuildPending = false;
        this.timelineRebuildReason = null;
        this.schedulePending = false;
        this.timelineNextFrame = this.computeTimelineNextFrame();
        this.nextStepFrame = this.timelineNextFrame;
        this.port.postMessage({
          type: "timeline-applied",
          timeline: { ...compiled.summary, generation: this.timelineGeneration, prepared: true },
          transport: this.transportIdentity,
        });
        this.port.postMessage({
          type: "event-trace-applied",
          trace: {
            version: traceDomain.TRACE_VERSION,
            runtimeVersion: EVENT_TRACE_RUNTIME_VERSION,
            generation: this.timelineGeneration,
            windowVersion: realtimeWindowDomain.WINDOW_VERSION,
          },
          transport: this.transportIdentity,
        });
        this.port.postMessage({ type: "realtime-budget-applied", budget: this.realtimeWindow.budgetSnapshot(), transport: this.transportIdentity });
        return Number.isSafeInteger(this.timelineNextFrame);
      }

      stop(transport = null) {
        this.preparedTimelineTemplate = null;
        this.pendingPreparedTimelineTemplate = null;
        super.stop(transport);
      }
    };
  }

  globalThis.BRKTRKProductionAudioProcessorExtension = Object.freeze({
    ...baseExtension,
    extendProcessor,
    PREPARED_TIMELINE_ERROR,
  });
  if (typeof module !== "undefined" && module.exports) module.exports = globalThis.BRKTRKProductionAudioProcessorExtension;
})();
