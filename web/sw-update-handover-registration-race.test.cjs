const assert = require("node:assert/strict");
const domain = require("./sw-update-handover.js");

let stateChange = null;
const installing = {
  state: "installing",
  scriptURL: "https://example.test/sw-next.js",
  addEventListener(type, listener) {
    if (type === "statechange") stateChange = listener;
  },
};

const registration = {
  installing,
  waiting: null,
  addEventListener() {},
};

const root = {
  navigator: {
    serviceWorker: {
      controller: { scriptURL: "https://example.test/sw-current.js" },
      addEventListener() {},
    },
  },
  BRKTRKProjectFileSession: {
    snapshot: () => ({ dirty: false, operationInFlight: false, saveInFlight: false, queuedSaveCount: 0 }),
  },
  BRKTRKInputSafety: {
    snapshotContinuousGestures: () => ({
      activeRangeCount: 0,
      pendingRangeCount: 0,
      activeKeyCount: 0,
      activePointerCount: 0,
      current: null,
    }),
    snapshotContinuousDurability: () => ({ pendingCount: 0 }),
  },
  BRKTRKStores: {
    transport: {
      runtime: {
        snapshot: () => ({ phase: "stopped", playing: false, requested: null, applied: null, stopRequest: null }),
      },
    },
  },
  BRKTRKBrowserWriterAuthority: {
    snapshot: () => ({ mode: "writer", canWrite: true }),
    canWrite: () => true,
  },
};

const controller = domain.createController(root, registration);
assert.equal(typeof stateChange, "function",
  "coordinator must immediately watch a registration.installing worker that predates listener attachment");
assert.equal(controller.snapshot().updateReady, false);

registration.waiting = installing;
installing.state = "installed";
stateChange();

assert.equal(controller.snapshot().updateReady, true,
  "pre-existing installing worker must become UPDATE READY when it reaches installed/waiting");
assert.equal(controller.snapshot().phase, "ready");

console.log("Service Worker update pre-attached installing race: PASS");
