const fs = require("node:fs");
const path = require("node:path");

const {
    getProjectRoot
} = require("./runtime/file-manager");

const {
    validateIntegrationOutput,
    writeIntegratedFiles
} = require("./orchestrator/integration-engine");

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

const projectSlug = "devteam-integration-engine-test";
const projectRoot = getProjectRoot(projectSlug);
const runId = "integration-test-run-001";

const integrationRoot = path.join(
    projectRoot,
    ".devteam",
    "integrated",
    runId
);

try {
    fs.rmSync(
        path.join(projectRoot, ".devteam", "integrated"),
        { recursive: true, force: true }
    );
} catch {}

test("Valid integration output is accepted", () => {
    const result = validateIntegrationOutput({
        summary: "Test application",
        files: [
            {
                path: "src/app.js",
                content: "console.log('Hello');"
            }
        ]
    });

    if (result.files.length !== 1) {
        throw new Error("Expected exactly one file.");
    }
});

test("Path traversal is rejected", () => {
    let rejected = false;

    try {
        validateIntegrationOutput({
            files: [
                {
                    path: "../outside.js",
                    content: "unsafe"
                }
            ]
        });
    } catch {
        rejected = true;
    }

    if (!rejected) {
        throw new Error("Path traversal was accepted.");
    }
});

test("Environment files are rejected", () => {
    let rejected = false;

    try {
        validateIntegrationOutput({
            files: [
                {
                    path: ".env",
                    content: "SECRET=value"
                }
            ]
        });
    } catch {
        rejected = true;
    }

    if (!rejected) {
        throw new Error("Environment file was accepted.");
    }
});

test("Integrated files are written to isolated run staging", () => {
    const written = writeIntegratedFiles(
        projectRoot,
        [
            {
                path: "src/app.js",
                content: "console.log('DevTeamAI');"
            }
        ],
        runId
    );

    const expectedPath = path.join(
        integrationRoot,
        "src",
        "app.js"
    );

    if (!fs.existsSync(expectedPath)) {
        throw new Error(`Integrated file was not created: ${expectedPath}`);
    }

    if (written.length !== 1) {
        throw new Error("Expected one written file.");
    }

    if (!written[0].path.includes(runId)) {
        throw new Error("File was not written to the requested run.");
    }

    const content = fs.readFileSync(expectedPath, "utf8");

    if (!content.includes("DevTeamAI")) {
        throw new Error("Integrated file content does not match.");
    }
});

test("Existing integrated files cannot be overwritten", () => {
    let rejected = false;

    try {
        writeIntegratedFiles(
            projectRoot,
            [
                {
                    path: "src/app.js",
                    content: "console.log('Overwrite');"
                }
            ],
            runId
        );
    } catch {
        rejected = true;
    }

    if (!rejected) {
        throw new Error("Existing file was overwritten.");
    }

    const existingFile = path.join(
        integrationRoot,
        "src",
        "app.js"
    );

    const content = fs.readFileSync(existingFile, "utf8");

    if (!content.includes("DevTeamAI")) {
        throw new Error("Original integrated content was modified.");
    }
});

test("Root-level application files are supported", () => {
    const rootRunId = "integration-root-file-test";

    const written = writeIntegratedFiles(
        projectRoot,
        [
            {
                path: "index.html",
                content: "<h1>DevTeamAI</h1>"
            }
        ],
        rootRunId
    );

    const expectedPath = path.join(
        projectRoot,
        ".devteam",
        "integrated",
        rootRunId,
        "index.html"
    );

    if (!fs.existsSync(expectedPath) || written.length !== 1) {
        throw new Error("Root-level file was not created.");
    }
});

console.log(`\nIntegration Engine Tests: ${passed}/6 passed`);

try {
    fs.rmSync(projectRoot, {
        recursive: true,
        force: true
    });
    console.log("Temporary test project cleaned up.");
} catch (error) {
    console.warn("Cleanup warning:", error.message);
}

if (passed !== 6) {
    process.exitCode = 1;
}
