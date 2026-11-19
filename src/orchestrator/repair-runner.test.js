const test = require("node:test");
const assert = require("node:assert/strict");

const {
    isTestFile,
    findApplicationFileInDiagnostics,
    selectFunctionalRepairIssue
} = require("./repair-runner");

// --------------------------------------------------
// TEST FILE PROTECTION
// --------------------------------------------------

test("identifies common test files", () => {
    assert.equal(isTestFile("tests/app.test.js"), true);
    assert.equal(isTestFile("src/app.spec.js"), true);
    assert.equal(isTestFile("test_user.py"), true);
    assert.equal(isTestFile("src/test/java/AppTest.java"), true);
    assert.equal(isTestFile("tests/AppTests.cs"), true);
    assert.equal(isTestFile("src/main/app.go"), false);
});

test("does not classify normal application files as test files", () => {
    assert.equal(isTestFile("src/app.js"), false);
    assert.equal(isTestFile("src/services/user.py"), false);
    assert.equal(isTestFile("src/main.go"), false);
});

// --------------------------------------------------
// DIAGNOSTIC FILE IDENTIFICATION
// --------------------------------------------------

test("identifies an application file in an absolute Node.js stack trace", () => {
    const files = [
        { path: "src/app.js" },
        { path: "tests/app.test.js" }
    ];

    const output =
        "TypeError: Invalid value\n" +
        "    at calculate (/workspace/project/src/app.js:12:4)";

    assert.equal(
        findApplicationFileInDiagnostics(output, files),
        "src/app.js"
    );
});

test("identifies an application file in a Windows-style diagnostic", () => {
    const files = [
        { path: "src/app.js" }
    ];

    const output =
        "at calculate (C:\\workspace\\project\\src\\app.js:18:2)";

    assert.equal(
        findApplicationFileInDiagnostics(output, files),
        "src/app.js"
    );
});

test("identifies Python source files from traceback output", () => {
    const files = [
        { path: "src/app.py" },
        { path: "tests/test_app.py" }
    ];

    const output =
        'File "/workspace/project/src/app.py", line 25, in calculate';

    assert.equal(
        findApplicationFileInDiagnostics(output, files),
        "src/app.py"
    );
});

test("does not select a test file as an application repair target", () => {
    const files = [
        { path: "src/app.js" },
        { path: "tests/app.test.js" }
    ];

    const output = "Error at app.test.js:15:3";

    assert.equal(
        findApplicationFileInDiagnostics(output, files),
        null
    );
});

test("rejects ambiguous basename-only diagnostics", () => {
    const files = [
        { path: "src/api/index.js" },
        { path: "src/web/index.js" }
    ];

    const output = "Error at index.js:15:3";

    assert.equal(
        findApplicationFileInDiagnostics(output, files),
        null
    );
});

test("accepts a unique basename-only diagnostic", () => {
    const files = [
        { path: "src/app.js" },
        { path: "src/service.js" }
    ];

    const output = "at calculate (app.js:12:4)";

    assert.equal(
        findApplicationFileInDiagnostics(output, files),
        "src/app.js"
    );
});

test("rejects diagnostics that reference multiple application files", () => {
    const files = [
        { path: "src/app.js" },
        { path: "src/service.js" }
    ];

    const output =
        "Failure at src/app.js:12:4\n" +
        "Related failure at src/service.js:20:2";

    assert.equal(
        findApplicationFileInDiagnostics(output, files),
        null
    );
});

test("returns null when diagnostics do not identify a source file", () => {
    const files = [
        { path: "src/app.js" }
    ];

    assert.equal(
        findApplicationFileInDiagnostics(
            "AssertionError: expected true but received false",
            files
        ),
        null
    );
});

// --------------------------------------------------
// FUNCTIONAL REPAIR ISSUE SELECTION
// --------------------------------------------------

test("selects a repair issue for a failed test with source diagnostics", () => {
    const files = [
        { path: "src/app.js" },
        { path: "tests/app.test.js" }
    ];

    const functionalResult = {
        status: "failed",
        report: {
            results: [
                {
                    status: "failed",
                    command: "node --test",
                    exitCode: 1,
                    stdout: "",
                    stderr:
                        "TypeError: Invalid value\n" +
                        "at calculate (/workspace/project/src/app.js:12:4)"
                }
            ]
        }
    };

    const issue = selectFunctionalRepairIssue(
        functionalResult,
        files
    );

    assert.ok(issue);
    assert.equal(issue.check, "functional_tests");
    assert.equal(issue.targetPath, "src/app.js");
    assert.ok(issue.agentId);
    assert.match(issue.message, /Do not modify test files/i);
});

test("does not select a repair issue when the command errored", () => {
    const files = [
        { path: "src/app.js" }
    ];

    const functionalResult = {
        status: "failed",
        report: {
            results: [
                {
                    status: "error",
                    command: "node --test",
                    exitCode: null,
                    error: "Command could not start"
                }
            ]
        }
    };

    assert.equal(
        selectFunctionalRepairIssue(functionalResult, files),
        null
    );
});

test("does not select a repair issue without reliable source diagnostics", () => {
    const files = [
        { path: "src/app.js" }
    ];

    const functionalResult = {
        status: "failed",
        report: {
            results: [
                {
                    status: "failed",
                    command: "node --test",
                    exitCode: 1,
                    stderr: "AssertionError: expected 10 but received 5"
                }
            ]
        }
    };

    assert.equal(
        selectFunctionalRepairIssue(functionalResult, files),
        null
    );
});

test("does not select a repair issue when functional tests passed", () => {
    const functionalResult = {
        status: "passed",
        report: {
            results: []
        }
    };

    assert.equal(
        selectFunctionalRepairIssue(functionalResult, [
            { path: "src/app.js" }
        ]),
        null
    );
});