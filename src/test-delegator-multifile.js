const assert = require("node:assert/strict");
const {
    parseRawAgentOutput,
    validateOutput
} = require("./orchestrator/delegator");

const START = "<<<DEVTEAM_FILE_CONTENT_START_9F31C2>>>";
const END = "<<<DEVTEAM_FILE_CONTENT_END_9F31C2>>>";

function block(path, content) {
    return `FILE_PATH: ${path}\n${START}\n${content}\n${END}`;
}

const raw = [
    "DEVTEAM_OUTPUT_V1",
    "SUMMARY: Three test files",
    "",
    block("backend/server.js", "const server = true;"),
    "",
    block("frontend/index.html", "<h1>TaskFlow</h1>"),
    "",
    block("frontend/app.js", "console.log('ready');")
].join("\n");

const parsed = parseRawAgentOutput(raw);
assert.equal(parsed.files.length, 3);

const validated = validateOutput(parsed, "Test Agent");
assert.equal(validated.files.length, 3);

assert.throws(() => validateOutput({
    files: [
        { path: "src/app.js", content: "one" },
        { path: "src/app.js", content: "two" }
    ]
}, "Duplicate Test"));

assert.throws(() => validateOutput({
    files: [{ path: "../outside.js", content: "unsafe" }]
}, "Traversal Test"));

assert.throws(() => validateOutput({
    files: Array.from({ length: 5 }, (_, i) => ({
        path: `src/file${i}.js`,
        content: "valid"
    }))
}, "Count Test"));

assert.throws(() => validateOutput({
    files: [{ path: "src/large.js", content: "x".repeat(60001) }]
}, "File Size Test"));

assert.throws(() => validateOutput({
    files: Array.from({ length: 4 }, (_, i) => ({
        path: `src/large${i}.js`,
        content: "x".repeat(50000)
    }))
}, "Aggregate Size Test"));

assert.throws(() => parseRawAgentOutput(
    "DEVTEAM_OUTPUT_V1\nSUMMARY: Broken\nFILE_PATH: src/a.js"
));

console.log("PASS: Three-file raw parsing");
console.log("PASS: Multi-file validation");
console.log("PASS: Duplicate path rejection");
console.log("PASS: Traversal rejection");
console.log("PASS: Four-file maximum");
console.log("PASS: Individual size limit");
console.log("PASS: Aggregate size limit");
console.log("PASS: Malformed raw output rejection");
console.log("\nALL MULTI-FILE TESTS PASSED");
