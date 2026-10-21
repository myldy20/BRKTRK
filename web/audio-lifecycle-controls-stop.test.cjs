const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

let inheritedToggleCalls = 0;
let readinessCalls = 0;
let phase = "playing";
let playing = true;

const runtime = {
  snapshot() {
    return Object.freeze({
      phase,
      version: 7,
      applied: Object.freeze({ scope: "phrase", version: 7 }),
      requested: Object.freeze({ scope: "phrase", version: 7 }),
      globalStep: 3,
    });
  },
  isPlaying() { return playing; },
  requestStart() { throw new Error("STOP fixture must not allocate a start request"); },
};

const sandbox = {
  console,
  Promise,
  Date,
  performance: { now() { return 0; } },
  requestAnimationFrame() { return 1; },
  document: {
    visibilityState: "visible",
    addEventListener() {},
    body: { dataset: {} },
  },
  window: {
    addEventListener() {},
    clearTimeout() {},
    setTimeout() { return 1; },
  },
  audio: {
    onStep() {},
    onMeter() {},
    playPlan() { throw new Error("STOP fixture must not start audio"); },
    play() { throw new Error("STOP fixture must not start audio"); },
  },
  BRKTRKAudioLifecycle: {
    snapshot() { return Object.freeze({ status: "suspended", contextState: "suspended" }); },
    async ensureReady() {
      readinessCalls += 1;
      throw new Error("readiness must not gate normal STOP");
    },
  },
  BRKTRKStores: { transport: { runtime } },
  BRKTRKTransport: {
    buildProgram() { throw new Error("STOP fixture must not build a new program"); },
    cancelI1Queue() {},
  },
  BRKTRKDiagnostics: { registerSection() {} },
  state: {
    songRow: 0,
    track: 0,
    chain: 0,
    chainRow: 0,
    phrase: 0,
    scope: "phrase",
    view: "phrase",
    p3: { activeWorkspace: "phrase" },
    p36: { queue: null },
    queued: null,
  },
  model: { tempo: 120 },
  setStatus() {},
  renderAll() {},
  renderTransport() {},
  $(selector) {
    if (selector === "#playButton") return { setAttribute() {} };
    return null;
  },
  async togglePlayback(forceSong) {
    inheritedToggleCalls += 1;
    assert.equal(forceSong, false);
    phase = "stopping";
    playing = false;
    return Object.freeze({ stopped: true });
  },
};
sandbox.globalThis = sandbox;
vm.runInNewContext(
  fs.readFileSync("web/audio-lifecycle-controls.js", "utf8"),
  sandbox,
  { filename: "audio-lifecycle-controls.js" },
);

(async () => {
  const result = await sandbox.BRKTRKAudioLifecycleControls.toggle(false);
  assert.equal(result.stopped, true);
  assert.equal(inheritedToggleCalls, 1, "outer lifecycle wrapper must delegate normal playing toggle directly to I1 STOP");
  assert.equal(readinessCalls, 0, "suspended/interrupted context must not make normal STOP wait on canonical readiness");
  assert.equal(phase, "stopping");
  assert.equal(playing, false);
  console.log("Audio lifecycle outer-wrapper STOP escape-hatch regression passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });