const assert = require("node:assert/strict");
const domain = require("./output-latency-domain.js");

// The owner's own numbers from the 2026-09-21 physical report (#496 item 7).
// Tempo was exact to three parts per million; this is what actually made the
// tracker feel late, and nothing in the product said so.
{
  const reading = domain.outputLatencyReading({ baseLatency: 0.0058, outputLatency: 0.192 });
  assert.equal(reading.known, true);
  assert.equal(reading.partial, false);
  assert.equal(reading.totalMs, 198, "the reading is the whole output path, not one of its two terms");
  assert.equal(reading.band, "late");
  assert.equal(domain.outputLatencyLabel(reading), "198 MS");
  assert.match(domain.outputLatencyNote(reading), /WIRED OUTPUT IS USUALLY UNDER 30 MS/,
    "a late reading must say what a healthy one looks like, or the number cannot be acted on");
}

// A wired output on the same machine.
{
  const reading = domain.outputLatencyReading({ baseLatency: 0.0058, outputLatency: 0.0104 });
  assert.equal(reading.totalMs, 16);
  assert.equal(reading.band, "ok");
  assert.equal(domain.outputLatencyNote(reading), "WHAT YOU HEAR ARRIVES THIS LATE");
}

// The band follows the number on screen, not the raw seconds behind it: a
// reading displayed as 30 MS that was flagged late would be arguing with
// itself. Exactly on the threshold is not late.
{
  assert.equal(domain.outputLatencyReading({ baseLatency: 0, outputLatency: 0.03 }).band, "ok");
  assert.equal(domain.outputLatencyReading({ baseLatency: 0, outputLatency: 0.0301 }).band, "ok",
    "30.1 ms is shown as 30 MS, so it must be banded as the 30 MS it displays");
  assert.equal(domain.outputLatencyReading({ baseLatency: 0, outputLatency: 0.0305 }).band, "late",
    "once it rounds to 31 MS it is past the threshold and says so");
  assert.equal(domain.LATE_MS, 30);
}

// Safari implements baseLatency and not outputLatency. Half a reading is still
// worth stating, but it must not be presented as the whole output path.
{
  const reading = domain.outputLatencyReading({ baseLatency: 0.0058 });
  assert.equal(reading.known, true);
  assert.equal(reading.partial, true);
  assert.equal(reading.outputMs, null);
  assert.equal(domain.outputLatencyLabel(reading), "≥6 MS", "a partial reading must read as a floor, not a total");
  assert.match(domain.outputLatencyNote(reading), /ONLY THE GRAPH'S OWN LATENCY/);
}

// No context at all, and contexts that report nonsense.
for (const context of [null, undefined, {}, { baseLatency: null, outputLatency: undefined }, { baseLatency: NaN, outputLatency: Infinity }, { baseLatency: -1, outputLatency: -2 }]) {
  const reading = domain.outputLatencyReading(context);
  assert.equal(reading.known, false, `unusable context must not produce a reading: ${JSON.stringify(context)}`);
  assert.equal(reading.band, "unknown");
  assert.equal(domain.outputLatencyLabel(reading), "—");
  assert.equal(domain.outputLatencyNote(reading), "START AUDIO TO MEASURE THE OUTPUT PATH");
}

// A reading is a measurement, so it is frozen like every other domain value.
{
  const reading = domain.outputLatencyReading({ baseLatency: 0.01 });
  assert.equal(Object.isFrozen(reading), true);
  reading.totalMs = 999;
  assert.equal(reading.totalMs, 10, "a reading must not be editable by whatever is displaying it");
}

console.log("Output latency reading domain tests passed");
