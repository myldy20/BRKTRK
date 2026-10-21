const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");

const source = readFileSync("web/mixer-transport-safety.js", "utf8");
const loader = readFileSync("web/app-bind.js", "utf8");
const indexHtml = readFileSync("web/index.html", "utf8");
const serviceWorker = readFileSync("web/sw.js", "utf8");

for (const required of [
  "cloneNode(true)",
  "safe.disabled = true",
  'dataset.routingState = "quarantined"',
  "currentAppliedScope",
  "currentRequestedScope",
  "currentQueuedScope",
  "attachTransportStore",
  "releaseToTrackMixer",
  "isReleased: () => released",
  'dataset.routingState = "track-owned-pending-render"',
  "if (!existing.isReleased?.()) existing.quarantineMixer?.()",
  "RUNNING ${applied.toUpperCase()}",
  "QUEUED ${queued.toUpperCase()}",
  "NEXT ${selectedScopeLabel()}",
  'dataset.mixerRoutingSafety = "quarantined-track-routing"',
]) {
  assert.ok(source.includes(required), `Mixer safety contract is missing: ${required}`);
}

for (const forbidden of [
  "model.instruments[",
  "channelInstrument.volume =",
  "persist();",
  "audio.updatePlan",
  "audio.updateSequence",
]) {
  assert.ok(!source.includes(forbidden), `Mixer safety layer must not own project/audio mutation: ${forbidden}`);
}

const scriptOrder = (name) => indexHtml.indexOf(`<script src="./${name}`);
const renderIndex = scriptOrder("app-render.js");
const safetyIndex = scriptOrder("mixer-transport-safety.js");
const bindingIndex = scriptOrder("app-bind.js");
assert.ok(renderIndex >= 0 && safetyIndex > renderIndex && bindingIndex > safetyIndex,
  "Mixer safety must bootstrap after render definitions and before app binding/initial render");
assert.equal(indexHtml.match(/<script src="\.\/mixer-transport-safety\.js(?:\?[^\"]*)?"><\/script>/g)?.length, 1,
  "static shell must include exactly one early Mixer safety bootstrap");

const i1Transport = loader.indexOf('"./i1-transport.js"');
const lateSafety = loader.indexOf('"./mixer-transport-safety.js"');
const lifecycleUi = loader.indexOf('"./audio-lifecycle-ui.js"');
const trackDomain = loader.indexOf('"./track-mix-domain.js"');
const trackRuntime = loader.indexOf('"./track-mix-runtime.js"');
const trackMixer = loader.indexOf('"./track-mixer.js"');
assert.ok(
  i1Transport >= 0
    && lateSafety > i1Transport
    && lifecycleUi > lateSafety
    && trackDomain > lifecycleUi
    && trackRuntime > trackDomain
    && trackMixer > trackRuntime,
  "lifecycle-first runtime must keep the late quarantine hook before the final Track Mixer handoff",
);

for (const moduleName of ["track-mix-domain.js", "track-mix-runtime.js", "track-mixer.js"]) {
  assert.ok(loader.includes(`"./${moduleName}"`), `${moduleName} must load in the late runtime`);
  assert.ok(serviceWorker.includes(`"./${moduleName}"`), `${moduleName} must be cached for PWA/offline use`);
}
assert.ok(serviceWorker.includes('"./mixer-transport-safety.js"'),
  "early safety quarantine and released late hook must remain cached for PWA/offline use");

console.log("Mixer quarantine-to-Track-bus handoff tests passed");
