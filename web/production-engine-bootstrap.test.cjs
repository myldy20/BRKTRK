const assert = require("node:assert/strict");

const identity = Object.freeze({
  moduleId: "design.myldy.brk-wav",
  engineId: "brk-wav",
  version: "0.1.0-rc5",
  packageSha256: "43ae3453349bb98dc61d4d8267178d328f72e78c569010862f4161f50fc9d58e",
  contentSha256: "a9a3c60fd2b4ae608a997800c51b8fbc363319e7306fa799906a3cd34aabe321",
});
const identity2 = Object.freeze({
  moduleId: "design.myldy.brk-wav",
  engineId: "brk-wav",
  version: "0.1.0-rc6",
  packageSha256: "b43641068e394f4c2f6b013bdfd9ec42f6aa561546a3162399a0b7beeadce7d7",
  contentSha256: "de40ec0c654b273b493bed1526642adab3e9cadf1d5bc8f3a2fd94afb1d7f2a1",
});

function makeProject(engineIdentity) {
  return Object.freeze({
    instrumentPool: Object.freeze({
      0: Object.freeze({
        id: 0,
        engineRef: Object.freeze({
          moduleId: engineIdentity.moduleId,
          engineId: engineIdentity.engineId,
          requestedVersion: engineIdentity.version,
          resolvedVersion: engineIdentity.version,
          resolvedPackageSha256: engineIdentity.packageSha256,
        }),
      }),
    }),
  });
}

const project = makeProject(identity);
const project2 = makeProject(identity2);
const emptyProject = Object.freeze({ instrumentPool: Object.freeze({}) });
const identitiesByVersion = new Map([[identity.version, identity], [identity2.version, identity2]]);

class FixturePort {
  constructor() {
    this.listeners = new Set();
    this.messages = [];
    this.probes = 0;
    this.mode = "eventual";
    this.emptyResponsesRemaining = 1;
    this.transportActive = false;
    this.registered = new Map();
    this.active = new Map();
  }

  addEventListener(type, listener) {
    if (type === "message") this.listeners.add(listener);
  }

  removeEventListener(type, listener) {
    if (type === "message") this.listeners.delete(listener);
  }

  start() {}

  register(engineIdentity) {
    this.registered.set(`${engineIdentity.version}:${engineIdentity.packageSha256}`, engineIdentity);
  }

  activateRegistered() {
    this.active = new Map(this.registered);
  }

  emit(data) {
    for (const listener of [...this.listeners]) listener({ data });
  }

  postMessage(message) {
    this.messages.push(message);
    if (message?.type !== "production-package-registry-request") return;
    this.probes += 1;
    const requestId = message.requestId;
    if (this.mode === "silent") return;

    queueMicrotask(() => {
      this.emit({
        type: "production-package-registry",
        requestId: `${requestId}-stale`,
        packages: [...this.active.values()],
        transportActive: this.transportActive,
      });
      if (this.mode === "wrong") {
        const first = [...this.active.values()][0] ?? identity;
        this.emit({
          type: "production-package-registry",
          requestId,
          packages: [{ ...first, packageSha256: "f".repeat(64) }],
          transportActive: this.transportActive,
        });
        return;
      }
      if (this.mode === "failed") {
        // The engine's module threw while registering in this Worklet scope.
        this.emit({
          type: "production-package-registry",
          requestId,
          packages: [],
          transportActive: this.transportActive,
          registrationFailures: [{
            moduleId: identity2.moduleId,
            engineId: identity2.engineId,
            version: identity2.version,
            packageSha256: identity2.packageSha256.toUpperCase(),
            code: "abi-version",
            message: "runtime reports ABI 131072, expected 65536",
          }],
        });
        return;
      }
      if (this.mode === "failed-other") {
        // The required package is active; an unrelated package failed earlier.
        this.emit({
          type: "production-package-registry",
          requestId,
          packages: [...this.active.values()].map((entry) => ({ ...entry, maxModuleInstances: 16 })),
          transportActive: this.transportActive,
          registrationFailures: [{ ...identity, code: "abi-version", message: "unrelated package" }],
        });
        return;
      }
      if (this.mode === "eventual" && this.emptyResponsesRemaining > 0) {
        this.emptyResponsesRemaining -= 1;
        this.emit({ type: "production-package-registry", requestId, packages: [], transportActive: this.transportActive });
        return;
      }
      this.emit({
        type: "production-package-registry",
        requestId,
        packages: [...this.active.values()].map((entry) => ({ ...entry, maxModuleInstances: 16 })),
        transportActive: this.transportActive,
      });
    });
  }
}

const port = new FixturePort();
const node = { port };
const context = {
  sampleRate: 48000,
  state: "running",
  async resume() { this.state = "running"; },
  async close() { this.state = "closed"; },
};
let currentProject = project;
let mutateProjectDuringPrepare = false;
let prepareCalls = 0;
let attachCalls = 0;
let observedNode = null;
let syncCalls = 0;
let forcedSyncCalls = 0;
let diagnosticsRegistrations = 0;
let baseInitCalls = 0;

globalThis.BRKTRKProductionEngineHost = Object.freeze({
  async prepareContext(candidateContext, candidate) {
    assert.equal(candidateContext, context);
    assert.ok(candidate === project || candidate === project2);
    assert.equal(observedNode, node, "the host must observe processor failures before package preparation");
    prepareCalls += 1;
    const ref = candidate.instrumentPool[0].engineRef;
    const engineIdentity = identitiesByVersion.get(ref.resolvedVersion);
    assert.ok(engineIdentity);
    port.register(engineIdentity);
    if (mutateProjectDuringPrepare && candidate === project) {
      mutateProjectDuringPrepare = false;
      currentProject = project2;
    }
  },
  observeNodeFailures(candidateNode, candidateContext) {
    assert.equal(candidateNode, node);
    assert.equal(candidateContext, context);
    observedNode = candidateNode;
  },
  attachNode(candidateNode, candidateContext, candidate) {
    assert.equal(candidateNode, node);
    assert.equal(candidateContext, context);
    assert.ok(candidate === project || candidate === project2);
    attachCalls += 1;
    port.activateRegistered();
  },
  syncProject(candidate, options = {}) {
    assert.ok(candidate === project || candidate === project2);
    syncCalls += 1;
    if (options.force === true) {
      forcedSyncCalls += 1;
      port.activateRegistered();
    }
    return true;
  },
  packageStatusFor(ref) {
    const engineIdentity = identitiesByVersion.get(ref.resolvedVersion ?? ref.requestedVersion);
    assert.ok(engineIdentity);
    return Object.freeze({ state: "ready", ...engineIdentity });
  },
  registerDiagnostics() { diagnosticsRegistrations += 1; },
});

globalThis.BRKTRKStores = Object.freeze({
  project: Object.freeze({ getState: () => currentProject }),
});

globalThis.CustomEvent = globalThis.CustomEvent ?? class {
  constructor(type, options) { this.type = type; this.detail = options?.detail; }
};
globalThis.dispatchEvent = globalThis.dispatchEvent ?? (() => {});
globalThis.audio = {
  ready: false,
  context: null,
  node: null,
  async init() {
    baseInitCalls += 1;
    this.context = context;
    this.node = node;
    this.ready = true;
  },
};

require("./audio-readiness.js");
require("./production-engine-bootstrap.js");
const bootstrap = globalThis.BRKTRKProductionEngineBootstrap;
const readiness = globalThis.BRKTRKAudioReadiness;

(async () => {
  assert.ok(bootstrap, "production bootstrap API must register");
  assert.equal(readiness.snapshot().registeredGates, 1, "production bootstrap must join the canonical AUDIO READY transaction");

  await globalThis.audio.init({ source: "initial" });
  assert.equal(baseInitCalls, 1);
  assert.equal(prepareCalls, 1, "audio init must prepare the exact project package");
  assert.equal(attachCalls, 1, "first audio init must attach the authoritative node once");
  assert.equal(syncCalls, 1, "an empty first active-registry response must trigger one bounded forced reconciliation");
  assert.equal(forcedSyncCalls, 1);
  assert.equal(diagnosticsRegistrations, 1);
  assert.equal(port.probes, 2, "empty current registry must cause a new correlated probe rather than pass");
  assert.equal(bootstrap.isWorkletReady(project, node), true, "exact Worklet identity must mark this node/project ready");
  assert.equal(bootstrap.registrationSnapshot().packageCount, 1);
  assert.equal(bootstrap.registrationSnapshot().forcedRegistryReconciliations, 1);
  assert.equal(readiness.snapshot().ready, true, "canonical AUDIO READY must wait for the Worklet package barrier");

  // Re-probing must revoke the previous exact proof immediately and keep
  // audition blocked if the current node returns a wrong registry. The barrier
  // may force exactly one bounded structural reconciliation, but wrong identity
  // must still fail closed rather than turning that reconciliation into a loop.
  port.mode = "wrong";
  const forcedBeforeWrong = forcedSyncCalls;
  const reconciliationsBeforeWrong = bootstrap.registrationSnapshot().forcedRegistryReconciliations;
  await assert.rejects(
    bootstrap.awaitWorkletPackages({ node, project, timeoutMs: 70, probeTimeoutMs: 20, pollMs: 1 }),
    (error) => error?.code === "worklet-package-registration-timeout"
      && error.details?.observed?.[0]?.packageSha256 === "f".repeat(64)
      && error.details?.reconciledActiveRegistry === true,
    "wrong exact package SHA must remain blocked until the bounded timeout",
  );
  assert.equal(forcedSyncCalls, forcedBeforeWrong + 1, "failed registry proof must perform at most one bounded structural reconciliation");
  assert.equal(bootstrap.registrationSnapshot().forcedRegistryReconciliations, reconciliationsBeforeWrong + 1);
  assert.equal(bootstrap.isWorkletReady(project, node), false, "failed re-probe must invalidate the old Worklet-ready proof");
  assert.equal(bootstrap.audition({ track: 0, instrumentId: 0 }), false, "audition must remain blocked after failed revalidation");

  port.mode = "normal";
  await bootstrap.awaitWorkletPackages({ node, project, timeoutMs: 70, probeTimeoutMs: 20, pollMs: 1 });
  assert.equal(bootstrap.isWorkletReady(project, node), true);

  // If package requirements change while readiness is in flight, the canonical
  // gate must prepare and prove the new Project before returning AUDIO READY.
  // Same-node readiness first proves the existing active registry read-only.
  // Only the newly required package mismatch may trigger one bounded stopped
  // reconciliation so the registered runtime becomes active.
  currentProject = project;
  mutateProjectDuringPrepare = true;
  const preparesBeforeDrift = prepareCalls;
  const forcedBeforeDrift = forcedSyncCalls;
  await globalThis.audio.init({ source: "project-drift" });
  assert.equal(currentProject, project2);
  assert.equal(prepareCalls, preparesBeforeDrift + 2, "project package drift must force one bounded re-prepare/re-proof cycle");
  assert.equal(forcedSyncCalls, forcedBeforeDrift + 1, "project drift must reconcile only the newly mismatched active registry, not the already-matching same-node pass");
  assert.equal(bootstrap.isWorkletReady(project2, node), true);
  assert.equal(readiness.snapshot().ready, true);
  assert.ok(port.registered.has(`${identity2.version}:${identity2.packageSha256}`));
  assert.ok(port.active.has(`${identity2.version}:${identity2.packageSha256}`), "registered rc6 runtime must enter the active registry before AUDIO READY");

  // Reproduce the physical failure directly: package is globally registered but
  // absent from the active registry. One readiness proof must self-heal the
  // active registry without changing Project data or extending the timeout.
  port.active = new Map([[`${identity.version}:${identity.packageSha256}`, identity]]);
  const reconciliationsBefore = bootstrap.registrationSnapshot().forcedRegistryReconciliations;
  const proof = await bootstrap.awaitWorkletPackages({ node, project: project2, timeoutMs: 70, probeTimeoutMs: 20, pollMs: 1 });
  assert.equal(proof.reconciledActiveRegistry, true);
  assert.ok(port.active.has(`${identity2.version}:${identity2.packageSha256}`));
  assert.equal(bootstrap.registrationSnapshot().forcedRegistryReconciliations, reconciliationsBefore + 1);

  // A stale registry discovered while transport is active must never be
  // structurally replaced by the readiness self-heal. It stays fail-closed and
  // waits for the existing stopped-boundary reconciliation path instead.
  port.active = new Map([[`${identity.version}:${identity.packageSha256}`, identity]]);
  port.transportActive = true;
  const forcedBeforeActiveTransport = forcedSyncCalls;
  const reconciliationsBeforeActiveTransport = bootstrap.registrationSnapshot().forcedRegistryReconciliations;
  await assert.rejects(
    bootstrap.awaitWorkletPackages({ node, project: project2, timeoutMs: 50, probeTimeoutMs: 15, pollMs: 1 }),
    (error) => error?.code === "worklet-package-registration-timeout"
      && error.details?.transportActive === true
      && error.details?.reconciledActiveRegistry === false,
    "active transport must block registry self-heal and fail readiness closed",
  );
  assert.equal(forcedSyncCalls, forcedBeforeActiveTransport, "active transport must not receive a forced structural Instrument snapshot from registry proof");
  assert.equal(bootstrap.registrationSnapshot().forcedRegistryReconciliations, reconciliationsBeforeActiveTransport);
  port.transportActive = false;

  // A package whose registration threw in this Worklet scope cannot appear by
  // waiting: the proof must fail at once, naming the engine's own reason,
  // instead of spending its whole timeout and reporting a generic timeout.
  port.mode = "failed";
  const probesBeforeFailed = port.probes;
  const failedStart = Date.now();
  await assert.rejects(
    bootstrap.awaitWorkletPackages({ node, project: project2, timeoutMs: 2000, probeTimeoutMs: 200, pollMs: 1 }),
    (error) => error?.code === "worklet-package-registration-failed"
      && error.message.includes("runtime reports ABI 131072, expected 65536")
      && error.message.includes(`${identity2.moduleId}/${identity2.engineId}@${identity2.version}`)
      && error.details?.failure?.code === "abi-version"
      && error.details?.failedPackage?.packageSha256 === identity2.packageSha256,
    "a registration failure reported by the Worklet must fail the proof with the engine's reason",
  );
  assert.ok(Date.now() - failedStart < 1000, "a reported registration failure must not wait out the proof timeout");
  assert.equal(port.probes, probesBeforeFailed + 1, "one probe answer carrying the failure is enough");
  assert.equal(bootstrap.isWorkletReady(project2, node), false);
  assert.equal(bootstrap.registrationSnapshot().failure?.failure?.code, "abi-version", "the failure stays visible in the registration snapshot");
  // A failure recorded for a package this Project does not require is not this
  // proof's business: the required package is active, so the proof holds.
  port.mode = "failed-other";
  await bootstrap.awaitWorkletPackages({ node, project: project2, timeoutMs: 70, probeTimeoutMs: 20, pollMs: 1 });
  assert.equal(bootstrap.isWorkletReady(project2, node), true, "an unrelated registration failure must not block the required package");

  port.mode = "silent";
  await assert.rejects(
    bootstrap.awaitWorkletPackages({ node, project: project2, timeoutMs: 50, probeTimeoutMs: 15, pollMs: 1 }),
    (error) => error?.code === "worklet-package-registration-timeout" && error.details?.probes >= 1,
    "missing Worklet acknowledgement must fail closed rather than silently enabling production transport",
  );
  assert.equal(bootstrap.isWorkletReady(project2, node), false);

  // Historical/non-production projects must not depend on the production
  // MessagePort at all. An empty package requirement set is already proven by
  // definition and must survive resume even if the registry port is silent or
  // unavailable.
  const probesBeforeEmpty = port.probes;
  const forcedBeforeEmpty = forcedSyncCalls;
  const reconciliationsBeforeEmpty = bootstrap.registrationSnapshot().forcedRegistryReconciliations;
  const emptyProof = await bootstrap.awaitWorkletPackages({ node: null, project: emptyProject, timeoutMs: 50, probeTimeoutMs: 15, pollMs: 1 });
  assert.deepEqual(emptyProof.packages, []);
  assert.equal(emptyProof.probes, 0);
  assert.equal(emptyProof.requestId, null);
  assert.equal(emptyProof.reconciledActiveRegistry, false);
  assert.equal(port.probes, probesBeforeEmpty, "zero-package proof must not probe the Worklet registry");
  assert.equal(forcedSyncCalls, forcedBeforeEmpty, "zero-package proof must not force a structural Instrument snapshot");
  assert.equal(bootstrap.registrationSnapshot().forcedRegistryReconciliations, reconciliationsBeforeEmpty);
  assert.equal(bootstrap.isWorkletReady(emptyProject, null), true, "zero-package Project must be immediately Worklet-ready without a MessagePort");

  console.log("A5 exact Worklet package-registration barrier + active-registry reconciliation + zero-package readiness tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
