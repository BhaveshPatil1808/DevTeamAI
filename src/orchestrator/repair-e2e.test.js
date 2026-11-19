
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const {
    writeIntegratedFiles
} = require("./integration-engine");

const {
    runStaticQA
} = require("./qa-runner");

const {
    runApprovedFunctionalTests
} = require("./functional-test-runner");

const {
    runAutomatedRepair
} = require("./repair-runner");


test(
    "repairs a broken application using an injected specialist, creates a new snapshot and passes retests",
    { timeout: 60000 },
    async () => {
        const projectRoot = fs.mkdtempSync(
            path.join(os.tmpdir(), "devteam-repair-e2e-")
        );

        const runId = randomUUID();
        const firstSnapshotId = randomUUID();

        let mockCalled = 0;

        try {
            const initialFiles = [
                {
                    path: "package.json",
                    content: JSON.stringify({
                        name: "devteam-repair-e2e",
                        version: "1.0.0",
                        private: true
                    }, null, 2)
                },
                {
                    path: "src/app.js",
                    content: `
function calculateTotal(a, b) {
    throw new Error("Temporary application failure");
}

module.exports = { calculateTotal };
`
                },
                {
                    path: "tests/app.test.js",
                    content: `
const test = require("node:test");
const assert = require("node:assert/strict");

const { calculateTotal } = require("../src/app");

test("calculateTotal adds two numbers", () => {
    assert.equal(calculateTotal(2, 3), 5);
});
`
                }
            ];

            // Create the initial immutable integration snapshot.
            const initialSnapshotFiles = writeIntegratedFiles(
                projectRoot,
                initialFiles,
                runId,
                firstSnapshotId
            );

            assert.equal(
                initialSnapshotFiles.length,
                initialFiles.length
            );

            // Static QA must pass before the functional test.
            const initialQA = await runStaticQA({
                projectRoot,
                runId: firstSnapshotId,
                integrationFiles: initialSnapshotFiles
            });

            assert.equal(
                initialQA.status,
                "passed",
                "Initial application should pass static QA"
            );

            // Execute the actual native Node.js test runner.
            const initialFunctionalResult =
                await runApprovedFunctionalTests({
                    projectRoot,
                    runId,
                    snapshotRunId: firstSnapshotId,
                    integrationFiles: initialSnapshotFiles,
                    approved: true
                });

            assert.equal(
                initialFunctionalResult.status,
                "failed",
                "The intentionally broken application should fail"
            );

            // This mock must be used instead of the real AI provider.
            const mockSpecialist = async ({ task }) => {
                mockCalled++;

                // src/app.js is classified as a frontend file
                // by the current agentForPath() implementation.
                assert.equal(
                    task.agentId,
                    "frontend-developer"
                );

                return {
                    agentName: "Mock Frontend Developer",
                    summary: "Fixed calculateTotal implementation",
                    files: [
                        {
                            path: "src/app.js",
                            content: `
function calculateTotal(a, b) {
    return a + b;
}

module.exports = { calculateTotal };
`
                        }
                    ]
                };
            };

            // Run the real repair engine with the injected mock.
            const repairResult = await runAutomatedRepair({
                projectRoot,
                projectName: "DevTeamAI Repair Test",
                description:
                    "Create a reliable function that adds two numbers.",
                plan: {
                    summary: "Small Node.js application",
                    technologyStack: ["Node.js", "JavaScript"]
                },
                runId,
                snapshotRunId: firstSnapshotId,
                integrationFiles: initialSnapshotFiles,
                qaReport: initialQA,
                functionalResult: initialFunctionalResult,
                dependencies: {
                    executePlannedTask: mockSpecialist
                }
            });

            // Prove the injected mock was actually executed.
            assert.equal(
                mockCalled,
                1,
                "The injected mock specialist must be called exactly once"
            );

            assert.notEqual(
                repairResult.snapshotRunId,
                firstSnapshotId,
                "Repair must create a new immutable snapshot"
            );

            assert.equal(
                repairResult.qaReport.status,
                "passed",
                "Repaired snapshot must pass static QA"
            );

            assert.ok(
                repairResult.integrationFiles.length > 0,
                "Repaired snapshot must contain integrated files"
            );

            assert.equal(
                repairResult.attempts.length,
                1,
                "One functional repair attempt is expected"
            );

            assert.equal(
                repairResult.attempts[0].status,
                "passed"
            );

            // The original snapshot must remain unchanged.
            const originalApp = fs.readFileSync(
                path.join(
                    projectRoot,
                    ".devteam",
                    "integrated",
                    firstSnapshotId,
                    "src",
                    "app.js"
                ),
                "utf8"
            );

            assert.match(
                originalApp,
                /Temporary application failure/
            );

            // Run real functional tests against the repaired snapshot.
            const finalFunctionalResult =
                await runApprovedFunctionalTests({
                    projectRoot,
                    runId,
                    snapshotRunId: repairResult.snapshotRunId,
                    integrationFiles: repairResult.integrationFiles,
                    approved: true
                });

            assert.equal(
                finalFunctionalResult.status,
                "passed",
                "Functional tests must pass against the repaired snapshot"
            );

            console.log(
                "[REPAIR E2E] Injected mock called:",
                mockCalled,
                "time(s)."
            );

            console.log(
                "[REPAIR E2E] Original snapshot preserved."
            );

            console.log(
                "[REPAIR E2E] New snapshot created:",
                repairResult.snapshotRunId
            );

            console.log(
                "[REPAIR E2E] Static QA passed."
            );

            console.log(
                "[REPAIR E2E] Functional tests passed after repair."
            );

        } finally {
            fs.rmSync(projectRoot, {
                recursive: true,
                force: true
            });
        }
    }
);
