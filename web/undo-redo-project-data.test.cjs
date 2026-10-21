const assert = require("node:assert/strict");
const undo = require("./undo-redo.js");

const target = { schemaVersion: 3, projectName: "TARGET" };
Object.defineProperty(target, "instruments", {
  configurable: true,
  enumerable: false,
  writable: true,
  value: [{ params: [0, 1, 2, 3, 4, 5] }],
});

const snapshot = JSON.parse('{"schemaVersion":3,"projectName":"RESTORED","__proto__":{"keep":true},"futureField":{"nested":7}}');
Object.defineProperty(snapshot, "instruments", {
  configurable: true,
  enumerable: false,
  writable: true,
  value: [{ params: [9, 8, 7, 6, 5, 4] }],
});

undo.replaceObjectState(target, snapshot);
assert.equal(target.projectName, "RESTORED");
assert.equal(Object.hasOwn(target, "__proto__"), true);
assert.deepEqual(target.__proto__, { keep: true });
assert.equal(Object.getPrototypeOf(target), Object.prototype, "history restore must not allow __proto__ data to change project prototype");
assert.deepEqual(target.futureField, { nested: 7 });
assert.equal(Object.keys(target).includes("instruments"), false, "history restore must keep runtime preview Instruments non-enumerable");
assert.deepEqual(target.instruments[0].params, [9, 8, 7, 6, 5, 4]);

{
  const project = { schemaVersion: 3, tempo: 120 };
  const subscribers = new Map();
  const store = {
    getState: () => project,
    subscribe(channel, listener) {
      subscribers.set(channel, listener);
      return () => subscribers.delete(channel);
    },
    publish(changeSet, channels) {
      for (const channel of channels) subscribers.get(channel)?.(changeSet, project);
    },
  };
  const root = { BRKTRKStores: { project: store }, setStatus() {}, renderAll() {} };
  const controller = undo.install(root, { projectStore: store, limit: 8 });
  project.tempo = 130;
  store.publish({ target: "project.tempo", persistsProject: true, source: "unit" }, ["persistence"]);
  assert.equal(controller.snapshot().undoDepth, 1, "pre-replacement edit must enter history");
  controller.reset("project-open");
  assert.equal(controller.snapshot().undoDepth, 0, "project replacement must clear Undo history");
  assert.equal(controller.snapshot().redoDepth, 0, "project replacement must clear Redo history");
  assert.equal(controller.snapshot().lastInvalidation.reason, "project-open");
  assert.equal(controller.undo().ok, false, "cleared history must not restore the previous project after Open/New");
  assert.equal(project.tempo, 130);
  controller.dispose();
}

console.log("Undo/Redo project replacement safety tests passed");
