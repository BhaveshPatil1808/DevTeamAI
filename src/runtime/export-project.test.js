
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const {
    exportIntegratedProject
} = require("./export-project");

function createProject() {
    const projectRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "devteam-export-test-")
    );

    const snapshotRunId = randomUUID();

    const snapshotRoot = path.join(
        projectRoot,
        ".devteam",
        "integrated",
        snapshotRunId
    );

    fs.mkdirSync(
        path.join(snapshotRoot, "src"),
        { recursive: true }
    );

    fs.writeFileSync(
        path.join(snapshotRoot, "src", "index.js"),
        '"use strict";\nconsole.log("Hello");\n'
    );

    fs.writeFileSync(
        path.join(snapshotRoot, "package.json"),
        JSON.stringify({
            name: "export-test",
            version: "1.0.0"
        }, null, 2)
    );

    return {
        projectRoot,
        snapshotRunId,
        snapshotRoot,
        integrationFiles: [
            { path: "src/index.js" },
            { path: "package.json" }
        ]
    };
}

function cleanup(projectRoot) {
    if (projectRoot && fs.existsSync(projectRoot)) {
        fs.rmSync(projectRoot, {
            recursive: true,
            force: true
        });
    }
}

// --------------------------------------------------
// TEST 1: SUCCESSFUL EXPORT
// --------------------------------------------------

test(
    "exports all files from the requested integration snapshot",
    () => {
        const project = createProject();

        try {
            const result = exportIntegratedProject(project);

            assert.equal(result.directory, "final");
            assert.equal(result.snapshotRunId, project.snapshotRunId);
            assert.equal(result.fileCount, 2);

            assert.deepEqual(
                [...result.files].sort(),
                ["package.json", "src/index.js"]
            );

            const finalRoot = path.join(
                project.projectRoot,
                "final"
            );

            assert.equal(
                fs.existsSync(
                    path.join(finalRoot, "src", "index.js")
                ),
                true
            );

            assert.equal(
                fs.readFileSync(
                    path.join(finalRoot, "src", "index.js"),
                    "utf8"
                ),
                fs.readFileSync(
                    path.join(project.snapshotRoot, "src", "index.js"),
                    "utf8"
                )
            );

            assert.equal(
                fs.readFileSync(
                    path.join(finalRoot, "package.json"),
                    "utf8"
                ),
                fs.readFileSync(
                    path.join(project.snapshotRoot, "package.json"),
                    "utf8"
                )
            );
        } finally {
            cleanup(project.projectRoot);
        }
    }
);

// --------------------------------------------------
// TEST 2: SNAPSHOT ID VALIDATION
// --------------------------------------------------

test(
    "rejects files belonging to a different integration snapshot",
    () => {
        const project = createProject();

        try {
            assert.throws(
                () => exportIntegratedProject({
                    ...project,
                    integrationFiles: [{
                        path: `.devteam/integrated/${randomUUID()}/src/index.js`
                    }]
                }),
                /different integration snapshot/i
            );
        } finally {
            cleanup(project.projectRoot);
        }
    }
);

// --------------------------------------------------
// TEST 3: PATH TRAVERSAL
// --------------------------------------------------

test(
    "rejects paths that escape the integration snapshot",
    () => {
        const project = createProject();

        try {
            assert.throws(
                () => exportIntegratedProject({
                    ...project,
                    integrationFiles: [{
                        path: "../outside.txt"
                    }]
                }),
                /unsafe|escapes/i
            );
        } finally {
            cleanup(project.projectRoot);
        }
    }
);

// --------------------------------------------------
// TEST 4: DUPLICATE PATHS
// --------------------------------------------------

test(
    "rejects duplicate export file paths",
    () => {
        const project = createProject();

        try {
            assert.throws(
                () => exportIntegratedProject({
                    ...project,
                    integrationFiles: [
                        { path: "src/index.js" },
                        { path: "src/index.js" }
                    ]
                }),
                /duplicate/i
            );
        } finally {
            cleanup(project.projectRoot);
        }
    }
);

// --------------------------------------------------
// TEST 5: SYMLINKED SOURCE FILE
// --------------------------------------------------

test(
    "rejects symbolic links inside the integration snapshot",
    t => {
        const project = createProject();

        try {
            const externalFile = path.join(
                project.projectRoot,
                "external.txt"
            );

            fs.writeFileSync(externalFile, "outside snapshot");

            const linkPath = path.join(
                project.snapshotRoot,
                "src",
                "linked.txt"
            );

            try {
                fs.symlinkSync(externalFile, linkPath);
            } catch (error) {
                if (
                    error.code === "EPERM" ||
                    error.code === "EACCES" ||
                    error.code === "ENOSYS"
                ) {
                    t.skip("Symbolic links are unavailable in this environment.");
                    return;
                }

                throw error;
            }

            assert.throws(
                () => exportIntegratedProject({
                    ...project,
                    integrationFiles: [{
                        path: "src/linked.txt"
                    }]
                }),
                /symbolic link|symlink|regular file/i
            );
        } finally {
            cleanup(project.projectRoot);
        }
    }
);

// --------------------------------------------------
// TEST 6: PRESERVE EXISTING EXPORT ON FAILURE
// --------------------------------------------------

test(
    "preserves the previous final export when the new export fails",
    () => {
        const project = createProject();

        try {
            const finalRoot = path.join(
                project.projectRoot,
                "final"
            );

            fs.mkdirSync(finalRoot);

            const previousFile = path.join(
                finalRoot,
                "previous.txt"
            );

            fs.writeFileSync(
                previousFile,
                "previous successful export"
            );

            assert.throws(
                () => exportIntegratedProject({
                    ...project,
                    integrationFiles: [{
                        path: "src/missing.js"
                    }]
                })
            );

            assert.equal(
                fs.existsSync(previousFile),
                true
            );

            assert.equal(
                fs.readFileSync(previousFile, "utf8"),
                "previous successful export"
            );
        } finally {
            cleanup(project.projectRoot);
        }
    }
);

// --------------------------------------------------
// TEST 7: EMPTY FILE LIST
// --------------------------------------------------

test(
    "rejects an empty integration file list",
    () => {
        const project = createProject();

        try {
            assert.throws(
                () => exportIntegratedProject({
                    ...project,
                    integrationFiles: []
                }),
                /no integration files/i
            );
        } finally {
            cleanup(project.projectRoot);
        }
    }
);

// --------------------------------------------------
// TEST 8: INVALID SNAPSHOT ID
// --------------------------------------------------

test(
    "rejects an invalid snapshot UUID",
    () => {
        const project = createProject();

        try {
            assert.throws(
                () => exportIntegratedProject({
                    ...project,
                    snapshotRunId: "invalid-snapshot-id"
                }),
                /invalid snapshot id/i
            );
        } finally {
            cleanup(project.projectRoot);
        }
    }
);

console.log("[EXPORT TESTS] Exporter test suite loaded.");
