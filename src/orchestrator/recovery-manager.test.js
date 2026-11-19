const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { saveCheckpoint } = require("../runtime/checkpoint-manager");
const { recoverProjectState } = require("./recovery-manager");

const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const PROJECT_SLUG = "sample-project";

function createFixture() {
    const projectRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "devteam-recovery-")
    );

    const generatedDirectory = path.join(
        projectRoot,
        ".devteam",
        "generated",
        RUN_ID,
        "backend"
    );

    fs.mkdirSync(generatedDirectory, { recursive: true });

    const artifactPath = path.join(generatedDirectory, "server.js");
    const content = "module.exports = { health: () => true };";

    fs.writeFileSync(artifactPath, content, "utf8");

    const artifact = {
        path: `.devteam/generated/${RUN_ID}/backend/server.js`,
        bytes: Buffer.byteLength(content)
    };

    const completedTask = {
        id: "backend",
        agentId: "backend",
        title: "Backend Developer",
        dependsOn: [],
        status: "completed",
        result: {
            agentName: "Backend Developer",
            summary: "Created the backend.",
            files: [artifact]
        },
        error: null
    };

    const planTasks = [
        {
            id: "backend",
            agentId: "backend",
            title: "Backend Developer",
            dependsOn: []
        },
        {
            id: "frontend",
            agentId: "frontend",
            title: "Frontend Developer",
            dependsOn: ["backend"]
        },
        {
            id: "qa",
            agentId: "qa",
            title: "QA Engineer",
            dependsOn: ["backend", "frontend"]
        }
    ];

    const state = {
        projectName: "Sample Project",
        projectSlug: PROJECT_SLUG,
        runId: RUN_ID,
        description: "A recovery test project.",
        status: "executing",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: null,
        plan: {
            summary: "Test plan",
            technologyStack: ["Node.js"],
            tasks: planTasks
        },
        tasks: [
            completedTask,
            {
                ...planTasks[1],
                status: "running",
                result: null,
                error: null
            },
            {
                ...planTasks[2],
                status: "failed",
                result: null,
                error: "Temporary provider failure"
            }
        ],
        generatedFiles: [artifact],
        integration: {
            status: "completed",
            summary: "Old integration result",
            files: [{ path: "old-file.js", bytes: 10 }],
            snapshotRunId: RUN_ID
        },
        qa: {
            status: "passed",
            report: { summary: "Old QA result" },
            error: null
        },
        verification: {
            status: "verified",
            approval: "granted",
            build: "not_run",
            functionalTests: "passed",
            report: { status: "passed" },
            evidence: []
        }
    };

    return {
        projectRoot,
        artifactPath,
        artifact,
        state,
        cleanup() {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    };
}

test("restores completed tasks with valid generated artifacts", () => {
    const fixture = createFixture();

    try {
        saveCheckpoint(fixture.projectRoot, fixture.state, "test");

        const result = recoverProjectState({
            projectRoot: fixture.projectRoot,
            projectSlug: PROJECT_SLUG,
            runId: RUN_ID
        });

        assert.equal(result.state.tasks[0].status, "completed");
        assert.equal(result.state.tasks[1].status, "pending");
        assert.equal(result.state.tasks[2].status, "pending");

        assert.deepEqual(result.recovery.resumedTaskIds, ["backend"]);
        assert.deepEqual(
            result.recovery.resetTaskIds.sort(),
            ["frontend", "qa"]
        );

        assert.equal(result.state.generatedFiles.length, 1);
        assert.equal(
            result.state.generatedFiles[0].path,
            fixture.artifact.path
        );
    } finally {
        fixture.cleanup();
    }
});

test("resets a completed task when its generated artifact is missing", () => {
    const fixture = createFixture();

    try {
        saveCheckpoint(fixture.projectRoot, fixture.state, "test");

        fs.unlinkSync(fixture.artifactPath);

        const result = recoverProjectState({
            projectRoot: fixture.projectRoot,
            projectSlug: PROJECT_SLUG,
            runId: RUN_ID
        });

        assert.equal(result.state.tasks[0].status, "pending");
        assert.equal(result.state.tasks[0].result, null);
        assert.equal(result.state.generatedFiles.length, 0);
        assert.equal(result.recovery.resumedTaskIds.length, 0);
        assert.equal(result.recovery.invalidCompletedTasks.length, 1);
    } finally {
        fixture.cleanup();
    }
});

test("resets downstream integration, QA and verification state", () => {
    const fixture = createFixture();

    try {
        saveCheckpoint(fixture.projectRoot, fixture.state, "test");

        const result = recoverProjectState({
            projectRoot: fixture.projectRoot,
            projectSlug: PROJECT_SLUG,
            runId: RUN_ID
        });

        assert.equal(result.state.integration.status, "pending");
        assert.deepEqual(result.state.integration.files, []);

        assert.equal(result.state.qa.status, "pending");
        assert.equal(result.state.verification.status, "pending");
        assert.equal(result.state.verification.approval, "not_granted");

        assert.equal(result.recovery.downstreamStagesReset, true);
    } finally {
        fixture.cleanup();
    }
});

test("rejects a checkpoint belonging to a different project slug", () => {
    const fixture = createFixture();

    try {
        saveCheckpoint(fixture.projectRoot, fixture.state, "test");

        assert.throws(
            () => recoverProjectState({
                projectRoot: fixture.projectRoot,
                projectSlug: "another-project",
                runId: RUN_ID
            }),
            /project slug does not match/
        );
    } finally {
        fixture.cleanup();
    }
});

test("rejects recovery when no checkpoint exists", () => {
    const projectRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "devteam-empty-recovery-")
    );

    try {
        assert.throws(
            () => recoverProjectState({
                projectRoot,
                projectSlug: PROJECT_SLUG,
                runId: RUN_ID
            }),
            /No saved checkpoint exists/
        );
    } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
    }
});
