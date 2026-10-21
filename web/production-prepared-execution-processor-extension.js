(() => {
  "use strict";

  const baseExtension = globalThis.BRKTRKProductionAudioProcessorExtension;
  const executionDomain = globalThis.BRKTRKProductionExecutionTemplate;
  const queueDomain = globalThis.BRKTRKRealtimeExecutionQueue;
  if (!baseExtension?.extendProcessor || !executionDomain?.validatePreparedExecution || !queueDomain?.createRealtimeExecutionQueue) {
    throw new Error("prepared execution processor extension requires the R1 processor chain + R2 execution/queue domains");
  }

  const PREPARED_EXECUTION_ERROR = "invalid-prepared-execution";
  const PREPARED_MESSAGE_TYPES = new Set(["play", "play-plan", "update-sequence", "update-plan", "tempo"]);

  function programForMessage(processor, message) {
    if (message.type === "play" || message.type === "update-sequence") {
      return Object.freeze({ mode: "sequence", steps: Array.isArray(message.sequence) ? message.sequence : [] });
    }
    if (message.type === "play-plan" || message.type === "update-plan") return message.plan;
    return processor.timelineProgramSnapshot();
  }

  function modeForMessage(processor, message) {
    if (message.type === "play" || message.type === "update-sequence") return "sequence";
    if (message.type === "play-plan" || message.type === "update-plan") return "track-plan";
    return processor.mode === "track-plan" ? "track-plan" : "sequence";
  }

  function extendProcessor(BaseProcessor) {
    if (typeof BaseProcessor !== "function") throw new TypeError("prepared execution extension requires the authoritative processor class");
    const PreparedTimelineProcessor = baseExtension.extendProcessor(BaseProcessor);

    return class BrktrkPreparedExecutionProcessor extends PreparedTimelineProcessor {
      constructor(...args) {
        super(...args);
        this.preparedExecutionTemplate = null;
        this.pendingPreparedExecutionTemplate = null;
        this.preparedExecutionSequenceRows = null;
        this.preparedExecutionTrackRows = Array(this.voices.length).fill(null);
        this.executionQueue = queueDomain.createRealtimeExecutionQueue({ capacity: this.realtimeWindow.budgetSnapshot().eventCapacity });
        this.r2DrainVisitor = (eventFrame, eventPhase, eventTrack, eventSourceOrder, eventKind, eventInstrumentId, eventNote, eventVelocity, eventFxLane, eventRetrigger, eventResetsPhase) => {
          this.applyPreparedExecutionEvent(eventFrame, eventPhase, eventTrack, eventSourceOrder, eventKind, eventInstrumentId, eventNote, eventVelocity, eventFxLane, eventRetrigger, eventResetsPhase);
        };
        // MessagePort structured-clones synchronously. Reuse one bounded source
        // object instead of constructing per-row transport-observability objects
        // in the AudioWorklet. Detailed row arrays remain diagnostics-only via
        // the legacy branch below.
        this.r2StepMessage = {
          type: "step",
          index: 0,
          frame: 0,
          trackSteps: null,
          transport: null,
          timelineGeneration: 0,
        };

        const baseMessageHandler = this.port.onmessage;
        this.port.onmessage = (event) => {
          const message = event?.data ?? {};
          if (!PREPARED_MESSAGE_TYPES.has(message.type)) {
            baseMessageHandler(event);
            return;
          }
          const executionTemplate = message.executionTemplate ?? null;
          try {
            if (!executionTemplate) throw new Error(`K3 R2 ${message.type} requires a prepared execution template`);
            executionDomain.validatePreparedExecution(executionTemplate, {
              timelineTemplate: message.timelineTemplate ?? this.preparedTimelineTemplate,
              mode: modeForMessage(this, message),
              program: programForMessage(this, message),
            });
          } catch (error) {
            this.port.postMessage({
              type: "production-transport-rejected",
              code: PREPARED_EXECUTION_ERROR,
              message: String(error?.message ?? error),
              transport: message.transport ?? this.transportIdentity,
            });
            return;
          }
          this.pendingPreparedExecutionTemplate = executionTemplate;
          try { baseMessageHandler(event); }
          finally { this.pendingPreparedExecutionTemplate = null; }
        };
      }

      commitPreparedExecution() {
        if (!this.pendingPreparedExecutionTemplate) throw new Error("K3 R2 prepared execution template is missing at commit");
        this.preparedExecutionTemplate = this.pendingPreparedExecutionTemplate;
        this.preparedExecutionSequenceRows = this.preparedExecutionTemplate.sequenceRows;
        this.preparedExecutionTrackRows.fill(null);
        for (const entry of this.preparedExecutionTemplate.tracks ?? []) this.preparedExecutionTrackRows[entry.track] = entry.rows;
        return this.preparedExecutionTemplate;
      }

      resetTimelineSchedule() {
        super.resetTimelineSchedule();
        this.executionQueue?.clear?.();
      }

      startSequence(...args) {
        super.startSequence(...args);
        if (this.playing) this.commitPreparedExecution();
      }

      startPlan(...args) {
        super.startPlan(...args);
        if (this.playing) this.commitPreparedExecution();
      }

      updateSequence(...args) {
        super.updateSequence(...args);
        if (this.playing) this.commitPreparedExecution();
      }

      updatePlan(...args) {
        super.updatePlan(...args);
        if (this.playing) this.commitPreparedExecution();
      }

      setTempo(value) {
        const before = this.tempo;
        super.setTempo(value);
        if (this.playing && this.tempo !== before && this.timelineRebuildPending) this.commitPreparedExecution();
      }

      compileTimeline(startFrame) {
        // R1 compilation clears its legacy scheduled-event array at this same
        // exact bind boundary. Clear the R2 heap before R1 computes the next
        // frame so no event from the replaced program can become a second
        // timing authority.
        this.executionQueue.clear();
        return super.compileTimeline(startFrame);
      }

      computeTimelineNextFrame() {
        const baseNext = super.computeTimelineNextFrame();
        const executionNext = this.executionQueue?.peekFrame?.() ?? null;
        if (!Number.isSafeInteger(executionNext)) return baseNext;
        if (!Number.isSafeInteger(baseNext)) return executionNext;
        return Math.min(baseNext, executionNext);
      }

      preparedRowsFor(row) {
        return row.kind === "sequence"
          ? this.preparedExecutionSequenceRows?.[row.row] ?? null
          : this.preparedExecutionTrackRows[row.track]?.[row.row] ?? null;
      }

      enqueuePreparedRow(frame, row) {
        const records = this.preparedRowsFor(row);
        if (!Array.isArray(records)) throw new Error(`K3 R2 prepared execution row ${row.kind}:${row.track}:${row.row} is unavailable`);
        for (let index = 0; index < records.length; index += 1) {
          const record = records[index];
          const eventFrame = frame + record.frameDelta;
          if (!Number.isSafeInteger(eventFrame) || eventFrame < frame) throw new RangeError("K3 R2 execution frame exceeds the safe absolute-frame range");
          this.executionQueue.push(
            eventFrame,
            record.phase,
            record.track,
            row.sourceOrder,
            record.kind,
            record.instrumentId,
            record.note,
            record.velocity,
            record.fxLane,
            record.retrigger,
            record.resetsPhase,
          );
        }
      }

      routePreparedProduction(frame, track, kind, instrumentId, note, velocity, retrigger) {
        if (!this.productionAudio?.hasInstrument?.(instrumentId)) return false;
        if (kind !== executionDomain.KIND.NOTE_RELEASE && kind !== executionDomain.KIND.NOTE_TRIGGER) return true;
        const type = kind === executionDomain.KIND.NOTE_RELEASE ? "note-off" : retrigger ? "retrigger" : "note-on";
        return this.productionAudio.routePreparedLifecycle(frame, track, instrumentId, type, note, velocity) === true;
      }

      applyPreparedExecutionEvent(frame, _phase, track, _sourceOrder, kind, instrumentId, note, velocity, _fxLane, retrigger, _resetsPhase) {
        if (kind !== executionDomain.KIND.NOTE_RELEASE && kind !== executionDomain.KIND.NOTE_TRIGGER) return false;
        const productionConsumed = this.routePreparedProduction(frame, track, kind, instrumentId, note, velocity, retrigger);
        if (!productionConsumed) {
          const voice = this.voices[track];
          if (!voice) return false;
          if (kind === executionDomain.KIND.NOTE_RELEASE) voice.release();
          else voice.triggerNote(note);
        }
        this.lastLifecycleFrame = frame;
        return true;
      }

      postPreparedStep(frame, sequenceRow) {
        const message = this.r2StepMessage;
        message.index = this.mode === "track-plan" ? this.globalStep : sequenceRow >= 0 ? sequenceRow : this.stepIndex;
        message.frame = frame;
        message.trackSteps = this.mode === "track-plan" ? this.timelineTrackPositions : null;
        message.transport = this.transportIdentity;
        message.timelineGeneration = this.timelineGeneration;
        this.port.postMessage(message);
        if (this.mode === "track-plan") this.globalStep += 1;
        this.lastAppliedStepFrame = frame;
      }

      applyTimelineFrame(frame) {
        // DEBUG timeline-frame output intentionally retains the legacy complete
        // object trace. Diagnostics are explicit opt-in; ordinary playback is
        // the allocation-hardened prepared path below.
        if (this.timelineDiagnostics) return super.applyTimelineFrame(frame);
        if (!this.timelineCompiled || !this.preparedExecutionTemplate) return false;

        let tableCount = 0;
        let nextTableIndex = this.timelineTableIndex;
        while (this.timelineCompiled.tableEvents[nextTableIndex]?.frame === frame) {
          tableCount += 1;
          nextTableIndex += 1;
        }

        this.collectTimelineRows(frame);
        for (let index = 0; index < this.timelineRowCount; index += 1) this.enqueuePreparedRow(frame, this.timelineRows[index]);

        const executionCount = this.executionQueue.countFrame(frame);
        this.realtimeWindow.reserveFrame(frame, tableCount + executionCount);
        this.timelineTableIndex = nextTableIndex;
        this.executionQueue.drainFrame(frame, this.r2DrainVisitor);
        this.lastEventTracePacket = null;

        let sequenceRow = -1;
        for (let index = 0; index < this.timelineRowCount; index += 1) {
          const row = this.timelineRows[index];
          if (row.kind === "sequence") {
            sequenceRow = row.row;
            this.stepIndex = (row.row + 1) % this.sequence.length;
          } else {
            const program = this.trackPrograms[row.track];
            if (program?.active && program.events.length > 0) program.position = (row.row + 1) % program.events.length;
            this.timelineTrackPositions[row.track] = row.row;
          }
        }

        if (this.timelineRowCount > 0) this.postPreparedStep(frame, sequenceRow);

        this.timelineNextFrame = this.computeTimelineNextFrame();
        this.nextStepFrame = this.timelineNextFrame;
        if (this.timelineNextFrame !== null && this.timelineNextFrame <= frame) throw new Error("K3 R2 prepared execution did not advance after draining a frame");
        return true;
      }

      handleRealtimeWindowError(error) {
        if (error instanceof queueDomain.RealtimeExecutionQueueError) {
          this.port.postMessage({
            type: "realtime-window-error",
            code: error.code,
            message: String(error.message),
            details: error.details ?? null,
            budget: this.realtimeWindow.budgetSnapshot(),
            execution: this.executionQueue.diagnostics(),
            transport: this.transportIdentity,
          });
          this.stop(this.transportIdentity);
          return true;
        }
        return super.handleRealtimeWindowError(error);
      }

      stop(...args) {
        this.preparedExecutionTemplate = null;
        this.pendingPreparedExecutionTemplate = null;
        this.preparedExecutionSequenceRows = null;
        this.preparedExecutionTrackRows.fill(null);
        this.executionQueue.clear();
        super.stop(...args);
      }
    };
  }

  globalThis.BRKTRKProductionAudioProcessorExtension = Object.freeze({
    ...baseExtension,
    extendProcessor,
    PREPARED_EXECUTION_ERROR,
  });
  if (typeof module !== "undefined" && module.exports) module.exports = globalThis.BRKTRKProductionAudioProcessorExtension;
})();
