const assert = require("node:assert/strict");

const {
    validateIntegrationOutput
} = require("./orchestrator/integration-engine");

function makeFiles(count, content = "console.log('test');") {
    return Array.from({ length: count }, (_, index) => ({
        path: `src/file-${index}.js`,
        content
    }));
}

function expectRejected(name, callback) {
    assert.throws(callback, undefined, name);
    console.log(`PASS: ${name}`);
}

const fourFiles = validateIntegrationOutput({
    summary: "Four-file application",
    files: makeFiles(4)
});

assert.equal(fourFiles.files.length, 4);
console.log("PASS: Four integrated files are accepted");

expectRejected("Five integrated files are rejected", () => {
    validateIntegrationOutput({
        files: makeFiles(5)
    });
});

expectRejected("A file larger than 60 KB is rejected", () => {
    validateIntegrationOutput({
        files: makeFiles(1, "x".repeat(60001))
    });
});

expectRejected("Total output larger than 180 KB is rejected", () => {
    validateIntegrationOutput({
        files: makeFiles(4, "x".repeat(45001))
    });
});

const maximumValidOutput = validateIntegrationOutput({
    files: makeFiles(4, "x".repeat(45000))
});

assert.equal(maximumValidOutput.files.length, 4);
console.log("PASS: Four files totalling exactly 180 KB are accepted");

console.log("\nALL INTEGRATION OUTPUT LIMIT TESTS PASSED");
