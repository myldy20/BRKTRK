const assert = require("node:assert/strict");
const { NavigationStore, createNavigationChangeSet } = require("./stores.js");

const state = {
  view: "phrase",
  focus: { pane: "phrase", row: 0, col: 0 },
  p3: { activeWorkspace: "phrase", parents: [] },
};
const store = new NavigationStore(state);
const calls = [];
let unsubscribeSecond = () => {};
let thirdInstalled = false;

store.subscribe("navigation", () => {
  calls.push("first");
  unsubscribeSecond();
  if (!thirdInstalled) {
    thirdInstalled = true;
    store.subscribe("navigation", () => calls.push("third"));
  }
});
unsubscribeSecond = store.subscribe("navigation", () => calls.push("second"));

const changeSet = createNavigationChangeSet({
  subtype: "test",
  target: "navigation.test",
  path: ["test"],
  before: 0,
  after: 1,
});

store.emit("navigation", changeSet);
assert.deepEqual(calls, ["first", "second"], "Current emit must use the subscriber snapshot captured at its start");

calls.length = 0;
store.emit("navigation", changeSet);
assert.deepEqual(calls, ["first", "third"], "Subscription changes must take effect on the next emit only");

console.log("Store subscriber snapshot tests passed");
