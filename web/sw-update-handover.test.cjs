const assert = require("node:assert/strict");
const domain = require("./sw-update-handover.js");

function rootWith(overrides = {}) {
  const fileSnapshot = {
    dirty: false,
    operationInFlight: false,
    saveInFlight: false,
    queuedSaveCount: 0,
    ...(overrides.file ?? {}),
  };
  const gestureSnapshot = {
    activeRangeCount: 0,
    pendingRangeCount: 0,
    activeKeyCount: 0,
    activePointerCount: 0,
    current: null,
    ...(overrides.gestures ?? {}),
  };
  const durabilitySnapshot = {
    pendingCount: 0,
    ...(overrides.durability ?? {}),
  };
  const transportSnapshot = {
    phase: "stopped",
    playing: false,
    requested: null,
    applied: null,
    stopRequest: null,
    ...(overrides.transport ?? {}),
  };
  const writerSnapshot = {
    mode: "writer",
    canWrite: true,
    ...(overrides.writer ?? {}),
  };
  const serviceWorkerListeners = new Map();
  const bootstrapCalls = [];
  let reloads = 0;
  let timeoutCallback = null;
  return {
    BRKTRKProjectFileSession: {
      snapshot: () => fileSnapshot,
      subscribe: () => () => {},
    },
    BRKTRKInputSafety: {
      snapshotContinuousGestures: () => gestureSnapshot,
      snapshotContinuousDurability: () => durabilitySnapshot,
      finalizeAllContinuousGestures: () => ({ ok: true, notificationErrors: [] }),
    },
    BRKTRKStores: {
      transport: {
        runtime: { snapshot: () => transportSnapshot },
        subscribe: () => () => {},
      },
    },
    BRKTRKBrowserWriterAuthority: {
      snapshot: () => writerSnapshot,
      canWrite: () => writerSnapshot.mode === "writer" && writerSnapshot.canWrite !== false,
    },
    BRKTRKBootstrapInput: {
      block: (reason) => { bootstrapCalls.push(["block", reason]); return true; },
      release: (reason) => { bootstrapCalls.push(["release", reason]); return true; },
    },
    navigator: {
      serviceWorker: {
        controller: { scriptURL: "https://example.test/sw-old.js" },
        addEventListener: (type, listener) => serviceWorkerListeners.set(type, listener),
      },
    },
    location: { reload: () => { reloads += 1; } },
    setTimeout: (callback) => { timeoutCallback = callback; return 1; },
    clearTimeout: () => { timeoutCallback = null; },
    setStatus() {},
    __test: {
      fileSnapshot,
      gestureSnapshot,
      durabilitySnapshot,
      transportSnapshot,
      writerSnapshot,
      serviceWorkerListeners,
      bootstrapCalls,
      reloads: () => reloads,
      fireTimeout() {
        const callback = timeoutCallback;
        timeoutCallback = null;
        callback?.();
      },
    },
  };
}

function reasons(overrides) {
  return domain.evaluateHandoverSafety(rootWith(overrides)).reasons;
}

assert.equal(domain.evaluateHandoverSafety(rootWith()).safe, true, "clean stopped writer must be handover-safe");
assert.deepEqual(reasons({ file: { dirty: true } }), ["project-dirty"]);
assert.deepEqual(reasons({ file: { operationInFlight: true } }), ["file-operation-in-flight"]);
assert.deepEqual(reasons({ file: { saveInFlight: true } }), ["save-in-flight"]);
assert.deepEqual(reasons({ file: { queuedSaveCount: 2 } }), ["save-in-flight"]);
assert.deepEqual(reasons({ gestures: { activePointerCount: 1 } }), ["gesture-active"]);
assert.deepEqual(reasons({ gestures: { current: { gestureId: "sound-drag:1" } } }), ["gesture-active"]);
assert.deepEqual(reasons({ durability: { pendingCount: 1 } }), ["gesture-durability-pending"]);
assert.deepEqual(reasons({ transport: { phase: "stopping", playing: false, stopRequest: { id: "transport-1" } } }), ["transport-not-stopped"]);
assert.deepEqual(reasons({ transport: { phase: "starting", playing: true, requested: { id: "transport-2" } } }), ["transport-not-stopped"]);
assert.deepEqual(reasons({ writer: { mode: "blocked", canWrite: false } }), ["not-browser-writer"]);

{
  const root = rootWith();
  delete root.BRKTRKProjectFileSession.snapshot().operationInFlight;
  assert.deepEqual(domain.evaluateHandoverSafety(root).reasons, ["file-operation-state-unavailable"],
    "handover must fail closed until FileSession exposes general operation state");
}

{
  const result = domain.evaluateHandoverSafety(rootWith({
    file: { dirty: true, operationInFlight: true, saveInFlight: true },
    gestures: { activeRangeCount: 1 },
    durability: { pendingCount: 1 },
    transport: { phase: "playing", playing: true, applied: { id: "transport-3" } },
    writer: { mode: "blocked", canWrite: false },
  }));
  assert.equal(result.safe, false);
  assert.deepEqual(result.reasons, [
    "project-dirty",
    "file-operation-in-flight",
    "save-in-flight",
    "gesture-active",
    "gesture-durability-pending",
    "transport-not-stopped",
    "not-browser-writer",
  ]);
}

function controllerHarness(overrides = {}) {
  const root = rootWith(overrides);
  const posted = [];
  const worker = {
    scriptURL: "https://example.test/sw-new.js",
    state: "installed",
    postMessage: (message) => posted.push(message),
  };
  const registration = {
    waiting: worker,
    installing: null,
    addEventListener() {},
  };
  const controller = domain.createController(root, registration);
  return { root, registration, worker, posted, controller };
}

function documentStub() {
  const make = (tag) => {
    const node = {
      tagName: String(tag).toUpperCase(),
      children: [],
      dataset: {},
      style: { cssText: "" },
      attributes: {},
      listeners: {},
      textContent: "",
      hidden: false,
      disabled: false,
      parent: null,
      setAttribute(name, value) { this.attributes[name] = String(value); },
      getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; },
      addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); },
      click() { for (const listener of this.listeners.click ?? []) listener(); },
      append(...nodes) { for (const child of nodes) { child.parent = this; this.children.push(child); } },
      remove() {
        if (!this.parent) return;
        const index = this.parent.children.indexOf(this);
        if (index >= 0) this.parent.children.splice(index, 1);
        this.parent = null;
      },
      matches(selector) {
        if (selector.startsWith("#")) return this.id === selector.slice(1);
        const dataMatch = /^\[data-([a-z-]+)\]$/.exec(selector);
        if (dataMatch) return Object.hasOwn(this.dataset, camel(dataMatch[1]));
        const buttonMatch = /^button\[data-([a-z-]+)\]$/.exec(selector);
        if (buttonMatch) return this.tagName === "BUTTON" && Object.hasOwn(this.dataset, camel(buttonMatch[1]));
        return false;
      },
      querySelector(selector) {
        for (const child of this.children) {
          if (child.matches(selector)) return child;
          const nested = child.querySelector(selector);
          if (nested) return nested;
        }
        return null;
      },
    };
    return node;
  };
  const camel = (value) => value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  const body = make("body");
  return { body, createElement: make, querySelector: (selector) => body.querySelector(selector) };
}

function panelHarness(overrides = {}) {
  const root = rootWith(overrides);
  const document = documentStub();
  root.document = document;
  const worker = {
    scriptURL: "https://example.test/sw-new.js",
    state: "installed",
    postMessage() {},
  };
  const registration = { waiting: worker, installing: null, addEventListener() {} };
  const controller = domain.createController(root, registration);
  return { root, document, worker, registration, controller };
}

(async () => {
  {
    const h = controllerHarness({ file: { dirty: true } });
    assert.equal(h.controller.snapshot().updateReady, true);
    assert.equal(await h.controller.requestHandover(), false, "dirty project must reject explicit activation");
    assert.deepEqual(h.posted, [], "dirty project must not message waiting worker");
    assert.equal(h.root.__test.reloads(), 0);
  }

  {
    const h = controllerHarness({ file: { operationInFlight: true, saveInFlight: true } });
    assert.equal(await h.controller.requestHandover(), false, "file operation must reject explicit activation");
    assert.deepEqual(h.posted, []);
  }

  {
    const h = controllerHarness({ gestures: { activePointerCount: 1 } });
    assert.equal(await h.controller.requestHandover(), false, "active gesture must reject explicit activation when finalization does not clear owner state");
    assert.deepEqual(h.posted, []);
  }

  {
    const h = controllerHarness({ transport: { phase: "stopping", playing: false, stopRequest: { id: "transport-4" } } });
    assert.equal(await h.controller.requestHandover(), false, "transport stopping is not stopped");
    assert.deepEqual(h.posted, []);
  }

  {
    const h = controllerHarness({ writer: { mode: "blocked", canWrite: false } });
    assert.equal(await h.controller.requestHandover(), false, "non-writer context must never activate waiting worker");
    assert.deepEqual(h.posted, []);
  }

  {
    const h = controllerHarness();
    assert.equal(await h.controller.requestHandover(), true, "clean stopped writer may explicitly approve update");
    assert.deepEqual(h.posted, [{ type: domain.UPDATE_MESSAGE }], "approved handover must send exactly one activation request");
    assert.deepEqual(h.root.__test.bootstrapCalls, [["block", "sw-update-handover"]]);
    assert.equal(h.root.__test.reloads(), 0, "approval alone must not reload before controllerchange");
    const controllerChange = h.root.__test.serviceWorkerListeners.get("controllerchange");
    assert.equal(typeof controllerChange, "function");
    controllerChange();
    assert.equal(h.root.__test.reloads(), 1, "initiating writer reloads exactly after controllerchange");
    controllerChange();
    assert.equal(h.root.__test.reloads(), 1, "controllerchange cannot double-reload after approval is consumed");
  }

  {
    const h = controllerHarness();
    assert.equal(await h.controller.requestHandover(), true, "safe approval must begin irreversible activation attempt");
    h.root.__test.fireTimeout();
    assert.equal(h.root.__test.reloads(), 1, "controllerchange timeout must reload rather than revive the stale editor runtime");
    assert.deepEqual(h.root.__test.bootstrapCalls, [["block", "sw-update-handover"]],
      "activation timeout must never release editor input after skipWaiting was requested");
    assert.equal(h.controller.snapshot().phase, "reloading");
    assert.equal(h.controller.snapshot().error, "controllerchange-timeout");
    const controllerChange = h.root.__test.serviceWorkerListeners.get("controllerchange");
    controllerChange();
    assert.equal(h.root.__test.reloads(), 1, "late controllerchange after fallback reload cannot double-reload");
  }

  // #298: the blocked notice sits fixed over the bottom of the editor, exactly
  // where the Sound parameter controls are, and the only actions that unblock
  // it (save, stop) happen underneath it. It must be dismissible.
  {
    const h = panelHarness({ file: { dirty: true } });
    const panel = () => h.document.querySelector("#swUpdateStatus");
    assert.ok(panel(), "a waiting worker must surface the notice");
    assert.equal(panel().querySelector("[data-sw-update-message]").textContent,
      "UPDATE READY · BLOCKED: project-dirty");
    assert.equal(panel().style.display, "none", "unsafe update must not cover the editor with an unusable Apply action");
    assert.equal(panel().dataset.deferred, "true", "deferred status stays available to diagnostics and the DOM");
    assert.equal(panel().querySelector("button[data-sw-update-apply]").disabled, true);
    assert.deepEqual(h.controller.snapshot().blockedReasons, ["project-dirty"]);
    // The update remains pending and becomes visible once actually actionable.
    h.root.__test.fileSnapshot.dirty = false;
    h.controller.render();
    assert.equal(panel().style.display, "flex", "safe update should be discoverable without another reload");
    assert.equal(panel().querySelector("button[data-sw-update-apply]").disabled, false);
    const dismiss = panel().querySelector("button[data-sw-update-dismiss]");
    assert.ok(dismiss, "the notice must carry a dismiss control");
    assert.equal(dismiss.getAttribute("aria-label"), "Hide the update notice");

    dismiss.click();
    assert.equal(panel(), null, "dismissing must take the notice out of the layout");
    assert.equal(h.controller.snapshot().dismissed, true);
    assert.equal(h.controller.snapshot().updateReady, true, "dismissing must not discard the pending update");
    assert.deepEqual(h.controller.snapshot().blockedReasons, [],
      "a dismissed safe notice must not invent blocked reasons");

    h.controller.render();
    assert.equal(panel(), null, "a later render must not resurrect a dismissed notice");

    // The notice returns only at a fresh blocked -> safe transition after dismissal.
    h.root.__test.fileSnapshot.dirty = true;
    h.controller.render();
    assert.equal(panel(), null, "safety-blocked state must stay non-obscuring");
    assert.deepEqual(h.controller.snapshot().blockedReasons, ["project-dirty"],
      "deferred update must preserve exact safety evidence");
    h.root.__test.fileSnapshot.dirty = false;
    h.controller.render();
    assert.ok(panel(), "the notice must return once the update becomes applicable");
    assert.equal(h.controller.snapshot().dismissed, false);
    assert.equal(panel().querySelector("[data-sw-update-message]").textContent,
      "UPDATE READY · SAFE TO RELOAD");
  }

  {
    // A handover in flight locks the editor and reloads the page; it may not be hidden.
    const h = panelHarness();
    assert.equal(await h.controller.requestHandover(), true);
    const dismiss = h.document.querySelector("#swUpdateStatus")?.querySelector("button[data-sw-update-dismiss]");
    assert.ok(dismiss);
    assert.equal(dismiss.hidden, true, "an activating handover must not offer a dismiss control");
  }

  console.log("Service Worker update handover safety/controller tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
