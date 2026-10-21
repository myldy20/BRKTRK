"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const handlers = new Map();
const events = [];
const runtime = { activeWorkspace: "sound" };
const state = { p3: { activeWorkspace: "sound", soundParam: 0 }, focus: { pane: "phrase", row: 0, col: 0 }, phrase: 0 };
const cell = { dataset: { pane: "phrase", row: "1", col: "2" } };
const commands = {
  installed: true,
  runtime,
  stores: { navigation: { entryState: {} } },
  subscribe() {},
  dispatch(command) {
    events.push(command);
    if (command.type === "workspace.select") {
      runtime.activeWorkspace = command.workspace;
      state.p3.activeWorkspace = command.workspace;
    }
    if (command.type === "cursor.select") state.focus = { pane: command.pane, row: command.row, col: command.col };
    return { ok: true };
  },
};
const sandbox = {
  console, state, BRKTRKCommands: commands,
  heldKeys: new Set(),
  window: { matchMedia: () => ({ matches: false }) },
  document: { addEventListener(type, fn) { handlers.set(type, fn); }, body: { dataset: {} } },
  requestAnimationFrame() {},
  $: () => null,
  $$: () => [],
};
sandbox.globalThis = sandbox;
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "command-bindings.js"), "utf8"), sandbox);
const click = handlers.get("click");
assert.equal(typeof click, "function");

function pointerClick() {
  click({
    target: { closest(selector) { return selector === "[data-pane][data-row][data-col]" ? cell : null; } },
    preventDefault() {}, stopImmediatePropagation() {},
  });
}

(async () => {
  click({
    target: { closest(selector) { return selector === "#utilityPanels [data-panel]" ? { dataset: { panel: "sound" } } : null; } },
    preventDefault() {}, stopImmediatePropagation() {},
  });
  assert.equal(events[0].type, "dock.toggle");
  assert.equal(events[0].dock, "sound");
  events.length = 0;
  pointerClick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.map((event) => event.type), ["workspace.select", "cursor.select"]);
  assert.equal(runtime.activeWorkspace, "phrase");
  assert.deepEqual(state.focus, { pane: "phrase", row: 1, col: 2 });
  events.length = 0;
  pointerClick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.map((event) => event.type), ["cursor.select"]);

  // Native enum and range controls must still receive clicks; the old card
  // selector was dead, so reviving it must not swallow their default action.
  for (const control of ["select", "input"]) {
    let prevented = false;
    click({
      target: { closest(selector) {
        if (selector === "#instrumentInspector .a4a-param, #instrumentInspector .parameter-card") return { dataset: {} };
        if (selector === "input, select, button") return control;
        return null;
      } },
      preventDefault() { prevented = true; }, stopImmediatePropagation() {},
    });
    assert.equal(prevented, false, `${control} keeps its native click`);
  }
  console.log("Pointer selection restores tracker workspace before cursor selection");
})().catch((error) => { console.error(error); process.exitCode = 1; });
