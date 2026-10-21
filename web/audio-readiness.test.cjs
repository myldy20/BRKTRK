const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const source = fs.readFileSync(__dirname + "/audio-readiness.js", "utf8");

let initCalls = 0;
let resumeCalls = 0;
let gateCalls = 0;
let gateShouldFail = false;
let blockNextGate = false;
let releaseBlockedGate = null;
let blockedGateStarted = null;
const events = [];
const context = {
  state: "suspended",
  async resume() {
    resumeCalls += 1;
    this.state = "running";
  },
  async close() { this.state = "closed"; },
};
const node = {};
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
  dispatchEvent() {},
  audio: {
    context: null,
    node: null,
    ready: false,
    async init() {
      initCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      this.context = context;
      this.node = node;
      await context.resume();
      this.ready = true;
    },
  },
};
sandbox.globalThis = sandbox;
vm.runInNewContext(source, sandbox);

sandbox.BRKTRKAudioReadiness.subscribe((event) => events.push(event));
sandbox.BRKTRKAudioReadiness.registerGate("fixture-production-gate", async () => {
  gateCalls += 1;
  if (blockNextGate) {
    blockNextGate = false;
    await new Promise((resolve) => {
      releaseBlockedGate = resolve;
      blockedGateStarted?.();
    });
  }
  if (gateShouldFail) throw new Error("fixture gate rejected");
});

(async () => {
  await Promise.all([
    sandbox.audio.init({ source: "one" }),
    sandbox.audio.init({ source: "two" }),
    sandbox.BRKTRKAudioReadiness.ensureReady({ source: "three" }),
  ]);
  assert.equal(initCalls, 1);
  assert.equal(gateCalls, 1, "single-flight initialization must execute the readiness gate once");
  assert.equal(sandbox.audio.context, context);
  assert.equal(sandbox.audio.node, node);
  assert.equal(sandbox.BRKTRKAudioReadiness.snapshot().successfulInitializations, 1);
  assert.equal(sandbox.BRKTRKAudioReadiness.snapshot().ready, true);
  assert.equal(events.at(-1)?.type, "ready");

  const invalidationRevision = sandbox.BRKTRKAudioReadiness.snapshot().invalidationRevision;
  sandbox.BRKTRKAudioReadiness.invalidate({ source: "fixture", reason: "proof-stale" });
  assert.equal(sandbox.BRKTRKAudioReadiness.snapshot().ready, false, "explicit proof invalidation must revoke canonical READY without destroying the graph");
  assert.equal(sandbox.audio.ready, true);
  assert.equal(sandbox.BRKTRKAudioReadiness.snapshot().invalidationRevision, invalidationRevision + 1);
  assert.equal(events.at(-1)?.type, "invalidated");
  await sandbox.audio.init({ source: "after-invalidation" });
  assert.equal(sandbox.BRKTRKAudioReadiness.snapshot().ready, true);

  context.state = "suspended";
  const resumeCallsBefore = resumeCalls;
  await sandbox.audio.init({ source: "resume" });
  assert.equal(initCalls, 1, "existing context recovery must not invoke cold initialization again");
  assert.equal(resumeCalls, resumeCallsBefore + 1);
  assert.equal(context.state, "running");
  assert.equal(sandbox.audio.context, context);
  assert.equal(sandbox.audio.node, node);
  assert.equal(gateCalls, 3, "resume must re-run canonical readiness gates");
  assert.equal(sandbox.BRKTRKAudioReadiness.snapshot().ready, true);

  // A synchronous request-event subscriber may re-enter ensureReady. The
  // transaction must already be published so the nested request joins the
  // same gate run instead of spawning a competing initialization/probe cycle.
  let reentrantPromise = null;
  const unsubscribeReentrant = sandbox.BRKTRKAudioReadiness.subscribe((event) => {
    if (event.type === "existing-request" && event.source === "reentrant-outer" && !reentrantPromise) {
      reentrantPromise = sandbox.BRKTRKAudioReadiness.ensureReady({ source: "reentrant-inner" });
    }
  });
  const gatesBeforeReentrant = gateCalls;
  await sandbox.audio.init({ source: "reentrant-outer" });
  await reentrantPromise;
  unsubscribeReentrant();
  assert.equal(gateCalls, gatesBeforeReentrant + 1, "request-event re-entry must join the published single-flight transaction");

  // Readiness observers are diagnostics/presentation, not transaction owners.
  // A bad observer must not strand the published start barrier or block future
  // audio initialization.
  const unsubscribeThrowing = sandbox.BRKTRKAudioReadiness.subscribe((event) => {
    if (event.type === "existing-request" && event.source === "throwing-observer") {
      throw new Error("fixture observer failure");
    }
  });
  const gatesBeforeThrowingObserver = gateCalls;
  await sandbox.audio.init({ source: "throwing-observer" });
  unsubscribeThrowing();
  assert.equal(gateCalls, gatesBeforeThrowingObserver + 1, "throwing request observer must not suppress the gate transaction");
  assert.equal(sandbox.BRKTRKAudioReadiness.snapshot().ready, true, "throwing observer must not deadlock canonical readiness");

  // A structural Project invalidation can arrive while a gate is awaiting an
  // exact Worklet proof. That older transaction must never restore READY over
  // the newer Project state; the next caller must run a fresh proof.
  let signalBlockedGate;
  const blockedGatePromise = new Promise((resolve) => { signalBlockedGate = resolve; });
  blockedGateStarted = signalBlockedGate;
  blockNextGate = true;
  const staleTransaction = sandbox.audio.init({ source: "stale-transaction" });
  await blockedGatePromise;
  const revisionBeforeInFlightInvalidation = sandbox.BRKTRKAudioReadiness.snapshot().invalidationRevision;
  sandbox.BRKTRKAudioReadiness.invalidate({
    source: "project-store",
    reason: "project-structure-changed",
    supersedeInFlight: true,
  });
  assert.equal(
    sandbox.BRKTRKAudioReadiness.snapshot().invalidationRevision,
    revisionBeforeInFlightInvalidation + 1,
    "structural invalidation must supersede the active readiness transaction",
  );
  releaseBlockedGate();
  await assert.rejects(
    staleTransaction,
    /invalidated during initialization/,
    "stale readiness transaction must reject instead of restoring canonical READY",
  );
  blockedGateStarted = null;
  releaseBlockedGate = null;
  assert.equal(sandbox.BRKTRKAudioReadiness.snapshot().ready, false);
  const gatesBeforeFreshProof = gateCalls;
  await sandbox.audio.init({ source: "fresh-after-invalidation" });
  assert.equal(gateCalls, gatesBeforeFreshProof + 1, "post-invalidation caller must execute one fresh proof");
  assert.equal(sandbox.BRKTRKAudioReadiness.snapshot().ready, true);

  gateShouldFail = true;
  await assert.rejects(
    sandbox.audio.init({ source: "gate-failure" }),
    /fixture gate rejected/,
    "canonical readiness must reject when a registered production gate fails",
  );
  assert.equal(initCalls, 1, "gate failure on an existing graph must not rebuild BrowserAudio");
  assert.equal(sandbox.audio.ready, true, "base graph may remain allocated after a gate failure");
  assert.equal(sandbox.BRKTRKAudioReadiness.snapshot().ready, false, "canonical AUDIO READY must be revoked while a gate is failing");
  assert.equal(events.at(-1)?.type, "existing-failed");
  assert.equal(events.at(-1)?.snapshot?.ready, false);

  gateShouldFail = false;
  await sandbox.audio.init({ source: "gate-recovery" });
  assert.equal(sandbox.BRKTRKAudioReadiness.snapshot().ready, true);
  assert.equal(events.at(-1)?.type, "ready");
  assert.equal(events.at(-1)?.kind, "existing");
  // An uncaught processor exception permanently kills this node. Repeated
  // Play must not reprove the same graph or secretly create a replacement.
  const beforeTerminalInit = initCalls;
  sandbox.BRKTRKAudioReadiness.failTerminal(new Error("processor crashed; reload BRKTRK"), { source: "fixture-processorerror" });
  assert.equal(sandbox.BRKTRKAudioReadiness.snapshot().ready, false);
  assert.equal(sandbox.BRKTRKAudioReadiness.snapshot().graphReady, true, "the dead graph remains allocated but cannot be called READY");
  assert.match(sandbox.BRKTRKAudioReadiness.snapshot().terminalError, /processor crashed/);
  assert.equal(events.at(-1)?.type, "terminal-failed");
  await assert.rejects(sandbox.audio.init({ source: "play-after-crash" }), /processor crashed/);
  await assert.rejects(sandbox.audio.init({ source: "another-play-after-crash" }), /processor crashed/);
  assert.equal(initCalls, beforeTerminalInit, "no second graph may be created after a terminal processor error");
  assert.equal(sandbox.audio.node, node);

  // A real BrowserAudio node can crash as context.resume() begins, before
  // package gates and before the transport module binds its MessagePort.
  const browserAudioSource = fs.readFileSync(__dirname + "/app-model.js", "utf8");
  const browserAudioClass = browserAudioSource.match(/class BrowserAudio \{[\s\S]*?const audio = new BrowserAudio\(\);/)?.[0];
  assert.ok(browserAudioClass, "the early-crash test must use the real BrowserAudio constructor");
  let earlyNode = null;
  class EarlyNode {
    constructor() { this.listeners = []; this.port = { onmessage: null }; earlyNode = this; }
    addEventListener(type, listener) { if (type === "processorerror") this.listeners.push(listener); }
    connect() {}
    crash() { for (const listener of this.listeners) listener({ message: "crashed during first resume" }); }
  }
  class EarlyContext {
    constructor() { this.state = "suspended"; this.destination = {}; this.audioWorklet = { addModule: async () => {} }; }
    async resume() { this.state = "running"; earlyNode.crash(); }
    async close() { this.state = "closed"; }
  }
  const earlyFailureLog = [];
  const early = {
    console, setTimeout, clearTimeout, AudioContext: EarlyContext, AudioWorkletNode: EarlyNode,
    BRKTRKProductionEngineHost: {
      observeNodeFailures(node, context) {
        assert.ok(node === earlyNode && context?.state === "suspended", "failure evidence must bind before first resume");
        node.addEventListener("processorerror", (event) => earlyFailureLog.push(event.message));
      },
    },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    dispatchEvent() {},
  };
  early.globalThis = early;
  vm.runInNewContext(`${browserAudioClass}\nglobalThis.audio = audio;`, early);
  vm.runInNewContext(source, early);
  await assert.rejects(early.audio.init({ source: "first-resume-crash" }), /invalidated during initialization|reload BRKTRK/);
  assert.match(early.BRKTRKAudioReadiness.snapshot().terminalError, /crashed during first resume; reload BRKTRK/);
  assert.equal(early.BRKTRKAudioReadiness.snapshot().ready, false);
  await assert.rejects(early.audio.init({ source: "play-after-early-crash" }), /reload BRKTRK/);
  assert.equal(earlyNode.listeners.length, 2, "readiness and host evidence listeners must be bound before resume");
  assert.deepEqual(earlyFailureLog, ["crashed during first resume"], "the first crash must appear in host evidence");

  // A throttled main-thread timer can resume after the nominal render-clock
  // deadline even though Chrome's realtime thread advanced during the sleep.
  // The final post-deadline sample must accept that real progress instead of
  // turning it into a false audio-readiness failure.
  function renderClockFixture({ advanceAfterSleep }) {
    let now = 0;
    let advanced = false;
    let timestampReads = 0;
    const realtimeContext = {
      state: "running",
      currentTime: 0,
      getOutputTimestamp() {
        timestampReads += 1;
        return { contextTime: advanced ? 0.125 : 0 };
      },
      async close() { this.state = "closed"; },
    };
    const fixture = {
      console,
      Date: { now: () => now },
      setTimeout(resolve) {
        now += 1001;
        if (advanceAfterSleep) advanced = true;
        resolve();
        return 1;
      },
      clearTimeout() {},
      CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
      dispatchEvent() {},
      audio: {
        context: null,
        node: null,
        ready: false,
        async init() {
          this.context = realtimeContext;
          this.node = {};
          this.ready = true;
        },
      },
    };
    fixture.globalThis = fixture;
    vm.runInNewContext(source, fixture);
    return { fixture, realtimeContext, timestampReads: () => timestampReads };
  }

  const delayedProgress = renderClockFixture({ advanceAfterSleep: true });
  await delayedProgress.fixture.audio.init({ source: "render-clock-final-sample" });
  assert.equal(
    delayedProgress.fixture.BRKTRKAudioReadiness.snapshot().ready,
    true,
    "render progress observed only after the final sleep must still satisfy canonical readiness",
  );
  assert.ok(
    delayedProgress.timestampReads() >= 3,
    "render-clock readiness must take a final sample after the deadline",
  );

  const stalledClock = renderClockFixture({ advanceAfterSleep: false });
  await assert.rejects(
    stalledClock.fixture.audio.init({ source: "render-clock-stalled" }),
    /render clock did not advance/,
    "a genuinely stalled realtime clock must still fail closed after the bounded readiness window",
  );
  assert.equal(
    stalledClock.fixture.BRKTRKAudioReadiness.snapshot().ready,
    false,
    "stalled render clock must never publish canonical READY",
  );

  console.log("BRKTRK audio readiness tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });