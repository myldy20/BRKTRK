const assert = require("node:assert/strict");
require("./timing-domain.js");
require("./phrase-fx-domain.js");
const runtime = require("./phrase-fx-runtime-domain.js");

assert.equal(runtime.RUNTIME_VERSION, 1);
assert.deepEqual(runtime.COMMAND, { CUT: 0x01, DELAY: 0x04, RETRIGGER: 0x05 });

{
  const analysis = runtime.analyze([
    { command: 0x04, value: 0x04 },
    { command: 0x01, value: 0x02 },
    { command: 0x05, value: 0x30 },
  ]);
  assert.equal(analysis.delayTicks, 4);
  assert.deepEqual(analysis.cuts, [{ lane: 1, ticks: 2 }]);
  assert.deepEqual(analysis.retriggers, [{ lane: 2, ticks: 3, value: 0x30 }]);
  assert.deepEqual(analysis.inert, []);
}

{
  const compiled = runtime.compileTiming([
    { command: 0x04, value: 0x04 },
    { command: 0x01, value: 0x02 },
    { command: 0x05, value: 0x30 },
  ], { frame: 100, sampleRate: 48000, ppqn: 24, tempo: 120 });
  assert.equal(compiled.executionFrame, 4100, "24 PPQN at 120 BPM/48 kHz is exactly 1000 frames per tick");
  assert.equal(compiled.cuts[0].frame, 6100, "CUT is relative to the delayed row execution frame");
  assert.equal(compiled.retriggers[0].frame, 7100, "single RET X0 is relative to delayed row execution");
}

{
  const compiled = runtime.compileTiming([{ command: 0x01, value: 0x03 }], {
    frame: 0,
    sampleRate: 48000,
    ppqn: 48,
    tempo: 120,
  });
  assert.equal(compiled.cuts[0].frame, 1500, "FX tick timing must follow the active row PPQN rather than a private 24 PPQN clock");
}

{
  const analysis = runtime.analyze([
    { command: 0x05, value: 0x31 },
    { command: 0xA7, value: 0x22 },
  ]);
  assert.deepEqual(analysis.retriggers, []);
  assert.deepEqual(analysis.inert.map((entry) => entry.kind), ["retrigger-ramp-unresolved", "unknown-command"]);
  assert.equal(analysis.inert[0].value, 0x31);
  assert.equal(analysis.inert[1].command, 0xA7);
}

assert.throws(() => runtime.analyze([
  { command: 0x04, value: 1 },
  { command: 0x04, value: 2 },
]), /more than one DELAY/);

console.log("M4.1C host-timed Phrase FX runtime-domain tests passed");
