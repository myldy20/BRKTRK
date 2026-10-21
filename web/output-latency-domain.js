(() => {
  "use strict";

  // Owner physical report 2026-09-21 (#496 item 7): the tracker "felt slow".
  // The tempo was exact to three parts per million; the device was reporting
  // 192 ms of output latency, which is Bluetooth-class. Tempo and latency are
  // different facts and only one of them was visible anywhere, so the musician
  // had no way to tell them apart. This turns the reading the AudioContext
  // already publishes into something the surface can state.

  // Under this, output is close enough to the gesture that playing along works.
  // Above it, everything arrives late enough to be felt, and a play-along test
  // says more about the output path than about BRKTRK.
  const LATE_MS = 30;

  const finite = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);

  // baseLatency is what the graph adds; outputLatency is what the device adds
  // on top and is the larger term by far on a wireless output. Safari does not
  // implement outputLatency, so a reading can be real and still incomplete -
  // that is reported as partial rather than rounded up into a total that would
  // read as the whole truth.
  function outputLatencyReading(context) {
    const base = finite(context?.baseLatency);
    const output = finite(context?.outputLatency);
    if (base === null && output === null) {
      return Object.freeze({ known: false, partial: false, totalMs: null, band: "unknown", baseMs: null, outputMs: null });
    }
    const totalSeconds = (base ?? 0) + (output ?? 0);
    const totalMs = Math.round(totalSeconds * 1000);
    return Object.freeze({
      known: true,
      partial: output === null,
      totalMs,
      band: totalMs > LATE_MS ? "late" : "ok",
      baseMs: base === null ? null : Math.round(base * 10000) / 10,
      outputMs: output === null ? null : Math.round(output * 10000) / 10,
    });
  }

  function outputLatencyLabel(reading) {
    if (!reading?.known) return "—";
    return `${reading.partial ? "≥" : ""}${reading.totalMs} MS`;
  }

  function outputLatencyNote(reading) {
    if (!reading?.known) return "START AUDIO TO MEASURE THE OUTPUT PATH";
    if (reading.partial) return "THIS BROWSER REPORTS ONLY THE GRAPH'S OWN LATENCY, NOT THE DEVICE'S";
    if (reading.band === "late") return "WHAT YOU HEAR ARRIVES THIS LATE · WIRED OUTPUT IS USUALLY UNDER 30 MS, BLUETOOTH OFTEN 150-250";
    return "WHAT YOU HEAR ARRIVES THIS LATE";
  }

  const api = Object.freeze({ LATE_MS, outputLatencyReading, outputLatencyLabel, outputLatencyNote });
  globalThis.BRKTRKOutputLatencyDomain = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
