(() => {
  const ADAPTER_RELEASE = "0.9.0";
  const timelineDomain = globalThis.BRKTRKProductionTimelineDomain;
  const templateDomain = globalThis.BRKTRKProductionTimelineTemplate;
  const executionDomain = globalThis.BRKTRKProductionExecutionTemplate;
  if (!timelineDomain || !templateDomain?.compileRelativeTimeline || !executionDomain?.compilePreparedExecution) {
    throw new Error("K3C Transport adapter requires production + relative timeline + prepared execution domains");
  }

  // app-model.js exposes the audio facade as a top-level lexical `const audio`.
  // Classic browser scripts can read that binding from later scripts, but it is
  // intentionally not a property of globalThis. Checking only globalThis.audio
  // therefore rejects the real production facade even though `audio` exists.
  const audioFacade = typeof audio !== "undefined" ? audio : globalThis.audio;
  if (!audioFacade) throw new Error("K3C Transport adapter requires the existing audio facade");

  const inheritedStop = typeof audioFacade.stop === "function" ? audioFacade.stop.bind(audioFacade) : null;
  const inheritedTempo = typeof audioFacade.tempo === "function" ? audioFacade.tempo.bind(audioFacade) : null;
  let desiredProgram = null;
  let pendingTempo = null;

  function sequenceProgram(sequence) {
    const steps = Array.isArray(sequence) ? sequence : [];
    return Object.freeze({
      mode: "sequence",
      steps,
      contexts: Object.freeze(Array.from({ length: steps.length }, (_, row) => Object.freeze({ phraseRow: row % 16 }))),
    });
  }

  function timelineForProgram(program) {
    return timelineDomain.createTimelineRequest(program, program?.timeline ?? null);
  }

  function projectTempo(fallback = 120) {
    const value = Number(globalThis.BRKTRKStores?.project?.getState?.()?.tempo);
    return Number.isFinite(value) ? value : fallback;
  }

  function audioSampleRate() {
    const rate = Number(audioFacade.context?.sampleRate);
    if (!Number.isSafeInteger(rate) || rate < 1) throw new Error("K3 R2 requires the active AudioContext sampleRate before timeline preparation");
    return rate;
  }

  function preparedTimelineForProgram(program, tempo = projectTempo()) {
    const timeline = timelineForProgram(program);
    const timelineTemplate = templateDomain.compileRelativeTimeline({
      sampleRate: audioSampleRate(),
      tempo,
      program,
      request: timeline,
    });
    const executionTemplate = executionDomain.compilePreparedExecution({ timelineTemplate, program });
    return Object.freeze({ timeline, timelineTemplate, executionTemplate });
  }

  audioFacade.play = function k3cPlaySequence(sequence, tempo, transport) {
    if (!this.ready || !this.node) return;
    const program = sequenceProgram(sequence);
    const prepared = preparedTimelineForProgram(program, tempo);
    desiredProgram = program;
    this.node.port.postMessage({
      type: "play",
      sequence: program.steps,
      tempo,
      transport,
      timeline: prepared.timeline,
      timelineTemplate: prepared.timelineTemplate,
      executionTemplate: prepared.executionTemplate,
    });
  };

  audioFacade.playPlan = function k3cPlayPlan(plan, tempo, transport) {
    if (!this.ready || !this.node) return;
    const prepared = preparedTimelineForProgram(plan, tempo);
    desiredProgram = plan;
    this.node.port.postMessage({
      type: "play-plan",
      plan: { ...plan, timeline: prepared.timeline },
      tempo,
      transport,
      timelineTemplate: prepared.timelineTemplate,
      executionTemplate: prepared.executionTemplate,
    });
  };

  audioFacade.updateSequence = function k3cUpdateSequence(sequence, transport) {
    if (!this.ready || !this.node) return;
    const program = sequenceProgram(sequence);
    const prepared = preparedTimelineForProgram(program, projectTempo(120));
    desiredProgram = program;
    this.node.port.postMessage({
      type: "update-sequence",
      sequence: program.steps,
      transport,
      timeline: prepared.timeline,
      timelineTemplate: prepared.timelineTemplate,
      executionTemplate: prepared.executionTemplate,
    });
  };

  audioFacade.updatePlan = function k3cUpdatePlan(plan, transport) {
    if (!this.ready || !this.node) return;
    const prepared = preparedTimelineForProgram(plan, projectTempo(120));
    desiredProgram = plan;
    this.node.port.postMessage({
      type: "update-plan",
      plan: { ...plan, timeline: prepared.timeline },
      transport,
      timelineTemplate: prepared.timelineTemplate,
      executionTemplate: prepared.executionTemplate,
    });
  };

  audioFacade.tempo = function k3cPreparedTempo(value) {
    if (!this.ready || !this.node) return;
    const transport = transportStore?.runtime?.snapshot?.();
    if (desiredProgram && transport?.playing && transport.applied && transport.requested
      && (transport.applied.id !== transport.requested.id || transport.applied.version !== transport.requested.version)) {
      // An update and its tempo edit can reach the port before the host hears
      // either acknowledgement. Wait for the program outcome so a rejected
      // new-engine update cannot leave Tempo carrying its execution template.
      pendingTempo = value;
      return;
    }
    if (!desiredProgram) {
      inheritedTempo?.(value);
      return;
    }
    const prepared = preparedTimelineForProgram(desiredProgram, value);
    this.node.port.postMessage({
      type: "tempo",
      value,
      timelineTemplate: prepared.timelineTemplate,
      executionTemplate: prepared.executionTemplate,
    });
  };

  audioFacade.stop = function k3cPreparedStop(transport) {
    desiredProgram = null;
    pendingTempo = null;
    if (inheritedStop) inheritedStop(transport);
  };

  const transportStore = globalThis.BRKTRKStores?.transport;
  transportStore?.subscribe?.("transport", (changeSet) => {
    if (["transport.program.stopped", "transport.worklet.error"].includes(changeSet.target)) {
      pendingTempo = null;
      return;
    }
    if (!["transport.program.deferred", "transport.program.applied"].includes(changeSet.target)) return;
    const applied = transportStore.runtime.getProgram();
    desiredProgram = applied?.mode === "track-plan" ? applied
      : applied ? sequenceProgram(applied.steps) : null;
    if (pendingTempo !== null) {
      const value = pendingTempo;
      pendingTempo = null;
      audioFacade.tempo(value);
    }
  });

  document.body.dataset.timelineArchitecture = "k3c";
  document.body.dataset.timelinePreparation = "r1-prepared-exact-bind";
  document.body.dataset.executionPreparation = "r2-prepared-lifecycle";
  document.body.dataset.k3cRelease = ADAPTER_RELEASE;
  globalThis.BRKTRKK3CTransportAdapter = Object.freeze({
    version: timelineDomain.TIMELINE_VERSION,
    release: ADAPTER_RELEASE,
    sequenceProgram,
    timelineForProgram,
    preparedTimelineForProgram,
    desiredProgram: () => desiredProgram,
  });
})();
