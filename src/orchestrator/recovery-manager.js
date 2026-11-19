
"use strict";

const {
    loadLatestCheckpoint,
    validateCompletedTasks
} = require("../runtime/checkpoint-manager");

function assertValidProjectState(
    state,
    expectedProjectSlug,
    expectedRunId
) {
    if (!state || typeof state !== "object" || Array.isArray(state)) {
        throw new Error(
            "Checkpoint does not contain a valid project state."
        );
    }

    if (state.projectSlug !== expectedProjectSlug) {
        throw new Error(
            "Checkpoint project slug does not match the requested project."
        );
    }

    if (state.runId !== expectedRunId) {
        throw new Error(
            "Checkpoint run ID does not match the requested run."
        );
    }

    if (
        !state.plan ||
        !Array.isArray(state.plan.tasks) ||
        !Array.isArray(state.tasks)
    ) {
        throw new Error(
            "Checkpoint is missing its saved project plan or task list."
        );
    }

    const taskIds = new Set();

    for (const task of state.tasks) {
        if (
            !task ||
            typeof task.id !== "string" ||
            !task.id.trim()
        ) {
            throw new Error(
                "Checkpoint contains a task with an invalid ID."
            );
        }

        if (taskIds.has(task.id)) {
            throw new Error(
                `Checkpoint contains duplicate task ID: ${task.id}`
            );
        }

        taskIds.add(task.id);

        if (
            task.dependsOn !== undefined &&
            (
                !Array.isArray(task.dependsOn) ||
                task.dependsOn.some(
                    id => typeof id !== "string"
                )
            )
        ) {
            throw new Error(
                `Task ${task.id} has invalid dependencies.`
            );
        }
    }

    const planIds = state.plan.tasks.map(
        task => task && task.id
    );

    if (
        planIds.length !== state.tasks.length ||
        planIds.some(
            (id, index) => id !== state.tasks[index].id
        )
    ) {
        throw new Error(
            "Saved task state does not match the saved project plan."
        );
    }
}

function resetIntegrationState() {
    return {
        status: "pending",
        summary: null,
        files: [],
        error: null,
        snapshotRunId: null
    };
}

function resetQAState() {
    return {
        status: "pending",
        report: null,
        error: null,
        repair: null
    };
}

function resetVerificationState() {
    return {
        status: "pending",
        approval: "not_granted",
        build: "not_run",
        functionalTests: "not_run",
        report: null,
        evidence: []
    };
}

function recoverProjectState({
    projectRoot,
    projectSlug,
    runId
}) {
    if (
        typeof projectSlug !== "string" ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(projectSlug)
    ) {
        throw new Error("Invalid project slug.");
    }

    const checkpoint = loadLatestCheckpoint(
        projectRoot,
        runId
    );

    if (!checkpoint) {
        throw new Error(
            "No saved checkpoint exists for this project run."
        );
    }

    const state = JSON.parse(
        JSON.stringify(checkpoint.state)
    );

    assertValidProjectState(
        state,
        projectSlug,
        runId
    );

    const validation = validateCompletedTasks(
        projectRoot,
        state.tasks,
        runId
    );

    const validTaskIds = new Set(
        validation.validTaskIds
    );

    const resumedTaskIds = [];
    const resetTaskIds = [];

    const invalidTaskMap = new Map(
        validation.invalidTasks.map(item => [
            item.taskId,
            item.reason
        ])
    );

    // Preserve only completed tasks whose generated artifacts
    // have been successfully validated.
    for (const task of state.tasks) {
        const isValidCompletedTask =
            task.status === "completed" &&
            validTaskIds.has(task.id);

        if (isValidCompletedTask) {
            resumedTaskIds.push(task.id);
            continue;
        }

        // Every unfinished or invalid task must be reported
        // as requiring execution again.
        resetTaskIds.push(task.id);

        if (
            task.status === "completed" &&
            invalidTaskMap.has(task.id)
        ) {
            console.warn(
                `[RECOVERY] Invalid completed task ${task.id}: ` +
                invalidTaskMap.get(task.id)
            );
        }

        task.status = "pending";
        task.result = null;
        task.error = null;
        task.startedAt = null;
        task.completedAt = null;
    }

    // Rebuild generated files using only validated completed tasks.
    const generatedFiles = [];

    for (const task of state.tasks) {
        if (
            task.status !== "completed" ||
            !task.result
        ) {
            continue;
        }

        if (Array.isArray(task.result.files)) {
            generatedFiles.push(
                ...task.result.files
            );
        }
    }

    state.generatedFiles = generatedFiles;

    // Downstream stages must run again against the recovered
    // and newly integrated project snapshot.
    state.integration = resetIntegrationState();
    state.qa = resetQAState();
    state.verification = resetVerificationState();

    state.status = "executing";
    state.completedAt = null;
    state.updatedAt = new Date().toISOString();

    state.recovery = {
        resumedAt: new Date().toISOString(),
        checkpointSequence: checkpoint.sequence,
        checkpointSavedAt: checkpoint.savedAt,
        resumedTaskIds,
        resetTaskIds,
        invalidCompletedTasks: validation.invalidTasks
    };

    return {
        state,

        checkpoint: {
            runId: checkpoint.runId,
            sequence: checkpoint.sequence,
            savedAt: checkpoint.savedAt,
            reason: checkpoint.reason
        },

        recovery: {
            resumedTaskIds,
            resetTaskIds,
            invalidCompletedTasks: validation.invalidTasks,
            generatedFileCount: generatedFiles.length,
            downstreamStagesReset: true
        }
    };
}

module.exports = {
    recoverProjectState,
    assertValidProjectState
};
