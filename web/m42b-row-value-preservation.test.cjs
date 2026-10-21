const assert = require("node:assert/strict");
const storeTypes = require("./stores.js");
const phraseStepTypes = require("./project-phrase-step.js");

const empty = () => ({
  note: -1,
  velocity: 100,
  instrument: -1,
  fx: [{ command: 0, value: 0 }, { command: 0, value: 0 }, { command: 0, value: 0 }],
});
const source = {
  note: 61,
  velocity: 113,
  instrument: 0xFE,
  fx: [
    { command: 0xE7, value: 0xC4 },
    { command: 5, value: 0x60 },
    { command: 4, value: 0x08 },
  ],
  condition: { probability: 73, every: 4, offset: 2 },
  parameterEvents: [],
};
const model = {
  schemaVersion: 2,
  projectName: "M42B BYTE PRESERVATION",
  tempo: 120,
  song: Array.from({ length: 64 }, () => Array(8).fill(-1)),
  chains: {},
  phrases: { 0: Array.from({ length: 16 }, (_, row) => row === 0 ? structuredClone(source) : empty()) },
  instruments: Array.from({ length: 16 }, (_, id) => ({ id })),
};
const store = new storeTypes.ProjectStore(model, { trackCount: 8 });
const domain = phraseStepTypes.install(store);

const copied = domain.read(0, 0);
assert.deepEqual(copied, source, "full-row reads must preserve stored Instrument/FX bytes even beyond the current preview Instrument pool");
domain.replaceRows(0, 1, [copied], { source: "m42b-byte-preservation" });
assert.deepEqual(domain.read(0, 1), source, "full-row replacement must preserve Instrument 00-FF and compound FX bytes without pool clamping");

console.log("M4.2B full stored Phrase-row byte preservation test passed");
