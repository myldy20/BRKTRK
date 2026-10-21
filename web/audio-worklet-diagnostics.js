const DIAGNOSTICS_RELEASE = "0.9.0";

class BrktrkRuntimeDiagnosticsProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const build = globalThis.BRKTRKAudioWorkletBuild ?? null;
    const timeline = globalThis.BRKTRKProductionTimelineDomain ?? null;
    const phraseFx = globalThis.BRKTRKPhraseFxRuntimeDomain ?? null;
    const trace = globalThis.BRKTRKEventTraceDomain ?? null;
    const realtimeWindow = globalThis.BRKTRKRealtimeEventWindowDomain ?? null;

    this.port.postMessage({
      type: "brktrk-runtime-info",
      diagnosticsRelease: DIAGNOSTICS_RELEASE,
      workletRelease: build?.release ?? null,
      runtimeProtocol: build?.runtimeProtocol ?? null,
      timelineVersion: timeline?.TIMELINE_VERSION ?? null,
      phraseFxRuntimeVersion: phraseFx?.RUNTIME_VERSION ?? null,
      traceVersion: trace?.TRACE_VERSION ?? null,
      realtimeWindowVersion: realtimeWindow?.WINDOW_VERSION ?? null,
      sampleRate,
      loaded: {
        productionTimeline: Boolean(timeline),
        phraseFxRuntime: Boolean(phraseFx),
        eventTrace: Boolean(trace),
        realtimeWindow: Boolean(realtimeWindow),
      },
    });
  }

  process() {
    return false;
  }
}

registerProcessor("brktrk-runtime-diagnostics", BrktrkRuntimeDiagnosticsProcessor);