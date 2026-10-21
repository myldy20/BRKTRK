const assert = require("node:assert/strict");
const storeTypes = require("./stores.js");
const trackMixTypes = require("./track-mix-domain.js");

const model = {
  projectName: "TEST",
  tempo: 120,
  song: [],
  chains: {},
  phrases: {},
  instruments: [
    { name: "INST 00", volume: 0.22, pan: 0.35, mute: false },
    { name: "INST 01", volume: 0.18, pan: -0.4, mute: true },
  ],
};
const state = {
  view: "phrase",
  dock: "mix",
  focus: { pane: "phrase", row: 0, col: 0 },
  p3: {},
};
const stores = storeTypes.createStores({ model, state, trackCount: 8 });
const domain = trackMixTypes.install(stores.project, { trackCount: 8 });

assert.equal(domain.snapshot().length, 8);
assert.deepEqual({ ...domain.get(0) }, { gain: 1, mute: false, pan: 0 });
assert.deepEqual({ ...domain.get(7) }, { gain: 1, mute: false, pan: 0 });
assert.deepEqual(model.tracks.map((track) => track.id), [0, 1, 2, 3, 4, 5, 6, 7]);

const instrumentBefore = JSON.stringify(model.instruments);
const events = [];
for (const channel of ["project", "persistence", "track-mix", "render"]) {
  stores.project.subscribe(channel, (changeSet) => events.push({ channel, changeSet }));
}

const first = stores.project.setTrackMix(1, { gain: 0.42, mute: true, pan: -0.65 }, {
  source: "domain-test",
  field: "all",
});
assert.equal(first.mutated, true);
assert.deepEqual({ ...first.after }, { gain: 0.42, mute: true, pan: -0.65 });
assert.deepEqual({ ...model.tracks[1].mix }, { gain: 0.42, mute: true, pan: -0.65 });
assert.equal(JSON.stringify(model.instruments), instrumentBefore, "Track mix must not mutate Instrument patches");
assert.equal(first.changeSet.affectsPlayback, false, "Track mix must not request a structural playback refresh");
assert.equal(first.changeSet.persistsProject, true);
assert.equal(first.changeSet.target, "project.tracks.1.mix");
assert.deepEqual(Array.from(first.changeSet.path), ["tracks", 1, "mix"]);
assert.deepEqual(events.map((entry) => entry.channel), ["persistence", "track-mix"]);
assert.equal(events.some((entry) => entry.channel === "project"), false,
  "Track mix must not reach broad project compatibility subscribers");
assert.equal(events.some((entry) => entry.channel === "render"), false,
  "Track mix must not trigger broad render replacement during a trusted drag");

const clamped = stores.project.setTrackMix(1, { gain: 3, pan: -4, mute: false }, { source: "clamp-test" });
assert.deepEqual({ ...clamped.after }, { gain: 1, mute: false, pan: -1 });
const unchanged = stores.project.setTrackMix(1, { gain: 1, mute: false, pan: -1 }, { source: "same-test" });
assert.equal(unchanged.mutated, false);

assert.throws(() => stores.project.setTrackMix(-1, { gain: 0.5 }), RangeError);
assert.throws(() => stores.project.setTrackMix(8, { gain: 0.5 }), RangeError);
assert.throws(() => stores.project.setTrackMix(0, null), TypeError);

console.log("Project-owned Track mix domain tests passed");
