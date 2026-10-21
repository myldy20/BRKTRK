// #496 item 2: the owner heard playback die right after Start, exported a debug
// snapshot after pressing Stop, and it read healthy. The Worklet had reported
// the failure - when the production render path throws, the processor posts
// `production-engine-error`, stops transport and outputs silence - but no
// main-thread code consumed that message, the processor-level catch counted
// nothing, and nothing listened for `processorerror`.
//
// This test holds each link of that chain: the Worklet counts a render failure
// and flags that it stopped playback; the engine host keeps a bounded log of
// what the Worklet reports, which outlives the node that reported it and is
// part of the debug snapshot; and the host decides which failures the status
// line names. p36-transport's use of failureStatus() is a thin call and is
// checked in the browser.

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");

const repoRoot = join(__dirname, "..");
const read = (relative) => readFileSync(join(repoRoot, relative), "utf8");

// The real production graph, in audio-worklet.js's import order, inside a
// context holding only AudioWorkletGlobalScope's globals (see
// worklet-global-scope-contract.test.cjs for why that matters).
function createWorkletScope(beforeRuntime = null) {
  const workletEntry = read("web/audio-worklet.js");
  const graph = [...workletEntry.matchAll(/^import "\.\/(.+?)";$/gm)].map((match) => `web/${match[1]}`);
  const processors = new Map();
  class AudioWorkletProcessor {
    constructor() {
      this.port = { onmessage: null, postMessage() {}, start() {} };
    }
  }
  const scope = vm.createContext({
    console: Object.freeze({ log() {}, info() {}, warn() {}, error() {}, debug() {} }),
    registerProcessor(name, processorClass) { processors.set(name, processorClass); },
    AudioWorkletProcessor,
    sampleRate: 48000,
    currentFrame: 0,
    currentTime: 0,
  });
  vm.runInContext("delete globalThis.SharedArrayBuffer;", scope);
  for (const file of graph) {
    if (file === "web/production-audio-runtime.js") beforeRuntime?.(scope);
    vm.runInContext(read(file), scope, { filename: file });
  }
  vm.runInContext(workletEntry.replace(/^import .*$/gm, ""), scope, { filename: "web/audio-worklet.js" });
  return { scope, processors };
}

// Loading the first package while an empty Phrase is already playing must
// defer a structural update before any decorated timeline/transport commits.
for (const mode of ["sequence", "track-plan"]) {
  const { scope, processors } = createWorkletScope();
  const processor = new (processors.get("brktrk-audio"))({ processorOptions: {} });
  const posted = [];
  processor.port.postMessage = (message) => posted.push(message);
  const send = (message) => {
    const data = vm.runInContext(`(${JSON.stringify(message)})`, scope);
    if (["play", "play-plan", "update-sequence", "update-plan"].includes(data.type)) {
      const program = data.plan ?? vm.runInContext(`({ mode: "sequence", steps: ${JSON.stringify(message.sequence)} })`, scope);
      const timelineDomain = vm.runInContext("globalThis.BRKTRKProductionTimelineDomain", scope);
      const templateDomain = vm.runInContext("globalThis.BRKTRKProductionTimelineTemplate", scope);
      const executionDomain = vm.runInContext("globalThis.BRKTRKProductionExecutionTemplate", scope);
      data.timeline = timelineDomain.createTimelineRequest(program);
      if (data.plan) data.plan.timeline = data.timeline;
      data.timelineTemplate = templateDomain.compileRelativeTimeline({ sampleRate: 48000, tempo: 120, program, request: data.timeline });
      data.executionTemplate = executionDomain.compilePreparedExecution({ timelineTemplate: data.timelineTemplate, program });
    }
    processor.port.onmessage({ data });
  };
  const steps = [{ notes: [], instrumentIds: [] }, { notes: [], instrumentIds: [] }];
  const plan = { mode: "track-plan", tracks: [{ active: true, events: steps }] };
  const first = { id: "live-first", version: 1, mode, scope: "phrase" };
  const next = { ...first, id: "live-next", version: 2 };
  send(mode === "sequence" ? { type: "play", sequence: steps, tempo: 120, transport: first }
    : { type: "play-plan", plan, tempo: 120, transport: first });
  assert.equal(processor.playing, true);
  vm.runInContext(`(() => {
    const hostContract = { id: globalThis.BRKTRKEnginePackageDomain.HOST_CONTRACT_ID, minVersion: 1, maxVersion: 1 };
    const entry = { moduleId: "design.myldy.test", engineId: "late-engine", version: "1.0.0", channel: "stable", hostContract,
      abiVersion: 65536, packageUrl: "fixture://late-engine", packageSha256: "a".repeat(64), stateSchemaVersion: 1, parameterSchemaVersion: 1, status: "active" };
    const buffer = new ArrayBuffer(65536);
    globalThis.BRKTRKBrkSynthAbiV1Runtime.registerModuleRuntime({
      entry,
      manifest: { ...entry, schema: globalThis.BRKTRKEnginePackageDomain.PACKAGE_FORMAT, contentSha256: "b".repeat(64), parameters: [], stateBytes: 256,
        files: [{ path: "runtime/module.wasm", bytes: 1, sha256: "c".repeat(64) }], runtime: { maxModuleInstances: 16, wasmInitialMemoryBytes: 65536, memoryGrowth: false } },
      module: { _brk_abi_version: () => 65536, HEAPU8: new Uint8Array(buffer), HEAPF32: new Float32Array(buffer), _malloc: () => 1024 }
    });
  })();`, scope);
  send({ type: "production-instruments", instruments: { 1: { id: 1, engineRef: { moduleId: "design.myldy.test", engineId: "late-engine", resolvedVersion: "1.0.0" } } } });
  const before = { sequence: processor.sequence, tracks: processor.trackPrograms, generation: processor.timelineGeneration,
    timeline: processor.preparedTimelineTemplate, execution: processor.preparedExecutionTemplate };
  posted.length = 0;
  send(mode === "sequence" ? { type: "update-sequence", sequence: [...steps, steps[0]], transport: next }
    : { type: "update-plan", plan, transport: next });
  assert.equal(processor.playing, true, `${mode}: a newly registered engine cannot stop current playback`);
  assert.equal(processor.sequence, before.sequence);
  assert.equal(processor.trackPrograms, before.tracks);
  assert.equal(processor.timelineGeneration, before.generation);
  assert.equal(processor.preparedTimelineTemplate, before.timeline);
  assert.equal(processor.preparedExecutionTemplate, before.execution);
  assert.equal(processor.transportIdentity.id, first.id);
  const deferred = posted.find((message) => message.type === "production-transport-rejected");
  assert.equal(deferred?.stoppedTransport, false);
  assert.equal(deferred?.deferredUpdate, true);
  assert.equal(deferred.transport.id, next.id);
  assert.equal(deferred.appliedTransport.id, first.id);
  assert.equal(posted.some((message) => ["transport-applied", "transport-stopped", "stopped"].includes(message.type)), false);
  const output = vm.runInContext("[new Float32Array(128), new Float32Array(128)]", scope);
  assert.equal(processor.process([], [output]), true);
  assert.equal(processor.playing, true, "the retained timeline must still render after deferral");
  assert.equal(posted.some((message) => message.type === "production-engine-error"), false);
  send({ type: "stop", transport: first });
  assert.equal(processor.playing, false);
  assert.equal(processor.productionAudio.diagnostics().activeRegistryPackages.length, 1, "Stop admits the registered engine");
  send(mode === "sequence" ? { type: "play", sequence: steps, tempo: 120, transport: next }
    : { type: "play-plan", plan, tempo: 120, transport: next });
  assert.equal(processor.playing, true);
  posted.length = 0;
  send(mode === "sequence" ? { type: "update-sequence", sequence: steps, transport: { ...next, version: 3 } }
    : { type: "update-plan", plan, transport: { ...next, version: 3 } });
  assert.equal(posted.some((message) => message.type === "transport-applied"), true, "unchanged active registry still accepts live edits");
}

// --- 1. the Worklet counts a render failure and says it stopped playback ----

{
  const { scope, processors } = createWorkletScope();
  const Processor = processors.get("brktrk-audio");
  const processor = new Processor({ processorOptions: {} });
  const posted = [];
  processor.port.postMessage = (message) => posted.push(message);

  const runtime = processor.productionAudio;
  assert.equal(runtime.diagnostics().renderFailures, 0, "a fresh runtime has no render failures");
  assert.equal(runtime.diagnostics().lastRenderFailure, null);

  // Only the render call fails; every other method is the real runtime, so the
  // failure is counted by the same closure diagnostics() reads.
  const forced = Object.assign(new Error("forced render failure"), { code: "forced-render-failure" });
  processor.productionAudio = {
    ...runtime,
    hasProductionInstruments: () => true,
    hasPreparedPerformers: () => true,
    renderInto() { throw forced; },
  };
  const [left, right] = vm.runInContext("[new Float32Array(128).fill(0.5), new Float32Array(128).fill(0.5)]", scope);
  const keepAlive = processor.process([], [[left, right]]);

  assert.equal(keepAlive, true, "a failed block must not end the processor");
  assert.ok(left.every((sample) => sample === 0) && right.every((sample) => sample === 0), "a failed block must output silence");
  const reported = posted.find((message) => message?.type === "production-engine-error");
  assert.ok(reported, "a render failure must be reported to the main thread");
  assert.equal(reported.code, "forced-render-failure");
  assert.equal(reported.message, "forced render failure");
  assert.equal(reported.stoppedTransport, true, "the report must say this failure is why playback stops");
  assert.equal(reported.renderFailures, 1);
  const stopIndex = posted.findIndex((message) => message?.type === "transport-stopped" || message?.type === "stopped");
  if (stopIndex >= 0) {
    assert.ok(posted.indexOf(reported) < stopIndex, "the reason must reach the main thread before the stop");
  }

  const diagnostics = runtime.diagnostics();
  assert.equal(diagnostics.renderFailures, 1, "Worklet diagnostics must count the render failure");
  assert.ok(diagnostics.runtimeErrors >= 1, "a render failure is a runtime error");
  assert.equal(diagnostics.lastRenderFailure.code, "forced-render-failure");
  assert.equal(diagnostics.lastRenderFailure.message, "forced render failure");
  assert.equal(diagnostics.lastRenderFailure.failure, 1);
}

// A real gateway throw (including values the engine will not let us mutate)
// must produce one report/count and retain the failing Track.
function assertSingleGatewayFailure(throwStatement, expectedCode, expectedMessage) {
  const { scope, processors } = createWorkletScope((workletScope) => vm.runInContext(`(() => {
    const domain = globalThis.BRKTRKSynthGatewayDomain;
    globalThis.BRKTRKSynthGatewayDomain = Object.freeze({
      ...domain,
      createSynthGateway(options) {
        const gateway = domain.createSynthGateway(options);
        return Object.freeze({
          ...gateway,
          renderTrack() { ${throwStatement} },
        });
      },
    });
  })()`, workletScope));
  const processor = new (processors.get("brktrk-audio"))({ processorOptions: {} });
  const posted = [];
  processor.port.postMessage = (message) => posted.push(message);
  const runtime = processor.productionAudio;
  processor.productionAudio = { ...runtime, hasProductionInstruments: () => true, hasPreparedPerformers: () => true };
  const [left, right] = vm.runInContext("[new Float32Array(128), new Float32Array(128)]", scope);
  assert.equal(processor.process([], [[left, right]]), true);
  const reports = posted.filter((message) => message?.type === "production-engine-error" && message?.code === expectedCode);
  assert.equal(reports.length, 1, "one gateway exception produces one durable failure report");
  assert.equal(reports[0].track, 0, "the report must retain the failing Track");
  assert.equal(reports[0].message, expectedMessage);
  assert.equal(reports[0].stoppedTransport, true);
  assert.equal(reports[0].renderFailures, 1);
  assert.equal(runtime.diagnostics().runtimeErrors, 1, "one gateway exception counts as one runtime error");
  assert.equal(runtime.diagnostics().renderFailures, 1);
}
assertSingleGatewayFailure('throw Object.freeze(Object.assign(new Error("frozen gateway failure"), { code: "gateway-render-failed" }));', "gateway-render-failed", "frozen gateway failure");
assertSingleGatewayFailure('throw "primitive gateway failure";', "production-engine-error", "primitive gateway failure");

// --- 2. the engine host keeps what the Worklet reports ----------------------

require("./engine-package-domain.js");
class FixtureTransportError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
globalThis.BRKTRKEnginePackageBrowser = Object.freeze({ EnginePackageTransportError: FixtureTransportError });
globalThis.location = { href: "http://127.0.0.1/index.html" };
require("./production-engine-host.js");
const host = globalThis.BRKTRKProductionEngineHost;

function fakeNode() {
  const portListeners = [];
  const errorListeners = [];
  return {
    port: {
      addEventListener(type, listener) { if (type === "message") portListeners.push(listener); },
      start() {},
      postMessage() {},
    },
    addEventListener(type, listener) { if (type === "processorerror") errorListeners.push(listener); },
    post(data) { for (const listener of portListeners) listener({ data }); },
    crash(event) { for (const listener of errorListeners) listener(event); },
  };
}

const project = { instrumentPool: {} };
const newest = () => host.failureLogSnapshot().entries[0];

{
  assert.equal(host.failureLogSnapshot().total, 0, "no failure is recorded before a node reports one");
  const first = fakeNode();
  host.attachNode(first, { state: "running", currentTime: 42.25 }, project);

  first.post({
    type: "production-engine-error",
    code: "forced-render-failure",
    message: "forced render failure",
    stoppedTransport: true,
    transport: { version: 7, scope: "phrase" },
    renderFailures: 1,
  });
  const stopped = newest();
  assert.equal(host.failureLogSnapshot().recorded, 1);
  assert.equal(stopped.source, "worklet-message");
  assert.equal(stopped.type, "production-engine-error");
  assert.equal(stopped.code, "forced-render-failure");
  assert.equal(stopped.message, "forced render failure");
  assert.equal(stopped.stoppedTransport, true);
  assert.deepEqual(stopped.transport, { version: 7, scope: "phrase" }, "the transport identity the Worklet was playing is evidence");
  assert.equal(stopped.renderFailures, 1);
  assert.equal(stopped.currentNode, true);
  assert.deepEqual({ ...stopped.audioContext }, { state: "running", currentTime: 42.25 }, "the AudioContext state at the moment of failure is recorded");
  assert.ok(!Number.isNaN(Date.parse(stopped.at)), "each failure carries a wall-clock time");
  assert.deepEqual(
    { ...host.failureStatus(stopped) },
    { text: "PLAYBACK STOPPED · ENGINE ERROR · forced render failure", tone: "danger" },
    "a failure that stopped playback is named in the status line",
  );

  // Logged, not announced: a rejected parameter during a drag did not stop
  // anything, and a status line that shouted it would hide the music.
  first.post({ type: "production-engine-error", code: "production-parameter-error", message: "bad parameter" });
  assert.equal(newest().code, "production-parameter-error");
  assert.equal(host.failureStatus(newest()), null);

  // A rejected program is transport's to announce (p36 already does); it is
  // still evidence here, details included.
  first.post({
    type: "production-transport-rejected",
    code: "production-program-capacity",
    message: "requires 17 independent performers but publishes capacity 16",
    details: { required: 17, capacity: 16 },
  });
  assert.equal(newest().type, "production-transport-rejected");
  assert.deepEqual({ ...newest().details }, { required: 17, capacity: 16 });
  assert.equal(host.failureStatus(newest()), null);

  const beforeNoise = host.failureLogSnapshot().total;
  first.post({ type: "meter", left: 0, right: 0 });
  first.post({ type: "production-diagnostics", snapshot: {} });
  assert.equal(host.failureLogSnapshot().total, beforeNoise, "ordinary Worklet traffic is not a failure");

  first.post({ type: "production-engine-error", code: "long", message: "x".repeat(5000) });
  assert.equal(newest().message.length, 2000, "a runaway message is bounded");

  const circular = {};
  circular.self = circular;
  first.post({ type: "production-engine-error", code: "circular", message: "circular details", details: circular });
  assert.equal(typeof newest().details, "string", "unserializable details degrade to text instead of losing the entry");

  // An exception that escapes process() ends the processor; the node event is
  // the only evidence left.
  first.crash({ message: "Uncaught TypeError: x is undefined", filename: "blob:engine", lineno: 12, colno: 4 });
  assert.equal(newest().source, "processorerror");
  assert.equal(newest().code, "worklet-processor-error");
  assert.equal(newest().details.lineno, 12);
  assert.deepEqual(
    { ...host.failureStatus(newest()) },
    { text: "AUDIO PROCESSOR STOPPED · Uncaught TypeError: x is undefined", tone: "danger" },
  );
  first.crash({});
  assert.equal(newest().message, "AudioWorkletProcessor stopped after an uncaught exception");

  // Replacing the AudioContext/Worklet does not erase what the old one said,
  // and a late report from the old node is kept but marked as not current.
  const second = fakeNode();
  host.attachNode(second, { state: "running", currentTime: 1 }, project);
  first.post({ type: "production-engine-error", code: "late", message: "late report", stoppedTransport: true });
  assert.equal(newest().code, "late");
  assert.equal(newest().currentNode, false, "a report from a replaced node is not current");
  assert.equal(newest().audioContext.currentTime, 42.25, "a late report describes the AudioContext of the node that sent it");
  assert.equal(newest().nodeGeneration, stopped.nodeGeneration);
  second.post({ type: "production-engine-error", code: "current", message: "current report" });
  assert.equal(newest().currentNode, true);
  assert.equal(newest().nodeGeneration, stopped.nodeGeneration + 1);
  assert.ok(host.failureLogSnapshot().entries.some((entry) => entry.code === "forced-render-failure"), "the first failure survives the replacement");
  assert.equal(host.failureLogSnapshot().entries.find((entry) => entry.code === "forced-render-failure").currentNode, false, "a historical failure cannot still claim the current node");

  // Attaching the same node again must not record each report twice.
  host.attachNode(second, { state: "running", currentTime: 2 }, project);
  const beforeRepeat = host.failureLogSnapshot().total;
  second.post({ type: "production-engine-error", code: "once", message: "recorded once" });
  assert.equal(host.failureLogSnapshot().total, beforeRepeat + 1);

  // Bounded: the newest failures are kept, the count keeps counting.
  const beforeBulk = host.failureLogSnapshot().total;
  for (let index = 0; index < host.FAILURE_LOG_LIMIT + 8; index += 1) {
    second.post({ type: "production-engine-error", code: `bulk-${index}`, message: "bulk" });
  }
  const bounded = host.failureLogSnapshot();
  assert.equal(bounded.recorded, host.FAILURE_LOG_LIMIT);
  assert.equal(bounded.total, beforeBulk + host.FAILURE_LOG_LIMIT + 8);
  assert.equal(bounded.entries[0].code, `bulk-${host.FAILURE_LOG_LIMIT + 7}`, "entries are newest first");

  const heard = [];
  const off = host.onFailure((entry) => heard.push(entry.code));
  second.post({ type: "production-engine-error", code: "heard", message: "heard" });
  off();
  second.post({ type: "production-engine-error", code: "unheard", message: "unheard" });
  assert.deepEqual(heard, ["heard"]);
  const offBroken = host.onFailure(() => { throw new Error("listener bug"); });
  second.post({ type: "production-engine-error", code: "kept", message: "kept despite a broken listener" });
  offBroken();
  assert.equal(newest().code, "kept", "a broken listener cannot lose evidence");

  // The debug snapshot exports the engine host's snapshot as productionEngines.
  const exported = host.snapshot().failures;
  assert.equal(exported.total, host.failureLogSnapshot().total);
  assert.equal(exported.entries[0].code, "kept");

  // A one-shot crash can precede package preparation and attachNode().
  const early = fakeNode();
  const earlyContext = { state: "running", currentTime: 0.5 };
  host.observeNodeFailures(early, earlyContext);
  const beforeEarly = host.failureLogSnapshot().total;
  early.crash({ message: "first package load crashed" });
  assert.equal(host.failureLogSnapshot().total, beforeEarly + 1);
  assert.equal(newest().source, "processorerror");
  assert.equal(newest().message, "first package load crashed");
  assert.equal(newest().currentNode, true);
  assert.equal(newest().audioContext.currentTime, 0.5);
  host.attachNode(early, earlyContext, project);
  assert.equal(host.failureLogSnapshot().total, beforeEarly + 1, "late host attachment cannot duplicate one-shot evidence");
  assert.equal(host.failureLogSnapshot().entries[0].currentNode, true);
}

// --- 3. an engine that cannot register says why, at once -------------------

async function registrationFailureEvidence() {
  const { scope, processors } = createWorkletScope();
  const runtime = vm.runInContext("globalThis.BRKTRKBrkSynthAbiV1Runtime", scope);
  const processor = new (processors.get("brktrk-audio"))({ processorOptions: {} });
  const posted = [];
  processor.port.postMessage = (message) => posted.push(message);
  const registryAnswer = (requestId) => {
    processor.port.onmessage({ data: vm.runInContext(`({ type: "production-package-registry-request", requestId: ${JSON.stringify(requestId)} })`, scope) });
    return posted.find((message) => message?.type === "production-package-registry" && message.requestId === requestId);
  };

  // An engine built for another ABI: its module loads, then registration
  // throws inside the host-composed module's top-level await - the case that
  // used to surface only as a 4000 ms "did not acknowledge" timeout.
  const entry = {
    moduleId: "design.myldy.test",
    engineId: "other-abi",
    version: "1.0.0",
    packageSha256: "C".repeat(64),
  };
  const bytes = (text) => new TextEncoder().encode(text);
  const loaded = {
    entry,
    manifest: {
      moduleId: entry.moduleId,
      engineId: entry.engineId,
      version: entry.version,
      contentSha256: "d".repeat(64),
      parameters: [],
      runtime: { directJs: "runtime/module.js", directWasm: "runtime/module.wasm" },
    },
    files: {
      "runtime/module.js": bytes("globalThis.Module = async function Module() { return { _brk_abi_version: () => 0x00020000 }; };"),
      "runtime/module.wasm": new Uint8Array(0),
    },
  };
  const composed = host.buildWorkletModuleSource(loaded);
  await assert.rejects(
    vm.runInContext(`(async function () {\n"use strict";\n${composed}\n}).call(undefined)`, scope, { filename: "failing-engine-module.js" }),
    /runtime reports ABI 131072, expected 65536/,
    "the composed module must still throw, so the Worklet console shows the failure",
  );

  const recorded = Array.from(runtime.registrationFailures());
  assert.equal(recorded.length, 1, "the Worklet runtime must keep the registration failure");
  assert.equal(recorded[0].engineId, "other-abi");
  assert.equal(recorded[0].packageSha256, "c".repeat(64), "identity is kept normalized");
  assert.equal(recorded[0].code, "abi-version");
  assert.match(recorded[0].message, /runtime reports ABI 131072, expected 65536/);

  const answer = registryAnswer("registration-failure-proof");
  assert.ok(answer, "the processor must answer the registry probe");
  assert.equal(Array.from(answer.packages).length, 0, "a package that failed to register is not active");
  assert.deepEqual(
    Array.from(answer.registrationFailures, (failure) => [failure.engineId, failure.code]),
    [["other-abi", "abi-version"]],
    "the registry probe must carry the failure so the host can fail at once",
  );
  assert.equal(Array.from(processor.productionAudio.diagnostics().registrationFailures).length, 1, "Worklet diagnostics expose it too");

  // Failure in the glue itself must be recorded before Module() can even run.
  const glueFailure = { ...loaded, files: {
    ...loaded.files,
    "runtime/module.js": bytes('throw new Error("missing Worklet global during glue evaluation");'),
  } };
  await assert.rejects(
    vm.runInContext(`(async function () {\n"use strict";\n${host.buildWorkletModuleSource(glueFailure)}\n}).call(undefined)`, scope),
    /missing Worklet global/,
  );
  assert.match(Array.from(runtime.registrationFailures())[0].message, /missing Worklet global/, "glue-evaluation failure must reach the registry probe");

  // Once the same package registers, the failure is history, not current truth.
  runtime.registerModuleRuntime({ entry, manifest: loaded.manifest, module: { _brk_abi_version: () => runtime.ABI_VERSION } });
  assert.equal(Array.from(runtime.registrationFailures()).length, 0, "a later successful registration clears the failure");
  assert.equal(Array.from(registryAnswer("registration-cleared").registrationFailures).length, 0);
}

registrationFailureEvidence().then(() => {
  console.log("Worklet failure evidence tests passed (render failure counted and flagged, host log bounded and outliving its node, status wording, registration failure named at once)");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
