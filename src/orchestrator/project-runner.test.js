"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const { runProject } = require("./project-runner");
const { getSpecialistAgents } = require("../agents/registry");

const {
    getProjectRoot,
    writeAgentFiles
} = require("../runtime/file-manager");

const {
    saveCheckpoint
} = require("../runtime/checkpoint-manager");

const AGENT_ORDER = [
    "business-analyst",
    "solution-architect",
    "database-engineer",
    "backend-developer",
    "frontend-developer",
    "integration-engineer",
    "qa-engineer",
    "security-engineer",
    "devops-engineer"
];

const DEPENDENCIES = {
    "business-analyst": [],
    "solution-architect": ["business-analyst"],
    "database-engineer": ["solution-architect"],
    "backend-developer": ["solution-architect"],
    "frontend-developer": ["solution-architect"],
    "integration-engineer": [
        "backend-developer",
        "frontend-developer"
    ],
    "qa-engineer": ["integration-engineer"],
    "security-engineer": ["backend-developer"],
    "devops-engineer": [
        "backend-developer",
        "frontend-developer",
        "security-engineer"
    ]
};

function makeProjectName(label) {
    return `devteam-runner-test-${label}-${randomUUID().slice(0, 8)}`;
}

function makePlan() {
    const agents = new Map(
        getSpecialistAgents().map(agent => [agent.id, agent])
    );

    assert.equal(
        agents.size,
        9,
        "The specialist registry must contain exactly nine agents."
    );

    const tasks = AGENT_ORDER.map(agentId => {
        const agent = agents.get(agentId);

        assert.ok(agent, `Missing specialist: ${agentId}`);

        return {
            id: agentId,
            agentId,
            title: agent.name,
            task: `Implement the ${agentId} responsibility.`,
            description: `Implement the ${agentId} responsibility.`,
            dependsOn: DEPENDENCIES[agentId]
        };
    });

    return {
        summary: "Isolated Project Runner test plan.",
        technologyStack: ["Node.js", "JavaScript"],
        tasks
    };
}

function makeAgentResult(task) {
    return {
        agentName: task.agentId,
        summary: `Completed ${task.agentId}.`,
        provider: "test",
        model: "mock",
        usage: null,
        attempts: [],
        files: [{
            path: `src/${task.agentId}.js`,
            content: `"use strict";\n// ${task.agentId}\n`
        }]
    };
}

function makeIntegrationResult(runId) {
    return {
        status: "completed",
        runId,
        snapshotRunId: randomUUID(),
        summary: "Mock integration completed.",
        files: [{
            path: "src/index.js",
            bytes: 20
        }]
    };
}

function makePassedQA() {
    return {
        status: "passed",
        summary: {
            passed: 1,
            failed: 0,
            skipped: 0
        },
        checks: []
    };
}


function makePassedFunctionalResult(snapshotRunId) {
    return {
        status: "passed",
        approval: "granted",
        snapshotRunId,

        runtime: {
            status: "passed"
        },

        report: {
            summary: "All tests passed.",
            testsExecuted: 1,
            testsPassed: 1,
            testsFailed: 0,
            testsSkipped: 0,

            testCases: {
                measured: true,
                executed: 10,
                passed: 10,
                failed: 0,
                skipped: 0
            },

            testCaseEvidence: [{
                strategy: "node-native-tests",
                status: "passed",
                measured: true,
                executed: 10,
                passed: 10,
                failed: 0,
                skipped: 0,
                source: "node-tap"
            }],

            results: [{
                strategy: "node-native-tests",
                status: "passed",
                command: "node --test",
                exitCode: 0,
                stdout: "Tests passed",
                stderr: ""
            }]
        }
    };
}

function makeDependencies(overrides = {}) {
    return {
        createProjectPlan: async () => makePlan(),

        executePlannedTask: async ({ task }) =>
            makeAgentResult(task),

        integrateProject: async ({ runId }) =>
            makeIntegrationResult(runId),

        runStaticQA: async () =>
            makePassedQA(),

        runAutomatedRepair: async () => {
            throw new Error("Unexpected repair call in this test.");
        },

        runApprovedFunctionalTests: async () => {
            throw new Error(
                "Functional tests were not configured for this test."
            );
        },

        exportIntegratedProject: async ({
            projectRoot,
            snapshotRunId,
            integrationFiles
        }) => {
            const finalDirectory = path.join(
                projectRoot,
                "final"
            );

            fs.rmSync(finalDirectory, {
                recursive: true,
                force: true
            });

            for (const file of integrationFiles) {
                const relativePath = file.path;
                const absolutePath = path.join(
                    finalDirectory,
                    relativePath
                );

                fs.mkdirSync(path.dirname(absolutePath), {
                    recursive: true
                });

                fs.writeFileSync(
                    absolutePath,
                    "// Test export file\n",
                    "utf8"
                );
            }

            return {
                directory: "final",
                fileCount: integrationFiles.length,
                files: integrationFiles.map(file => file.path),
                snapshotRunId
            };
        },

        ...overrides
    };
}


function removeTestProject(projectRoot) {
    if (!projectRoot) return;

    const expectedParent = path.resolve(
        __dirname,
        "../../workspace"
    );

    const resolved = path.resolve(projectRoot);

    if (
        path.dirname(resolved) !== expectedParent ||
        !path.basename(resolved).startsWith("devteam-runner-test-")
    ) {
        throw new Error(
            `Refusing to remove unexpected test directory: ${resolved}`
        );
    }

    fs.rmSync(resolved, {
        recursive: true,
        force: true
    });
}

function makeInitialState(projectName, runId) {
    const projectSlug = projectName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 50);

    const plan = makePlan();

    const tasks = plan.tasks.map(task => ({
        ...task,
        status: "pending",
        result: null,
        error: null
    }));

    return {
        projectName,
        projectSlug,
        runId,
        description: "Isolated resume test project.",
        status: "executing",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        plan,
        tasks,
        generatedFiles: [],
        integration: {
            status: "pending",
            summary: null,
            files: [],
            error: null,
            snapshotRunId: null
        },
        qa: {
            status: "pending",
            report: null,
            error: null,
            repair: null
        },
        verification: {
            status: "pending",
            approval: "not_granted",
            build: "not_run",
            functionalTests: "not_run",
            report: null,
            evidence: []
        },
        export: { status: "not_attempted", path: null, fileCount: 0, snapshotRunId: null }
    };
}


// --------------------------------------------------
// TEST 1: FUNCTIONAL FAILURE -> REPAIR -> RETEST
// --------------------------------------------------


test(
    "Project Runner repairs a functional failure using a new snapshot",
    async () => {
        const projectName = makeProjectName("repair");
        const runId = randomUUID();

        const projectRoot = getProjectRoot(
            projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-")
        );

        let repairCalls = 0;
        let functionalCalls = 0;
        let executedAgents = 0;

        const dependencies = makeDependencies({
            executePlannedTask: async ({ task }) => {
                executedAgents++;
                return makeAgentResult(task);
            },

            runApprovedFunctionalTests: async ({
                snapshotRunId,
                approved
            }) => {
                assert.equal(approved, true);

                functionalCalls++;

                // FIRST EXECUTION: deliberately fail.
                if (functionalCalls === 1) {
                    return {
                        status: "failed",
                        approval: "granted",
                        snapshotRunId,
                        error: "Intentional test failure.",

                        report: {
                            summary: "One test failed.",
                            testsExecuted: 1,
                            testsPassed: 0,
                            testsFailed: 1,

                            results: [{
                                status: "failed",
                                command: "node --test",
                                exitCode: 1,
                                stdout: "Assertion failed",
                                stderr: ""
                            }]
                        }
                    };
                }

                // SECOND EXECUTION: pass after repair.
                // SECOND EXECUTION: pass after repair.
                return {
                    status: "passed",
                    approval: "granted",
                    snapshotRunId,

                    runtime: {
                        status: "passed"
                    },

                    report: {
                        summary: "Tests passed after repair.",
                        testsExecuted: 1,
                        testsPassed: 1,
                        testsFailed: 0,
                        testsSkipped: 0,

                        testCases: {
                            measured: true,
                            executed: 10,
                            passed: 10,
                            failed: 0,
                            skipped: 0
                        },

                        testCaseEvidence: [{
                            strategy: "node-native-tests",
                            status: "passed",
                            measured: true,
                            executed: 10,
                            passed: 10,
                            failed: 0,
                            skipped: 0,
                            source: "node-tap"
                        }],

                        results: [{
                            strategy: "node-native-tests",
                            status: "passed",
                            command: "node --test",
                            exitCode: 0,
                            stdout: "Tests passed",
                            stderr: ""
                        }]
                    }
                };
            },

            runAutomatedRepair: async ({
                snapshotRunId
            }) => {
                repairCalls++;

                const newSnapshotId = randomUUID();

                assert.notEqual(
                    newSnapshotId,
                    snapshotRunId
                );

                return {
                    status: "completed",

                    attempts: [{
                        attempt: 1,
                        status: "completed"
                    }],

                    snapshotRunId: newSnapshotId,

                    integrationFiles: [{
                        path: "src/index.js",
                        bytes: 20
                    }],

                    qaReport: makePassedQA()
                };
            }
        });

        try {
            const result = await runProject({
                projectName,
                description: "Test repair and functional retesting.",
                runId,
                approveFunctionalTests: true,
                dependencies
            });

            // Agent execution.
            assert.equal(executedAgents, 9);
            assert.equal(result.completed, 9);
            assert.equal(result.failed, 0);

            // Repair and retesting.
            assert.equal(repairCalls, 1);
            assert.equal(functionalCalls, 2);

            // Final QA.
            assert.equal(result.qaStatus, "passed");

            // Functional verification.
            assert.equal(
                result.verification.functionalTests,
                "passed"
            );

            assert.equal(
                result.verification.status,
                "verified"
            );

            // Project completion.
            assert.equal(result.status, "completed");

            // Repair-cycle evidence.
            assert.equal(
                result.verification.repairCycles.length,
                1
            );

            const cycle =
                result.verification.repairCycles[0];

            assert.equal(cycle.status, "verified");

            assert.ok(cycle.previousSnapshotId);
            assert.ok(cycle.newSnapshotId);

            assert.notEqual(
                cycle.previousSnapshotId,
                cycle.newSnapshotId
            );

            console.log(
                "[PROJECT RUNNER TEST] Repair cycle verified."
            );

        } finally {
            removeTestProject(projectRoot);
        }
    }
);




// --------------------------------------------------
// TEST 2: INVALID STRUCTURED TEST EVIDENCE
// --------------------------------------------------

test(
    "Project Runner rejects passed results with invalid test-case evidence",
    async t => {
        const scenarios = [
            {
                name: "missing aggregate test-case counts",
                mutate: result => {
                    delete result.report.testCases;
                }
            },
            {
                name: "unmeasured aggregate test-case counts",
                mutate: result => {
                    result.report.testCases.measured = false;
                }
            },
            {
                name: "inconsistent aggregate counters",
                mutate: result => {
                    result.report.testCases.executed = 11;
                }
            },
            {
                name: "missing per-strategy evidence",
                mutate: result => {
                    result.report.testCaseEvidence = [];
                }
            },
            {
                name: "duplicate per-strategy evidence",
                mutate: result => {
                    result.report.testCaseEvidence.push({
                        ...result.report.testCaseEvidence[0]
                    });
                }
            },
            {
                name: "passed result containing failed test cases",
                mutate: result => {
                    result.report.testCases.passed = 9;
                    result.report.testCases.failed = 1;

                    result.report.testCaseEvidence[0].passed = 9;
                    result.report.testCaseEvidence[0].failed = 1;
                }
            }
        ];

        for (const scenario of scenarios) {
            await t.test(scenario.name, async () => {
                const projectName = makeProjectName("invalid-evidence");
                const runId = randomUUID();

                const projectRoot = getProjectRoot(
                    projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-")
                );

                const dependencies = makeDependencies({
                    runApprovedFunctionalTests: async ({
                        snapshotRunId,
                        approved
                    }) => {
                        assert.equal(approved, true);

                        const result =
                            makePassedFunctionalResult(snapshotRunId);

                        scenario.mutate(result);

                        // Deliberately claims success despite invalid evidence.
                        return result;
                    }
                });

                try {
                    const result = await runProject({
                        projectName,
                        description: `Test invalid evidence: ${scenario.name}`,
                        runId,
                        approveFunctionalTests: true,
                        dependencies
                    });

                    assert.equal(
                        result.verification.status,
                        "error",
                        "Invalid evidence must not produce verified status."
                    );

                    assert.equal(
                        result.verification.functionalTests,
                        "error"
                    );

                    assert.deepEqual(
                        result.verification.evidence,
                        [],
                        "Invalid evidence must never become verification evidence."
                    );

                    assert.notEqual(
                        result.status,
                        "completed",
                        "A project with invalid test evidence must not be completed."
                    );
                } finally {
                    removeTestProject(projectRoot);
                }
            });
        }
    }
);



// --------------------------------------------------
// TEST 3: FAILED AGENT MUST NOT BE MARKED COMPLETED
// --------------------------------------------------

test(
    "Project Runner does not mark an agent completed after both attempts fail",
    async () => {
        const projectName = makeProjectName("failed-agent");
        const runId = randomUUID();

        const projectRoot = getProjectRoot(
            projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-")
        );

        let databaseAttempts = 0;

        const dependencies = makeDependencies({
            executePlannedTask: async ({ task }) => {
                if (task.agentId === "database-engineer") {
                    databaseAttempts++;

                    throw new Error(
                        "Intentional database agent failure."
                    );
                }

                return makeAgentResult(task);
            }
        });

        try {
            const result = await runProject({
                projectName,
                description: "Test failed-agent handling.",
                runId,
                approveFunctionalTests: false,
                dependencies
            });

            assert.equal(databaseAttempts, 2);

            const databaseTask = result.tasks.find(
                task => task.agentId === "database-engineer"
            );

            assert.ok(databaseTask);
            assert.equal(databaseTask.status, "failed");
            assert.equal(databaseTask.result, null);

            assert.equal(result.completed, 8);
            assert.equal(result.failed, 1);

            assert.notEqual(
                result.status,
                "completed"
            );

            console.log(
                "[PROJECT RUNNER TEST] Failed agent was not falsely completed."
            );

        } finally {
            removeTestProject(projectRoot);
        }
    }
);
