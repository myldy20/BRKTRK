const assert = require("node:assert/strict");
const commandState = require("./command-state.js");

assert.equal(commandState.normalizeWorkspace("mix"), "mix");
assert.equal(commandState.normalizeWorkspace("unknown"), "phrase");
assert.deepEqual(commandState.createTrackerCursor({ pane: "chain", row: 3, col: 1 }), { pane: "chain", row: 3, col: 1 });
assert.ok(Object.isFrozen(commandState.createTrackerCursor({ pane: "song", row: 0, col: 0 })));
assert.deepEqual(commandState.CHANGE_OWNERS, ["project", "navigation", "transport", "ui"]);

const snapshot = commandState.createWorkspaceSnapshot({
  activeWorkspace: "mix",
  view: "mix",
  focus: { pane: "chain", row: 3, col: 1 },
  track: 4,
  chain: 2,
});
assert.equal(snapshot.activeWorkspace, "mix");
assert.deepEqual(snapshot.trackerCursor, { pane: "chain", row: 3, col: 1 });
assert.ok(Object.isFrozen(snapshot));

const change = commandState.createChangeSet({
  kind: "note",
  target: "phrase:00:row:00:note",
  path: ["phrases", 0, 0, "note"],
  before: 60,
  after: 61,
  affectsPlayback: true,
  persistsProject: true,
  renderTargets: ["phrase.row.0"],
});
assert.equal(change.owner, "project");
assert.equal(change.subtype, "phrase:00:row:00:note");
assert.equal(change.affectsPlayback, true);
assert.equal(change.persistsProject, true);
assert.deepEqual(change.path, ["phrases", 0, 0, "note"]);
assert.deepEqual(change.renderTargets, ["phrase.row.0"]);
assert.ok(Object.isFrozen(change.path));
assert.ok(Object.isFrozen(change.renderTargets));

const workspaceNavigation = commandState.createChangeSet({
  kind: "ui",
  target: "navigation.workspace",
  before: "phrase",
  after: "chain",
  persistsProject: true,
  affectsPlayback: true,
});
assert.equal(workspaceNavigation.owner, "navigation");
assert.equal(workspaceNavigation.kind, "cursor", "legacy kind remains compatible during M4.0A");
assert.equal(workspaceNavigation.subtype, "workspace");
assert.equal(workspaceNavigation.persistsProject, false);
assert.equal(workspaceNavigation.affectsPlayback, false);

const mixSelection = commandState.createChangeSet({
  kind: "mix",
  target: "mix.selectTrack",
  before: 0,
  after: 1,
  affectsPlayback: true,
  persistsProject: true,
});
assert.equal(mixSelection.owner, "navigation");
assert.equal(mixSelection.kind, "cursor");
assert.equal(mixSelection.subtype, "mix.selectTrack");
assert.equal(mixSelection.affectsPlayback, false);
assert.equal(mixSelection.persistsProject, false);

const soundSelection = commandState.createChangeSet({
  kind: "parameter",
  target: "sound.selectParam",
  before: 0,
  after: 1,
  affectsPlayback: true,
  persistsProject: true,
});
assert.equal(soundSelection.owner, "navigation");
assert.equal(soundSelection.kind, "cursor");
assert.equal(soundSelection.persistsProject, false);

const octaveSelection = commandState.createChangeSet({
  kind: "note",
  target: "note.octave",
  before: 4,
  after: 5,
  affectsPlayback: true,
  persistsProject: true,
});
assert.equal(octaveSelection.owner, "ui");
assert.equal(octaveSelection.kind, "ui");
assert.equal(octaveSelection.affectsPlayback, false);
assert.equal(octaveSelection.persistsProject, false);

const transportChange = commandState.createChangeSet({
  kind: "transport",
  target: "transport.toggle",
  before: false,
  after: true,
});
assert.equal(transportChange.owner, "transport");
assert.equal(transportChange.subtype, "transport.toggle");

const merged = commandState.mergeChangeSets([change, commandState.createChangeSet({
  kind: "note",
  target: "phrase:00:row:00:velocity",
  before: 100,
  after: 110,
  affectsPlayback: true,
  persistsProject: true,
  renderTargets: ["phrase.row.0"],
})]);
assert.equal(merged.owner, "project");
assert.equal(merged.subtype, "merged");
assert.equal(merged.persistsProject, true);
assert.deepEqual(merged.renderTargets, ["phrase.row.0"]);

const history = new commandState.CommandHistory(2);
history.push({ type: "first" }, snapshot, snapshot, change, { ok: true });
history.push({ type: "second" }, snapshot, snapshot, change, { ok: true });
history.push({ type: "third" }, snapshot, snapshot, change, { ok: true });
assert.equal(history.list().length, 2);
assert.equal(history.last().command.type, "third");
assert.equal(history.last().id, 3);
assert.equal(history.last().changeSet.owner, "project");

console.log("P3.1 command-state tests passed");
