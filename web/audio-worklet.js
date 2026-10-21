import "./timing-domain.js";
import "./timing-map-domain.js";
import "./table-source-domain.js";
import "./production-timeline-domain.js";
import "./production-timeline-template.js";
import "./production-timeline-bind-budget-extension.js";
import "./note-lifecycle-domain.js";
import "./phrase-fx-domain.js";
import "./phrase-fx-runtime-domain.js";
import "./event-trace-domain.js";
import "./production-execution-template.js";
import "./realtime-execution-queue.js";
import "./realtime-event-window-domain.js";
import "./engine-package-domain.js";
import "./engine-registry-domain.js";
import "./performer-registry-domain.js";
import "./synth-gateway-domain.js";
import "./brk-synth-abi-v1-worklet.js";
import "./brk-synth-runtime-lifetime-extension.js";
import "./brk-synth-prepared-state-extension.js";
import "./brk-synth-r6-realtime-extension.js";
import "./prepared-instrument-state-worklet-domain.js";
import "./prepared-instrument-state-gateway-extension.js";
import "./synth-gateway-r6-realtime-extension.js";
import "./track-insert-fx-domain.js";
import "./production-audio-runtime.js";
import "./production-runtime-lifetime-extension.js";
import "./production-r6-realtime-extension.js";
import "./production-prepared-lifecycle-pair-runtime-extension.js";
import "./production-track-note-owner-runtime-extension.js";
import "./production-prepared-state-runtime-extension.js";
import "./production-audio-processor-extension.js";
import "./production-prepared-timeline-processor-extension.js";
import "./production-prepared-execution-processor-extension.js";
import "./audio-worklet-runtime.js";

// Transitional compatibility markers for two older non-Mixer static gates.
// They are not Track Mixer implementation evidence; executable Mixer ownership
// is checked against audio-worklet-runtime.js and behavioral regressions.
// data.type === "play-plan" · trackSteps
// SOURCE_CONTROL → TABLE → NOTE_RELEASE → PARAMETER → NOTE_TRIGGER → OBSERVE

// Read-only build identity for the on-demand diagnostics processor. The
// runtime protocol value is checked against audio-worklet-runtime.js in CI so
// this marker cannot silently drift from the actual realtime consumer.
globalThis.BRKTRKAudioWorkletBuild = Object.freeze({
  release: "0.9.0",
  runtimeProtocol: 3,
  timelineVersion: globalThis.BRKTRKProductionTimelineDomain?.TIMELINE_VERSION ?? null,
  phraseFxRuntimeVersion: globalThis.BRKTRKPhraseFxRuntimeDomain?.RUNTIME_VERSION ?? null,
  traceVersion: globalThis.BRKTRKEventTraceDomain?.TRACE_VERSION ?? null,
  realtimeWindowVersion: globalThis.BRKTRKRealtimeEventWindowDomain?.WINDOW_VERSION ?? null,
  synthGatewayAvailable: Boolean(globalThis.BRKTRKSynthGatewayDomain),
  brkSynthAbiV1Available: Boolean(globalThis.BRKTRKBrkSynthAbiV1Runtime),
  productionAudioRuntimeAvailable: Boolean(globalThis.BRKTRKProductionAudioRuntime),
  productionProcessorExtensionAvailable: Boolean(globalThis.BRKTRKProductionAudioProcessorExtension),
});
