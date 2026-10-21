"use strict";

const assert = require("node:assert/strict");
const storeTypes = require("./stores.js");
const phraseStepTypes = require("./project-phrase-step.js");
const trackMixTypes = require("./track-mix-domain.js");
const fields = require("./field-schema.js");
const inputSafety = require("./input-safety.js");
const sessionDomain = require("./project-file-session.js");
const undoRedoTypes = require("./undo-redo.js");
const recoveryDomain = require("./project-recovery.js");

const emptyStep = () => ({
  note: -1,
  velocity: 40,
  instrument: -1,
  fx: Array.from({ length: 3 }, () => ({ command: 0, value: 0 })),
});

function realisticProject(label) {
  const phrases = {};
  for (let phraseId = 0; phraseId < 32; phraseId += 1) {
    phrases[phraseId] = Array.from({ length: 16 }, (_, row) => ({
      ...emptyStep(),
      note: row % 4 === 0 ? 48 + ((phraseId + row) % 24) : -1,
      velocity: phraseId === 0 && row === 0 ? 40 : 64 + ((phraseId + row) % 32),
      instrument: row % 4 === 0 ? 3 : -1,
    }));
  }
  const chains = {};
  for (let chainId = 0; chainId < 16; chainId += 1) {
    chains[chainId] = Array.from({ length: 16 }, (_, row) => ({
      phrase: (chainId * 2 + row) % 32,
      transpose: (row % 5) - 2,
    }));
  }
  return {
    schemaVersion: 4,
    projectName: label,
    tempo: 120,
    tracks: Array.from({ length: 8 }, (_, id) => ({ id, mix: { gain: 1, mute: false, pan: 0 } })),
    song: Array.from({ length: 64 }, (_, row) => Array.from({ length: 8 }, (_, track) => (row + track) % 16)),
    chains,
    phrases,
    instrumentPool: {},
    tables: Object.fromEntries(Array.from({ length: 8 }, (_, id) => [id, { values: Array.from({ length: 16 }, (_, n) => (n + id) & 255) }])),
    grooves: { 0: { name: "STRAIGHT", values: Array(16).fill(0) } },
    scales: { 0: { name: "CHROMATIC", values: Array.from({ length: 12 }, (_, n) => n) } },
    modulation: {}, mixer: {}, master: {}, effects: {}, assets: {}, presets: {}, mappings: {},
    sourceFormat: "brktrk", sourceVersion: null, sourceMetadata: { fixture: "g1-realistic" }, compatibilityExtensions: {}, unknownData: [],
  };
}

function makeState() {
  return {
    view: "phrase", dock: "sound", songRow: 0, track: 0, chain: 0, chainRow: 0, phrase: 0, phraseRow: 0, instrument: 3,
    focus: { pane: "phrase", row: 0, col: 1 }, lastChain: 0, lastPhrase: 0,
    p3: { activeWorkspace: "phrase", soundParam: 0, parents: [], mixReturn: null },
  };
}

function addInstrument(projectStore) {
  projectStore.createProductionInstrument(3, {
    id: 3,
    name: "G1 COST FIXTURE",
    engineRef: {
      moduleId: "design.myldy.fixture", engineId: "fixture", requestedVersion: "^1.0.0", resolvedVersion: "1.0.0",
      resolvedPackageSha256: "a".repeat(64), hostContract: "1.x",
    },
    patchState: { schemaVersion: 1, encoding: "opaque", data: null },
    parameterSnapshot: { cutoff: 0.25 },
    provenance: {}, compatibilityData: {}, unknownData: [],
  }, { source: "g1.cost.setup" });
}

function createLocalStorage() {
  const values = new Map();
  const counts = { get: 0, set: 0, remove: 0 };
  return {
    counts,
    getItem(key) { counts.get += 1; return values.has(String(key)) ? values.get(String(key)) : null; },
    setItem(key, value) { counts.set += 1; values.set(String(key), String(value)); },
    removeItem(key) { counts.remove += 1; values.delete(String(key)); },
    value(key) { return values.get(String(key)) ?? null; },
  };
}

function transaction(id, family, phase) {
  return Object.freeze({
    gestureId: id,
    gestureFamily: family,
    gestureKind: family === "tracker" ? "keyboard-repeat" : "pointer-range",
    gesturePhase: phase,
  });
}

async function createHarness(label) {
  const model = realisticProject(label);
  const state = makeState();
  const stores = storeTypes.createStores({ model, state, trackCount: 8 });
  phraseStepTypes.install(stores.project);
  const trackMix = trackMixTypes.install(stores.project, { trackCount: 8 });
  inputSafety.installContinuousGestureDurability(stores.project);
  addInstrument(stores.project);

  const local = createLocalStorage();
  const writes = [];
  const handle = { name: `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.brktrk` };
  const root = {
    BRKTRK_VERSION: "g1-test",
    BRKTRKStores: stores,
    BRKTRKCommands: { installed: true },
    BRKTRKUndoRedo: { reset() {} },
    BRKTRKSelectionClipboard: { cancelSelection() {} },
    stopPlayback() {}, renderAll() {}, focusSelectedCell() {}, setStatus() {},
  };
  const adapter = {
    capabilities: { directOpen: true, directSave: true, uploadFallback: true, downloadFallback: true },
    async openFile() { return { ok: false, cancelled: true }; },
    async saveAs(text, fileName) {
      writes.push({ kind: "saveAs", text, fileName });
      return { ok: true, handle, fileName: handle.name, mode: "handle", durableWriteConfirmed: true };
    },
    async writeHandle(boundHandle, text) {
      writes.push({ kind: "handle", text, fileName: boundHandle?.name ?? null });
      return { ok: true, handle: boundHandle, fileName: boundHandle?.name ?? handle.name, mode: "handle", durableWriteConfirmed: true };
    },
    async confirmDiscard() { return true; },
  };
  const session = sessionDomain.createController(root, {
    projectStore: stores.project,
    navigationStore: stores.navigation,
    commands: root.BRKTRKCommands,
    adapter,
    createInitialProject: () => realisticProject("NEW PROJECT"),
  });
  const history = undoRedoTypes.install(root, { projectStore: stores.project });
  root.BRKTRKInputSafety = {
    finalizeAllContinuousGestures(reason) {
      return stores.project.finalizeAllContinuousGestures({ gesturePhase: "end", gestureEndReason: reason });
    },
  };
  const recovery = recoveryDomain.createController(root, {
    projectStore: stores.project,
    fileSession: session,
    localStorage: local,
    now: (() => { let tick = 1000; return () => ++tick; })(),
  });

  const saved = await session.dispatch({ type: "project.saveAs", source: "g1.cost.baseline" });
  assert.equal(saved.ok, true);
  assert.equal(saved.durableWriteConfirmed, true);
  assert.equal(session.snapshot().dirty, false);
  assert.equal(history.snapshot().undoDepth, 0);
  assert.equal(recovery.snapshot().journalPresent, false);
  local.counts.set = 0;
  local.counts.remove = 0;
  local.counts.get = 0;

  const channelCounts = { project: 0, persistence: 0, audio: 0, render: 0, trackMix: 0, structuralAudio: 0 };
  stores.project.subscribe("project", () => { channelCounts.project += 1; });
  stores.project.subscribe("persistence", () => { channelCounts.persistence += 1; });
  stores.project.subscribe("audio", (changeSet) => {
    channelCounts.audio += 1;
    if (changeSet?.structuralPlayback === true) channelCounts.structuralAudio += 1;
  });
  stores.project.subscribe("render", () => { channelCounts.render += 1; });
  stores.project.subscribe("track-mix", () => { channelCounts.trackMix += 1; });

  return { model, state, stores, trackMix, root, session, history, recovery, local, writes, channelCounts };
}

function assertNoIntermediateDurableWork(h, label) {
  assert.equal(h.channelCounts.persistence, 0, `${label}: raw samples must not publish persistence`);
  assert.equal(h.history.snapshot().undoDepth, 0, `${label}: raw samples must not allocate history entries`);
  assert.equal(h.session.snapshot().dirty, false, `${label}: file-session durable state must not churn during raw samples`);
  assert.equal(h.session.snapshot().revision, 0, `${label}: durable revision must remain unchanged during raw samples`);
  assert.equal(h.local.counts.set, 0, `${label}: recovery journal must not serialize per raw sample`);
  assert.equal(h.recovery.snapshot().journalPresent, false, `${label}: recovery remains clear until explicit durable finalize`);
}

function assertOneFinalize(h, result, label) {
  assert.equal(result.committed, true, `${label}: gesture must explicitly finalize`);
  assert.equal(result.sampleCount, 1000, `${label}: durable record must account for all 1000 samples`);
  assert.equal(h.channelCounts.persistence, 1, `${label}: exactly one persistence publication is allowed`);
  assert.equal(h.history.snapshot().undoDepth, 1, `${label}: exactly one history entry is allowed`);
  assert.equal(h.session.snapshot().dirty, true, `${label}: finalized gesture must make the saved project dirty`);
  assert.equal(h.session.snapshot().revision, 1, `${label}: finalized gesture must advance durable revision once`);
  assert.equal(h.local.counts.set, 1, `${label}: recovery journal must serialize exactly once at finalize`);
  assert.equal(h.recovery.snapshot().journalPresent, true, `${label}: final value must be recoverable`);
}

(async () => {
  // Sound: 1000 exact ordered desired/audio/render mutations, zero structural
  // playback refresh semantics, then one durable/history/recovery transaction.
  {
    const h = await createHarness("G1 SOUND 1000");
    const finalValue = 1000 / 1001;
    for (let index = 0; index < 1000; index += 1) {
      const value = (index + 1) / 1001;
      h.stores.project.setProductionInstrumentParameter(3, "cutoff", value, {
        source: "a4-sound-range",
        transient: true,
        transaction: transaction("sound-1000", "sound", index === 0 ? "begin" : "update"),
      });
      assert.equal(h.model.instrumentPool[3].parameterSnapshot.cutoff, value, `Sound sample ${index + 1} must install synchronously`);
    }
    assert.deepEqual(
      { project: h.channelCounts.project, audio: h.channelCounts.audio, render: h.channelCounts.render, structuralAudio: h.channelCounts.structuralAudio },
      { project: 1000, audio: 1000, render: 1000, structuralAudio: 0 },
      "Sound 1000 samples must preserve ordered targeted live fan-out without generic structural refresh",
    );
    assertNoIntermediateDurableWork(h, "Sound");
    const result = h.stores.project.finalizeContinuousGesture({
      ...transaction("sound-1000", "sound", "end"), gestureEndReason: "pointerup",
    });
    assertOneFinalize(h, result, "Sound");
    assert.equal(h.channelCounts.project, 1000, "Sound finalize must not replay Project mutation");
    assert.equal(h.channelCounts.audio, 1000, "Sound finalize must not replay audio mutation");
    assert.equal(h.channelCounts.render, 1000, "Sound finalize must not replay render mutation");
    assert.equal(h.history.undo().ok, true);
    assert.equal(h.model.instrumentPool[3].parameterSnapshot.cutoff, 0.25);
    assert.equal(h.session.snapshot().dirty, false, "Sound Undo to saved baseline must restore CLEAN exactly");
    assert.equal(h.recovery.snapshot().journalPresent, false, "Sound Undo to clean baseline must clear recovery journal");
    assert.equal(h.history.redo().ok, true);
    assert.equal(h.model.instrumentPool[3].parameterSnapshot.cutoff, finalValue);
    assert.equal(h.session.snapshot().dirty, true);
  }

  // Mixer: the dedicated track-mix path gets all 1000 immediate mutations;
  // broad Project/audio/render and durable consumers stay untouched until end.
  {
    const h = await createHarness("G1 MIXER 1000");
    const finalValue = 1000 / 1001;
    for (let index = 0; index < 1000; index += 1) {
      const value = (index + 1) / 1001;
      h.trackMix.set(0, { gain: value }, {
        field: "gain",
        source: "track-mixer-gain-input",
        transaction: transaction("mixer-1000", "mixer", index === 0 ? "begin" : "update"),
      });
      assert.equal(h.trackMix.get(0).gain, value, `Mixer sample ${index + 1} must install synchronously`);
    }
    assert.deepEqual(
      { project: h.channelCounts.project, audio: h.channelCounts.audio, render: h.channelCounts.render, trackMix: h.channelCounts.trackMix },
      { project: 0, audio: 0, render: 0, trackMix: 1000 },
      "Mixer 1000 samples must stay on dedicated live fan-out",
    );
    assertNoIntermediateDurableWork(h, "Mixer");
    const result = h.stores.project.finalizeContinuousGesture({
      ...transaction("mixer-1000", "mixer", "end"), gestureEndReason: "pointerup",
    });
    assertOneFinalize(h, result, "Mixer");
    assert.equal(h.channelCounts.trackMix, 1000, "Mixer finalize must not replay live Track Mix mutation");
    assert.equal(h.history.undo().ok, true);
    assert.equal(h.trackMix.get(0).gain, 1);
    assert.equal(h.session.snapshot().dirty, false, "Mixer Undo to saved baseline must restore CLEAN exactly");
    assert.equal(h.recovery.snapshot().journalPresent, false);
    assert.equal(h.history.redo().ok, true);
    assert.equal(h.trackMix.get(0).gain, finalValue);
  }

  // Tracker: 1000 held-key-like edits alternate so every raw event mutates,
  // while the final value intentionally differs from the saved baseline.
  {
    const h = await createHarness("G1 TRACKER 1000");
    const env = {
      EMPTY: -1,
      NOTE_OFF: -2,
      state: h.state,
      model: h.model,
      projectStore: h.stores.project,
      phrase(id, create = true) {
        if (!Object.hasOwn(h.model.phrases, id) && create) h.model.phrases[id] = Array.from({ length: 16 }, emptyStep);
        return h.model.phrases[id];
      },
      chain(id, create = true) {
        if (!Object.hasOwn(h.model.chains, id) && create) h.model.chains[id] = [];
        return h.model.chains[id];
      },
      firstUnused() { return 1; },
      noteName(value) { return String(value); },
      fxName(value) { return String(value); },
    };
    const descriptor = fields.resolve("phrase", 1);
    for (let index = 0; index < 1000; index += 1) {
      const direction = index === 999 ? "ArrowRight" : index % 2 === 0 ? "ArrowRight" : "ArrowLeft";
      const before = h.model.phrases[0][0].velocity;
      fields.adjust(env, descriptor, direction, h.state.focus, {
        source: "keyboard",
        transaction: transaction("tracker-1000", "tracker", index === 0 ? "begin" : "update"),
      });
      assert.notEqual(h.model.phrases[0][0].velocity, before, `Tracker sample ${index + 1} must mutate synchronously`);
    }
    assert.equal(h.model.phrases[0][0].velocity, 42);
    assert.deepEqual(
      { project: h.channelCounts.project, audio: h.channelCounts.audio, render: h.channelCounts.render },
      { project: 1000, audio: 1000, render: 1000 },
      "Tracker 1000 samples must preserve immediate Project/audio/render fan-out",
    );
    assertNoIntermediateDurableWork(h, "Tracker");
    const result = h.stores.project.finalizeContinuousGesture({
      ...transaction("tracker-1000", "tracker", "end"), gestureEndReason: "keyup",
    });
    assertOneFinalize(h, result, "Tracker");
    assert.equal(h.channelCounts.project, 1000, "Tracker finalize must not replay Project mutation");
    assert.equal(h.channelCounts.audio, 1000, "Tracker finalize must not replay audio mutation");
    assert.equal(h.channelCounts.render, 1000, "Tracker finalize must not replay render mutation");
    assert.equal(h.history.undo().ok, true);
    assert.equal(h.model.phrases[0][0].velocity, 40);
    assert.equal(h.session.snapshot().dirty, false, "Tracker Undo to saved baseline must restore CLEAN exactly");
    assert.equal(h.recovery.snapshot().journalPresent, false);
    assert.equal(h.history.redo().ok, true);
    assert.equal(h.model.phrases[0][0].velocity, 42);
  }

  console.log("G1 integrated realistic-project 1000-sample cost + clean-baseline acceptance passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
