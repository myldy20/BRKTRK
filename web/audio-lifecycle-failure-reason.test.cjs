// An audio readiness failure used to reach the screen as "AUDIO ERROR · RETRY"
// and nothing else, while its reason - for an engine that cannot register,
// "<engine>@<version> could not start in the AudioWorklet: <engine's own
// words>" - stayed in the console and the debug JSON. This drives
// audio-lifecycle-ui.js against minimal DOM/Store stubs and checks that a new
// failure interrupts the status line once with its reason, that the chip's
// title carries it, and that recovery hands the line back to readiness.

const assert = require("node:assert/strict");

function element(tag = "div") {
  const attributes = new Map();
  const children = new Map();
  return {
    tagName: tag.toUpperCase(),
    textContent: "",
    title: "",
    style: {},
    dataset: {},
    tabIndex: -1,
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    removeAttribute(name) { attributes.delete(name); },
    addEventListener() {},
    querySelector(selector) { return children.get(selector) ?? null; },
    withChild(selector, child) { children.set(selector, child); return this; },
  };
}

const statusLine = element();
statusLine.textContent = "READY · AUDIO DISABLED";
const chipDetail = element("small");
const bootButton = element("button").withChild("small", chipDetail);
const nodes = new Map([["#statusLine", statusLine], ["#bootButton", bootButton]]);

globalThis.window = { matchMedia: () => ({ matches: false, addEventListener() {} }) };
globalThis.document = {
  querySelector: (selector) => nodes.get(selector) ?? null,
  createElement: (tag) => element(tag),
  head: { append() {} },
  body: { dataset: {} },
};

let terminalError = null;
let lifecycleState = { status: "disabled", contextState: "none", visibility: "visible", pageHidden: false, persistedRestore: false, error: null };
globalThis.BRKTRKAudioLifecycle = { snapshot: () => lifecycleState };
globalThis.BRKTRKAudioReadiness = { snapshot: () => ({ ready: lifecycleState.status === "ready" && !terminalError, terminalError }) };
globalThis.BRKTRKStores = {
  transport: {
    runtime: { snapshot: () => ({ requested: null, applied: null, stopRequest: null }) },
    subscribe() {},
  },
  project: { getState: () => ({ instrumentPool: { 0: { engineRef: { moduleId: "m", engineId: "e" } } } }), subscribe() {} },
  navigation: { captureContext: () => ({ instrument: 0 }), subscribe() {} },
};
globalThis.BRKTRKRenderRuntime = { registerAfterTransport() {} };
globalThis.BRKTRKProductionEngineBootstrap = { isWorkletReady: () => lifecycleState.status === "ready" };

require("./audio-lifecycle-ui.js");
const ui = globalThis.BRKTRKAudioLifecycleUI;
assert.ok(ui?.render && ui.describeReadiness, "the lifecycle UI must install");

const reason = "design.myldy.test/engine@1.0.0 could not start in the AudioWorklet: runtime reports ABI 131072, expected 65536";

{
  const described = ui.describeReadiness({ status: "error", error: `Error: ${reason}` }, {});
  assert.equal(described.label, "AUDIO ERROR · RETRY", "the chip label stays short");
  assert.equal(described.reason, reason, "the reason keeps the failure's own words without the Error: prefix");
  assert.equal(ui.describeReadiness({ status: "error", error: "x".repeat(400) }, {}).reason.length, 160, "a runaway reason is bounded");
  assert.equal(ui.describeReadiness({ status: "error", error: "  " }, {}).reason, null);
  assert.equal(ui.describeReadiness({ status: "ready" }, { canonicalReady: true, workletReady: true, hasProductionInstrument: true }).reason, undefined);
}

// Something the musician did last is on the status line when audio fails.
statusLine.textContent = "DOCK SOUND";
lifecycleState = { ...lifecycleState, status: "error", error: `Error: ${reason}` };
ui.render();
assert.equal(statusLine.textContent, `AUDIO ERROR · ${reason}`, "a new failure interrupts the status line with its reason");
assert.equal(statusLine.style.color, "var(--danger)");
assert.match(bootButton.title, /^AUDIO ERROR · RETRY — design\.myldy\.test\/engine@1\.0\.0 could not start/, "the chip's title carries the reason");
assert.equal(chipDetail.textContent, "AUDIO ERROR · RETRY");

// Announced once: a later action is not overwritten by the same failure.
statusLine.textContent = "DOCK MIX";
ui.render();
assert.equal(statusLine.textContent, "DOCK MIX", "the same failure is not announced twice");

// A different failure is news.
lifecycleState = { ...lifecycleState, error: "AudioWorklet did not acknowledge 1 exact active production package within 4000ms" };
ui.render();
assert.equal(statusLine.textContent, "AUDIO ERROR · AudioWorklet did not acknowledge 1 exact active production package within 4000ms");

// Renders while the same failure lasts (transport or navigation changes) must
// leave the announced text as the thing recovery replaces.
ui.render();
ui.render();
assert.equal(
  statusLine.textContent,
  "AUDIO ERROR · AudioWorklet did not acknowledge 1 exact active production package within 4000ms",
  "the reason stays on the line while the failure lasts instead of collapsing to the generic label",
);

// Recovery hands the line back to the ordinary readiness projection.
lifecycleState = { ...lifecycleState, status: "ready", error: null, contextState: "running" };
ui.render();
assert.equal(statusLine.textContent, "PLAYABLE · READY", "recovery replaces the failure text");
assert.equal(bootButton.title.includes("—"), false, "a healthy chip carries no failure reason");

// And the next failure after a recovery is announced again, even if it repeats.
statusLine.textContent = "DOCK SOUND";
lifecycleState = { ...lifecycleState, status: "error", error: reason };
ui.render();
assert.equal(statusLine.textContent, `AUDIO ERROR · ${reason}`);

terminalError = "processor crashed; reload BRKTRK to restore audio";
lifecycleState = { ...lifecycleState, status: "error", error: terminalError };
ui.render();
assert.equal(chipDetail.textContent, "AUDIO STOPPED · RELOAD APP", "terminal failures cannot offer Retry");
assert.equal(bootButton.disabled, true, "the dead node cannot be retried through the audio button");
assert.match(bootButton.title, /RELOAD APP.*reload BRKTRK/);
assert.match(statusLine.textContent, /reload BRKTRK/, "the failure line must keep the recovery action");

console.log("Audio lifecycle failure-reason projection tests passed");
