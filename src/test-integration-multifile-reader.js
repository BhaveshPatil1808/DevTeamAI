const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const { getProjectRoot } = require("./runtime/file-manager");
const {
    readGeneratedFiles
} = require("./orchestrator/integration-engine");

const projectSlug = "devteam-multifile-reader-test";
const projectRoot = getProjectRoot(projectSlug);
const runId = "multi-file-reader-test-001";

const generatedRoot = path.join(
    projectRoot,
    ".devteam",
    "generated",
    runId
);

function createAgentFile(agentId, relativePath, content) {
    const absolutePath = path.join(
        generatedRoot,
        agentId,
        relativePath
    );

    fs.mkdirSync(path.dirname(absolutePath), {
        recursive: true
    });

    fs.writeFileSync(absolutePath, content, "utf8");

    return {
        path: path.relative(projectRoot, absolutePath).replace(/\\/g, "/")
    };
}

try {
    fs.rmSync(projectRoot, {
        recursive: true,
        force: true
    });

    const generatedFiles = [
        createAgentFile(
            "backend-developer",
            "src/server.js",
            "B".repeat(500)
        ),
        createAgentFile(
            "backend-developer",
            "src/routes.js",
            "R".repeat(500)
        ),
        createAgentFile(
            "backend-developer",
            "src/services/tasks.js",
            "T".repeat(500)
        ),
        createAgentFile(
            "frontend-developer",
            "src/app.js",
            "F".repeat(400)
        )
    ];

    const artifacts = readGeneratedFiles(
        projectRoot,
        generatedFiles,
        runId
    );

    const backendFiles = artifacts.filter(
        item => item.agentId === "backend-developer"
    );

    const frontendFiles = artifacts.filter(
        item => item.agentId === "frontend-developer"
    );

    assert.equal(
        backendFiles.length,
        3,
        "All three backend files should be included."
    );

    assert.equal(
        frontendFiles.length,
        1,
        "The frontend file should be included."
    );

    const backendBytes = backendFiles.reduce(
        (sum, item) => sum + Buffer.byteLength(item.content, "utf8"),
        0
    );

    assert.ok(
        backendBytes <= 1800,
        "Backend files must respect the cumulative 1800-byte agent budget."
    );

    const totalBytes = artifacts.reduce(
        (sum, item) => sum + Buffer.byteLength(item.content, "utf8"),
        0
    );

    assert.ok(
        totalBytes <= 10000,
        "All artifacts must respect the 10 KB global input budget."
    );

    console.log("PASS: Multiple files from one agent are included.");
    console.log("PASS: Files from different agents are included.");
    console.log("PASS: Per-agent cumulative budget is respected.");
    console.log("PASS: Global input budget is respected.");

    console.log("\nIncluded artifacts:");

    for (const artifact of artifacts) {
        console.log(
            artifact.agentId + " -> " + artifact.path
        );
    }

    console.log("\nALL MULTI-FILE READER TESTS PASSED");

} finally {
    fs.rmSync(projectRoot, {
        recursive: true,
        force: true
    });

    console.log("Temporary test project cleaned up.");
}
