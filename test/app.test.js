const test = require("node:test");
const assert = require("node:assert/strict");

test("application basic verification", () => {
  assert.equal(1 + 1, 2);
});