const assert = require("node:assert/strict");
const { duplicateFixedRowsTransform } = require("./structural-row-operations.js");

{
  const rows = Array.from({ length: 6 }, (_, index) => [index, index + 100]);
  const result = duplicateFixedRowsTransform(rows, 1, 2);
  assert.equal(result.insertionRow, 3);
  assert.equal(result.rowCount, 2);
  assert.deepEqual(result.rows, [
    [0, 100],
    [1, 101],
    [2, 102],
    [1, 101],
    [2, 102],
    [3, 103],
  ]);
  assert.deepEqual(result.truncatedRows, [[4, 104], [5, 105]]);
}

{
  const rows = Array.from({ length: 4 }, (_, index) => [index]);
  const result = duplicateFixedRowsTransform(rows, 2, 2);
  assert.equal(result.insertionRow, 4);
  assert.equal(result.rowCount, 0);
  assert.deepEqual(result.rows, rows);
}

{
  const rows = Array.from({ length: 4 }, (_, index) => [index]);
  const result = duplicateFixedRowsTransform(rows, 1, 3);
  assert.equal(result.insertionRow, 4);
  assert.equal(result.rowCount, 0);
}

{
  const rows = Array.from({ length: 4 }, (_, index) => [index]);
  const result = duplicateFixedRowsTransform(rows, 0, 3);
  assert.equal(result.insertionRow, 3);
  assert.equal(result.rowCount, 1);
  assert.deepEqual(result.rows, [[0], [1], [2], [0]]);
}

console.log("Structural row operation tests passed");
