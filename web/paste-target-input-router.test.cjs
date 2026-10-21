const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(require.resolve("./paste-target-input-router.js"), "utf8");

function makeHarness({ pane = "song", armed = true, available = true, movePending = false, phone = false } = {}) {
  let clickHandler = null;
  let commandHandler = null;
  const retargets = [];
  const cancels = [];
  const controller = {
    snapshot: () => ({ pasteTarget: { armed, movePending } }),
    getClipboardMetadata: () => ({ available, pane }),
    retargetPasteTarget: async (target, sourceName) => {
      retargets.push({ target: { ...target }, sourceName });
      return true;
    },
    cancelSelection(sourceName) {
      cancels.push(sourceName);
      return { ok: true };
    },
  };
  const commands = {
    runtime: { trackerCursor: { pane, row: 0, col: 0 } },
    subscribe(handler) {
      commandHandler = handler;
      return () => { commandHandler = null; };
    },
  };
  const document = {
    addEventListener(type, handler, capture) {
      if (type === "click") {
        assert.equal(capture, true);
        clickHandler = handler;
      }
    },
    removeEventListener() {},
  };
  const globalThis = {
    BRKTRKSelectionClipboard: controller,
    BRKTRKCommands: commands,
    matchMedia: () => ({ matches: phone }),
  };
  const context = { globalThis, document, console };
  vm.runInNewContext(source, context, { filename: "paste-target-input-router.js" });
  assert.ok(clickHandler, "router did not register capture click handler");
  assert.ok(commandHandler, "router did not subscribe to semantic command records");
  return {
    clickHandler,
    retargets,
    cancels,
    context,
    setCursor(nextPane, row, col) {
      commands.runtime.trackerCursor = { pane: nextPane, row, col };
    },
    emitCommand(command, ok = true) {
      commandHandler?.({ command, ok });
    },
  };
}

function eventFor(targetPane, row = 4, col = 2, overrides = {}) {
  let prevented = false;
  let stopped = false;
  const cell = { dataset: { pane: targetPane, row: String(row), col: String(col) } };
  return {
    button: 0,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    defaultPrevented: false,
    target: { closest: (selector) => selector === "[data-pane][data-row][data-col]" ? cell : null },
    preventDefault() { prevented = true; },
    stopImmediatePropagation() { stopped = true; },
    get prevented() { return prevented; },
    get stopped() { return stopped; },
    ...overrides,
  };
}

async function settle() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

(async () => {
  for (const pane of ["song", "chain", "phrase"]) {
    const harness = makeHarness({ pane });
    const col = pane === "song" ? 2 : 0;
    const event = eventFor(pane, 4, col);
    harness.clickHandler(event);
    await settle();
    assert.equal(event.prevented, true, `${pane} pointer target was not consumed`);
    assert.equal(event.stopped, true, `${pane} pointer target did not stop ordinary pointer navigation`);
    assert.equal(harness.retargets.length, 1, `${pane} pointer target was not delegated exactly once`);
    assert.equal(harness.retargets[0].sourceName, "pointer-cell-precommand-router");
    assert.equal(harness.retargets[0].target.pane, pane);
    assert.equal(harness.retargets[0].target.row, 4);
    assert.equal(harness.retargets[0].target.col, col);
    assert.equal(harness.cancels.length, 0, `${pane} pointer route must retain explicit destination selection`);
  }

  for (const pane of ["song", "chain", "phrase"]) {
    const harness = makeHarness({ pane });
    const col = pane === "song" ? 3 : 0;
    harness.setCursor(pane, 6, col);
    harness.emitCommand({ type: "cursor.move", source: "keyboard", direction: "ArrowDown" });
    await settle();
    assert.deepEqual(harness.cancels, ["keyboard-paste-target-cursor-moved"], `${pane} desktop cursor move must clear stale source selection exactly once`);
    assert.equal(harness.retargets.length, 0, `${pane} desktop post-command route must not redispatch cursor.select`);
  }

  {
    const harness = makeHarness({ pane: "phrase", phone: true });
    harness.setCursor("phrase", 6, 0);
    harness.emitCommand({ type: "cursor.move", source: "keyboard", direction: "ArrowDown" });
    await settle();
    assert.equal(harness.cancels.length, 0, "a phone keyboard cursor move must not hide the touch selection action bar");
    assert.equal(harness.retargets.length, 0, "a phone keyboard cursor move must not redispatch cursor.select / reopen Note Dock");
  }

  {
    const harness = makeHarness({ pane: "song" });
    const event = eventFor("chain", 4, 0);
    harness.clickHandler(event);
    assert.equal(event.prevented, false, "cross-pane pointer target must fail closed");
    assert.equal(harness.retargets.length, 0);
    assert.equal(harness.cancels.length, 0);
  }

  for (const overrides of [
    { shiftKey: true }, { metaKey: true }, { ctrlKey: true }, { altKey: true }, { button: 1 },
  ]) {
    const harness = makeHarness({ pane: "song" });
    const event = eventFor("song", 4, 2, overrides);
    harness.clickHandler(event);
    assert.equal(event.prevented, false, "modified/non-primary click must remain ordinary input");
    assert.equal(harness.retargets.length, 0);
    assert.equal(harness.cancels.length, 0);
  }

  for (const state of [
    { armed: false }, { available: false }, { movePending: true },
  ]) {
    const harness = makeHarness({ pane: "song", ...state });
    const event = eventFor("song", 4, 2);
    harness.clickHandler(event);
    harness.setCursor("song", 4, 2);
    harness.emitCommand({ type: "cursor.move", source: "keyboard" });
    await settle();
    assert.equal(event.prevented, false, "inactive paste-target state must not consume click");
    assert.equal(harness.retargets.length, 0, "inactive paste-target state must not route pointer target");
    assert.equal(harness.cancels.length, 0, "inactive paste-target state must not alter selection on keyboard navigation");
  }

  for (const command of [
    { type: "cursor.move", source: "pointer-cell" },
    { type: "cursor.select", source: "keyboard" },
    { type: "context.navigate", source: "keyboard" },
    { type: "cursor.move", source: "prepared-note-auto-advance" },
  ]) {
    const harness = makeHarness({ pane: "phrase" });
    harness.setCursor("phrase", 7, 0);
    harness.emitCommand(command);
    await settle();
    assert.equal(harness.retargets.length, 0, `unrelated command must not pointer-retarget: ${JSON.stringify(command)}`);
    assert.equal(harness.cancels.length, 0, `unrelated command must not clear selection: ${JSON.stringify(command)}`);
  }

  {
    const harness = makeHarness({ pane: "chain" });
    harness.setCursor("song", 3, 0);
    harness.emitCommand({ type: "cursor.move", source: "keyboard" });
    await settle();
    assert.equal(harness.cancels.length, 0, "cross-pane keyboard target must fail closed");
  }

  {
    const harness = makeHarness({ pane: "song" });
    harness.setCursor("song", 2, 0);
    harness.emitCommand({ type: "cursor.move", source: "keyboard" }, false);
    await settle();
    assert.equal(harness.cancels.length, 0, "failed cursor command must not alter paste destination state");
  }

  const snapshot = makeHarness({ pane: "phrase" }).context.globalThis.BRKTRKPasteTargetInputRouter.snapshot();
  assert.equal(snapshot.keyboardRoute, "desktop-post-command-cursor-as-destination");
  assert.equal(snapshot.phoneKeyboardRoute, "not-intercepted-use-touch-target");
  console.log("M4.2B pointer target + desktop cursor-owned keyboard Paste routing tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
