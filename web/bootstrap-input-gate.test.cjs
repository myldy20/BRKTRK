const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "bootstrap-input-gate.js"), "utf8");

function element(id = null) {
  const attributes = new Map();
  const style = {
    removeProperty(name) {
      const camel = name.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
      delete this[camel];
      delete this[name];
    },
  };
  return {
    id,
    inert: false,
    style,
    dataset: {},
    textContent: "",
    title: "",
    removed: false,
    children: [],
    contains(target) { return target === this; },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    removeAttribute(name) { attributes.delete(name); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    append(child) { this.children.push(child); child.parent = this; },
    remove() {
      this.removed = true;
      if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
    },
  };
}

function createHarness({ fixtureHold = false } = {}) {
  const shell = element("appShell");
  const help = element("helpDialog");
  const body = element("body");
  const listeners = new Map();
  const documentListeners = new Map();
  const intervalCallbacks = [];
  let observerCallback = null;
  let observerDisconnects = 0;
  let clearedIntervals = 0;
  let now = 10;
  let renderCount = 0;
  let focusCount = 0;

  const documentElement = element("html");
  const document = {
    body,
    documentElement,
    querySelector(selector) {
      if (selector === "#appShell") return shell;
      if (selector === "#helpDialog") return help;
      if (selector === "#bootstrapLoadingSurface") return body.children.find((child) => child.id === "bootstrapLoadingSurface") ?? null;
      return null;
    },
    createElement() { return element(); },
    addEventListener(type, callback) {
      if (!documentListeners.has(type)) documentListeners.set(type, new Set());
      documentListeners.get(type).add(callback);
    },
    removeEventListener(type, callback) { documentListeners.get(type)?.delete(callback); },
  };

  const top = fixtureHold ? {} : null;
  const window = {
    top: null,
    location: { search: fixtureHold ? "?j2HoldBootstrap=1" : "" },
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    setInterval(callback) { intervalCallbacks.push(callback); return intervalCallbacks.length; },
    clearInterval() { clearedIntervals += 1; },
  };
  window.top = fixtureHold ? top : window;

  class MutationObserver {
    constructor(callback) { observerCallback = callback; }
    observe() {}
    disconnect() { observerDisconnects += 1; }
  }

  const context = {
    console,
    document,
    window,
    URLSearchParams,
    MutationObserver,
    performance: { now: () => ++now },
    renderAll() { renderCount += 1; },
    focusSelectedCell() { focusCount += 1; },
  };
  context.globalThis = context;

  vm.runInNewContext(source, context, { filename: "bootstrap-input-gate.js" });

  return {
    context,
    shell,
    body,
    listeners,
    intervalCallbacks,
    get renderCount() { return renderCount; },
    get focusCount() { return focusCount; },
    get observerDisconnects() { return observerDisconnects; },
    get clearedIntervals() { return clearedIntervals; },
    poll() { intervalCallbacks.at(-1)?.(); },
    mutate() { observerCallback?.(); },
    advance(ms) { now += ms; },
    dispatch(type, overrides = {}) {
      let prevented = false;
      let stopped = false;
      const event = {
        type,
        target: null,
        preventDefault() { prevented = true; },
        stopImmediatePropagation() { stopped = true; },
        ...overrides,
      };
      for (const callback of [...(documentListeners.get(type) ?? [])]) callback(event);
      return { get prevented() { return prevented; }, get stopped() { return stopped; } };
    },
    notice() { return body.children.find((child) => child.id === "bootstrapInitialisingNotice") ?? null; },
    emitWindow(type, event = {}) {
      for (const callback of [...(listeners.get(type) ?? [])]) callback(event);
    },
    loading() { return body.children.find((child) => child.id === "bootstrapLoadingSurface") ?? null; },
    realmEval(expression) { return vm.runInNewContext(expression, context); },
  };
}

function installFinalOwners(h) {
  h.body.dataset.commandArchitecture = "p3.4";
  h.context.BRKTRKCommands = { installed: true };
  h.context.BRKTRKCommandBindings = {};
  h.context.BRKTRKSoundEditRenderer = { renderProductionSurface() {} };
  h.context.BRKTRKTrackMixer = { installed: true };
}

{
  const h = createHarness();
  const snapshot = h.context.BRKTRKBootstrapInput.snapshot();
  assert.equal(snapshot.blocked, true);
  assert.equal(snapshot.surfaceGuardEnabled, true);
  assert.equal(snapshot.baseSurfaceReady, true);
  assert.equal(snapshot.surfaceState, "ready", "base tracker shell must become visible before late Sound/Mixer capability readiness");
  assert.equal(snapshot.nonFatalResourceFailures.length, 0);
  assert.equal(h.shell.style.visibility, undefined);
  assert.equal(h.shell.getAttribute("aria-hidden"), null);
  assert.equal(h.shell.inert, true, "visible base shell must remain inert until authoritative input owners are ready");
  assert.equal(h.loading(), null);
  assert.equal(h.renderCount, 1, "base shell reveal must render once");

  h.body.dataset.commandArchitecture = "p3.4";
  h.context.BRKTRKCommands = { installed: true };
  h.context.BRKTRKCommandBindings = {};
  h.context.BRKTRKSoundEditRenderer = { renderProductionSurface() {} };
  h.poll();
  assert.equal(h.context.BRKTRKBootstrapInput.isBlocked(), true, "missing Track Mixer owner must keep input blocked even after shell reveal");
  assert.equal(h.shell.style.visibility, undefined);
  assert.equal(h.renderCount, 1);

  h.context.BRKTRKTrackMixer = { installed: true };
  h.poll();
  const ready = h.context.BRKTRKBootstrapInput.snapshot();
  assert.equal(h.context.BRKTRKBootstrapInput.isBlocked(), false);
  assert.equal(ready.surfaceState, "ready");
  assert.equal(ready.watchersStopped, true);
  assert.equal(h.shell.style.visibility, undefined);
  assert.equal(h.shell.getAttribute("aria-hidden"), null);
  assert.equal(h.shell.inert, false);
  assert.equal(h.loading(), null);
  assert.equal(h.renderCount, 2, "authoritative release must perform one final render after the early base-shell render");
  assert.equal(h.focusCount, 1);
  assert.equal(h.observerDisconnects, 1);
  assert.equal(h.clearedIntervals, 1);
}

{
  const h = createHarness();
  h.emitWindow("unhandledrejection", { reason: h.realmEval("new Error()") });
  const snapshot = h.context.BRKTRKBootstrapInput.snapshot();
  assert.equal(snapshot.blocked, true);
  assert.equal(snapshot.startupFailed, true);
  assert.equal(snapshot.surfaceState, "failed");
  assert.equal(snapshot.startupFailure, "Unknown bootstrap failure", "empty in-realm Error.message must normalize to a useful fallback");
  assert.equal(snapshot.watchersStopped, true);
  assert.equal(h.shell.style.visibility, undefined, "failure overlay may cover the already-rendered base shell while input remains inert");
  assert.match(h.loading()?.textContent ?? "", /^BRKTRK · STARTUP FAILED\n/);
  assert.match(h.loading()?.textContent ?? "", /Unknown bootstrap failure/);
  assert.equal(h.loading()?.style.textTransform, "none", "visible failure detail must preserve exact casing");
  assert.equal(h.context.BRKTRKBootstrapInput.release("fixture-release"), false, "terminal startup failure must not be manually released");
  assert.equal(h.observerDisconnects, 1);
  assert.equal(h.clearedIntervals, 1);
}

{
  const h = createHarness();
  const exactSource = "https://example.test/SoundEditRenderer.js";
  h.emitWindow("error", { target: { tagName: "SCRIPT", src: exactSource } });
  const snapshot = h.context.BRKTRKBootstrapInput.snapshot();
  assert.equal(snapshot.startupFailed, true);
  assert.equal(snapshot.startupFailure, `Failed to load startup resource: ${exactSource}`);
  assert.ok((h.loading()?.textContent ?? "").includes(exactSource), "visible diagnostic must preserve case-sensitive startup resource URL");
  assert.equal(h.loading()?.style.textTransform, "none");
  assert.equal(snapshot.surfaceState, "failed");
  assert.equal(snapshot.watchersStopped, true);
}

{
  const h = createHarness();
  h.emitWindow("error", {
    target: {
      tagName: "LINK",
      rel: "manifest",
      href: "https://example.test/__physical/abc/physical-candidate.webmanifest",
    },
  });
  let snapshot = h.context.BRKTRKBootstrapInput.snapshot();
  assert.equal(snapshot.startupFailed, false, "candidate manifest failure must not kill the usable application bootstrap");
  assert.equal(snapshot.nonFatalResourceFailures.length, 1);
  assert.equal(snapshot.nonFatalResourceFailures[0].rel, "manifest");
  assert.match(snapshot.nonFatalResourceFailures[0].source, /physical-candidate\.webmanifest/);
  assert.equal(snapshot.watchersStopped, false, "non-fatal metadata failure must keep readiness watchers alive");

  installFinalOwners(h);
  h.poll();
  snapshot = h.context.BRKTRKBootstrapInput.snapshot();
  assert.equal(snapshot.surfaceState, "ready", "non-critical PWA metadata failure must not block authoritative UI release");
  assert.equal(snapshot.startupFailed, false);
  assert.equal(snapshot.nonFatalResourceFailures.length, 1);
}

{
  const h = createHarness();
  h.emitWindow("error", {
    target: {
      tagName: "LINK",
      rel: "stylesheet",
      href: "https://example.test/styles.css",
    },
  });
  const snapshot = h.context.BRKTRKBootstrapInput.snapshot();
  assert.equal(snapshot.startupFailed, true, "a required stylesheet failure remains a terminal startup failure");
  assert.match(snapshot.startupFailure, /styles\.css/);
}

{
  const h = createHarness({ fixtureHold: true });
  const snapshot = h.context.BRKTRKBootstrapInput.snapshot();
  assert.equal(snapshot.fixtureHoldRequested, true);
  assert.equal(snapshot.surfaceGuardEnabled, false, "fixture hold must preserve historical visible-but-inert acceptance surface");
  assert.equal(snapshot.surfaceState, "fixture-visible");
  assert.equal(snapshot.blocked, true);
  assert.equal(h.shell.style.visibility, undefined);
  assert.equal(h.loading(), null);
}

// UX0-10 (#299): a shell that is visible but still deaf owes the musician a
// word - but only when there is genuinely something to explain. A healthy cold
// start measured ~168ms between reveal and release, so saying anything then
// would be a flash on every start.
{
  const h = createHarness();
  assert.equal(h.context.BRKTRKBootstrapInput.snapshot().surfaceState, "ready", "the shell is up");
  assert.equal(h.context.BRKTRKBootstrapInput.isBlocked(), true, "and still deaf");
  h.advance(600);
  h.poll();
  assert.equal(h.notice(), null, "a start well inside the budget must say nothing at all");
  assert.equal(h.body.dataset.bootstrapNotice, undefined);

  h.advance(700);
  h.poll();
  const notice = h.notice();
  assert.ok(notice, "past the budget the wait must explain itself");
  assert.equal(h.body.dataset.bootstrapNotice, "slow-start");
  assert.match(notice.textContent, /^STILL STARTING · NOT TAKING INPUT YET/);
  assert.match(notice.textContent, /LOADING COMMANDS$/, "it must name the stage it is actually waiting on");
  assert.equal(h.body.dataset.bootstrapStage, "commands");
  assert.equal(notice.style.pointerEvents, "none", "a notice explaining a swallowed tap must not swallow the next one");
  assert.equal(notice.getAttribute("role"), "status");

  // The stage it names must follow the boundary it reads from, not a cached guess.
  h.body.dataset.commandArchitecture = "p3.4";
  h.context.BRKTRKCommands = { installed: true };
  h.context.BRKTRKCommandBindings = {};
  h.poll();
  assert.match(h.notice().textContent, /LOADING THE MIXER$/);
  assert.equal(h.context.BRKTRKBootstrapInput.pendingStage(), "mixer");
  h.context.BRKTRKTrackMixer = { installed: true };
  h.poll();
  assert.match(h.notice().textContent, /LOADING SOUND$/);

  h.context.BRKTRKSoundEditRenderer = { renderProductionSurface() {} };
  h.poll();
  assert.equal(h.context.BRKTRKBootstrapInput.isBlocked(), false);
  assert.equal(h.notice(), null, "release must take the notice away with it");
  assert.equal(h.body.dataset.bootstrapNotice, undefined);
  assert.equal(h.context.BRKTRKBootstrapInput.snapshot().pendingStage, null);
}

// A swallowed interaction is better evidence than any clock: the musician has
// proved they are trying, so it explains itself immediately.
{
  const h = createHarness();
  h.advance(50);
  const blockedEvent = h.dispatch("keydown");
  assert.equal(blockedEvent.prevented, true, "the event is still swallowed - this changes what the musician is told, not the gating");
  assert.equal(blockedEvent.stopped, true);
  const notice = h.notice();
  assert.ok(notice, "a tap inside the budget must still be answered");
  assert.equal(h.body.dataset.bootstrapNotice, "blocked-interaction");
  assert.match(notice.textContent, /^STILL STARTING · THAT DID NOT REGISTER/);
  assert.equal(h.context.BRKTRKBootstrapInput.snapshot().blockedCount, 1);

  // A later slow-start tick must not downgrade a message about the musician's
  // own tap into a generic one.
  h.advance(2000);
  h.poll();
  assert.match(h.notice().textContent, /^STILL STARTING · THAT DID NOT REGISTER/);
  assert.equal(h.body.dataset.bootstrapNotice, "blocked-interaction");
}

// A terminal failure owns the whole screen. The notice must not sit on top of
// it still promising that something is starting.
{
  const h = createHarness();
  h.dispatch("keydown");
  assert.ok(h.notice(), "precondition: the notice is up");
  h.emitWindow("unhandledrejection", { reason: "engine gone" });
  assert.equal(h.notice(), null, "a startup failure must take the optimistic notice away");
  assert.equal(h.body.dataset.bootstrapNotice, undefined);
  assert.equal(h.context.BRKTRKBootstrapInput.snapshot().surfaceState, "failed");
}

// This gate is re-blocked after startup for reasons that are not startup:
// another tab holds the writer, a Service Worker update, a history restore.
// #browserWriterStatus owns saying so, and a running app must never be told
// it is still starting.
{
  const h = createHarness();
  installFinalOwners(h);
  h.poll();
  assert.equal(h.context.BRKTRKBootstrapInput.isBlocked(), false, "precondition: startup finished");
  assert.equal(h.context.BRKTRKBootstrapInput.snapshot().startupCompleted, true);

  h.context.BRKTRKBootstrapInput.block("browser-writer-unavailable");
  assert.equal(h.context.BRKTRKBootstrapInput.isBlocked(), true);
  assert.equal(h.context.BRKTRKBootstrapInput.snapshot().releasedAtMs, null, "block() clears releasedAt, which is why completion is remembered separately");
  h.advance(9000);
  h.dispatch("keydown");
  // Assert before polling: the poll would release again, which would hide the
  // notice for the wrong reason and let this pass vacuously.
  assert.equal(h.notice(), null, "a post-startup block is not a slow start and must not claim to be one");
  assert.equal(h.body.dataset.bootstrapNotice, undefined);
  assert.equal(h.context.BRKTRKBootstrapInput.snapshot().blockedCount, 1, "the event is still swallowed; only the explanation is withheld");
}

// An inert subtree is excluded from hit testing, so a real tap on the grid
// does not target the grid. Measured in Chromium: document.elementFromPoint
// over a Song cell answers HEADER before the block and BODY after it. Without
// this, the affordance answers synthetic events and keyboard input but not the
// phone tap it exists for.
{
  const h = createHarness();
  assert.equal(h.shell.inert, true, "precondition: the visible shell is inert while blocked");
  const tap = h.dispatch("pointerdown", { target: h.body });
  assert.equal(tap.prevented, true, "a tap retargeted out of the inert shell is still the app's");
  assert.equal(h.context.BRKTRKBootstrapInput.snapshot().blockedCount, 1);
  assert.ok(h.notice(), "and must be answered: it is the interaction the notice exists for");
  assert.match(h.notice().textContent, /THAT DID NOT REGISTER/);
}

// The same target outside the blocked window is not the app's business, so the
// broadening is bounded by inertness rather than applied always.
{
  const h = createHarness();
  installFinalOwners(h);
  h.poll();
  assert.equal(h.shell.inert, false);
  assert.equal(h.context.BRKTRKBootstrapInput.isBlocked(), false);
  const tap = h.dispatch("pointerdown", { target: h.body });
  assert.equal(tap.prevented, false, "once released nothing is intercepted at all");
}

// The broadening is tied to the cause, not to being blocked: inertness is what
// retargets the tap, so a shell that is blocked but not inert retargets
// nothing and a document-level pointer is not a swallowed app tap.
{
  const h = createHarness();
  h.shell.inert = false;
  const tap = h.dispatch("pointerdown", { target: h.body });
  assert.equal(tap.prevented, false, "without inertness there is no retarget to recognise");
  assert.equal(h.notice(), null);
}

// A pointer on a genuinely unrelated node is still not the app's.
{
  const h = createHarness();
  const elsewhere = { id: "somewhere-else", closest: () => null };
  const stray = h.dispatch("pointerdown", { target: elsewhere });
  assert.equal(stray.prevented, false, "a pointer outside the shell and off the document is not a swallowed app tap");
  assert.equal(h.notice(), null);
  assert.equal(h.context.BRKTRKBootstrapInput.snapshot().blockedCount, 0);
}

// The browser-writer panel owns its own explanation and its buttons must work.
{
  const h = createHarness();
  const writerButton = { id: "tryAgain", closest: (selector) => (selector === "#browserWriterStatus" ? { id: "browserWriterStatus" } : null) };
  const press = h.dispatch("pointerdown", { target: writerButton });
  assert.equal(press.prevented, false, "the writer panel stays usable while input is blocked");
  assert.equal(h.notice(), null, "and owns its own message rather than gaining a second one");
}

// A fixture hold is a deliberate test state, not a slow start.
{
  const h = createHarness({ fixtureHold: true });
  h.advance(5000);
  h.poll();
  h.dispatch("keydown");
  assert.equal(h.notice(), null, "a held fixture must not grow a notice the fixture never asked for");
}

console.log("Bootstrap visible-shell + authoritative input gate tests passed");