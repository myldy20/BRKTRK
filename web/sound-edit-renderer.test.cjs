const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
require("./production-instrument-domain.js");
const stores = require("./stores.js");
const renderer = require("./sound-edit-renderer.js");

// Alpha Sound Workbench uses real engine parameters, not duplicated macro state.
const performanceView = {
  parameters: ["model", "cutoff", "resonance", "tone", "decay", "attack", "extra", "level"]
    .map((id) => ({ id })),
  ui: { pages: [
    { id: "main", label: "Main", mode: "curated", controls: ["model", "cutoff", "resonance", "tone", "decay", "attack", "extra"] },
    { id: "all", label: "All", mode: "all" },
  ] },
};
assert.deepEqual(renderer.performanceControls(performanceView).map((p) => p.id),
  ["model", "cutoff", "resonance", "tone", "decay", "level"],
  "PLAY must contain at most six genuine parameters, retain authored main order and include output level");
assert.equal(new Set(renderer.performanceControls(performanceView).map((p) => p.id)).size, 6,
  "PLAY must never duplicate a parameter");
assert.equal(renderer.pageControls(performanceView, "all").controls.length, 8,
  "Full engine page must keep every parameter editable");
assert.deepEqual(renderer.performanceControls({ parameters: [{ id: "pitch" }], ui: {} }).map((p) => p.id), ["pitch"],
  "Fallback engine without curated pages must still have a PLAY control");
const strictlyCurated = {
  parameters: [
    { id: "shape" }, { id: "cutoff" }, { id: "drive.amount" },
  ],
  ui: { pages: [
    { id: "main", mode: "curated", controls: ["shape", "cutoff"] },
    { id: "advanced", mode: "all" },
  ] },
};
assert.deepEqual(renderer.performanceControls(strictlyCurated).map((p) => p.id),
  ["shape", "cutoff"], "PLAY must not invent extra controls absent from the engine-curated page");
assert.deepEqual(renderer.performanceControls({
  ...strictlyCurated,
  parameters: [...strictlyCurated.parameters, { id: "level" }],
}).map((p) => p.id), ["shape", "cutoff", "level"],
  "Engine output level is the only explicitly allowed addition to curated PLAY");
assert.deepEqual(renderer.pageControls({
  parameters: [{ id: "cutoff" }, { id: "drive.amount" }],
  ui: { pages: [{ id: "__play__", label: "Provider-owned page", mode: "all" }] },
}, "__play__").controls.map((p) => p.id), ["cutoff", "drive.amount"],
  "An engine may legally use the former synthetic page ID; its authored page must remain addressable");

assert.equal(renderer.knobDragValue(0.25, 80), 0.75, "dragging up increases value");
assert.equal(renderer.knobDragValue(0.25, -200), 0, "dragging down clamps at zero");
assert.equal(renderer.knobDragValue(0.9, 200), 1, "dragging up clamps at one");
assert.equal(renderer.knobDragValue(0.25, 80, true), 0.25 + 80 / 600, "Shift performs fine adjustment");

assert.deepEqual(renderer.selectionDelta({ instrument: 1, soundParam: 2 }, { instrument: 1, soundParam: 4 }), {
  instrumentChanged: false,
  parameterChanged: true,
});
assert.deepEqual(
  renderer.productionParameter({ path: ["instrumentPool", 3, "parameterSnapshot", "filter.cutoff"] }),
  { instrumentId: 3, parameterId: "filter.cutoff" },
);
assert.equal(renderer.productionParameter({ path: ["instruments", 3, "params", 5] }), null);
assert.equal(Object.hasOwn(renderer, "instrumentParameter"), false, "legacy preview parameter resolver must not exist");

const compatibleCandidate = Object.freeze({
  entry: Object.freeze({ engineId: "ready-engine", version: "1.0.0", packageSha256: "a".repeat(64) }),
  compatibility: Object.freeze({ compatible: true, code: "compatible", reason: "catalog declares compatible host contract" }),
});
const incompatibleCandidate = Object.freeze({
  entry: Object.freeze({ engineId: "future-engine", version: "2.0.0", packageSha256: "b".repeat(64) }),
  compatibility: Object.freeze({ compatible: false, code: "abi-version", reason: "ABI 0x00020000 is not supported by this Host" }),
});
const unavailable = renderer.catalogCandidatePresentation(incompatibleCandidate);
assert.equal(unavailable.compatible, false);
assert.equal(unavailable.disabled, true, "incompatible trusted engine must render disabled before Create");
assert.match(unavailable.label, /future-engine · 2\.0\.0 · unavailable · abi-version: ABI 0x00020000 is not supported by this Host/);
assert.equal(unavailable.status, "UNAVAILABLE · abi-version · ABI 0x00020000 is not supported by this Host");
const ready = renderer.catalogCandidatePresentation(compatibleCandidate);
assert.equal(ready.compatible, true);
assert.equal(ready.disabled, false);
assert.equal(ready.status, "Verified package will create this Instrument");
assert.equal(renderer.selectedCatalogCandidate([incompatibleCandidate, compatibleCandidate], "0"), null, "incompatible selection must never enter package verification");
assert.strictEqual(renderer.selectedCatalogCandidate([incompatibleCandidate, compatibleCandidate], "1"), compatibleCandidate, "compatible selection must retain normal Create path");
assert.equal(renderer.selectedCatalogCandidate([compatibleCandidate], "invalid"), null);

const rendererSource = fs.readFileSync(path.join(__dirname, "sound-edit-renderer.js"), "utf8");
{
  require("./engine-package-domain.js");
  const candidate = (moduleId, engineId, version, compatible = true, channel = "stable") => ({
    entry: { moduleId, engineId, version, channel, packageSha256: "c".repeat(64) },
    compatibility: { compatible, code: compatible ? "compatible" : "abi-version" },
  });
  const catalog = [
    candidate("wav", "brk-wav", "0.1.0-rc.2"),
    candidate("fm", "brk-fm4", "1.0.0"),
    candidate("wav", "brk-wav", "0.1.0-rc.10"),
    candidate("wav", "brk-wav", "0.2.0", false),
    candidate("wav", "brk-wav", "2.0.0", true, "preview"),
    candidate("ay", "brk-ay", "1.0.0", false),
  ];
  const choices = renderer.catalogEngineChoices(catalog);
  assert.deepEqual(choices.map((entry) => entry.label), ["BRK WAV", "BRK FM4", "brk-ay · unavailable · abi-version"]);
  assert.equal(choices[0].index, 2, "resolve semver RC10 rather than RC2, incompatible newer and other-channel rows");
  assert.equal(choices[2].disabled, true);
  assert.equal(renderer.catalogEngineChoices([]).length, 0);
  const calls = [];
  globalThis.BRKTRKProductionEngineHost = { ensurePackageView: async (...args) => { calls.push(args); return "verified"; } };
  const original = JSON.stringify(catalog);
  Promise.all([renderer.prefetchCatalogEngine(catalog[2]), renderer.prefetchCatalogEngine(catalog[3])]).then((result) => {
    assert.deepEqual(result, ["verified", null]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0].resolvedVersion, "0.1.0-rc.10");
    assert.equal(calls[0][0].resolvedPackageSha256, catalog[2].entry.packageSha256);
    assert.equal(JSON.stringify(catalog), original, "preload must not rewrite identities");
  }).catch((error) => { console.error(error); process.exitCode = 1; });
}
assert.match(rendererSource, /BRKTRKProductionEngineHost\.catalogCandidates\(\)/, "Create picker must consume all trusted compatibility candidates");
assert.match(rendererSource, /option\.disabled = entry\.disabled/, "Create picker must disable incompatible options");
assert.match(rendererSource, /BRKTRKSampleAssetSurface\?\.renderPanel/, "verified sampler Sound must render the separate asset surface without inventing a DSP parameter");

// --- the Create picker groups by engine and leads with the newest -----------
// The picker listed one flat row per VERSION, so choosing an engine meant
// reading its name several times and picking a release candidate by hand. The
// owner's report was blunt: "тупо последний нужен".
{
  const candidate = (engineId, version, compatible, moduleId = "design.myldy.brk") => Object.freeze({
    entry: Object.freeze({ moduleId, engineId, version, packageSha256: "c".repeat(64) }),
    compatibility: Object.freeze(compatible
      ? { compatible: true, code: "compatible", reason: "ok" }
      : { compatible: false, code: "abi-version", reason: "ABI is not supported by this Host" }),
  });

  // Deliberately out of order, and with the newest of brk-wav in the middle.
  const candidates = [
    candidate("brk-wav", "0.1.0-rc5", true),
    candidate("brk-modal", "1.0.0", true),
    candidate("brk-wav", "0.1.0-rc6", true),
    candidate("brk-wav", "0.2.0-alpha.1", false),
  ];
  const groups = renderer.catalogPickerGroups(candidates);

  assert.deepEqual(groups.map((group) => group.label), ["brk-wav", "brk-modal"],
    "engines group in the order the catalog declares them, each named once");
  assert.deepEqual(groups[0].options.map((option) => option.version), ["0.2.0-alpha.1", "0.1.0-rc6", "0.1.0-rc5"],
    "versions inside an engine run newest first");
  // A disabled row cannot be selected, so the status line can never speak for
  // it and its title is unreachable on touch: its own label is the only place
  // its reason can live.
  assert.equal(groups[0].options[0].label, "0.2.0-alpha.1 · unavailable · abi-version: ABI is not supported by this Host",
    "an unavailable version carries its human reason, and never repeats the engine name the group already carries");
  assert.equal(groups[0].options[1].label, "0.1.0-rc6",
    "a version that runs here is just its version");
  assert.equal(groups[0].options[0].disabled, true, "an incompatible version must render disabled before Create");
  assert.equal(groups[0].options[1].disabled, false);

  // The index has to keep addressing the ORIGINAL candidate, because that is
  // what the selector's value means and what Create resolves through.
  assert.strictEqual(renderer.selectedCatalogCandidate(candidates, String(groups[0].options[1].index)), candidates[2],
    "a grouped option must still resolve to its own candidate");

  const chosen = renderer.defaultCatalogIndex(groups);
  assert.strictEqual(candidates[chosen], candidates[2],
    "the newest version that actually runs here is preselected, so Create is one tap away");

  // Two modules publishing the same engineId must stay distinguishable.
  const ambiguous = renderer.catalogPickerGroups([
    candidate("brk-wav", "1.0.0", true, "design.myldy.brk"),
    candidate("brk-wav", "1.0.0", true, "design.other.brk"),
  ]);
  assert.deepEqual(ambiguous.map((group) => group.label), ["design.myldy.brk · brk-wav", "design.other.brk · brk-wav"],
    "an engineId shared by two modules must name its module");

  // The Create path resolves one channel; `entryCompatibility` never reads it.
  // A compatible preview entry could therefore be offered, be PRESELECTED by
  // newest-first ordering, and then fail Create with `package-unavailable` on
  // the row the panel put under the user's thumb. The picker offers only what
  // Create can build.
  const withPreview = [
    candidate("brk-wav", "0.1.0", true),
    Object.freeze({ ...candidate("brk-wav", "0.9.0", true), entry: Object.freeze({ ...candidate("brk-wav", "0.9.0", true).entry, channel: "preview" }) }),
  ];
  const stableOnly = renderer.catalogPickerGroups(withPreview);
  assert.deepEqual(stableOnly[0].options.map((option) => option.version), ["0.1.0"],
    "a channel the Create path cannot resolve must not be offered at all");
  assert.strictEqual(withPreview[renderer.defaultCatalogIndex(stableOnly)], withPreview[0],
    "and must never become the preselected default");
  // An entry that declares no channel is the resolvable one by definition.
  assert.equal(renderer.catalogPickerGroups([candidate("brk-wav", "1.0.0", true)])[0].options.length, 1);
  // The filter is explicit, so a host that resolves another channel says so.
  assert.deepEqual(
    renderer.catalogPickerGroups(withPreview, { channel: "preview" })[0].options.map((option) => option.version),
    ["0.9.0"],
    "the offered channel follows what Create will resolve, rather than being hard-coded here",
  );

  // Nothing compatible is not a default: the button's wording depends on it.
  assert.equal(renderer.defaultCatalogIndex(renderer.catalogPickerGroups([candidate("brk-wav", "9.0.0", false)])), -1,
    "a catalog that cannot create anything must not preselect a row");
  assert.equal(renderer.defaultCatalogIndex([]), -1);
  console.log("Create picker groups by engine and leads with the newest that runs here");
}
assert.match(rendererSource, /selectedCatalogCandidate\(candidates, select\.value\)/, "Create click must pass through compatibility guard before verification");
assert.match(rendererSource, /host\.snapshot\?\.\(\)\.catalog/, "loaded incompatible-only catalogs must not refetch forever");

const model = {
  schemaVersion: 4,
  sourceFormat: "brktrk",
  projectName: "TEST",
  tempo: 120,
  tracks: Array.from({ length: 8 }, (_, id) => ({ id, mix: { gain: 1, mute: false, pan: 0 } })),
  song: [],
  chains: {},
  phrases: {},
  instrumentPool: {
    2: {
      id: 2,
      name: "PRODUCTION TEST",
      engineRef: {
        moduleId: "design.myldy.fixture",
        engineId: "fixture",
        requestedVersion: "1.0.0",
        resolvedVersion: "1.0.0",
        resolvedPackageSha256: "a".repeat(64),
        hostContract: "brktrk-synth-gateway-v1",
      },
      patchState: { schemaVersion: 1, encoding: "base64", data: null },
      parameterSnapshot: { "filter.cutoff": 0.5 },
      presetRef: null,
      provenance: { source: "fixture" },
      compatibilityData: {},
      unknownData: [],
    },
  },
};
const state = { view: "sound", dock: "sound", focus: { pane: "phrase", row: 0, col: 0 }, instrument: 2, p3: { activeWorkspace: "sound", soundParam: 0 } };
const project = stores.createStores({ model, state }).project;
const events = [];
for (const channel of ["project", "persistence", "audio", "render"]) project.subscribe(channel, (change) => events.push([channel, change]));
const mutation = project.setProductionInstrumentParameter(2, "filter.cutoff", 0.75, { source: "g8-production-test" });
assert.equal(mutation.mutated, true);
assert.equal(model.instrumentPool[2].parameterSnapshot["filter.cutoff"], 0.75);
assert.deepEqual(events.map(([channel]) => channel), ["project", "persistence", "audio", "render"]);
assert.equal(mutation.changeSet.target, "project.instrumentPool.2.parameterSnapshot.filter.cutoff");
assert.deepEqual(mutation.changeSet.renderTargets, ["production-instrument.parameter.2.filter.cutoff"]);
assert.equal(Object.hasOwn(model, "instruments"), false);
assert.equal(Object.hasOwn(model, "previewInstruments"), false);

console.log("G8 production Sound/Edit renderer + catalog compatibility preflight tests passed");
// --- the engine's own ranges outrank the package JSON (#455) -----------------
// BRK Modal declares 33 of its 89 parameters with real units - dB, Hz, ms,
// cents, semitones, octaves, voices - and every one of them could only reach
// the Sound surface as a percentage, because BRKTRK read presentation from
// static package JSON instead of from the binary that answers for the DSP.
{
  const savedHost = globalThis.BRKTRKProductionEngineHost;
  const entry = { moduleId: "design.myldy.brk-modal", engineId: "brk-modal", version: "1.2.0", packageSha256: "d".repeat(64) };
  globalThis.BRKTRKProductionEngineHost = {
    abiDescriptorsFor: () => ({
      parameters: [
        { key: "output_gain", unit: "dB", plainMin: -60, plainMax: 12, plainStep: 0 },
        { key: "polyphony", unit: "voices", plainMin: 1, plainMax: 16, plainStep: 1 },
        { key: "cutoff", unit: "Hz", plainMin: 30, plainMax: 18000, plainStep: 0 },
        // Genuinely normalized: no unit, 0..1. A percentage is the honest
        // reading and "0.50" would be a downgrade dressed as precision.
        { key: "timbre", unit: "", plainMin: 0, plainMax: 1, plainStep: 0 },
      ],
    }),
  };
  const view = { entry };

  // The package JSON says nothing about these, exactly as brk-macro's cutoff
  // carries no range and no unit. The engine does.
  assert.equal(renderer.displayValue({ id: "output_gain" }, 0.5, {}, view), "-24.0 dB",
    "a parameter the engine describes in dB must stop rendering as a percentage");
  assert.equal(renderer.displayValue({ id: "polyphony" }, 1, {}, view), "16 voices",
    "plainStep must quantise to whole voices");

  // The curve comes from the package UI profile, not the ABI: the descriptor
  // struct has no skew field, and that split is deliberate upstream.
  const skewed = renderer.displayValue({ id: "cutoff" }, 0.5, { plainSkewByKey: { cutoff: 0.35 } }, view);
  const linear = renderer.displayValue({ id: "cutoff" }, 0.5, {}, view);
  assert.notEqual(skewed, linear, "a declared skew must change the reading, not be ignored");
  assert.equal(linear, "9015 Hz", "without a skew the mapping is linear across the engine's range");
  assert.equal(skewed, "2510 Hz", "with skew 0.35 the midpoint lands far lower, as the engine intends");

  assert.equal(renderer.displayValue({ id: "timbre" }, 0.5, {}, view), "50%",
    "a unitless 0..1 parameter is genuinely normalized and must stay a percentage");

  // An engine that never described itself keeps the package-JSON behaviour.
  globalThis.BRKTRKProductionEngineHost = { abiDescriptorsFor: () => null };
  assert.equal(
    renderer.displayValue({ id: "attack", plainRange: [1, 4000], plainCurve: "exponential", plainScales: [{ divide: 1, decimals: 0, unit: "ms" }] }, 0.5, {}, view),
    "63 ms",
    "an engine without descriptors must keep rendering from its package descriptor",
  );
  assert.equal(renderer.displayValue({ id: "unknown" }, 0.25, {}, view), "25%",
    "with neither source the honest reading is still a percentage");

  globalThis.BRKTRKProductionEngineHost = savedHost;
  console.log("Sound display prefers engine-reported ranges over package JSON");
}

// --- the ABI supplies the RANGE; the package still owns the CURVE (#463) -----
// The 96-byte descriptor struct has plain_min/plain_max/plain_step and no field
// for a curve, so reading the range and implying a linear mapping overrides a
// package that declared an exponential one. The dev engine ships `attack`,
// `decay` and `release` as exponential 1ms..4s and its DSP runs that mapping:
// at 0.5 the truthful reading is 63 ms, and a linear reading of the same range
// prints 2001 ms.
{
  const savedHost = globalThis.BRKTRKProductionEngineHost;
  const entry = { moduleId: "design.myldy.dev", engineId: "brk-dev-poly", version: "0.1.0", packageSha256: "e".repeat(64) };
  globalThis.BRKTRKProductionEngineHost = {
    abiDescriptorsFor: () => ({
      parameters: [
        { key: "attack", unit: "ms", plainMin: 1, plainMax: 4000, plainStep: 0 },
        { key: "quarters", unit: "q", plainMin: 0, plainMax: 4, plainStep: 0.25 },
        { key: "tenths", unit: "q", plainMin: 0, plainMax: 1, plainStep: Math.fround(0.1) },
        { key: "mystery", unit: "ms", plainMin: 1, plainMax: 4000, plainStep: 0 },
      ],
    }),
  };
  const view = { entry };
  const msScales = [
    { atLeast: 1000, divide: 1000, decimals: 2, unit: "s" },
    { atLeast: 100, divide: 1, decimals: 0, unit: "ms" },
    { atLeast: 10, divide: 1, decimals: 1, unit: "ms" },
    { divide: 1, decimals: 2, unit: "ms" },
  ];
  const attack = { id: "attack", plainRange: [1, 4000], plainCurve: "exponential", plainScales: msScales };

  assert.equal(renderer.displayValue(attack, 0.5, {}, view), "63.2 ms",
    "the engine's range must be read through the curve the package declared, not linearly");
  assert.notEqual(renderer.displayValue(attack, 0.5, {}, view), "2001 ms",
    "a linear reading of an exponential control is the confident lie a declared curve exists to prevent");
  assert.equal(renderer.displayValue(attack, 1, {}, view), "4.00 s",
    "the top of the engine's range must still be the top of the reading");

  // Decimals follow the step's real decimal representation. ceil(-log10(0.25))
  // is 1, which would round a value the engine holds at exactly 0.25 to "0.3".
  assert.equal(renderer.displayValue({ id: "quarters" }, 0.5, {}, view), "2.00 q",
    "a non-power-of-ten step must keep the precision it actually quantises to");
  assert.equal(renderer.displayValue({ id: "quarters" }, 0.06, {}, view), "0.25 q",
    "a stepped value must be printed exactly, not rounded past its own increment");
  assert.equal(renderer.displayValue({ id: "tenths" }, 0.5, {}, view), "0.5 q",
    "an f32 0.1 step must display at semantic decimal precision, not expose binary expansion digits");

  // A curve this renderer cannot honour must fall back rather than guess.
  assert.equal(
    renderer.displayValue({ id: "mystery", plainRange: [1, 4000], plainCurve: "logarithmic" }, 0.5, {}, view),
    "50%",
    "an unrecognised declared curve must fall back, never silently become linear",
  );

  globalThis.BRKTRKProductionEngineHost = savedHost;
  console.log("Sound display composes the engine range with the package curve");
}

// --- parameters group into titled sections (#455 groupLabels) ---------------
// Engines tag each parameter with a `group` and ship `ui.groupLabels`, and
// nothing read either: every control landed in one flat grid with its own
// group name repeated underneath it. For BRK Modal that is 89 undifferentiated
// controls, each captioned with the section it is already in.
{
  const parameters = [
    { id: "shape", group: "OSC" },
    { id: "cutoff", group: "FILTER" },
    { id: "resonance", group: "FILTER" },
    { id: "attack", group: "ENV" },
    { id: "level", group: "AMP" },
    { id: "decay", group: "ENV" },
  ];
  const ui = { groupLabels: { OSC: "Oscillator", FILTER: "Filter", ENV: "Envelope" } };

  const groups = renderer.groupedControls(parameters, ui);
  assert.deepEqual(groups.map((group) => group.key), ["OSC", "FILTER", "ENV", "AMP"],
    "section order must follow the engine's own signal flow, not the alphabet");
  assert.deepEqual(groups.map((group) => group.label), ["Oscillator", "Filter", "Envelope", "AMP"],
    "groupLabels supplies the human label, and the raw key is the fallback when it does not");
  const blankLabel = renderer.groupedControls([{ id: "cutoff", group: "FILTER" }], { groupLabels: { FILTER: "   " } });
  assert.equal(blankLabel[0].label, "FILTER",
    "blank groupLabels metadata must fall back to the raw group key instead of rendering an empty heading");
  assert.deepEqual(groups.map((group) => group.controls.map((parameter) => parameter.id)), [
    ["shape"], ["cutoff", "resonance"], ["attack", "decay"], ["level"],
  ], "a parameter appearing later must join its existing section rather than opening a new one");

  // An engine that declares no groups must render exactly as it does today.
  const ungrouped = renderer.groupedControls([{ id: "a" }, { id: "b" }], {});
  assert.equal(ungrouped.length, 1, "no declared groups means one section");
  assert.equal(ungrouped[0].label, null, "and that section carries no heading, so the layout is unchanged");
  assert.deepEqual(ungrouped[0].controls.map((parameter) => parameter.id), ["a", "b"]);

  // A blank or whitespace group is absence, not a section named " ".
  const blank = renderer.groupedControls([{ id: "a", group: "  " }, { id: "b", group: null }], {});
  assert.equal(blank.length, 1);
  assert.equal(blank[0].label, null);

  console.log("Sound parameters group into titled sections from the engine's own metadata");
}

// --- a bipolar control must read as bipolar ---------------------------------
// A parameter whose plain range crosses zero was drawn as a bar growing from
// the left, so WARP at -0.25 looked like a quarter-full positive value. The
// fill has to start at the parameter's own zero, and that zero is only at the
// middle of the track when the engine's range happens to be symmetric.
{
  const savedHost = globalThis.BRKTRKProductionEngineHost;
  const entry = { moduleId: "design.myldy.brk-modal", engineId: "brk-modal", version: "1.2.0", packageSha256: "e".repeat(64) };
  globalThis.BRKTRKProductionEngineHost = {
    abiDescriptorsFor: () => ({
      parameters: [
        // Symmetric: zero is the midpoint.
        { key: "warp", unit: "", plainMin: -1, plainMax: 1, plainStep: 0 },
        // Asymmetric: zero is NOT the midpoint, and assuming 50% would put the
        // tick where the reading is +6 dB.
        { key: "trim", unit: "dB", plainMin: -60, plainMax: 12, plainStep: 0 },
        // Never negative: unipolar, no tick.
        { key: "cutoff", unit: "Hz", plainMin: 30, plainMax: 18000, plainStep: 0 },
      ],
    }),
  };
  const view = { entry };

  const warpCentre = renderer.fillGeometry({ id: "warp" }, 0.5, {}, view);
  assert.equal(warpCentre.bipolar, true, "a range crossing zero is bipolar");
  assert.ok(Math.abs(warpCentre.zero - 0.5) < 1e-9, "a symmetric range puts zero at the middle");
  assert.ok(Math.abs(warpCentre.from - warpCentre.to) < 1e-9, "at zero the fill has no width");

  const warpNegative = renderer.fillGeometry({ id: "warp" }, 0.375, {}, view);
  assert.ok(Math.abs(warpNegative.from - 0.375) < 1e-9, "a negative value fills from the value");
  assert.ok(Math.abs(warpNegative.to - 0.5) < 1e-9, "...to zero, not from the left edge");

  const warpPositive = renderer.fillGeometry({ id: "warp" }, 0.75, {}, view);
  assert.ok(Math.abs(warpPositive.from - 0.5) < 1e-9, "a positive value fills from zero");
  assert.ok(Math.abs(warpPositive.to - 0.75) < 1e-9, "...to the value");

  const trim = renderer.fillGeometry({ id: "trim" }, 1, {}, view);
  assert.ok(Math.abs(trim.zero - (60 / 72)) < 1e-9,
    "an asymmetric range puts zero where the reading is actually 0 dB, not at the middle");
  assert.equal(renderer.displayValue({ id: "trim" }, trim.zero, {}, view), "0.00 dB",
    "and the anchor must agree with the number the same parameter prints there");

  // The skew is applied to the reading as proportion = normalized^(1/skew), so
  // the normalized position of a plain value is proportion^skew. Taking the raw
  // proportion would draw the tick where the number is not zero.
  const skewedUi = { plainSkewByKey: { trim: 0.35 } };
  const skewed = renderer.fillGeometry({ id: "trim" }, 1, skewedUi, view);
  assert.ok(Math.abs(skewed.zero - Math.pow(60 / 72, 0.35)) < 1e-9, "a declared skew must move the anchor");
  assert.equal(renderer.displayValue({ id: "trim" }, skewed.zero, skewedUi, view), "0.00 dB",
    "a skewed anchor must still land exactly on the parameter's own zero");

  // Landing exactly on the tick must not read as a negative value.
  assert.equal(renderer.displayValue({ id: "trim" }, skewed.zero, skewedUi, view).startsWith("-"), false,
    "a reading that rounds to zero must not print as negative at the parameter's own zero");
  assert.equal(renderer.displayValue({ id: "trim" }, 0, {}, view), "-60.0 dB",
    "and a genuinely negative reading must keep its sign");

  const unipolar = renderer.fillGeometry({ id: "cutoff" }, 0.96, {}, view);
  assert.equal(unipolar.bipolar, false, "a range that never goes negative is not bipolar");
  assert.equal(unipolar.zero, null);
  assert.equal(unipolar.from, 0, "a unipolar fill starts at the left edge");
  assert.ok(Math.abs(unipolar.to - 0.96) < 1e-9);

  // An exponential mapping is only defined for strictly positive bounds, so a
  // range that claims to cross zero under one cannot be anchored. Drawing a
  // guessed centre there is the same confident lie the reading path refuses.
  globalThis.BRKTRKProductionEngineHost = { abiDescriptorsFor: () => null };
  assert.equal(renderer.zeroAnchor({ id: "x", plainRange: [-1, 1], plainCurve: "exponential" }, {}, view), null,
    "an unhonourable curve must fall back to a unipolar fill rather than guess a centre");
  assert.equal(renderer.zeroAnchor({ id: "x", plainRange: [-1, 1] }, {}, view), 0.5,
    "a package-declared range with no curve is linear and anchors at its own zero");
  assert.equal(renderer.zeroAnchor({ id: "x" }, {}, view), null,
    "a parameter that declares no range at all cannot be bipolar");

  // The anchor must agree with the reading on BOTH sources, not just the ABI
  // one. Only the ABI path composes the package skew; taking it on the package
  // fallback drew the tick at 0.785 where the parameter reads 0.57.
  for (const [label, parameter, anchorUi] of [
    ["package range, no skew", { id: "warp", plainRange: [-1, 1] }, {}],
    ["package range, declared skew", { id: "warp", plainRange: [-1, 1] }, { plainSkewByKey: { warp: 0.35 } }],
    ["package range, asymmetric", { id: "warp", plainRange: [-60, 12] }, { plainSkewByKey: { warp: 0.35 } }],
  ]) {
    const zero = renderer.zeroAnchor(parameter, anchorUi, view);
    assert.ok(zero !== null, `${label}: a range crossing zero must anchor`);
    assert.equal(Number(renderer.displayValue(parameter, zero, anchorUi, view)), 0,
      `${label}: the anchor must land where the parameter reads zero`);
  }

  // Clamping: a value outside 0..1 must not paint outside the track.
  const clamped = renderer.fillGeometry({ id: "x", plainRange: [-1, 1] }, 4, {}, view);
  assert.equal(clamped.to, 1, "an over-range value must clamp to the end of the track");
  assert.equal(clamped.from, 0.5, "and still fill from its own zero");

  globalThis.BRKTRKProductionEngineHost = savedHost;
  console.log("Sound bipolar controls fill from the parameter's own zero");
}

// --- the notch, the reset target and the section's colour -------------------
// A parameter's default is the second value a synth control has to show: the
// track marks it, a double-tap returns to it, and creation seeds from it. Three
// copies of the same fallback chain existed and would have drifted apart.
{
  assert.equal(renderer.defaultNormalized({ defaultNormalized: 0.25 }), 0.25);
  assert.equal(renderer.defaultNormalized({ normalized_default: 0.6 }), 0.6, "the snake_case spelling a package may use is honoured");
  assert.equal(renderer.defaultNormalized({ default: 0.4 }), 0.4);
  assert.equal(renderer.defaultNormalized({}), 0, "a parameter that declares no default sits at zero");
  assert.equal(renderer.defaultNormalized({ defaultNormalized: 4 }), 1, "a default outside 0..1 cannot point off the track");
  assert.equal(renderer.defaultNormalized(null), 0);
  // defaultNormalized wins over the other spellings, and normalizedValue still
  // prefers what the instrument actually stores.
  assert.equal(renderer.defaultNormalized({ defaultNormalized: 0.25, default: 0.9 }), 0.25);
  assert.equal(renderer.normalizedValue({ id: "x", defaultNormalized: 0.25 }, { parameterSnapshot: { x: 0.8 } }), 0.8);
  assert.equal(renderer.normalizedValue({ id: "x", defaultNormalized: 0.25 }, {}), 0.25,
    "with nothing stored the control sits on the engine's own default");

  // Colour is the engine's section metadata made visible. An engine that
  // declares no sections yields one unlabelled group and gets no accent: this
  // surface does not invent decoration for an engine that did not ask for one.
  const declared = [
    { key: "OSC", label: "SOURCE" },
    { key: "FLT", label: "FILTER" },
    { key: "ENV", label: "ENVELOPE" },
    { key: "AMP", label: "AMP" },
    { key: "EXTRA", label: "EXTRA" },
  ];
  const accents = declared.map((group, index) => renderer.sectionAccent(group, index));
  assert.deepEqual(accents.slice(0, 4), ["var(--cyan)", "var(--pink)", "var(--amber)", "var(--green)"],
    "sections take the existing palette in the order the engine declares them");
  assert.equal(accents[4], "var(--cyan)", "a fifth section wraps rather than inventing a new colour");
  assert.equal(renderer.sectionAccent({ key: "", label: null }, 0), null,
    "an engine that declares no sections gets no accent");
  assert.equal(renderer.sectionAccent(null, 0), null);

  console.log("Sound sections take the engine's own metadata as colour, and defaults have one definition");
}


// --- Wave 1 alpha: every engine parameter is a visible Instrument control --
// Alpha donor engines are allowed to move fast only if their full public ABI
// surface reaches the Web UI. A hidden parameter is a regression, not an
// acceptable implementation detail. Keep this host-owned and descriptor-driven.
{
  const savedHost = globalThis.BRKTRKProductionEngineHost;
  const wave1 = [
    {
      label: "Bogie",
      moduleId: "design.myldy.brk-bogie",
      engineId: "brk-bogie",
      title: "BRK BOGIE",
      packageSha256: "baa62656386541558344a0de8cc0399b53d6740a735440c1031fa50fe9d64d51",
      keys: ["model", "decay", "tone", "sweep", "noise", "fm", "drive", "level"],
      abiIds: [0x0100, 0x0101, 0x0102, 0x0103, 0x0104, 0x0105, 0x0200, 0x0201],
      modelValues: ["Kick", "Snare", "Hat", "Clap", "Tom", "Rim", "FM", "Noise", "Cowbell", "Cymbal", "Shaker", "Clave"],
    },
    {
      label: "MME",
      moduleId: "design.myldy.brk-mme",
      engineId: "brk-mme",
      title: "BRK MME",
      packageSha256: "32e590d606a860aed0bff536f12abb3132dd4eaa4400ffe0d88aa966ea4e520d",
      keys: ["model", "waves", "interval", "amount", "flow", "feedback", "shaper", "level"],
      abiIds: [0x0100, 0x0101, 0x0102, 0x0103, 0x0104, 0x0105, 0x0106, 0x0201],
      modelValues: ["Ring", "Fold", "Cross", "VPM", "Sync", "Logic", "Vocode"],
    },
    {
      label: "Sintered",
      moduleId: "design.myldy.brk-sintered",
      engineId: "brk-sintered",
      title: "BRK SINTERED",
      packageSha256: "2f402f6461c534def9aa8fdfae8117e24a7c99367c6c33c898a82c4b0ba01ba9",
      keys: ["model", "decay", "mod", "a", "b", "motion", "c", "level"],
      abiIds: [0x0100, 0x0101, 0x0102, 0x0103, 0x0104, 0x0105, 0x0106, 0x0201],
      modelValues: ["Knot", "Shard", "Burst", "Comb", "Logic", "Melt"],
    },
  ];

  const viewFor = (engine) => ({
    entry: {
      moduleId: engine.moduleId,
      engineId: engine.engineId,
      version: "0.1.0-alpha.2",
      channel: "preview",
      packageSha256: engine.packageSha256,
      hostContract: { id: "brktrk-synth-gateway-v1" },
      stateSchemaVersion: 65536,
    },
    parameters: engine.keys.map((id, index) => ({
      id,
      abiId: engine.abiIds[index],
      defaultNormalized: id === "level" ? 0.8 : id === "model" ? 0 : 0.5,
      type: id === "model" ? "enum" : "float",
      values: id === "model" ? engine.modelValues : undefined,
    })),
    ui: {
      title: engine.title,
      pages: [
        { id: "main", label: "Main", mode: "curated", controls: engine.keys },
        { id: "all", label: "All", mode: "all" },
      ],
    },
  });

  for (const engine of wave1) {
    const view = viewFor(engine);
    assert.deepEqual(
      renderer.pageControls(view, "main").controls.map((parameter) => parameter.id),
      engine.keys,
      `${engine.label} Main must show all 8/8 public parameters`,
    );
    assert.deepEqual(
      renderer.pageControls(view, "all").controls.map((parameter) => parameter.id),
      engine.keys,
      `${engine.label} All must show all 8/8 public parameters`,
    );

    const created = renderer.buildCreationInput(view, 5);
    assert.equal(created.engineRef.channel, "preview",
      `${engine.label} Instrument must persist its exact preview catalog channel`);
    assert.equal(created.engineRef.resolvedPackageSha256, engine.packageSha256,
      `${engine.label} Instrument must persist its exact qualified package identity`);
    assert.deepEqual(Object.keys(created.parameterSnapshot), engine.keys,
      `${engine.label} Instrument must seed a value for every visible parameter`);
  }

  const candidates = [
    ...wave1.map((engine) => ({
      entry: { ...viewFor(engine).entry },
      compatibility: { compatible: true, code: "compatible", reason: "ok" },
    })),
    {
      entry: { ...viewFor(wave1[0]).entry, engineId: "stable-fixture", channel: "stable", version: "1.0.0" },
      compatibility: { compatible: true, code: "compatible", reason: "ok" },
    },
  ];
  globalThis.BRKTRKProductionEngineHost = { catalogChannels: () => ["stable"] };
  assert.deepEqual(renderer.catalogEngineChoices(candidates).map((choice) => choice.label), ["STABLE FIXTURE"],
    "ordinary Sound picker must hide all Wave 1 preview engines");
  globalThis.BRKTRKProductionEngineHost = { catalogChannels: () => ["stable", "preview"] };
  assert.deepEqual(
    renderer.catalogEngineChoices(candidates).map((choice) => choice.label),
    ["BRK BOGIE", "BRK MME", "BRK SINTERED", "STABLE FIXTURE"],
    "preview Sound picker must offer all Wave 1 engines without losing stable ones",
  );

  globalThis.BRKTRKProductionEngineHost = savedHost;
  console.log("Wave 1 alpha exposes all 8/8 parameters and persists exact preview package identities");
}
