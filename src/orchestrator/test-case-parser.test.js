"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    parseTestCaseCounts
} = require("./test-case-parser");

test("parses Node test runner summary", () => {
    const output = `
ℹ tests 4
ℹ pass 2
ℹ fail 1
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
`;

    assert.deepEqual(
        parseTestCaseCounts("node-native-tests", output),
        {
            measured: true,
            executed: 4,
            passed: 2,
            failed: 1,
            skipped: 1,
            source: "node-test",
            reason: null
        }
    );
});

test("parses pytest summary", () => {
    const output = "2 passed, 1 failed, 1 skipped in 0.12s";

    const result = parseTestCaseCounts("python-pytest", output);

    assert.equal(result.measured, true);
    assert.equal(result.executed, 4);
    assert.equal(result.passed, 2);
    assert.equal(result.failed, 1);
    assert.equal(result.skipped, 1);
});

test("parses Python unittest summary", () => {
    const output = `
Ran 5 tests in 0.01s

FAILED (failures=1, errors=1, skipped=1)
`;

    const result = parseTestCaseCounts(
        "python-unittest-standard",
        output
    );

    assert.equal(result.measured, true);
    assert.equal(result.executed, 5);
    assert.equal(result.passed, 2);
    assert.equal(result.failed, 2);
    assert.equal(result.skipped, 1);
});

test("parses Go JSON test events", () => {
    const output = [
        { Action: "pass", Package: "example/app", Test: "TestCreate" },
        { Action: "fail", Package: "example/app", Test: "TestDelete" },
        { Action: "skip", Package: "example/app", Test: "TestUpdate" }
    ].map(item => JSON.stringify(item)).join("\n");

    const result = parseTestCaseCounts("go-native-tests", output);

    assert.equal(result.measured, true);
    assert.equal(result.executed, 3);
    assert.equal(result.passed, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.skipped, 1);
});

test("parses Rust test summary", () => {
    const output = `
test result: ok. 3 passed; 1 failed; 2 ignored; 0 measured; 0 filtered out
`;

    const result = parseTestCaseCounts("rust-native-tests", output);

    assert.equal(result.measured, true);
    assert.equal(result.executed, 6);
    assert.equal(result.passed, 3);
    assert.equal(result.failed, 1);
    assert.equal(result.skipped, 2);
});

test("parses Maven aggregate summary", () => {
    const output = `
Results:

Tests run: 5, Failures: 1, Errors: 0, Skipped: 1
`;

    const result = parseTestCaseCounts("java-maven-tests", output);

    assert.equal(result.measured, true);
    assert.equal(result.executed, 5);
    assert.equal(result.passed, 3);
    assert.equal(result.failed, 1);
    assert.equal(result.skipped, 1);
});

test("parses .NET test summary", () => {
    const output =
        "Test summary: total: 5, failed: 1, succeeded: 3, skipped: 1";

    const result = parseTestCaseCounts("dotnet-native-tests", output);

    assert.equal(result.measured, true);
    assert.equal(result.executed, 5);
    assert.equal(result.passed, 3);
    assert.equal(result.failed, 1);
    assert.equal(result.skipped, 1);
});

test("does not invent counts when output has no summary", () => {
    const result = parseTestCaseCounts(
        "node-native-tests",
        "The process started but produced no test summary."
    );

    assert.equal(result.measured, false);
    assert.equal(result.executed, null);
});

test("does not accept inconsistent totals", () => {
    const result = parseTestCaseCounts(
        "node-native-tests",
        `
ℹ tests 5
ℹ pass 2
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
`
    );

    assert.equal(result.measured, false);
});