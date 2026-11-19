"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CHECKPOINT_VERSION = 1;

function isInside(parent, target) {
    const relative = path.relative(parent, target);

    return (
        relative !== "" &&
        relative !== ".." &&
        !relative.startsWith(".." + path.sep) &&
        !path.isAbsolute(relative)
    );
}

function validateRunId(runId) {
    if (
        typeof runId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)
    ) {
        throw new Error("Invalid checkpoint run ID.");
    }

    return runId;
}

function ensureSafeDirectory(base, segments) {
    const realBase = fs.realpathSync(base);
    let current = realBase;

    for (const segment of segments) {
        if (
            typeof segment !== "string" ||
            !segment ||
            segment === "." ||
            segment === ".." ||
            segment.includes("/") ||
            segment.includes("\\")
        ) {
            throw new Error("Invalid checkpoint directory segment.");
        }

        current = path.join(current, segment);

        try {
            const stats = fs.lstatSync(current);

            if (stats.isSymbolicLink() || !stats.isDirectory()) {
                throw new Error("Unsafe checkpoint directory detected.");
            }
        } catch (error) {
            if (error.code !== "ENOENT") {
                throw error;
            }

            fs.mkdirSync(current);

            const stats = fs.lstatSync(current);

            if (stats.isSymbolicLink() || !stats.isDirectory()) {
                throw new Error("Unsafe checkpoint directory detected.");
            }
        }
    }

    const realTarget = fs.realpathSync(current);

    if (realTarget !== realBase && !isInside(realBase, realTarget)) {
        throw new Error("Checkpoint directory escaped the project.");
    }

    return realTarget;
}

function getCheckpointDirectory(projectRoot, runId) {
    const rootStats = fs.lstatSync(projectRoot);

    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
        throw new Error("Invalid project root for checkpoint storage.");
    }

    const realRoot = fs.realpathSync(projectRoot);

    return ensureSafeDirectory(realRoot, [
        ".devteam",
        "checkpoints",
        validateRunId(runId)
    ]);
}

function readJsonFile(filePath) {
    const stats = fs.lstatSync(filePath);

    if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error("Checkpoint file is not a regular file.");
    }

    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));

    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Invalid checkpoint JSON.");
    }

    return value;
}

function writeImmutableJson(filePath, value) {
    const descriptor = fs.openSync(filePath, "wx", 0o600);

    try {
        fs.writeFileSync(
            descriptor,
            JSON.stringify(value, null, 2),
            "utf8"
        );

        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
}

function writeAtomicJson(filePath, value) {
    const temporary = `${filePath}.${process.pid}.tmp`;

    const descriptor = fs.openSync(temporary, "wx", 0o600);

    try {
        fs.writeFileSync(
            descriptor,
            JSON.stringify(value, null, 2),
            "utf8"
        );

        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }

    try {
        const existing = fs.lstatSync(filePath);

        if (!existing.isFile() || existing.isSymbolicLink()) {
            throw new Error("Unsafe latest checkpoint pointer.");
        }
    } catch (error) {
        if (error.code !== "ENOENT") {
            fs.rmSync(temporary, { force: true });
            throw error;
        }
    }

    try {
        fs.renameSync(temporary, filePath);
    } catch (error) {
        fs.rmSync(temporary, { force: true });
        throw error;
    }
}

function getLatestSequence(directory, runId) {
    const latestPath = path.join(directory, "latest.json");

    try {
        const latest = readJsonFile(latestPath);

        if (
            latest.version !== CHECKPOINT_VERSION ||
            latest.runId !== runId ||
            !Number.isSafeInteger(latest.sequence) ||
            latest.sequence < 1
        ) {
            throw new Error("Invalid latest checkpoint pointer.");
        }

        return latest.sequence;
    } catch (error) {
        if (error.code === "ENOENT") {
            return 0;
        }

        throw error;
    }
}

function saveCheckpoint(projectRoot, state, reason = "progress") {
    if (!state || typeof state !== "object" || Array.isArray(state)) {
        throw new Error("Invalid project state for checkpoint.");
    }

    const runId = validateRunId(state.runId);

    if (!Array.isArray(state.tasks)) {
        throw new Error("Project state has no valid task list.");
    }

    const validation = validateCompletedTasks(
        projectRoot,
        state.tasks,
        runId
    );

    if (validation.invalidTasks.length > 0) {
        const details = validation.invalidTasks
            .map(item => `${item.taskId || "unknown"}: ${item.reason}`)
            .join("; ");

        throw new Error(
            `Checkpoint rejected because completed task artifacts are invalid: ${details}`
        );
    }

    const directory = getCheckpointDirectory(projectRoot, runId);
    const sequence = getLatestSequence(directory, runId) + 1;
    const savedAt = new Date().toISOString();

    state.checkpoint = {
        version: CHECKPOINT_VERSION,
        sequence,
        savedAt,
        reason: String(reason).slice(0, 200)
    };

    const snapshot = {
        version: CHECKPOINT_VERSION,
        runId,
        sequence,
        savedAt,
        reason: String(reason).slice(0, 200),
        state: JSON.parse(JSON.stringify(state))
    };

    const checkpointFile = `checkpoint-${sequence}.json`;
    const checkpointPath = path.join(directory, checkpointFile);

    writeImmutableJson(checkpointPath, snapshot);

    writeAtomicJson(path.join(directory, "latest.json"), {
        version: CHECKPOINT_VERSION,
        runId,
        sequence,
        file: checkpointFile,
        savedAt
    });

    return {
        runId,
        sequence,
        savedAt,
        file: checkpointFile
    };
}

function loadLatestCheckpoint(projectRoot, expectedRunId) {
    const runId = validateRunId(expectedRunId);
    const directory = getCheckpointDirectory(projectRoot, runId);
    const latestPath = path.join(directory, "latest.json");

    let latest;

    try {
        latest = readJsonFile(latestPath);
    } catch (error) {
        if (error.code === "ENOENT") {
            return null;
        }

        throw error;
    }

    if (
        latest.version !== CHECKPOINT_VERSION ||
        latest.runId !== runId ||
        !Number.isSafeInteger(latest.sequence) ||
        latest.sequence < 1 ||
        latest.file !== `checkpoint-${latest.sequence}.json`
    ) {
        throw new Error("Latest checkpoint pointer failed validation.");
    }

    const checkpointPath = path.join(directory, latest.file);
    const snapshot = readJsonFile(checkpointPath);

    if (
        snapshot.version !== CHECKPOINT_VERSION ||
        snapshot.runId !== runId ||
        snapshot.sequence !== latest.sequence ||
        !snapshot.state ||
        snapshot.state.runId !== runId ||
        !Array.isArray(snapshot.state.tasks)
    ) {
        throw new Error("Checkpoint snapshot failed validation.");
    }

    return {
        runId,
        sequence: snapshot.sequence,
        savedAt: snapshot.savedAt,
        reason: snapshot.reason,
        state: snapshot.state
    };
}

function validateArtifact(projectRoot, artifact, runId) {
    if (!artifact || typeof artifact.path !== "string") {
        return {
            valid: false,
            reason: "Invalid artifact record."
        };
    }

    const normalized = artifact.path.replace(/\\/g, "/");
    const parts = normalized.split("/");

    if (
        normalized.startsWith("/") ||
        /^[a-zA-Z]:/.test(normalized) ||
        normalized.includes("\0") ||
        parts.some(part =>
            !part ||
            part === "." ||
            part === ".."
        ) ||
        parts[0] !== ".devteam" ||
        parts[1] !== "generated" ||
        parts[2] !== runId ||
        parts.length < 5
    ) {
        return {
            valid: false,
            reason: "Artifact path is outside the expected run staging directory."
        };
    }

    const realRoot = fs.realpathSync(projectRoot);
    const absolutePath = path.resolve(realRoot, ...parts);

    if (!isInside(realRoot, absolutePath)) {
        return {
            valid: false,
            reason: "Artifact path escaped the project."
        };
    }

    let current = realRoot;

    try {
        for (const part of parts) {
            current = path.join(current, part);
            const stats = fs.lstatSync(current);

            if (stats.isSymbolicLink()) {
                return {
                    valid: false,
                    reason: "Symbolic links are not allowed in checkpoint artifacts."
                };
            }
        }

        const stats = fs.lstatSync(absolutePath);

        if (!stats.isFile()) {
            return {
                valid: false,
                reason: "Artifact is not a regular file."
            };
        }

        if (
            Number.isSafeInteger(artifact.bytes) &&
            artifact.bytes !== stats.size
        ) {
            return {
                valid: false,
                reason: "Artifact size differs from the saved checkpoint."
            };
        }

        return {
            valid: true,
            path: normalized,
            bytes: stats.size
        };
    } catch (error) {
        return {
            valid: false,
            reason: `Artifact validation failed: ${error.message}`
        };
    }
}

function validateCompletedTasks(projectRoot, tasks, runId) {
    validateRunId(runId);

    if (!Array.isArray(tasks)) {
        throw new Error("Invalid task list for checkpoint validation.");
    }

    const validTaskIds = [];
    const invalidTasks = [];

    for (const task of tasks) {
        if (!task || task.status !== "completed") {
            continue;
        }

        const files = task.result && task.result.files;

        if (!Array.isArray(files) || files.length === 0) {
            invalidTasks.push({
                taskId: task.id || null,
                reason: "Completed task has no saved artifact records."
            });
            continue;
        }

        const results = files.map(file =>
            validateArtifact(projectRoot, file, runId)
        );

        const invalid = results.filter(result => !result.valid);

        if (invalid.length) {
            invalidTasks.push({
                taskId: task.id || null,
                reason: invalid.map(item => item.reason).join("; ")
            });
        } else {
            validTaskIds.push(task.id);
        }
    }

    return {
        validTaskIds,
        invalidTasks
    };
}

module.exports = {
    saveCheckpoint,
    loadLatestCheckpoint,
    validateArtifact,
    validateCompletedTasks
};
