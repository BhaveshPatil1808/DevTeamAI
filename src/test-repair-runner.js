const assert = require("node:assert/strict");

const {
    selectRepairIssue,
    agentForPath,
    safeRelative,
    MAX_REPAIR_ATTEMPTS
} = require("./orchestrator/repair-runner");

let passed = 0;

function test(name, callback) {
    try {
        callback();
        passed++;
        console.log(`PASS: ${name}`);
    } catch (error) {
        console.error(`FAIL: ${name}`);
        console.error(error.message);
        process.exitCode = 1;
    }
}

test("Missing frontend asset selects frontend specialist", () => {
    const issue = selectRepairIssue({
        checks: [{
            name: "html_references",
            status: "failed",
            missing: [{
                html: "index.html",
                reference: "./src/app.js"
            }]
        }]
    });

    assert.equal(issue.targetPath, "src/app.js");
    assert.equal(issue.agentId, "frontend-developer");
});

test("JavaScript syntax error identifies backend specialist", () => {
    const issue = selectRepairIssue({
        checks: [{
            name: "javascript_syntax",
            status: "failed",
            results: [{
                path: "server.js",
                status: "failed",
                message: "Unexpected token"
            }]
        }]
    });

    assert.equal(issue.targetPath, "server.js");
    assert.equal(issue.agentId, "backend-developer");
});

test("Empty file identifies its responsible specialist", () => {
    const issue = selectRepairIssue({
        checks: [{
            name: "non_empty_files",
            status: "failed",
            files: ["index.html"]
        }]
    });

    assert.equal(issue.targetPath, "index.html");
    assert.equal(issue.agentId, "frontend-developer");
});

test("Unsafe HTML reference selects its HTML file", () => {
    const issue = selectRepairIssue({
        checks: [{
            name: "html_references",
            status: "failed",
            unsafe: [{
                html: "index.html",
                reference: "../../outside.js"
            }]
        }]
    });

    assert.equal(issue.targetPath, "index.html");
    assert.equal(issue.agentId, "frontend-developer");
});

test("Unsafe traversal paths are rejected", () => {
    assert.throws(() => safeRelative("../outside.js"));
    assert.throws(() => safeRelative(".env"));
});

test("Repair attempts are strictly limited to two", () => {
    assert.equal(MAX_REPAIR_ATTEMPTS, 2);
});

console.log(`\n${passed}/6 repair tests passed.`);
