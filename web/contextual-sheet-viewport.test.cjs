const assert = require("node:assert/strict");
const policy = require("./contextual-sheet-viewport.js");

assert.deepEqual(policy.resolveViewportTarget({
  activeSheet: "note",
  workspace: "chain",
  focus: { pane: "chain", row: 7, col: 1 },
}), {
  activeSheet: "note",
  sheetSelector: "#p3NoteDock",
  pane: "phrase",
  gridSelector: "#phraseGrid",
  row: 7,
  col: 0,
});

for (const [activeSheet, selector] of Object.entries(policy.SHEET_SELECTORS)) {
  const target = policy.resolveViewportTarget({
    activeSheet,
    workspace: "chain",
    focus: { pane: "chain", row: 3, col: 1 },
  });
  assert.equal(target.sheetSelector, selector);
  assert.equal(target.gridSelector, activeSheet === "note" ? "#phraseGrid" : "#chainGrid");
}

assert.equal(policy.resolveViewportTarget({
  activeSheet: "context",
  workspace: "mix",
  focus: { pane: "mix", row: 0, col: 0 },
}), null);
assert.equal(policy.resolveViewportTarget({ activeSheet: null, workspace: "phrase" }), null);

assert.equal(policy.computeAvailableHeight({ gridTop: 100, sheetTop: 420 }), 312);
assert.equal(policy.computeAvailableHeight({ gridTop: 300, sheetTop: 310 }), 86);
assert.equal(policy.computeAvailableHeight({ gridTop: Number.NaN, sheetTop: 310, minHeight: 64 }), 64);

assert.equal(policy.computeScrollTop({
  scrollTop: 0,
  scrollHeight: 800,
  clientHeight: 200,
  gridTop: 100,
  gridBottom: 300,
  sheetTop: 320,
  cellTop: 360,
  cellBottom: 388,
}), 94);
assert.equal(policy.computeScrollTop({
  scrollTop: 200,
  scrollHeight: 800,
  clientHeight: 200,
  gridTop: 100,
  gridBottom: 300,
  sheetTop: 320,
  cellTop: 70,
  cellBottom: 98,
}), 160);
assert.equal(policy.computeScrollTop({
  scrollTop: 590,
  scrollHeight: 800,
  clientHeight: 200,
  gridTop: 100,
  gridBottom: 300,
  sheetTop: 320,
  cellTop: 400,
  cellBottom: 460,
}), 600);

assert.equal(policy.computeRowScrollTop({
  scrollTop: 0,
  scrollHeight: 540,
  clientHeight: 179,
  headerHeight: 28,
  rowOffsetTop: 493,
  rowHeight: 31,
}), 351, "final Phrase row must reveal from content offsets");
assert.equal(policy.computeRowScrollTop({
  scrollTop: 300,
  scrollHeight: 540,
  clientHeight: 179,
  headerHeight: 28,
  rowOffsetTop: 100,
  rowHeight: 31,
}), 66, "row above the sticky header must scroll back into view");
assert.equal(policy.computeRowScrollTop({
  scrollTop: 120,
  scrollHeight: 540,
  clientHeight: 179,
  headerHeight: 28,
  rowOffsetTop: 180,
  rowHeight: 31,
}), 120, "already visible row must keep the current scroll position");

const fake = { style: { height: "12px", maxHeight: "", minHeight: "4px", overflowY: "clip", overflowAnchor: "auto", scrollPaddingBottom: "2px" } };
const snapshot = policy.snapshotInlineStyles(fake);
fake.style.height = "99px";
fake.style.maxHeight = "99px";
fake.style.minHeight = "0";
fake.style.overflowY = "auto";
fake.style.overflowAnchor = "none";
fake.style.scrollPaddingBottom = "8px";
policy.restoreInlineStyles(fake, snapshot);
assert.deepEqual(fake.style, {
  height: "12px",
  maxHeight: "",
  minHeight: "4px",
  overflowY: "clip",
  overflowAnchor: "auto",
  scrollPaddingBottom: "2px",
});

console.log("Contextual sheet viewport policy tests passed");
