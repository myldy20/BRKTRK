const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const stores = require("./stores.js");
const storage = require("./project-storage.js");
const files = require("./project-file.js");
const sessionDomain = require("./project-file-session.js");

const EXPECTED_LIMITS = Object.freeze({
  maxFileBytes: 4 * 1024 * 1024,
  maxDepth: 64,
  maxContainers: 50000,
  maxEntries: 100000,
  maxArrayLength: 4096,
  maxObjectKeys: 4096,
});

function portableProject(name = "RESOURCE", tempo = 120) {
  return {
    schemaVersion: storage.CURRENT_SCHEMA_VERSION,
    projectName: name,
    tempo,
    tracks: [{ mix: { gain: 1, mute: false, pan: 0 } }],
    song: [[0]],
    chains: { 0: [{ phrase: 0, transpose: 0 }] },
    phrases: { 0: [{ note: 60, velocity: 100, instrument: 0, fx: [0, 0, 0] }] },
    instrumentPool: {},
    compatibilityExtensions: { "org.example.compat": { keep: true } },
  };
}

function rawEnvelope(project, unknownEnvelope = {}, producer = { app: "fixture", version: "1" }) {
  return JSON.stringify({
    ...unknownEnvelope,
    format: "BRKTRK_PROJECT",
    formatVersion: 1,
    producer,
    project,
  });
}

function nestedUnknown(depth) {
  let value = { leaf: true };
  for (let i = 0; i < depth; i += 1) value = [value];
  return value;
}

function createHarness(options = {}) {
  const model = portableProject(options.name ?? "ACTIVE", options.tempo ?? 120);
  storage.installRuntimeProject(model);
  const navigation = {
    view: "phrase",
    dock: "mix",
    songRow: 0,
    track: 0,
    chain: 0,
    chainRow: 0,
    phrase: 0,
    phraseRow: 0,
    instrument: 0,
    focus: { pane: "phrase", row: 0, col: 0 },
    lastChain: 0,
    lastPhrase: 0,
    p3: { activeWorkspace: "phrase", soundParam: 0, parents: [], mixReturn: null },
  };
  const bundle = stores.createStores({ model, state: navigation, trackCount: 8 });
  const statuses = [];
  const root = {
    BRKTRK_VERSION: "resource-test",
    BRKTRKStores: bundle,
    BRKTRKCommands: { installed: true },
    BRKTRKUndoRedo: { reset() {} },
    BRKTRKSelectionClipboard: { cancelSelection() {} },
    stopPlayback() {},
    renderAll() {},
    focusSelectedCell() {},
    setStatus(message, kind) { statuses.push({ message, kind }); },
  };
  const adapter = {
    capabilities: { directOpen: true, directSave: false, uploadFallback: true, downloadFallback: true },
    openFile: async () => options.openResult ?? { ok: false, cancelled: true },
    writeHandle: async () => ({ ok: false, error: new Error("not used") }),
    saveAs: async () => ({ ok: false, error: new Error("not used") }),
    confirmDiscard: async () => true,
  };
  const controller = sessionDomain.createController(root, {
    projectStore: bundle.project,
    navigationStore: bundle.navigation,
    commands: root.BRKTRKCommands,
    adapter,
    createInitialProject: () => portableProject("NEW", 100),
  });
  return { model, bundle, statuses, controller };
}

function assertResourceFailure(fn, message) {
  assert.throws(fn, (error) => {
    assert.equal(files.isResourceLimitError?.(error), true, message);
    assert.equal(error?.code, "BRKTRK_PROJECT_RESOURCE_LIMIT");
    return true;
  });
}

(async () => {
  assert.deepEqual(files.RESOURCE_LIMITS, EXPECTED_LIMITS, "portable .brktrk resource limits must be explicit and deterministic");
  assert.equal(
    files.UNKNOWN_DATA_POLICY,
    "preserve-whole-within-resource-envelope",
    "compatible unknown data must be all-or-nothing inside the same resource envelope",
  );

  {
    const project = portableProject("OVERSIZE");
    const text = rawEnvelope(project, { futureOuter: { padding: "x".repeat(EXPECTED_LIMITS.maxFileBytes) } });
    assert.ok(Buffer.byteLength(text, "utf8") > EXPECTED_LIMITS.maxFileBytes);
    assertResourceFailure(
      () => files.prepareOpen(text),
      "oversize string input must reject before migration/cloning",
    );
  }

  {
    const project = portableProject("DEEP");
    const text = rawEnvelope(project, { futureOuter: nestedUnknown(EXPECTED_LIMITS.maxDepth + 1) });
    assertResourceFailure(
      () => files.prepareOpen(text),
      "deep input must fail closed at the portable codec boundary",
    );
  }

  {
    const project = portableProject("DEGENERATE");
    const text = rawEnvelope(project, {
      futureOuter: { values: Array.from({ length: EXPECTED_LIMITS.maxArrayLength + 1 }, () => 0) },
    });
    assertResourceFailure(
      () => files.prepareOpen(text),
      "degenerate over-wide arrays must fail closed with bounded traversal",
    );
  }

  {
    const padding = "u".repeat(EXPECTED_LIMITS.maxFileBytes - 64 * 1024);
    const source = rawEnvelope(
      portableProject("NEAR LIMIT", 143),
      { futureOuter: { keep: true, padding } },
      { app: "fixture", version: "1", futureProducer: { keep: true } },
    );
    assert.ok(Buffer.byteLength(source, "utf8") < EXPECTED_LIMITS.maxFileBytes);
    assert.ok(
      Buffer.byteLength(source, "utf8") > EXPECTED_LIMITS.maxFileBytes - 128 * 1024,
      "near-limit fixture must stay close enough to exercise the byte ceiling",
    );
    const prepared = files.prepareOpen(source);
    assert.equal(prepared.unknownEnvelope.futureOuter.padding.length, padding.length);
    assert.equal(prepared.unknownEnvelope.futureOuter.keep, true);
    assert.equal(prepared.producer.futureProducer.keep, true);
    const savedA = files.serializeProject(prepared.project, {
      unknownEnvelope: prepared.unknownEnvelope,
      producer: prepared.producer,
    });
    const savedB = files.serializeProject(prepared.project, {
      unknownEnvelope: prepared.unknownEnvelope,
      producer: prepared.producer,
    });
    assert.equal(savedA, savedB, "near-limit save must be deterministic");
    assert.ok(Buffer.byteLength(savedA, "utf8") <= EXPECTED_LIMITS.maxFileBytes);
    const reopened = files.prepareOpen(savedA);
    assert.equal(reopened.unknownEnvelope.futureOuter.padding, padding);
    assert.equal(reopened.project.compatibilityExtensions["org.example.compat"].keep, true);
  }

  {
    const fixtureRoot = path.resolve(__dirname, "../fixtures/m43a/stable-projects");
    const manifest = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "manifest.json"), "utf8"));
    for (const entry of manifest.fixtures.filter((item) => item.kind === "accept-project")) {
      const fixturePath = path.join(fixtureRoot, entry.file);
      const bytes = fs.readFileSync(fixturePath);
      assert.equal(
        crypto.createHash("sha256").update(bytes).digest("hex"),
        entry.sha256,
        `${entry.file} historical bytes must remain frozen`,
      );
      const prepared = files.prepareOpen(bytes.toString("utf8"));
      assert.equal(prepared.projectSchemaVersion, storage.CURRENT_SCHEMA_VERSION);
    }
    const schema3Text = fs.readFileSync(path.join(fixtureRoot, "format1-schema3.brktrk.json"), "utf8");
    const schema3 = files.prepareOpen(schema3Text);
    assert.equal(schema3.unknownEnvelope.futureOuter.keep, true);
    assert.equal(schema3.producer.futureProducer.keep, true);
    assert.equal(schema3.project.futureProject.keep, true);
    assert.equal(schema3.project.tracks[0].futureTrack.keep, true);
    assert.equal(schema3.project.chains[5][0].futureChain.keep, true);
    assert.equal(schema3.project.phrases[9][0].futureStep.keep, true);
    assert.equal(schema3.project.compatibilityExtensions["org.example.future"].keep, true);
    const roundTrip = files.prepareOpen(files.serializeProject(schema3.project, {
      unknownEnvelope: schema3.unknownEnvelope,
      producer: schema3.producer,
    }));
    assert.equal(roundTrip.unknownEnvelope.futureOuter.keep, true);
    assert.equal(roundTrip.producer.futureProducer.keep, true);
    assert.equal(roundTrip.project.futureProject.keep, true);
    assert.equal(roundTrip.project.tracks[0].futureTrack.keep, true);
    assert.equal(roundTrip.project.chains[5][0].futureChain.keep, true);
    assert.equal(roundTrip.project.phrases[9][0].futureStep.keep, true);
    assert.equal(roundTrip.project.compatibilityExtensions["org.example.future"].keep, true);
  }

  {
    let textReads = 0;
    const file = {
      name: "too-large.brktrk",
      size: EXPECTED_LIMITS.maxFileBytes + 1,
      async text() {
        textReads += 1;
        return "{}";
      },
    };
    const handle = { name: file.name, async getFile() { return file; } };
    const adapter = sessionDomain.createBrowserFileAdapter({
      showOpenFilePicker: async () => [handle],
    });
    const result = await adapter.openFile();
    assert.equal(result.ok, false);
    assert.equal(result.reason, "project-too-large-invalid");
    assert.equal(files.isResourceLimitError?.(result.error), true);
    assert.equal(textReads, 0, "File.size fast-reject must happen before file.text() allocates the payload");
  }

  {
    const text = rawEnvelope(
      portableProject("SHOULD NOT INSTALL", 199),
      { futureOuter: { padding: "x".repeat(EXPECTED_LIMITS.maxFileBytes) } },
    );
    const h = createHarness({
      openResult: { ok: true, text, fileName: "too-large.brktrk", handle: null, mode: "upload" },
    });
    const before = JSON.stringify(storage.migrateProject(h.model).project);
    const result = await h.controller.dispatch({ type: "project.open", force: true });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "project-too-large-invalid");
    assert.equal(
      JSON.stringify(storage.migrateProject(h.model).project),
      before,
      "resource rejection must be atomic and leave the active Project untouched",
    );
    assert.equal(h.model.projectName, "ACTIVE");
    assert.equal(h.model.tempo, 120);
    assert.equal(h.controller.snapshot().fileName, null);
    assert.equal(
      h.controller.snapshot().lastOperation.message,
      "PROJECT TOO LARGE/INVALID · CURRENT PROJECT UNCHANGED",
    );
    assert.equal(
      h.statuses.at(-1)?.message,
      "PROJECT TOO LARGE/INVALID · CURRENT PROJECT UNCHANGED",
      "resource rejection must remain visible through the normal status channel",
    );
  }

  console.log("G2A .brktrk deterministic resource-bound regression tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
