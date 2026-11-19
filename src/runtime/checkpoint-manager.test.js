"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const {
    saveCheckpoint,
    loadLatestCheckpoint,
    validateCompletedTasks
} = require("./checkpoint-manager");

const WORKSPACE = path.resolve(__dirname, "../../workspace");

function createTestProject() {
    fs.mkdirSync(WORKSPACE, { recursive: true });

    const projectRoot = path.join(
        WORKSPACE,
        `.checkpoint-test-${randomUUID()}`
    );

    fs.mkdirSync(projectRoot);

    return projectRoot;
}

test("saves and restores the latest checkpoint", () => {
    const projectRoot = createTestProject();
    const runId = randomUUID();

    try {
        const state = {
            runId,
            status: "executing",
            tasks: [
                { id: "backend", status: "pending" }
            ]
        };

        const saved = saveCheckpoint(
            projectRoot,
            state,
            "test checkpoint"
        );

        assert.equal(saved.sequence, 1);

        const restored = loadLatestCheckpoint(
            projectRoot,
            runId
        );

        assert.equal(restored.sequence, 1);
        assert.equal(restored.state.status, "executing");
        assert.equal(restored.state.tasks[0].id, "backend");

        state.status = "integrating";

        const second = saveCheckpoint(
            projectRoot,
            state,
            "second checkpoint"
        );

        assert.equal(second.sequence, 2);

        const latest = loadLatestCheckpoint(
            projectRoot,
            runId
        );

        assert.equal(latest.sequence, 2);
        assert.equal(latest.state.status, "integrating");
    } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
    }
});

test("validates completed task artifacts", () => {
    const projectRoot = createTestProject();
    const runId = randomUUID();

    try {
        const artifactPath = path.join(
            projectRoot,
            ".devteam",
            "generated",
            runId,
            "backend-developer",
            "server.js"
        );

        fs.mkdirSync(path.dirname(artifactPath), {
            recursive: true
        });

        fs.writeFileSync(artifactPath, "module.exports = true;\n");

        const task = {
            id: "backend",
            status: "completed",
            result: {
                files: [{
                    path: path.relative(projectRoot, artifactPath),
                    bytes: Buffer.byteLength("module.exports = true;\n")
                }]
            }
        };

        const result = validateCompletedTasks(
            projectRoot,
            [task],
            runId
        );

        assert.deepEqual(result.validTaskIds, ["backend"]);
        assert.equal(result.invalidTasks.length, 0);

        fs.writeFileSync(artifactPath, "changed");

        const changed = validateCompletedTasks(
            projectRoot,
            [task],
            runId
        );

        assert.equal(changed.validTaskIds.length, 0);
        assert.equal(changed.invalidTasks.length, 1);
    } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
    }
});

test("rejects a checkpoint for a different run ID", () => {
    const projectRoot = createTestProject();

    try {
        const state = {
            runId: randomUUID(),
            status: "executing",
            tasks: []
        };

        saveCheckpoint(projectRoot, state);

        const differentRun = loadLatestCheckpoint(
            projectRoot,
            randomUUID()
        );

        assert.equal(differentRun, null);
    } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
    }
});

test("rejects completed tasks when generated artifacts are missing", () => {
    const projectRoot = createTestProject();
    const runId = randomUUID();

    try {
        const state = {
            runId,
            status: "executing",
            tasks: [
                {
                    id: "backend",
                    status: "completed",
                    result: {
                        files: [{
                            path: path.join(
                                ".devteam",
                                "generated",
                                runId,
                                "backend-developer",
                                "missing.js"
                            ),
                            bytes: 100
                        }]
                    }
                }
            ]
        };

        assert.throws(
            () => saveCheckpoint(
                projectRoot,
                state,
                "invalid completed task"
            ),
            /completed task artifacts are invalid/i
        );

        assert.equal(
            loadLatestCheckpoint(projectRoot, runId),
            null
        );
    } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
    }
});

test("saves and restores a completed task with its generated artifact", () => {
    const projectRoot = createTestProject();
    const runId = randomUUID();
    const content = "module.exports = 'verified';\n";

    try {
        const relativePath = path.join(
            ".devteam",
            "generated",
            runId,
            "backend-developer",
            "server.js"
        );

        const artifactPath = path.join(projectRoot, relativePath);

        fs.mkdirSync(path.dirname(artifactPath), {
            recursive: true
        });

        fs.writeFileSync(artifactPath, content);

        const state = {
            runId,
            status: "executing",
            tasks: [{
                id: "backend",
                status: "completed",
                result: {
                    summary: "Backend files generated",
                    files: [{
                        path: relativePath,
                        bytes: Buffer.byteLength(content)
                    }]
                }
            }]
        };

        const saved = saveCheckpoint(
            projectRoot,
            state,
            "backend completed"
        );

        assert.equal(saved.sequence, 1);

        const restored = loadLatestCheckpoint(
            projectRoot,
            runId
        );

        assert.equal(
            restored.state.tasks[0].status,
            "completed"
        );

        assert.equal(
            restored.state.tasks[0].result.files[0].path,
            relativePath
        );

        assert.equal(
            fs.readFileSync(artifactPath, "utf8"),
            content
        );
    } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
    }
});
