
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const { createProjectPlan } = require("./planner");
const { executePlannedTask } = require("./delegator");
const { integrateProject } = require("./integration-engine");
const { runStaticQA } = require("./qa-runner");
const { runAutomatedRepair } = require("./repair-runner");
const { runApprovedFunctionalTests } = require("./functional-test-runner");

const {
    getProjectRoot,
    writeAgentFiles
} = require("../runtime/file-manager");

const {
    saveProjectState,
    recordEvent
} = require("../runtime/project-store");

const { saveCheckpoint } = require("../runtime/checkpoint-manager");
const { recoverProjectState } = require("./recovery-manager");
const { exportIntegratedProject } = require("../runtime/export-project");

const MAX_AGENT_RECOVERY_ROUNDS = 1;
const AGENT_RECOVERY_DELAY_MS = 1500;

const MAX_FUNCTIONAL_REPAIR_CYCLES = (() => {
    const configured = Number(process.env.MAX_FUNCTIONAL_REPAIR_CYCLES);

    return Number.isInteger(configured) &&
        configured >= 1 &&
        configured <= 15
        ? configured
        : 6;
})();

const MAX_QA_FOLLOWUPS_PER_CYCLE = 2;

const REQUIRED_INTEGRATION_AGENTS = [
    "business-analyst",
    "solution-architect",
    "backend-developer",
    "frontend-developer",
    "integration-engineer"
];


// --------------------------------------------------
// GENERAL HELPERS
// --------------------------------------------------

function slugify(value) {
    return String(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 50);
}

function validateRunId(runId) {
    return (
        typeof runId === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)
    );
}

function safeErrorMessage(error) {
    return error && typeof error.message === "string"
        ? error.message
        : String(error || "Unknown error");
}

function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function normalizeRelativePath(filePath) {
    if (typeof filePath !== "string" || !filePath.trim()) {
        throw new Error("A file path must be a non-empty string.");
    }

    const normalized = filePath.replace(/\\/g, "/");

    if (
        normalized.startsWith("/") ||
        /^[a-zA-Z]:/.test(normalized) ||
        normalized.includes("\0")
    ) {
        throw new Error(`Unsafe file path: ${filePath}`);
    }

    const segments = normalized.split("/");

    if (
        segments.some(segment =>
            !segment ||
            segment === "." ||
            segment === ".."
        )
    ) {
        throw new Error(`Unsafe or non-normalized file path: ${filePath}`);
    }

    return segments.join("/");
}

function validateIntegrationFiles(files, label = "Integration") {
    if (!Array.isArray(files) || files.length === 0) {
        throw new Error(`${label} did not provide any files.`);
    }

    const seen = new Set();

    return files.map(file => {
        if (!file || typeof file !== "object") {
            throw new Error(`${label} returned an invalid file entry.`);
        }

        const normalizedPath = normalizeRelativePath(file.path);

        if (seen.has(normalizedPath)) {
            throw new Error(`${label} returned a duplicate path: ${normalizedPath}`);
        }

        seen.add(normalizedPath);

        return {
            ...file,
            path: normalizedPath
        };
    });
}

function evaluateIntegrationGate(tasks, completedTaskIds, generatedFiles) {
    const completedAgentIds = new Set(
        tasks
            .filter(task => completedTaskIds.has(task.id))
            .map(task => task.agentId)
    );

    const missingRequiredAgents = REQUIRED_INTEGRATION_AGENTS.filter(
        agentId => !completedAgentIds.has(agentId)
    );

    return {
        allowed:
            Array.isArray(generatedFiles) &&
            generatedFiles.length > 0 &&
            missingRequiredAgents.length === 0,
        missingRequiredAgents
    };
}


// --------------------------------------------------
// PREVIOUS AGENT FILE CONTEXT
// --------------------------------------------------

function readPreviousAgentFiles(projectRoot, generatedFiles) {
    const MAX_TOTAL_CONTEXT = 30000;
    const MAX_FILE_CONTEXT = 12000;

    let totalBytes = 0;
    const artifacts = [];

    let realProjectRoot;

    try {
        realProjectRoot = fs.realpathSync(projectRoot);
    } catch {
        return "Project directory is not available.";
    }

    for (const file of generatedFiles || []) {
        if (totalBytes >= MAX_TOTAL_CONTEXT) break;

        if (!file || typeof file.path !== "string") continue;

        try {
            const normalizedPath = normalizeRelativePath(file.path);
            const absolutePath = path.resolve(projectRoot, normalizedPath);

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

            if (!stats.isFile() || stats.isSymbolicLink()) continue;

            const realFilePath = fs.realpathSync(absolutePath);
            const realRelative = path.relative(realProjectRoot, realFilePath);

            if (
                !realRelative ||
                realRelative === ".." ||
                realRelative.startsWith(".." + path.sep) ||
                path.isAbsolute(realRelative)
            ) {
                continue;
            }

            const remaining = MAX_TOTAL_CONTEXT - totalBytes;
            const allowedBytes = Math.min(MAX_FILE_CONTEXT, remaining);

            if (stats.size > allowedBytes) {
                artifacts.push(
                    `FILE: ${normalizedPath}\n` +
                    `[File omitted: ${stats.size} bytes exceeds the remaining shared-context limit.]`
                );
                continue;
            }

            const content = fs.readFileSync(realFilePath, "utf8");

            artifacts.push(
                `FILE: ${normalizedPath}\nCONTENT:\n${content}`
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

function buildCompletedTaskContext(tasks) {
    return tasks
        .filter(task => task.status === "completed" && task.result)
        .map(task =>
            `${task.title} (${task.result.agentName || task.agentId}): ` +
            `${task.result.summary || "Completed."}`
        );
}


// --------------------------------------------------
// STATE HELPERS
// --------------------------------------------------

function createInitialIntegrationState() {
    return {
        status: "pending",
        summary: null,
        files: [],
        error: null,
        snapshotRunId: null
    };
}

function createInitialQAState() {
    return {
        status: "pending",
        report: null,
        error: null,
        repair: null,
        snapshotRunId: null
    };
}

function createInitialVerificationState(approved = false) {
    return {
        status: "pending",
        approval: approved ? "granted" : "not_granted",
        build: "not_run",
        functionalTests: "not_run",
        runtime: null,
        report: null,
        evidence: [],
        repairCycles: []
    };
}

function createInitialExportState() {
    return {
        status: "not_attempted",
        path: null,
        fileCount: 0,
        snapshotRunId: null,
        files: []
    };
}

function persistState(projectRoot, state, reason = null) {
    state.updatedAt = new Date().toISOString();

    const runningTask = state.tasks.find(
        task => task.status === "running"
    );

    const checkpointReason = reason || (
        runningTask
            ? `task:${runningTask.id}:${runningTask.status}`
            : [
                state.status,
                state.integration.status,
                state.qa.status,
                state.verification.status
            ].join(":")
    );

    saveCheckpoint(projectRoot, state, checkpointReason);
    saveProjectState(projectRoot, state);
}


// --------------------------------------------------
// QA GATE
// --------------------------------------------------

async function executeStaticQA({
    services,
    projectRoot,
    runId,
    snapshotRunId,
    integrationFiles
}) {
    if (!validateRunId(snapshotRunId)) {
        throw new Error("Static QA received an invalid snapshot ID.");
    }

    const files = validateIntegrationFiles(
        integrationFiles,
        "Static QA input"
    );

    const report = await services.runStaticQA({
        projectRoot,
        runId: snapshotRunId,
        integrationFiles: files
    });

    if (
        !report ||
        typeof report !== "object" ||
        typeof report.status !== "string"
    ) {
        throw new Error("Static QA returned an invalid report.");
    }

    return {
        status: report.status,
        report,
        snapshotRunId
    };
}


// --------------------------------------------------
// FUNCTIONAL VERIFICATION GATE
// --------------------------------------------------

function validateFunctionalTestResult(result, expectedSnapshotId) {
    if (!result || typeof result !== "object") {
        throw new Error("Functional test runner returned an invalid result.");
    }

    if (
        !validateRunId(expectedSnapshotId) ||
        !validateRunId(result.snapshotRunId) ||
        result.snapshotRunId !== expectedSnapshotId
    ) {
        throw new Error(
            "Functional test result is missing a matching snapshot ID."
        );
    }

    if (result.approval !== "granted") {
        throw new Error(
            "Functional test runner did not confirm test approval."
        );
    }

    if (
        !result.report ||
        typeof result.report !== "object" ||
        !Array.isArray(result.report.results)
    ) {
        throw new Error(
            "Functional test runner did not provide native test evidence."
        );
    }

    if (result.status === "passed") {
        const report = result.report;

        if (report.results.length === 0) {
            throw new Error(
                "Functional test runner reported success without test results."
            );
        }

        if (
            !Number.isInteger(report.testsExecuted) ||
            report.testsExecuted <= 0 ||
            !Number.isInteger(report.testsFailed) ||
            report.testsFailed !== 0 ||
            !Number.isInteger(report.testsPassed) ||
            report.testsPassed <= 0
        ) {
            throw new Error(
                "Functional test counters do not support a passed result."
            );
        }

        const failedOrUnsupportedResult = report.results.some(
            item => !item || item.status !== "passed"
        );

        if (failedOrUnsupportedResult) {
            throw new Error(
                "One or more native test results did not pass."
            );
        }

        if (
            !result.runtime ||
            result.runtime.status !== "passed"
        ) {
            throw new Error(
                "Runtime verification did not pass."
            );
        }
    }

    return result;
}

async function executeCurrentFunctionalTests({
    services,
    projectRoot,
    runId,
    integration
}) {
    const snapshotId = integration.snapshotRunId;

    if (!validateRunId(snapshotId)) {
        throw new Error(
            "Invalid integration snapshot before functional testing."
        );
    }

    const integrationFiles = validateIntegrationFiles(
        integration.files,
        "Functional test input"
    );

    const result = await services.runApprovedFunctionalTests({
        projectRoot,
        runId,
        snapshotRunId: snapshotId,
        integrationFiles,
        approved: true,
        runtimeVerification: true
    });

    return validateFunctionalTestResult(result, snapshotId);
}


// --------------------------------------------------
// REPAIR SNAPSHOT VALIDATION
// --------------------------------------------------

function validateRepairSnapshot(repairResult, previousSnapshotId) {
    if (!repairResult || typeof repairResult !== "object") {
        throw new Error("Repair engine returned an invalid result.");
    }

    if (!validateRunId(repairResult.snapshotRunId)) {
        throw new Error("Repair returned a missing or invalid snapshot ID.");
    }

    if (repairResult.snapshotRunId === previousSnapshotId) {
        throw new Error(
            "Repair must create a new immutable snapshot."
        );
    }

    const integrationFiles = validateIntegrationFiles(
        repairResult.integrationFiles,
        "Repair"
    );

    return {
        ...repairResult,
        integrationFiles,
        attempts: Array.isArray(repairResult.attempts)
            ? repairResult.attempts
            : []
    };
}

async function createAndCheckRepairSnapshot({
    services,
    projectRoot,
    projectName,
    description,
    plan,
    runId,
    previousSnapshotId,
    integrationFiles,
    qaReport,
    functionalResult = null
}) {
    const rawRepair = await services.runAutomatedRepair({
        projectRoot,
        projectName,
        description,
        plan,
        runId,
        snapshotRunId: previousSnapshotId,
        integrationFiles,
        qaReport,
        functionalResult
    });

    let repair = validateRepairSnapshot(
        rawRepair,
        previousSnapshotId
    );

    let qaResult = await executeStaticQA({
        services,
        projectRoot,
        runId,
        snapshotRunId: repair.snapshotRunId,
        integrationFiles: repair.integrationFiles
    });

    let followups = 0;

    while (
        qaResult.status !== "passed" &&
        followups < MAX_QA_FOLLOWUPS_PER_CYCLE
    ) {
        followups++;

        const previousRepairSnapshotId = repair.snapshotRunId;

        const followupRaw = await services.runAutomatedRepair({
            projectRoot,
            projectName,
            description,
            plan,
            runId,
            snapshotRunId: previousRepairSnapshotId,
            integrationFiles: repair.integrationFiles,
            qaReport: qaResult.report,
            functionalResult: null
        });

        const followup = validateRepairSnapshot(
            followupRaw,
            previousRepairSnapshotId
        );

        repair = {
            ...followup,
            attempts: [
                ...repair.attempts,
                ...followup.attempts
            ]
        };

        qaResult = await executeStaticQA({
            services,
            projectRoot,
            runId,
            snapshotRunId: repair.snapshotRunId,
            integrationFiles: repair.integrationFiles
        });
    }

    return {
        repair,
        qaResult,
        followups
    };
}


// --------------------------------------------------
// EXPORT VALIDATION
// --------------------------------------------------

function collectExportedFiles(directory) {
    const files = [];

    function walk(currentDirectory, relativeDirectory = "") {
        for (const entry of fs.readdirSync(currentDirectory, {
            withFileTypes: true
        })) {
            const absolutePath = path.join(currentDirectory, entry.name);
            const relativePath = relativeDirectory
                ? `${relativeDirectory}/${entry.name}`
                : entry.name;

            if (entry.isSymbolicLink()) {
                throw new Error(
                    `Export contains a symbolic link: ${relativePath}`
                );
            }

            if (entry.isDirectory()) {
                walk(absolutePath, relativePath);
            } else if (entry.isFile()) {
                files.push(normalizeRelativePath(relativePath));
            } else {
                throw new Error(
                    `Export contains an unsupported filesystem entry: ${relativePath}`
                );
            }
        }
    }

    walk(directory);

    return files.sort();
}

function validateExportResult({
    projectRoot,
    integrationFiles,
    snapshotRunId,
    exportResult
}) {
    if (
        !exportResult ||
        exportResult.directory !== "final" ||
        exportResult.snapshotRunId !== snapshotRunId ||
        !Number.isInteger(exportResult.fileCount) ||
        exportResult.fileCount <= 0 ||
        !Array.isArray(exportResult.files)
    ) {
        throw new Error(
            "Exporter returned invalid or mismatched snapshot evidence."
        );
    }

    const expected = validateIntegrationFiles(
        integrationFiles,
        "Export input"
    )
        .map(file => file.path)
        .sort();

    const returned = exportResult.files
        .map(file => {
            const value = typeof file === "string" ? file : file?.path;
            return normalizeRelativePath(value);
        })
        .sort();

    if (
        exportResult.fileCount !== expected.length ||
        returned.length !== expected.length ||
        new Set(returned).size !== returned.length ||
        expected.some((file, index) => file !== returned[index])
    ) {
        throw new Error(
            "Exported file list does not exactly match the verified snapshot."
        );
    }

    const finalDirectory = path.join(projectRoot, "final");

    let directoryStats;

    try {
        directoryStats = fs.lstatSync(finalDirectory);
    } catch {
        throw new Error("Final export directory does not exist.");
    }

    if (
        !directoryStats.isDirectory() ||
        directoryStats.isSymbolicLink()
    ) {
        throw new Error("Final export path is not a real directory.");
    }

    const actualFiles = collectExportedFiles(finalDirectory);

    if (
        actualFiles.length !== expected.length ||
        actualFiles.some((file, index) => file !== expected[index])
    ) {
        throw new Error(
            "Actual final export contents do not match the verified snapshot."
        );
    }

    return {
        directory: "final",
        fileCount: actualFiles.length,
        files: actualFiles,
        snapshotRunId
    };
}


// --------------------------------------------------
// MAIN PROJECT RUNNER
// --------------------------------------------------

async function runProject({
    projectName,
    description,
    runId: suppliedRunId,
    resume = false,
    approveFunctionalTests = false,
    dependencies = {}
}) {
    if (typeof projectName !== "string" || !projectName.trim()) {
        throw new Error("Please provide a valid project name.");
    }

    if (typeof description !== "string" || !description.trim()) {
        throw new Error("Please provide a project description.");
    }

    const projectSlug = slugify(projectName);

    if (!projectSlug) {
        throw new Error("Please provide a valid project name.");
    }

    if (
        !dependencies ||
        typeof dependencies !== "object" ||
        Array.isArray(dependencies)
    ) {
        throw new Error("Project runner dependencies must be an object.");
    }

    const projectRoot = getProjectRoot(projectSlug);

    const services = {
        createProjectPlan,
        executePlannedTask,
        integrateProject,
        runStaticQA,
        runAutomatedRepair,
        runApprovedFunctionalTests,
        exportIntegratedProject,
        ...dependencies
    };

    for (const name of [
        "createProjectPlan",
        "executePlannedTask",
        "integrateProject",
        "runStaticQA",
        "runAutomatedRepair",
        "runApprovedFunctionalTests",
        "exportIntegratedProject"
    ]) {
        if (typeof services[name] !== "function") {
            throw new Error(
                `Project runner dependency "${name}" must be a function.`
            );
        }
    }

    const isResume = resume === true;
    const runId = suppliedRunId || randomUUID();

    if (!validateRunId(runId)) {
        throw new Error("Invalid project run ID.");
    }

    if (isResume && !suppliedRunId) {
        throw new Error(
            "A valid original run ID is required to resume a project."
        );
    }

    console.log(`[PROJECT] Run ID: ${runId}`);
    console.log(
        `[PROJECT] Execution mode: ${isResume ? "RESUME" : "NEW RUN"}`
    );

    let state;
    let plan;

    // --------------------------------------------------
    // INITIALIZE OR RECOVER
    // --------------------------------------------------

    if (isResume) {
        const recovered = recoverProjectState({
            projectRoot,
            projectSlug,
            runId
        });

        if (
            !recovered ||
            !recovered.state ||
            !recovered.checkpoint ||
            !recovered.recovery
        ) {
            throw new Error("Project recovery returned an invalid result.");
        }

        state = recovered.state;
        plan = state.plan;

        state.recovery = recovered.recovery;

        // Never reuse old QA, verification, or export evidence after resume.
        state.integration = createInitialIntegrationState();
        state.qa = createInitialQAState();
        state.verification = createInitialVerificationState(
            approveFunctionalTests
        );
        state.export = createInitialExportState();

        projectName = state.projectName || projectName;
        description = state.description || description;

        recordEvent(projectRoot, {
            type: "project.resumed",
            projectName,
            runId,
            checkpointSequence: recovered.checkpoint.sequence,
            resumedTaskIds: recovered.recovery.resumedTaskIds,
            resetTaskIds: recovered.recovery.resetTaskIds,
            invalidCompletedTasks: recovered.recovery.invalidCompletedTasks
        });

        console.log(
            `[RECOVERY] Restored completed tasks: ${recovered.recovery.resumedTaskIds.length}`
        );

        console.log(
            `[RECOVERY] Tasks to execute again: ${recovered.recovery.resetTaskIds.length}`
        );
    } else {
        state = {
            projectName,
            projectSlug,
            runId,
            description,
            status: "planning",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            completedAt: null,
            plan: null,
            tasks: [],
            generatedFiles: [],
            integration: createInitialIntegrationState(),
            qa: createInitialQAState(),
            verification: createInitialVerificationState(
                approveFunctionalTests
            ),
            export: createInitialExportState(),
            recovery: null
        };

        recordEvent(projectRoot, {
            type: "project.started",
            projectName,
            runId
        });
    }

    const persist = reason =>
        persistState(projectRoot, state, reason);

    // --------------------------------------------------
    // STAGE 0: PLANNING
    // --------------------------------------------------

    if (!isResume) {
        persist("planning_started");

        plan = await services.createProjectPlan({
            projectName,
            description
        });

        if (
            !plan ||
            !Array.isArray(plan.tasks) ||
            plan.tasks.length === 0
        ) {
            throw new Error(
                "Planner did not produce a valid project plan."
            );
        }

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

        persist("plan_created");
    } else {
        if (
            !plan ||
            !Array.isArray(state.tasks) ||
            state.tasks.length === 0
        ) {
            throw new Error(
                "Recovered project does not contain a valid saved plan."
            );
        }

        state.status = "executing";
        persist("project_recovered");
    }

    // --------------------------------------------------
    // STAGE 1: SPECIALIST AGENTS
    // --------------------------------------------------

    const completed = new Set(
        state.tasks
            .filter(task => task.status === "completed")
            .map(task => task.id)
    );

    const summaries = buildCompletedTaskContext(state.tasks);

    for (const task of state.tasks) {
        if (task.status === "completed") continue;

        if (task.status !== "pending") {
            task.status = "pending";
            task.result = null;
            task.error = null;
        }

        const taskDependencies = Array.isArray(task.dependsOn)
            ? task.dependsOn
            : [];

        const blockedBy = taskDependencies.filter(
            dependency => !completed.has(dependency)
        );

        if (blockedBy.length > 0) {
            task.status = "skipped";
            task.error =
                `Blocked by unsuccessful dependencies: ${blockedBy.join(", ")}`;

            recordEvent(projectRoot, {
                type: "task.skipped",
                runId,
                taskId: task.id,
                agentId: task.agentId,
                reason: task.error
            });

            persist();
            continue;
        }

        task.status = "running";
        task.error = null;

        recordEvent(projectRoot, {
            type: "task.started",
            runId,
            taskId: task.id,
            agentId: task.agentId,
            title: task.title,
            resumed: isResume
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
${plan.summary || "Not provided."}

TECHNOLOGY STACK:
${Array.isArray(plan.technologyStack)
    ? plan.technologyStack.join(", ")
    : "Not specified"}

PREVIOUS COMPLETED AGENT SUMMARIES:
${summaries.join("\n\n") || "No previous tasks."}

ACTUAL FILES GENERATED BY PREVIOUS AGENTS:
${previousFiles}

EXECUTION MODE:
${isResume ? "RESUMING AN INTERRUPTED PROJECT" : "NEW PROJECT"}

IMPORTANT COLLABORATION RULES:
1. Read and understand previous agent files before implementing your task.
2. Reuse existing interfaces, names, data structures and contracts wherever appropriate.
3. Do not contradict or unnecessarily duplicate previous implementations.
4. Explain required changes to previous implementations in your summary.
5. Generate complete, usable source files.
6. Do not assume files have been integrated into the live application.
7. All generated files are staged for review, not automatically deployed.
8. Complete the assigned task, not the tasks assigned to other agents.
`;

            let result = null;
            let recoveryError = null;

            for (
                let recoveryRound = 0;
                recoveryRound <= MAX_AGENT_RECOVERY_ROUNDS;
                recoveryRound++
            ) {
                try {
                    if (recoveryRound > 0) {
                        recordEvent(projectRoot, {
                            type: "task.recovery_started",
                            runId,
                            taskId: task.id,
                            agentId: task.agentId,
                            recoveryRound,
                            previousError: safeErrorMessage(recoveryError)
                        });

                        persist();
                        await delay(AGENT_RECOVERY_DELAY_MS);
                    }

                    const recoveryContext = recoveryRound > 0
                        ? context + `

PREVIOUS EXECUTION FAILURE:
${safeErrorMessage(recoveryError).slice(0, 2000)}

RECOVERY INSTRUCTIONS:
This is a recovery execution of the same assigned task.
Complete the original task.
Do not assume the previous attempt saved files.
Follow all original output and file safety requirements.
`
                        : context;

                    result = await services.executePlannedTask({
                        task,
                        projectContext: recoveryContext
                    });

                    if (
                        !result ||
                        !Array.isArray(result.files) ||
                        result.files.length === 0 ||
                        result.files.some(file =>
                            !file ||
                            typeof file.path !== "string" ||
                            !file.path.trim() ||
                            typeof file.content !== "string"
                        )
                    ) {
                        throw new Error(
                            "Agent returned invalid files. Each file must contain a path and string content."
                        );
                    }

                    recoveryError = null;
                    break;
                } catch (error) {
                    recoveryError = error;
                    result = null;

                    recordEvent(projectRoot, {
                        type: "task.recovery_attempt_failed",
                        runId,
                        taskId: task.id,
                        agentId: task.agentId,
                        recoveryRound,
                        error: safeErrorMessage(error)
                    });

                    console.error(
                        `[AGENT EXECUTION FAILED] ${task.agentId}: ${safeErrorMessage(error)}`
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

            if (!Array.isArray(writtenFiles) || writtenFiles.length === 0) {
                throw new Error(
                    "Agent output was not saved as generated artifacts."
                );
            }

            task.status = "completed";
            task.result = {
                agentName: result.agentName || task.agentId,
                summary: result.summary || "Task completed.",
                files: writtenFiles,
                provider: result.provider,
                model: result.model,
                usage: result.usage,
                generationAttempts: result.attempts
            };
            task.error = null;

            completed.add(task.id);

            summaries.push(
                `${task.title} (${result.agentName || task.agentId}): ` +
                `${result.summary || "Completed."}`
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
            task.error = safeErrorMessage(error);
            task.result = null;
            completed.delete(task.id);

            recordEvent(projectRoot, {
                type: "task.failed",
                runId,
                taskId: task.id,
                agentId: task.agentId,
                error: task.error
            });

            console.error(`[TASK FAILED] ${task.id}: ${task.error}`);
        }

        persist();
    }

    // --------------------------------------------------
    // STAGE 2: INTEGRATION
    // --------------------------------------------------

    const integrationGate = evaluateIntegrationGate(
        state.tasks,
        completed,
        state.generatedFiles
    );

    if (integrationGate.allowed) {
        state.status = "integrating";
        state.integration = {
            status: "running",
            summary: null,
            files: [],
            error: null,
            snapshotRunId: null
        };

        recordEvent(projectRoot, {
            type: "integration.started",
            runId,
            generatedFileCount: state.generatedFiles.length,
            resumed: isResume
        });

        persist();

        try {
            const integrationResult = await services.integrateProject({
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
                integrationResult.runId !== runId ||
                !validateRunId(integrationResult.snapshotRunId)
            ) {
                throw new Error(
                    "Integration returned invalid run or snapshot evidence."
                );
            }

            const integrationFiles = validateIntegrationFiles(
                integrationResult.files,
                "Integration"
            );

            state.integration = {
                ...integrationResult,
                status: "completed",
                files: integrationFiles,
                snapshotRunId: integrationResult.snapshotRunId,
                error: null
            };

            recordEvent(projectRoot, {
                type: "integration.completed",
                runId,
                snapshotRunId: state.integration.snapshotRunId,
                status: state.integration.status,
                files: state.integration.files,
                summary: state.integration.summary || null
            });
        } catch (error) {
            state.integration = {
                status: "failed",
                summary: null,
                files: [],
                error: safeErrorMessage(error),
                snapshotRunId: null
            };

            recordEvent(projectRoot, {
                type: "integration.failed",
                runId,
                error: state.integration.error
            });
        }

        persist();
    } else {
        state.integration = {
            status: "skipped",
            summary: null,
            files: [],
            snapshotRunId: null,
            error: integrationGate.missingRequiredAgents.length
                ? "Integration blocked. Required agents did not complete: " +
                    integrationGate.missingRequiredAgents.join(", ")
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
    // STAGE 3: STATIC QA
    // --------------------------------------------------

    if (state.integration.status === "completed") {
        state.status = "testing";
        state.qa = {
            status: "running",
            report: null,
            error: null,
            repair: null,
            snapshotRunId: state.integration.snapshotRunId
        };

        recordEvent(projectRoot, {
            type: "qa.started",
            runId,
            snapshotRunId: state.integration.snapshotRunId
        });

        persist();

        try {
            let qaResult = await executeStaticQA({
                services,
                projectRoot,
                runId,
                snapshotRunId: state.integration.snapshotRunId,
                integrationFiles: state.integration.files
            });

            let repairInfo = {
                status: "not_needed",
                attempts: []
            };

            if (qaResult.status !== "passed") {
                state.qa.status = "repairing";
                persist();

                const repaired = await createAndCheckRepairSnapshot({
                    services,
                    projectRoot,
                    projectName,
                    description,
                    plan,
                    runId,
                    previousSnapshotId: state.integration.snapshotRunId,
                    integrationFiles: state.integration.files,
                    qaReport: qaResult.report
                });

                repairInfo = {
                    status: repaired.qaResult.status === "passed"
                        ? "completed"
                        : "failed",
                    attempts: repaired.repair.attempts,
                    followups: repaired.followups
                };

                // Adopt the latest actual repair snapshot, even if QA failed.
                state.integration = {
                    ...state.integration,
                    files: repaired.repair.integrationFiles,
                    snapshotRunId: repaired.repair.snapshotRunId
                };

                qaResult = repaired.qaResult;
            }

            state.qa = {
                status: qaResult.status,
                report: qaResult.report,
                error: qaResult.status === "passed"
                    ? null
                    : "Static QA did not pass for the current integration snapshot.",
                repair: repairInfo,
                snapshotRunId: qaResult.snapshotRunId
            };

            recordEvent(projectRoot, {
                type: "qa.completed",
                runId,
                snapshotRunId: qaResult.snapshotRunId,
                status: qaResult.status,
                summary: qaResult.report.summary || null,
                repairAttempts: repairInfo.attempts.length
            });
        } catch (error) {
            state.qa = {
                status: "failed",
                report: null,
                error: safeErrorMessage(error),
                repair: null,
                snapshotRunId: state.integration.snapshotRunId
            };

            recordEvent(projectRoot, {
                type: "qa.failed",
                runId,
                snapshotRunId: state.integration.snapshotRunId,
                error: state.qa.error
            });
        }

        persist();
    } else {
        state.qa = {
            status: "skipped",
            report: null,
            error: "QA requires successful integration.",
            repair: null,
            snapshotRunId: null
        };

        persist();
    }

    // --------------------------------------------------
    // STAGE 4: APPROVED FUNCTIONAL TESTS + REPAIR
    // --------------------------------------------------

    if (
        state.integration.status === "completed" &&
        state.qa.status === "passed" &&
        state.qa.snapshotRunId === state.integration.snapshotRunId
    ) {
        const repairCycles = [];

        state.status = "verifying";
        state.verification = {
            status: "running",
            approval: approveFunctionalTests === true
                ? "granted"
                : "not_granted",
            build: "not_run",
            functionalTests: "running",
            runtime: null,
            report: null,
            evidence: [],
            repairCycles
        };

        persist();

        let functionalResult = null;

        try {
            if (approveFunctionalTests !== true) {
                functionalResult = {
                    status: "approval_required",
                    approval: "not_granted",
                    snapshotRunId: state.integration.snapshotRunId,
                    error: "User approval is required before functional tests can run."
                };
            } else {
                functionalResult = await executeCurrentFunctionalTests({
                    services,
                    projectRoot,
                    runId,
                    integration: state.integration
                });

                for (
                    let cycle = 1;
                    cycle <= MAX_FUNCTIONAL_REPAIR_CYCLES;
                    cycle++
                ) {
                    if (functionalResult.status !== "failed") break;

                    const previousSnapshotId =
                        state.integration.snapshotRunId;

                    const cycleRecord = {
                        cycle,
                        status: "repairing",
                        previousSnapshotId,
                        newSnapshotId: null,
                        repairAttempts: []
                    };

                    repairCycles.push(cycleRecord);

                    recordEvent(projectRoot, {
                        type: "functional_repair.started",
                        runId,
                        cycle,
                        snapshotRunId: previousSnapshotId
                    });

                    state.verification = {
                        status: "repairing",
                        approval: "granted",
                        build: functionalResult.runtime?.status || "failed",
                        functionalTests: "failed",
                        runtime: functionalResult.runtime || null,
                        report: functionalResult,
                        evidence: [],
                        repairCycles
                    };

                    persist();

                    try {
                        const repaired = await createAndCheckRepairSnapshot({
                            services,
                            projectRoot,
                            projectName,
                            description,
                            plan,
                            runId,
                            previousSnapshotId,
                            integrationFiles: state.integration.files,
                            qaReport: state.qa.report,
                            functionalResult
                        });

                        cycleRecord.repairAttempts =
                            repaired.repair.attempts;

                        cycleRecord.newSnapshotId =
                            repaired.repair.snapshotRunId;

                        // Keep the latest repair snapshot visible.
                        state.integration = {
                            ...state.integration,
                            files: repaired.repair.integrationFiles,
                            snapshotRunId: repaired.repair.snapshotRunId
                        };

                        state.qa = {
                            status: repaired.qaResult.status,
                            report: repaired.qaResult.report,
                            error: repaired.qaResult.status === "passed"
                                ? null
                                : "Static QA failed after functional repair.",
                            repair: {
                                status: repaired.qaResult.status === "passed"
                                    ? "completed"
                                    : "failed",
                                attempts: repaired.repair.attempts,
                                followups: repaired.followups
                            },
                            snapshotRunId: repaired.qaResult.snapshotRunId
                        };

                        if (
                            repaired.qaResult.status !== "passed" ||
                            repaired.qaResult.snapshotRunId !==
                                state.integration.snapshotRunId
                        ) {
                            cycleRecord.status = "static_qa_failed";

                            recordEvent(projectRoot, {
                                type: "functional_repair.static_qa_failed",
                                runId,
                                cycle,
                                snapshotRunId: state.integration.snapshotRunId
                            });

                            persist();
                            break;
                        }

                        cycleRecord.status = "static_qa_passed";

                        persist();

                        // Retest the new snapshot, not the old one.
                        functionalResult = await executeCurrentFunctionalTests({
                            services,
                            projectRoot,
                            runId,
                            integration: state.integration
                        });

                        cycleRecord.functionalTestStatus =
                            functionalResult.status;

                        cycleRecord.status =
                            functionalResult.status === "passed"
                                ? "verified"
                                : functionalResult.status;

                        recordEvent(projectRoot, {
                            type: "functional_repair.retested",
                            runId,
                            cycle,
                            snapshotRunId: state.integration.snapshotRunId,
                            status: functionalResult.status,
                            summary: functionalResult.report?.summary || null
                        });

                        persist();

                        if (functionalResult.status !== "failed") break;
                    } catch (repairError) {
                        cycleRecord.status = "error";
                        cycleRecord.error = safeErrorMessage(repairError);

                        functionalResult = {
                            status: "error",
                            approval: "granted",
                            snapshotRunId: state.integration.snapshotRunId,
                            error: cycleRecord.error
                        };

                        recordEvent(projectRoot, {
                            type: "functional_repair.failed",
                            runId,
                            cycle,
                            error: cycleRecord.error
                        });

                        break;
                    }
                }
            }

            const finalFunctionalStatus = functionalResult.status;

            const verified =
                finalFunctionalStatus === "passed" &&
                functionalResult.approval === "granted" &&
                functionalResult.snapshotRunId ===
                    state.integration.snapshotRunId &&
                functionalResult.runtime?.status === "passed" &&
                state.qa.status === "passed" &&
                state.qa.snapshotRunId ===
                    state.integration.snapshotRunId;

            state.verification = {
                status: verified
                    ? "verified"
                    : finalFunctionalStatus === "approval_required"
                        ? "approval_required"
                        : finalFunctionalStatus === "unsupported"
                            ? "unsupported"
                            : finalFunctionalStatus === "failed"
                                ? "failed"
                                : "error",

                approval: functionalResult.approval || "not_granted",
                build: functionalResult.runtime?.status || "not_run",
                functionalTests: finalFunctionalStatus,
                runtime: functionalResult.runtime || null,
                report: functionalResult,

                evidence: verified
                    ? [{
                        type: "native_functional_tests",
                        snapshotRunId: state.integration.snapshotRunId,
                        summary: functionalResult.report.summary
                    }]
                    : [],

                repairCycles
            };

            recordEvent(projectRoot, {
                type: "functional_tests.completed",
                runId,
                status: finalFunctionalStatus,
                snapshotRunId: state.integration.snapshotRunId,
                summary: functionalResult.report?.summary || null,
                error: functionalResult.error || null,
                repairCycles: repairCycles.length
            });
        } catch (error) {
            state.verification = {
                status: "error",
                approval: approveFunctionalTests === true
                    ? "granted"
                    : "not_granted",
                build: "not_run",
                functionalTests: "error",
                runtime: null,
                report: {
                    status: "error",
                    error: safeErrorMessage(error)
                },
                evidence: [],
                repairCycles
            };

            recordEvent(projectRoot, {
                type: "functional_tests.failed",
                runId,
                error: safeErrorMessage(error)
            });
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
            runtime: null,
            report: null,
            evidence: [],
            repairCycles: []
        };

        persist();
    }

    // --------------------------------------------------
    // STAGE 5: EXPORT ONLY THE VERIFIED SNAPSHOT
    // --------------------------------------------------

    state.export = createInitialExportState();

    const verificationSnapshotId = state.integration.snapshotRunId;
    const verificationReport = state.verification.report;

    const tasksAllCompleted =
        state.tasks.length > 0 &&
        state.tasks.every(task => task.status === "completed");

    const verificationEvidenceValid =
        state.verification.status === "verified" &&
        state.verification.approval === "granted" &&
        state.verification.build === "passed" &&
        state.verification.functionalTests === "passed" &&
        state.verification.runtime?.status === "passed" &&
        verificationReport?.status === "passed" &&
        verificationReport?.approval === "granted" &&
        verificationReport?.snapshotRunId === verificationSnapshotId &&
        validateRunId(verificationSnapshotId) &&
        state.qa.status === "passed" &&
        state.qa.snapshotRunId === verificationSnapshotId;

    if (
        tasksAllCompleted &&
        state.integration.status === "completed" &&
        state.qa.status === "passed" &&
        verificationEvidenceValid &&
        Array.isArray(state.integration.files) &&
        state.integration.files.length > 0
    ) {
        try {
            const exportResult = await services.exportIntegratedProject({
                projectRoot,
                snapshotRunId: verificationSnapshotId,
                integrationFiles: state.integration.files
            });

            const validatedExport = validateExportResult({
                projectRoot,
                integrationFiles: state.integration.files,
                snapshotRunId: verificationSnapshotId,
                exportResult
            });

            state.export = {
                status: "completed",
                path: `workspace/${projectSlug}/final`,
                fileCount: validatedExport.fileCount,
                snapshotRunId: validatedExport.snapshotRunId,
                files: validatedExport.files
            };

            recordEvent(projectRoot, {
                type: "project.exported",
                runId,
                path: state.export.path,
                fileCount: state.export.fileCount,
                snapshotRunId: state.export.snapshotRunId
            });

            console.log(
                `[EXPORT] ${state.export.fileCount} files -> ${state.export.path}`
            );
        } catch (error) {
            state.export = {
                status: "failed",
                path: null,
                fileCount: 0,
                snapshotRunId: verificationSnapshotId,
                files: [],
                error: safeErrorMessage(error)
            };

            console.error(`[EXPORT ERROR] ${safeErrorMessage(error)}`);
        }
    } else {
        state.export.reason =
            "Export requires all tasks, static QA, runtime verification, and native functional tests to pass on the same snapshot.";
    }

    persist("export_evaluated");

    // --------------------------------------------------
    // STAGE 6: FINAL STATUS
    // --------------------------------------------------

    const failedTasks = state.tasks.filter(
        task => task.status === "failed"
    );

    const skippedTasks = state.tasks.filter(
        task => task.status === "skipped"
    );

    const pendingTasks = state.tasks.filter(
        task => task.status === "pending" || task.status === "running"
    );

    const exportEvidenceValid =
        state.export.status === "completed" &&
        state.export.snapshotRunId === state.integration.snapshotRunId &&
        Number.isInteger(state.export.fileCount) &&
        state.export.fileCount > 0;

    if (pendingTasks.length > 0) {
        state.status = "partially_completed";
    } else if (failedTasks.length > 0) {
        state.status = completed.size > 0
            ? "partially_completed"
            : "failed";
    } else if (skippedTasks.length > 0) {
        state.status = "partially_completed";
    } else if (state.integration.status !== "completed") {
        state.status = "integration_failed";
    } else if (state.qa.status !== "passed") {
        state.status = "qa_failed";
    } else if (state.verification.functionalTests === "failed") {
        state.status = "functional_tests_failed";
    } else if (
        state.verification.functionalTests === "error" ||
        state.verification.status === "error"
    ) {
        state.status = "verification_failed";
    } else if (
        state.verification.status === "approval_required" ||
        state.verification.status === "unsupported" ||
        state.verification.status === "blocked"
    ) {
        state.status = "verification_required";
    } else if (!verificationEvidenceValid) {
        state.status = "verification_required";
    } else if (state.export.status === "failed") {
        state.status = "export_failed";
    } else if (!exportEvidenceValid) {
        state.status = "export_failed";
    } else {
        state.status = "completed";
    }

    // This is the time the orchestration ended, not proof of success.
    state.finishedAt = new Date().toISOString();
    state.completedAt = state.status === "completed"
        ? state.finishedAt
        : null;

    recordEvent(projectRoot, {
        type: "project.finished",
        runId,
        status: state.status,
        completedTasks: completed.size,
        failedTasks: failedTasks.length,
        skippedTasks: skippedTasks.length,
        pendingTasks: pendingTasks.length,
        integrationStatus: state.integration.status,
        qaStatus: state.qa.status,
        verificationStatus: state.verification.status,
        exportStatus: state.export.status,
        exportSnapshotRunId: state.export.snapshotRunId || null
    });

    persist("project_finished");

    console.log(`[PROJECT] Finished with status: ${state.status}`);

    // --------------------------------------------------
    // FINAL RESULT
    // --------------------------------------------------

    return {
        projectName,
        projectSlug,
        runId,
        projectPath: `workspace/${projectSlug}`,

        runnablePath: state.export.status === "completed"
            ? state.export.path
            : null,

        export: state.export,
        status: state.status,

        totalTasks: state.tasks.length,
        completed: completed.size,
        failed: failedTasks.length,
        skipped: skippedTasks.length,
        pending: pendingTasks.length,

        generatedFiles: state.generatedFiles,

        integration: state.integration,
        integrationStatus: state.integration.status,

        qaStatus: state.qa.status,
        qa: state.qa,

        verification: state.verification,

        repairStatus: state.qa.repair?.status || "not_needed",
        repair: state.qa.repair || null,

        recovery: state.recovery || null,

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


// --------------------------------------------------
// EXPORTS
// --------------------------------------------------

module.exports = {
    runProject,
    evaluateIntegrationGate
};
