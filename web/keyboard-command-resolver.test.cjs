const assert = require("node:assert/strict");
const {
  resolveKeydown,
  handleKeydown,
  duplicateTargetPane,
  phraseKeyboardTargetAvailable,
} = require("./keyboard-command-resolver.js");

function event(overrides = {}) {
  let prevented = false;
  let stopped = false;
  return {
    key: "d",
    code: "KeyD",
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    target: { matches: () => false },
    preventDefault() { prevented = true; },
    stopImmediatePropagation() { stopped = true; },
    get prevented() { return prevented; },
    get stopped() { return stopped; },
    ...overrides,
  };
}

function root(workspace = "phrase", focusPane = workspace) {
  const phraseDispatched = [];
  const structuralDispatched = [];
  const commandDispatched = [];
  const statuses = [];
  let selection = null;
  return {
    state: {
      phrase: 0,
      chain: 0,
      view: workspace,
      p3: { activeWorkspace: workspace, activeSheet: null },
      focus: { pane: focusPane, row: 0, col: 0 },
    },
    BRKTRKStores: { navigation: { entryState: { getActiveSheet: () => null } } },
    BRKTRKSelectionClipboard: { getSelection() { return selection; } },
    BRKTRKPhraseRowOperations: {
      installed: true,
      dispatch(command) {
        phraseDispatched.push(command);
        return Promise.resolve({ ok: true });
      },
    },
    BRKTRKStructuralRowOperations: {
      installed: true,
      dispatch(command) {
        structuralDispatched.push(command);
        return Promise.resolve({ ok: true });
      },
    },
    BRKTRKCommands: {
      installed: true,
      dispatch(command) {
        commandDispatched.push(command);
        return Promise.resolve({ ok: true });
      },
    },
    document: { querySelector: () => null },
    setStatus(message, tone) { statuses.push({ message, tone }); },
    setSelection(value) { selection = value; },
    phraseDispatched,
    structuralDispatched,
    commandDispatched,
    statuses,
  };
}

{
  const app = root("phrase");
  assert.equal(duplicateTargetPane(app), "phrase");
  assert.equal(phraseKeyboardTargetAvailable(app), true);
  const decision = resolveKeydown(event(), app);
  assert.equal(decision.handled, true);
  assert.equal(decision.reason, "resolved");
  assert.equal(decision.owner, "phrase-row-operations");
  assert.equal(decision.command.type, "phrase.rows.duplicate");
}

{
  const app = root("phrase");
  const key = event();
  const decision = handleKeydown(key, app);
  assert.equal(decision.handled, true);
  assert.equal(key.prevented, true);
  assert.equal(key.stopped, true);
  assert.deepEqual(app.phraseDispatched, [{ type: "phrase.rows.duplicate", source: "keyboard-command-resolver" }]);
  assert.equal(app.structuralDispatched.length, 0);
}

for (const pane of ["song", "chain"]) {
  const app = root(pane, pane);
  const key = event({ metaKey: pane === "song", ctrlKey: pane !== "song" });
  const decision = handleKeydown(key, app);
  assert.equal(decision.handled, true);
  assert.equal(decision.reason, "resolved");
  assert.equal(decision.owner, "structural-row-operations");
  assert.equal(decision.pane, pane);
  assert.equal(key.prevented, true);
  assert.equal(key.stopped, true);
  assert.deepEqual(app.structuralDispatched, [{ type: "structure.rows.duplicate", pane, source: "keyboard-command-resolver" }]);
  assert.equal(app.phraseDispatched.length, 0);
}

{
  // Owner diagnostics showed this exact coexistence: wider Phrase workspace can
  // remain active while canonical focus is on Song. The canonical tracker focus
  // owns Duplicate, so this must duplicate the Song row rather than mutate a
  // hidden Phrase or merely swallow the shortcut.
  const app = root("phrase", "song");
  assert.equal(duplicateTargetPane(app), "song");
  assert.equal(phraseKeyboardTargetAvailable(app), false);
  const decision = handleKeydown(event({ metaKey: true, ctrlKey: false }), app);
  assert.equal(decision.reason, "resolved");
  assert.equal(decision.pane, "song");
  assert.equal(app.structuralDispatched.length, 1);
  assert.equal(app.phraseDispatched.length, 0);
}

{
  // An explicit current-context Phrase selection may still outrank stale parent
  // focus, preserving the accepted M4.2B selection ownership rule.
  const app = root("phrase", "song");
  app.setSelection({ active: true, pane: "phrase", contextId: 0, startRow: 2, rowCount: 2 });
  assert.equal(duplicateTargetPane(app), "phrase");
  assert.equal(phraseKeyboardTargetAvailable(app), true);
  const decision = handleKeydown(event(), app);
  assert.equal(decision.owner, "phrase-row-operations");
  assert.equal(app.phraseDispatched.length, 1);
  assert.equal(app.structuralDispatched.length, 0);
}

{
  const app = root("phrase", "chain");
  app.setSelection({ active: true, pane: "chain", contextId: 1, startRow: 2, rowCount: 2 });
  assert.equal(duplicateTargetPane(app), "chain");
  const decision = handleKeydown(event(), app);
  assert.equal(decision.owner, "structural-row-operations");
  assert.equal(decision.pane, "chain");
}

{
  const app = root("mix", "mix");
  const key = event();
  const decision = handleKeydown(key, app);
  assert.equal(decision.handled, true);
  assert.equal(decision.reason, "tracker-target-unavailable");
  assert.equal(key.prevented, true);
  assert.equal(key.stopped, true);
  assert.equal(app.phraseDispatched.length, 0);
  assert.equal(app.structuralDispatched.length, 0);
}

{
  const app = root("phrase");
  app.BRKTRKStores.navigation.entryState.getActiveSheet = () => "note";
  const decision = handleKeydown(event(), app);
  assert.equal(decision.reason, "contextual-sheet-active");
  assert.equal(app.phraseDispatched.length, 0);
  assert.equal(app.structuralDispatched.length, 0);
}

{
  const app = root("phrase");
  assert.equal(resolveKeydown(event({ target: { matches: () => true } }), app).handled, false);
  assert.equal(resolveKeydown(event({ ctrlKey: false, metaKey: false }), app).handled, false);
  app.document.querySelector = (selector) => selector === "#helpDialog" ? { open: true } : null;
  assert.equal(resolveKeydown(event(), app).handled, false);
}

// UX0-03 (#373): the desktop half of duplicate-and-repoint. Shift is the only
// thing that separates it from row duplication, so the two must never reach
// each other's owner.
{
  const app = root("song");
  const decision = resolveKeydown(event({ shiftKey: true, key: "D" }), app);
  assert.equal(decision.handled, true);
  assert.equal(decision.semantic, "make-unique");
  assert.equal(decision.reason, "resolved");
  assert.equal(decision.owner, "commands");
  assert.equal(decision.command.type, "structure.duplicateAndRepoint");
  assert.equal(Object.hasOwn(decision.command, "cursor"), false,
    "the command carries no cursor so the dispatcher reads the live one");
}

{
  const app = root("chain");
  handleKeydown(event({ shiftKey: true }), app);
  assert.deepEqual(app.commandDispatched.map((command) => command.type), ["structure.duplicateAndRepoint"]);
  assert.equal(app.structuralDispatched.length, 0, "make-unique must not reach row duplication");
  assert.equal(app.phraseDispatched.length, 0);
}

// The Phrase pane has no structural reference column, but which cells the
// operation accepts is the dispatcher's rule and it says so itself. The
// resolver does not keep a second copy of it.
{
  const app = root("phrase");
  const decision = resolveKeydown(event({ shiftKey: true }), app);
  assert.equal(decision.owner, "commands");
  assert.equal(decision.command.type, "structure.duplicateAndRepoint");
}

// Sound and Mix borrow the screen while state.focus still names a tracker
// cell. Acting there would repoint a cell the musician cannot see.
for (const workspace of ["sound", "mix"]) {
  const app = root(workspace, "chain");
  const decision = handleKeydown(event({ shiftKey: true }), app);
  assert.equal(decision.handled, true);
  assert.equal(decision.reason, "tracker-workspace-not-active");
  assert.equal(app.commandDispatched.length, 0);
  assert.match(app.statuses.at(-1).message, /^MAKE UNIQUE \u00b7 TRACKER NOT ACTIVE/);
  assert.match(app.statuses.at(-1).message, new RegExp(workspace.toUpperCase() + " ACTIVE$"));
}

{
  const app = root("chain");
  app.BRKTRKStores.navigation.entryState.getActiveSheet = () => "note";
  const decision = handleKeydown(event({ shiftKey: true }), app);
  assert.equal(decision.reason, "contextual-sheet-active");
  assert.equal(app.statuses.at(-1).message, "MAKE UNIQUE BLOCKED \u00b7 NOTE OWNS INPUT",
    "the blocked message must name the semantic that was blocked, not the other one");
  assert.equal(app.commandDispatched.length, 0);
}

{
  const app = root("chain");
  app.BRKTRKCommands = { installed: false };
  const decision = handleKeydown(event({ shiftKey: true }), app);
  assert.equal(decision.reason, "commands-unavailable");
  assert.equal(app.statuses.at(-1).message, "MAKE UNIQUE INITIALIZING");
}

// Without Shift the existing shortcut is unchanged, and Shift on any other
// key is still none of this resolver's business.
{
  const app = root("chain");
  const decision = handleKeydown(event(), app);
  assert.equal(decision.semantic, "duplicate");
  assert.equal(decision.owner, "structural-row-operations");
  assert.equal(app.commandDispatched.length, 0);
  assert.equal(resolveKeydown(event({ shiftKey: true, key: "z", code: "KeyZ" }), app).handled, false,
    "Ctrl/Cmd+Shift+Z belongs to Redo and must pass straight through");
}

console.log("Keyboard command resolver tests passed");
