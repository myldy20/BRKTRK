const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const failures = [];
function check(name, body) {
  try { body(); }
  catch (error) { failures.push(`${name}: ${error.message}`); }
}

function classList() {
  const values = new Set();
  return {
    add(...names) { for (const name of names) values.add(name); },
    remove(...names) { for (const name of names) values.delete(name); },
    contains(name) { return values.has(name); },
    values,
  };
}

function cell() {
  return {
    textContent: "",
    title: "",
    classList: classList(),
    querySelector() { return null; },
    append() {},
  };
}

check("incremental Phrase renderer", () => {
  const cells = Array.from({ length: 6 }, cell);
  const row = {
    querySelector(selector) {
      const match = /data-col="(\d+)"/.exec(selector);
      return match ? cells[Number(match[1])] ?? null : null;
    },
  };

  globalThis.state = { phrase: 0 };
  globalThis.model = {
    phrases: {
      0: [{
        note: 48,
        velocity: 100,
        instrument: 7,
        fx: Array.from({ length: 3 }, () => ({ command: 0, value: 0 })),
      }],
    },
    instrumentPool: {},
  };
  globalThis.document = {
    querySelector(selector) {
      return selector.includes('data-row-pane="phrase"') ? row : null;
    },
  };
  globalThis.noteName = () => "C-3";
  globalThis.hex = (value) => Number(value).toString(16).padStart(2, "0").toUpperCase();
  globalThis.fxCommandCode = (slot) => Number(slot?.command ?? slot ?? 0);
  globalThis.fxValueByte = (slot) => Number(slot?.value ?? 0);
  globalThis.fxName = (slot) => Number(slot?.command ?? 0) === 0 ? "---" : "FX";
  globalThis.instrumentReferencePresentation = (instrumentId, pool) => {
    const id = Number(instrumentId);
    if (!Number.isInteger(id) || id < 0) return { state: "empty", text: "--", title: "Instrument unassigned" };
    if (pool && Object.hasOwn(pool, id)) return { state: "resolved", text: globalThis.hex(id), title: `Instrument ${globalThis.hex(id)}` };
    return { state: "unresolved", text: `?${globalThis.hex(id)}`, title: `Unresolved Instrument ${globalThis.hex(id)} — preserved from Project` };
  };

  const modulePath = require.resolve("./phrase-step-renderer.js");
  delete require.cache[modulePath];
  const renderer = require(modulePath);
  assert.equal(renderer.render(0, 0), true);
  assert.equal(cells[2].textContent, "?07", "incremental row render must retain the unresolved marker");
  assert.equal(cells[2].classList.contains("unresolved"), true, "incremental row render must retain unresolved semantic state");
  assert.match(cells[2].title, /Unresolved Instrument 07/, "incremental row render must retain the unresolved explanation");
});

check("instrumentPool invalidation wiring", () => {
  const source = fs.readFileSync(path.join(__dirname, "store-runtime-adapters.js"), "utf8");
  const match = /renderInstrumentContext:\s*\(\)\s*=>\s*\{([\s\S]*?)\n\s*\},\n\s*renderPreparedEntry:/.exec(source);
  assert.ok(match, "production instrument.context renderer wiring must remain explicit");
  assert.match(match[1], /renderPhrase\s*\(/, "instrumentPool changes must immediately rerender visible Phrase references");
  assert.match(match[1], /renderFocusState\s*\(/, "instrumentPool changes must immediately rerender focused reference breadcrumbs");
});

for (const key of ["state", "model", "document", "noteName", "hex", "fxCommandCode", "fxValueByte", "fxName", "instrumentReferencePresentation"]) {
  try { delete globalThis[key]; } catch {}
}

if (failures.length) {
  throw new Error(failures.join(" | "));
}
console.log("A5 incremental Instrument reference truth regressions passed");
