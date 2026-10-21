// #463: a live parameter write publishes a render change that reaches
// renderProjectMutation, the targeted path that repaints one control without a
// full surface render. It formatted its value without the package view, so a
// parameter the engine describes in dB was repainted as a percentage the
// instant the store render landed - the input handler's correct reading was
// overwritten by the fallback on every drag, undo and external change.
//
// The path had no coverage at all: `state` is a script-scope binding from
// app-model.js, so the module cannot be require()d with it in place. That gap
// is why the regression reached a PR. This loads the real source into a vm
// with the bindings the browser gives it.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");

function elementStub(tag, attributes = {}) {
  // A real element always carries a style map, and the targeted path writes the
  // row's fill through it. Without one here the repaint would move the number
  // and leave the bar behind - the same class of bug this file exists for.
  const styleProperties = new Map();
  return {
    tagName: String(tag).toUpperCase(),
    attributes: { ...attributes },
    dataset: {},
    children: [],
    value: "",
    textContent: "",
    style: {
      setProperty(name, value) { styleProperties.set(name, String(value)); },
      removeProperty(name) { styleProperties.delete(name); },
      getPropertyValue(name) { return styleProperties.get(name) ?? ""; },
    },
    getAttribute(name) { return this.attributes[name] ?? null; },
    append(...nodes) { this.children.push(...nodes); },
    querySelector(selector) {
      for (const child of this.children) {
        if (selector === 'input[type="range"]' && child.tagName === "INPUT") return child;
        if (selector === "select" && child.tagName === "SELECT") return child;
        if (selector === "output" && child.tagName === "OUTPUT") return child;
      }
      return null;
    },
  };
}

function harness({ parameter, ui, descriptors }) {
  const output = elementStub("output");
  const input = elementStub("input");
  const card = elementStub("section");
  card.append(input, output);
  const body = elementStub("body");
  const entry = { moduleId: "design.myldy.brk-modal", engineId: "brk-modal", version: "1.2.0", packageSha256: "d".repeat(64) };

  const sandbox = {
    state: { instrument: 0 },
    console,
    CSS: { escape: (value) => String(value) },
    // initialize() is queued in a microtask in the browser; the targeted path
    // does not need it and a full surface render is not what this covers.
    queueMicrotask() {},
    document: {
      body,
      querySelector(selector) { return selector.includes("data-production-param") ? card : null; },
    },
    BRKTRKStores: {
      project: { getState: () => ({ instrumentPool: [{ engineRef: entry }] }) },
    },
    BRKTRKProductionEngineHost: {
      // The real host returns entry and ui alongside the parameter.
      interactionFor: () => ({ parameter, entry, ui, policy: "parameter-ramp", smoothingMs: 0, discrete: false }),
      abiDescriptorsFor: () => descriptors,
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(readFileSync(require.resolve("./sound-edit-renderer.js"), "utf8"), sandbox, {
    filename: "sound-edit-renderer.js",
  });
  return { api: sandbox.BRKTRKSoundEditRenderer, output, input, card, body };
}

const changeSet = (value) => ({ path: ["instrumentPool", 0, "parameterSnapshot", "output_gain"], after: value });

// A parameter the engine describes in dB must repaint in dB.
{
  const h = harness({
    parameter: { id: "output_gain" },
    ui: {},
    descriptors: { parameters: [{ key: "output_gain", unit: "dB", plainMin: -60, plainMax: 12, plainStep: 0 }] },
  });
  const result = h.api.renderProjectMutation(changeSet(0.5));
  assert.ok(result, "the targeted path must handle a production parameter change");
  assert.equal(h.output.textContent, "-24.0 dB",
    "a targeted repaint must format exactly as the full render does, not fall back to a percentage");
  assert.notEqual(h.output.textContent, "50%",
    "the store render must not overwrite the engine's own reading with a percentage");
  assert.equal(h.input.value, "0.5", "the range input must follow the committed value");
  // The bar has to follow the number. A repaint that moves only the reading
  // leaves the row showing the previous value at full size.
  // -60..+12 dB crosses zero, so -24 dB fills from the value back to 0 dB.
  assert.equal(h.card.dataset.bipolar, "true");
  assert.equal(h.input.style.getPropertyValue("--a4a-fill-from"), "50.000%",
    "a targeted repaint must redraw the fill, not only the reading");
  assert.equal(h.input.style.getPropertyValue("--a4a-fill-to"), "83.333%",
    "a negative reading fills back to its own zero, not from the left edge");
  assert.equal(h.body.dataset.targetedProductionSoundParameterRenders, "1");
}

// A parameter whose range crosses zero must repaint as bipolar through the
// targeted path too, anchored where its own zero actually sits.
{
  const h = harness({
    parameter: { id: "output_gain" },
    ui: {},
    descriptors: { parameters: [{ key: "output_gain", unit: "dB", plainMin: -60, plainMax: 12, plainStep: 0 }] },
  });
  h.api.renderProjectMutation(changeSet(1));
  assert.equal(h.card.dataset.bipolar, "true", "a range crossing zero must repaint as bipolar");
  assert.equal(h.input.style.getPropertyValue("--a4a-fill-zero"), "83.333%",
    "zero sits where 0 dB is, not at the middle of the track");
  assert.equal(h.input.style.getPropertyValue("--a4a-fill-from"), "83.333%");
  assert.equal(h.input.style.getPropertyValue("--a4a-fill-to"), "100.000%",
    "a positive value fills from its own zero to the value");
}

// The UI profile reaches the targeted path too: a declared skew changes the
// reading, and ignoring it would make the repaint disagree with the control
// the operator is holding.
{
  const descriptors = { parameters: [{ key: "output_gain", unit: "Hz", plainMin: 30, plainMax: 18000, plainStep: 0 }] };
  const plain = harness({ parameter: { id: "output_gain" }, ui: {}, descriptors });
  plain.api.renderProjectMutation(changeSet(0.5));
  const skewed = harness({
    parameter: { id: "output_gain" },
    ui: { plainSkewByKey: { output_gain: 0.35 } },
    descriptors,
  });
  skewed.api.renderProjectMutation(changeSet(0.5));
  assert.equal(plain.output.textContent, "9015 Hz");
  assert.notEqual(skewed.output.textContent, plain.output.textContent,
    "a declared skew must reach the targeted repaint, not only the full render");
}

// An engine that never described itself keeps the package reading here too.
{
  const h = harness({
    parameter: { id: "output_gain", plainRange: [1, 4000], plainCurve: "exponential", plainScales: [{ divide: 1, decimals: 0, unit: "ms" }] },
    ui: {},
    descriptors: null,
  });
  h.api.renderProjectMutation(changeSet(0.5));
  assert.equal(h.output.textContent, "63 ms",
    "without descriptors the targeted path must still use the package descriptor");
}

console.log("Targeted Sound parameter repaint formats through the package view");
