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

        runApprovedFunctionalTests: async ({
            snapshotRunId,
            approved
        }) => ({
            status: approved ? "passed" : "approval_required",
            snapshotRunId,
            report: {
                summary: approved
                    ? "Mock functional tests passed."
                    : "Functional-test approval is required."
            }
        }),

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
        }
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

                if (functionalCalls === 1) {
                    return {
                        status: "failed",
                        snapshotRunId,
                        error: "Intentional test failure.",
                        report: {
                            summary: "One test failed."
                        },
                        results: [{
                            status: "failed",
                            command: "node --test",
                            exitCode: 1,
                            stdout: "Assertion failed",
                            stderr: ""
                        }]
                    };
                }

                return {
                    status: "passed",
                    snapshotRunId,
                    report: {
                        summary: "Tests passed after repair."
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

            assert.equal(executedAgents, 9);
            assert.equal(result.completed, 9);
            assert.equal(result.failed, 0);

            assert.equal(repairCalls, 1);
            assert.equal(functionalCalls, 2);

            assert.equal(result.qaStatus, "passed");
            assert.equal(
                result.verification.functionalTests,
                "passed"
            );
            assert.equal(result.verification.status, "verified");
            assert.equal(result.status, "completed");

            assert.equal(
                result.verification.repairCycles.length,
                1
            );

            const cycle = result.verification.repairCycles[0];

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
// TEST 2: RESUME FROM A REAL CHECKPOINT
// --------------------------------------------------

test(
    "Project Runner resumes valid completed tasks and executes only unfinished tasks",
    async () => {
        const projectName = makeProjectName("resume");
        const projectSlug = projectName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 50);

        const runId = randomUUID();
        const projectRoot = getProjectRoot(projectSlug);

        let plannerCalls = 0;
        const executedAgents = [];

        try {
            const state = makeInitialState(
                projectName,
                runId
            );

            // Save eight valid completed tasks.
            // DevOps is deliberately left unfinished.
            for (const task of state.tasks) {
                if (task.agentId === "devops-engineer") {
                    continue;
                }

                const agentResult = makeAgentResult(task);

                const writtenFiles = writeAgentFiles(
                    projectRoot,
                    task.id,
                    agentResult.files,
                    runId
                );

                task.status = "completed";
                task.result = {
                    agentName: agentResult.agentName,
                    summary: agentResult.summary,
                    files: writtenFiles,
                    provider: "test",
                    model: "mock",
                    usage: null,
                    generationAttempts: []
                };

                state.generatedFiles.push(...writtenFiles);
            }

            saveCheckpoint(
                projectRoot,
                state,
                "test_interrupted_after_eight_agents"
            );

            const dependencies = makeDependencies({
                createProjectPlan: async () => {
                    plannerCalls++;
                    throw new Error(
                        "Planner must not run during resume."
                    );
                },

                executePlannedTask: async ({ task }) => {
                    executedAgents.push(task.agentId);
                    return makeAgentResult(task);
                }
            });

            const result = await runProject({
                projectName,
                description: "Resume the interrupted test project.",
                runId,
                resume: true,
                approveFunctionalTests: false,
                dependencies
            });

            assert.equal(plannerCalls, 0);

            assert.deepEqual(
                executedAgents,
                ["devops-engineer"]
            );

            assert.equal(result.totalTasks, 9);
            assert.equal(result.completed, 9);
            assert.equal(result.failed, 0);
            assert.equal(result.pending, 0);

            assert.equal(
                result.verification.functionalTests,
                "approval_required"
            );

            assert.equal(
                result.status,
                "verification_required"
            );

            assert.equal(
                result.recovery.resumedTaskIds.length,
                8
            );

            assert.deepEqual(
                result.recovery.resetTaskIds,
                ["devops-engineer"]
            );

            console.log(
                "[PROJECT RUNNER TEST] Checkpoint resume verified."
            );

        } finally {
            removeTestProject(projectRoot);
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
