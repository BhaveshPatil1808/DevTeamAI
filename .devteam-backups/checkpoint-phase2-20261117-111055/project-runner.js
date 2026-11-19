
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const { createProjectPlan } = require("./planner");
const { executePlannedTask } = require("./delegator");
const { integrateProject } = require("./integration-engine");
const { runStaticQA } = require("./qa-runner");
const { runAutomatedRepair } = require("./repair-runner");
const {
    runApprovedFunctionalTests
} = require("./functional-test-runner");

const {
    getProjectRoot,
    writeAgentFiles
} = require("../runtime/file-manager");

const {
    saveProjectState,
    recordEvent
} = require("../runtime/project-store");

const MAX_AGENT_RECOVERY_ROUNDS = 1;
const AGENT_RECOVERY_DELAY_MS = 1500;

// --------------------------------------------------
// HELPERS
// --------------------------------------------------


function evaluateIntegrationGate(tasks, completedTaskIds, generatedFiles) {
    const requiredIntegrationAgents = new Set([
        "business-analyst",
        "solution-architect",
        "backend-developer",
        "frontend-developer",
        "integration-engineer"
    ]);

    const completedAgentIds = new Set(
        tasks
            .filter(task => completedTaskIds.has(task.id))
            .map(task => task.agentId)
    );

    const missingRequiredAgents = [
        ...requiredIntegrationAgents
    ].filter(agentId => !completedAgentIds.has(agentId));

    return {
        allowed:
            generatedFiles.length > 0 &&
            missingRequiredAgents.length === 0,
        missingRequiredAgents
    };
}

function slugify(value) {
    return String(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 50);
}

function readPreviousAgentFiles(projectRoot, generatedFiles) {
    const MAX_TOTAL_CONTEXT = 30000;
    const MAX_FILE_CONTEXT = 12000;

    let totalBytes = 0;
    const artifacts = [];

    for (const file of generatedFiles) {
        if (totalBytes >= MAX_TOTAL_CONTEXT) {
            break;
        }

        try {
            const absolutePath = path.resolve(projectRoot, file.path);
            const relative = path.relative(projectRoot, absolutePath);

            if (
                !relative ||
                relative === ".." ||
                relative.startsWith(".." + path.sep) ||
                path.isAbsolute(relative)
            ) {
                continue;
            }

            const stats = fs.lstatSync(absolutePath);

            if (!stats.isFile() || stats.isSymbolicLink()) {
                continue;
            }

            const remaining = MAX_TOTAL_CONTEXT - totalBytes;
            const allowedBytes = Math.min(
                MAX_FILE_CONTEXT,
                remaining
            );

            if (stats.size > allowedBytes) {
                artifacts.push(
                    `FILE: ${file.path}\n` +
                    `[File omitted: ${stats.size} bytes exceeds the remaining shared-context limit.]`
                );

                continue;
            }

            const content = fs.readFileSync(absolutePath, "utf8");

            artifacts.push(
                `FILE: ${file.path}\n` +
                `CONTENT:\n${content}`
            );

            totalBytes += Buffer.byteLength(content, "utf8");

        } catch (error) {
            console.warn(
                `[PROJECT] Could not read previous artifact ${file.path}: ${error.message}`
            );
        }
    }

    return artifacts.length
        ? artifacts.join("\n\n--- NEXT GENERATED FILE ---\n\n")
        : "No previous generated source files available.";
}

// --------------------------------------------------
// MAIN PROJECT RUNNER
// --------------------------------------------------

async function runProject({
    projectName,
    description,
    runId: suppliedRunId,
    approveFunctionalTests = false
}) {
    if (
        typeof projectName !== "string" ||
        !projectName.trim()
    ) {
        throw new Error("Please provide a valid project name.");
    }

    if (
        typeof description !== "string" ||
        !description.trim()
    ) {
        throw new Error("Please provide a project description.");
    }

    const projectSlug = slugify(projectName);

    if (!projectSlug) {
        throw new Error("Please provide a valid project name.");
    }

    const projectRoot = getProjectRoot(projectSlug);

    // Every project execution receives a unique ID.
    const runId = suppliedRunId || randomUUID();

    if (
        typeof runId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)
    ) {
        throw new Error("Invalid project run ID.");
    }

    console.log(`[PROJECT] Run ID: ${runId}`);

    const state = {
        projectName,
        projectSlug,
        runId,
        description,

        status: "planning",

        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),

        plan: null,
        tasks: [],
        generatedFiles: [],

        integration: {
            status: "pending",
            summary: null,
            files: [],
            error: null
        },

        qa: {
            status: "pending",
            report: null,
            error: null
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

    function persist() {
        state.updatedAt = new Date().toISOString();
        saveProjectState(projectRoot, state);
    }

    recordEvent(projectRoot, {
        type: "project.started",
        projectName,
        runId
    });

    persist();

    // --------------------------------------------------
    // STAGE 0: PLANNING
    // --------------------------------------------------

    console.log(`[PROJECT] Planning started: ${projectName}`);

    const plan = await createProjectPlan({
        projectName,
        description
    });

    state.plan = plan;
    state.status = "executing";

    state.tasks = plan.tasks.map(task => ({
        ...task,
        status: "pending",
        result: null,
        error: null
    }));

    recordEvent(projectRoot, {
        type: "project.plan_created",
        runId,
        taskCount: plan.tasks.length,
        technologyStack: plan.technologyStack
    });

    persist();

    const completed = new Set();
    const failed = new Set();
    const summaries = [];

    // --------------------------------------------------
    // STAGE 1: EXECUTE SPECIALIST AGENTS
    // --------------------------------------------------

    for (const task of state.tasks) {
        const blockedBy = task.dependsOn.filter(
            dependency => !completed.has(dependency)
        );

        if (blockedBy.length) {
            task.status = "skipped";

            task.error =
                `Blocked by unsuccessful dependencies: ${blockedBy.join(", ")}`;

            recordEvent(projectRoot, {
                type: "task.skipped",
                runId,
                taskId: task.id,
                reason: task.error
            });

            persist();
            continue;
        }

        task.status = "running";

        recordEvent(projectRoot, {
            type: "task.started",
            runId,
            taskId: task.id,
            agentId: task.agentId,
            title: task.title
        });

        persist();

        try {
            const previousFiles = readPreviousAgentFiles(
                projectRoot,
                state.generatedFiles
            );

            const context = `
PROJECT: ${projectName}

PROJECT RUN ID:
${runId}

USER REQUIREMENT:
${description}

PROJECT SUMMARY:
${plan.summary}

TECHNOLOGY STACK:
${plan.technologyStack.join(", ")}

PREVIOUS COMPLETED AGENT SUMMARIES:
${summaries.join("\n\n") || "No previous tasks."}

ACTUAL FILES GENERATED BY PREVIOUS AGENTS:
${previousFiles}

IMPORTANT COLLABORATION RULES:
1. Read and understand the previous agent files before implementing your task.
2. Reuse existing interfaces, names, data structures and contracts wherever appropriate.
3. Do not contradict or unnecessarily duplicate previous implementations.
4. If a previous implementation needs improvement, explain the required change in your summary.
5. Generate complete, usable source files.
6. Do not assume that files have been integrated into the live application.
7. All generated files are staged for review, not automatically deployed.
`;

            let result = null;
            let recoveryError = null;

            // The delegator already performs three generation attempts.
            // If all of them fail, give this specialist one more full
            // execution round before marking it failed.
            for (
                let recoveryRound = 0;
                recoveryRound <= MAX_AGENT_RECOVERY_ROUNDS;
                recoveryRound++
            ) {
                try {
                    if (recoveryRound > 0) {
                        task.status = "running";

                        recordEvent(projectRoot, {
                            type: "task.recovery_started",
                            runId,
                            taskId: task.id,
                            agentId: task.agentId,
                            recoveryRound,
                            previousError: recoveryError?.message || null
                        });

                        console.warn(
                            `[AGENT RECOVERY] ${task.agentId}: ` +
                            `Recovery round ${recoveryRound}/` +
                            `${MAX_AGENT_RECOVERY_ROUNDS}`
                        );

                        persist();

                        await new Promise(resolve =>
                            setTimeout(resolve, AGENT_RECOVERY_DELAY_MS)
                        );
                    }

                    const recoveryContext = recoveryRound > 0
                        ? context + `

PREVIOUS EXECUTION FAILURE:
${String(recoveryError?.message || "Unknown execution failure").slice(0, 2000)}

RECOVERY INSTRUCTIONS:
This is a recovery execution of the same assigned task.
Complete the original task. Do not assume the previous attempt saved files.
Follow all original output and file safety requirements.
`
                        : context;

                    result = await executePlannedTask({
                        task,
                        projectContext: recoveryContext
                    });

                    recoveryError = null;
                    break;

                } catch (error) {
                    recoveryError = error;

                    recordEvent(projectRoot, {
                        type: "task.recovery_attempt_failed",
                        runId,
                        taskId: task.id,
                        agentId: task.agentId,
                        recoveryRound,
                        error: error.message
                    });

                    console.error(
                        `[AGENT EXECUTION FAILED] ${task.agentId}: ` +
                        `Round ${recoveryRound + 1}: ${error.message}`
                    );
                }
            }

            if (!result) {
                throw recoveryError || new Error(
                    "Agent execution failed without a result."
                );
            }

            const writtenFiles = writeAgentFiles(
                projectRoot,
                task.id,
                result.files,
                runId
            );

            task.status = "completed";

            task.result = {
                agentName: result.agentName,
                summary: result.summary,
                files: writtenFiles,
                provider: result.provider,
                model: result.model,
                usage: result.usage,
                generationAttempts: result.attempts
            };

            completed.add(task.id);

            summaries.push(
                `${task.title} (${result.agentName}): ${result.summary}`
            );

            state.generatedFiles.push(...writtenFiles);

            recordEvent(projectRoot, {
                type: "task.completed",
                runId,
                taskId: task.id,
                agentId: task.agentId,
                provider: result.provider || null,
                model: result.model || null,
                generationAttempts: result.attempts || null,
                files: writtenFiles
            });

        } catch (error) {
            task.status = "failed";
            task.error = error.message;

            failed.add(task.id);

            recordEvent(projectRoot, {
                type: "task.failed",
                runId,
                taskId: task.id,
                agentId: task.agentId,
                error: error.message
            });

            console.error(
                `[TASK FAILED] ${task.id}: ${error.message}`
            );
        }

        persist();
    }

    // --------------------------------------------------
    // STAGE 2: INTEGRATION
    // --------------------------------------------------

    // Integration requires the five core delivery agents.
    // Database, QA, Security and DevOps are not integration blockers.
    const integrationGate = evaluateIntegrationGate(
        state.tasks,
        completed,
        state.generatedFiles
    );

    const canIntegrate = integrationGate.allowed;
    const missingRequiredAgents =
        integrationGate.missingRequiredAgents;

    if (canIntegrate) {
        state.status = "integrating";

        state.integration = {
            status: "running",
            summary: null,
            files: [],
            error: null
        };

        recordEvent(projectRoot, {
            type: "integration.started",
            runId,
            generatedFileCount: state.generatedFiles.length
        });

        persist();

        console.log(
            `[INTEGRATION] Starting integration for ${projectName}`
        );

        try {
            const integrationResult = await integrateProject({
                projectSlug,
                projectName,
                description,
                plan,
                generatedFiles: state.generatedFiles,
                runId
            });

            if (
                !integrationResult ||
                integrationResult.status !== "completed" ||
                !Array.isArray(integrationResult.files) ||
                integrationResult.files.length === 0
            ) {
                throw new Error(
                    "Integration did not produce valid output files."
                );
            }

            // Verify the integration run ID matches this project run.
            if (
                integrationResult.runId &&
                integrationResult.runId !== runId
            ) {
                throw new Error(
                    "Integration run ID does not match the project run ID."
                );
            }

            state.integration = {
                ...integrationResult,
                status: "completed",
                error: null
            };

            recordEvent(projectRoot, {
                type: "integration.completed",
                runId,
                status: state.integration.status,
                files: state.integration.files,
                summary: state.integration.summary || null
            });

            console.log(
                `[INTEGRATION] Finished with status: ${state.integration.status}`
            );

        } catch (error) {
            state.integration = {
                status: "failed",
                summary: null,
                files: [],
                error: error.message
            };

            recordEvent(projectRoot, {
                type: "integration.failed",
                runId,
                error: error.message
            });

            console.error(
                `[INTEGRATION FAILED] ${error.message}`
            );
        }

        persist();

    } else {
        state.integration = {
            status: "skipped",
            summary: null,
            files: [],
            error: missingRequiredAgents.length
                ? `Integration blocked. Required agents did not complete: ${missingRequiredAgents.join(", ")}`
                : "Integration skipped because no generated agent files are available."
        };

        recordEvent(projectRoot, {
            type: "integration.skipped",
            runId,
            reason: state.integration.error
        });

        persist();
    }

    // --------------------------------------------------

    // --------------------------------------------------
    // STAGE 3: STATIC QA + AUTOMATED REPAIR
    // --------------------------------------------------

    if (state.integration.status === "completed") {
        state.status = "testing";

        state.qa = {
            status: "running",
            report: null,
            error: null,
            repair: null
        };

        recordEvent(projectRoot, {
            type: "qa.started",
            runId,
            integrationFileCount: state.integration.files.length
        });

        persist();

        console.log(`[QA] Starting static QA for ${projectName}`);

        try {
            let qaReport = await runStaticQA({
                projectRoot,
                runId,
                integrationFiles: state.integration.files
            });

            let repairResult = {
                status: "not_needed",
                attempts: [],
                qaReport,
                integrationFiles: state.integration.files,
                snapshotRunId: runId
            };

            // Repair only when the first QA run fails.
            if (qaReport.status !== "passed") {
                console.log("[REPAIR] Initial QA failed. Starting automated repair.");

                state.qa.status = "repairing";

                recordEvent(projectRoot, {
                    type: "repair.started",
                    runId,
                    initialQaStatus: qaReport.status
                });

                persist();

                repairResult = await runAutomatedRepair({
                    projectRoot,
                    projectName,
                    description,
                    plan,
                    runId,
                    integrationFiles: state.integration.files,
                    qaReport
                });

                qaReport = repairResult.qaReport || qaReport;

                // Point the final project state to the latest immutable snapshot.
                if (
                    Array.isArray(repairResult.integrationFiles) &&
                    repairResult.integrationFiles.length > 0
                ) {
                    state.integration = {
                        ...state.integration,
                        files: repairResult.integrationFiles,
                        snapshotRunId: repairResult.snapshotRunId
                    };
                }

                recordEvent(projectRoot, {
                    type: "repair.completed",
                    runId,
                    status: repairResult.status,
                    attempts: repairResult.attempts,
                    snapshotRunId: repairResult.snapshotRunId
                });
            }

            state.qa = {
                status: qaReport.status,
                report: qaReport,
                error: null,
                repair: repairResult
            };

            recordEvent(projectRoot, {
                type: "qa.completed",
                runId,
                status: qaReport.status,
                summary: qaReport.summary,
                repairAttempts: repairResult.attempts.length
            });

            console.log(
                `[QA] Finished: ${qaReport.status} | ` +
                `Repair attempts: ${repairResult.attempts.length}`
            );

        } catch (error) {
            state.qa = {
                status: "failed",
                report: null,
                error: error.message,
                repair: null
            };

            recordEvent(projectRoot, {
                type: "qa.failed",
                runId,
                error: error.message
            });

            console.error(`[QA FAILED] ${error.message}`);
        }

        persist();

    } else {
        state.qa = {
            status: "skipped",
            report: null,
            error: "QA requires successful integration.",
            repair: null
        };

        recordEvent(projectRoot, {
            type: "qa.skipped",
            runId,
            reason: state.qa.error
        });

        persist();
    }

    // --------------------------------------------------
    // STAGE 4: APPROVED FUNCTIONAL VERIFICATION
    // --------------------------------------------------

    if (
        state.integration.status === "completed" &&
        state.qa.status === "passed"
    ) {
        state.status = "verifying";

        state.verification = {
            status: "running",
            approval: approveFunctionalTests === true
                ? "granted"
                : "not_granted",
            build: "not_run",
            functionalTests: "running",
            report: null,
            evidence: []
        };

        recordEvent(projectRoot, {
            type: "functional_tests.started",
            runId,
            approved: approveFunctionalTests === true,
            snapshotRunId:
                state.integration.snapshotRunId || runId
        });

        persist();

        try {
            const functionalResult = await runApprovedFunctionalTests({
                projectRoot,
                runId,
                snapshotRunId:
                    state.integration.snapshotRunId || runId,
                integrationFiles: state.integration.files,
                approved: approveFunctionalTests === true
            });

            const verificationStatus =
                functionalResult.status === "passed"
                    ? "verified"
                    : functionalResult.status === "approval_required"
                        ? "approval_required"
                        : functionalResult.status === "unsupported"
                            ? "unsupported"
                            : functionalResult.status === "failed"
                                ? "failed"
                                : "error";

            state.verification = {
                status: verificationStatus,
                approval: approveFunctionalTests === true
                    ? "granted"
                    : "not_granted",
                build: "not_run",
                functionalTests: functionalResult.status,
                report: functionalResult,
                evidence: functionalResult.status === "passed"
                    ? [{
                        type: "simulated_dom_functional_tests",
                        snapshotRunId: functionalResult.snapshotRunId,
                        summary: functionalResult.report?.summary || null
                    }]
                    : []
            };

            recordEvent(projectRoot, {
                type: "functional_tests.completed",
                runId,
                status: functionalResult.status,
                snapshotRunId:
                    functionalResult.snapshotRunId || null,
                summary:
                    functionalResult.report?.summary || null,
                error: functionalResult.error || null
            });

            console.log(
                `[FUNCTIONAL TESTS] ${functionalResult.status}`
            );

        } catch (error) {
            state.verification = {
                status: "error",
                approval: approveFunctionalTests === true
                    ? "granted"
                    : "not_granted",
                build: "not_run",
                functionalTests: "error",
                report: {
                    status: "error",
                    error: error.message
                },
                evidence: []
            };

            recordEvent(projectRoot, {
                type: "functional_tests.failed",
                runId,
                error: error.message
            });

            console.error(
                `[FUNCTIONAL TESTS ERROR] ${error.message}`
            );
        }

        persist();

    } else {
        state.verification = {
            status: "blocked",
            approval: approveFunctionalTests === true
                ? "granted"
                : "not_granted",
            build: "not_run",
            functionalTests: "not_run",
            report: null,
            evidence: []
        };

        persist();
    }

    // --------------------------------------------------
    // STAGE 5: FINAL PROJECT STATUS
    // --------------------------------------------------

    if (failed.size > 0) {
        state.status = completed.size > 0
            ? "partially_completed"
            : "failed";

    } else if (state.integration.status !== "completed") {
        state.status = "integration_failed";

    } else if (state.qa.status !== "passed") {
        state.verification.status = "blocked";
        state.status = "qa_failed";

    } else if (state.verification.status === "verified") {
        state.status = "completed";

    } else if (state.verification.functionalTests === "failed") {
        state.status = "functional_tests_failed";

    } else if (state.verification.functionalTests === "error") {
        state.status = "verification_failed";

    } else {
        state.status = "verification_required";
    }

    state.completedAt = new Date().toISOString();

    recordEvent(projectRoot, {
        type: "project.finished",
        runId,
        status: state.status,
        completedTasks: completed.size,
        failedTasks: state.tasks.filter(
            task => task.status === "failed"
        ).length,
        skippedTasks: state.tasks.filter(
            task => task.status === "skipped"
        ).length,
        integrationStatus: state.integration.status,
        qaStatus: state.qa.status,
        verificationStatus: state.verification.status
    });

    persist();

    console.log(`[PROJECT] Finished with status: ${state.status}`);

    // --------------------------------------------------
    // FINAL RESULT
    // --------------------------------------------------

    return {
        projectName,
        projectSlug,
        runId,

        projectPath: `workspace/${projectSlug}`,
        status: state.status,

        totalTasks: state.tasks.length,
        completed: completed.size,

        failed: state.tasks.filter(
            task => task.status === "failed"
        ).length,

        skipped: state.tasks.filter(
            task => task.status === "skipped"
        ).length,

        generatedFiles: state.generatedFiles,

        integration: state.integration,
        integrationStatus: state.integration.status,

        qaStatus: state.qa.status,
        qa: state.qa,
        verification: state.verification,
        repairStatus: state.qa.repair?.status || "not_needed",
        repair: state.qa.repair || null,

        tasks: state.tasks.map(task => ({
            id: task.id,
            title: task.title,
            agentId: task.agentId,
            status: task.status,
            error: task.error,
            result: task.result
        }))
    };
}

module.exports = {
    runProject,
    evaluateIntegrationGate
};
