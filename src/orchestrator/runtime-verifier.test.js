
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const {
    verifyRuntime,
    analyzeStatic,
    detectProject,
    extractIssuesFromOutput
} = require("./runtime-verifier");

const { writeIntegratedFiles } = require("./integration-engine");
const { runStaticQA } = require("./qa-runner");
const { runApprovedFunctionalTests } = require("./functional-test-runner");
const { runAutomatedRepair } = require("./repair-runner");
const { exportIntegratedProject } = require("../runtime/export-project");

const files = object => new Map(Object.entries(object));

const manifest = (extra = {}) => JSON.stringify({
    name: "sample",
    version: "1.0.0",
    scripts: {
        start: "node server.js",
        test: "node --test"
    },
    ...extra
});

const WORKING_SERVER = `
const http = require("http");
const fs = require("fs");
const path = require("path");

http.createServer((req, res) => {
    if (req.url === "/") {
        res.setHeader("content-type", "text/html");
        return res.end(fs.readFileSync(path.join(__dirname, "public/index.html")));
    }

    const file = path.join(__dirname, "public", req.url);

    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        return res.end(fs.readFileSync(file));
    }

    res.statusCode = 404;
    res.end("not found");
}).listen(process.env.PORT || 3000, () => console.log("listening"));
`;

test("static check finds a missing required module", () => {
    const map = files({
        "package.json": manifest(),
        "server.js": 'const routes = require("./routes/students");'
    });

    const issues = analyzeStatic(map, detectProject(map));

    assert.equal(issues.length, 1);
    assert.equal(issues[0].kind, "missing_file");
    assert.equal(issues[0].targetPath, "routes/students.js");
    assert.equal(issues[0].requiredBy, "server.js");
});

test("static check accepts index files, json files and node builtins", () => {
    const map = files({
        "package.json": manifest(),
        "server.js": `
            const fs = require("node:fs");
            const path = require("path");
            const lib = require("./lib");
            const data = require("./data.json");
        `,
        "lib/index.js": "module.exports = {};",
        "data.json": "{}"
    });

    assert.deepEqual(analyzeStatic(map, detectProject(map)), []);
});

test("static check finds an undeclared dependency", () => {
    const map = files({
        "package.json": manifest(),
        "server.js": 'const express = require("express");'
    });

    const issues = analyzeStatic(map, detectProject(map));

    assert.equal(issues[0].kind, "missing_dependency");
    assert.equal(issues[0].targetPath, "package.json");
    assert.equal(issues[0].packageName, "express");
});

test("static check finds missing local assets referenced by HTML", () => {
    const map = files({
        "package.json": manifest(),
        "server.js": "1",
        "public/index.html":
            '<link rel="stylesheet" href="style.css">' +
            '<script src="/app.js"></script>' +
            '<script src="https://cdn.example.com/x.js"></script>',
        "public/style.css": "a{}"
    });

    const issues = analyzeStatic(map, detectProject(map));

    assert.deepEqual(
        issues.map(issue => issue.targetPath),
        ["public/app.js"]
    );
});

test("static check finds an invalid package.json and a missing start target", () => {
    const broken = files({
        "package.json": "{ nope",
        "server.js": "1"
    });

    const brokenIssues = analyzeStatic(broken, detectProject(broken));

    assert.equal(brokenIssues[0].kind, "invalid_json");

    const noEntry = files({
        "package.json": manifest({
            scripts: {
                start: "node src/main.js"
            }
        })
    });

    const entryIssues = analyzeStatic(noEntry, detectProject(noEntry));

    assert.equal(entryIssues[0].targetPath, "src/main.js");
});

test("startup errors are mapped to the file that must be fixed", () => {
    const map = files({
        "server.js": "1",
        "routes/a.js": "1"
    });

    const workDir = os.tmpdir();

    const output = [
        "node:internal/modules/cjs/loader:1228",
        "  throw err;",
        "Error: Cannot find module './models/student'",
        "Require stack:",
        `- ${workDir}/routes/a.js`,
        `- ${workDir}/server.js`
    ].join("\n");

    const issues = extractIssuesFromOutput(
        output,
        workDir,
        map,
        "server.js"
    );

    assert.equal(issues[0].kind, "missing_file");
    assert.equal(issues[0].targetPath, "routes/models/student.js");
});

test(
    "a working server passes and its assets are verified as served",
    { timeout: 60000 },
    async () => {
        const result = await verifyRuntime({
            files: files({
                "package.json": manifest(),
                "server.js": WORKING_SERVER,
                "public/index.html": '<script src="/app.js"></script>',
                "public/app.js": "console.log('hi');"
            }),
            startWaitMs: 10000
        });

        assert.equal(result.status, "passed", result.summary);
        assert.ok(result.url);
    }
);

test(
    "a crash on startup fails and points at the crashing file",
    { timeout: 60000 },
    async () => {
        const result = await verifyRuntime({
            files: files({
                "package.json": manifest(),
                "server.js": "function start() { notDefinedAnywhere(); }\nstart();\n"
            }),
            startWaitMs: 10000
        });

        assert.equal(result.status, "failed");
        assert.equal(result.issues[0].targetPath, "server.js");
    }
);

test(
    "provider API keys are never exposed to generated code",
    { timeout: 60000 },
    async () => {
        process.env.TEST_PROVIDER_API_KEY = "must-not-leak";

        try {
            const result = await verifyRuntime({
                files: files({
                    "package.json": manifest(),
                    "server.js":
                        "if (process.env.TEST_PROVIDER_API_KEY) process.exit(2);"
                }),
                startWaitMs: 10000
            });

            assert.equal(result.status, "passed", result.summary);
        } finally {
            delete process.env.TEST_PROVIDER_API_KEY;
        }
    }
);

test(
    "full loop: verify -> repair missing files with injected agents -> verify again -> export",
    { timeout: 120000 },
    async () => {
        const projectRoot = fs.mkdtempSync(
            path.join(os.tmpdir(), "devteam-runtime-loop-")
        );

        try {
            const runId = randomUUID();
            const firstSnapshotId = randomUUID();

            // Initial snapshot intentionally has a missing application module.
            // The native test suite is present from the beginning.
            const initial = [
                {
                    path: "package.json",
                    content: manifest()
                },
                {
                    path: "server.js",
                    content: `
const http = require("http");
const greeting = require("./lib/greeting");

http.createServer((req, res) => res.end(greeting()))
    .listen(process.env.PORT || 3000, () => console.log("up"));
`
                },
                {
                    path: "test/app.test.js",
                    content: `
const test = require("node:test");
const assert = require("node:assert/strict");
const greeting = require("../lib/greeting");

test("generated greeting module returns the expected response", () => {
    assert.equal(greeting(), "hello");
});
`
                }
            ];

            let snapshotFiles = writeIntegratedFiles(
                projectRoot,
                initial,
                runId,
                firstSnapshotId
            );

            const snapshotId = firstSnapshotId;

            // Static QA on the initial snapshot.
            const qaReport = await runStaticQA({
                projectRoot,
                runId: snapshotId,
                integrationFiles: snapshotFiles
            });

            // First verification must fail because lib/greeting.js is missing.
            const first = await runApprovedFunctionalTests({
                projectRoot,
                runId,
                snapshotRunId: snapshotId,
                integrationFiles: snapshotFiles,
                approved: true,
                runtimeVerification: true,
                runtimeOptions: {
                    startWaitMs: 10000
                }
            });

            assert.equal(first.status, "failed");

            assert.deepEqual(
                first.runtime.issues.map(issue => issue.targetPath),
                ["lib/greeting.js"]
            );

            // Run automated repair with an injected mock backend agent.
            const requested = [];

            const repaired = await runAutomatedRepair({
                projectRoot,
                projectName: "Greeter",
                description: "A tiny greeting server.",
                plan: {
                    summary: "",
                    technologyStack: ["Node.js"]
                },
                runId,
                snapshotRunId: snapshotId,
                integrationFiles: snapshotFiles,
                qaReport,
                functionalResult: first,
                dependencies: {
                    executePlannedTask: async ({ task, projectContext }) => {
                        requested.push({
                            task,
                            projectContext
                        });

                        return {
                            agentName: "Mock Backend",
                            summary: "Created missing greeting module.",
                            files: [
                                {
                                    path: "lib/greeting.js",
                                    content:
                                        'module.exports = () => "hello";\n'
                                }
                            ]
                        };
                    }
                }
            });

            assert.equal(requested.length, 1);

            assert.match(
                requested[0].projectContext,
                /server\.js/
            );

            assert.match(
                requested[0].projectContext,
                /Missing file|lib\/greeting\.js/
            );

            // Repair must create a new immutable snapshot.
            assert.notEqual(
                repaired.snapshotRunId,
                snapshotId
            );

            // Re-run native tests and runtime verification on the repaired snapshot.
            const second = await runApprovedFunctionalTests({
                projectRoot,
                runId,
                snapshotRunId: repaired.snapshotRunId,
                integrationFiles: repaired.integrationFiles,
                approved: true,
                runtimeVerification: true,
                runtimeOptions: {
                    startWaitMs: 10000
                }
            });

            assert.equal(
                second.status,
                "passed",
                JSON.stringify(second, null, 2)
            );

            // Export only the successfully verified repaired snapshot.
            const exported = exportIntegratedProject({
                projectRoot,
                snapshotRunId: repaired.snapshotRunId,
                integrationFiles: repaired.integrationFiles
            });

            assert.deepEqual(
                exported.files.sort(),
                [
                    "lib/greeting.js",
                    "package.json",
                    "server.js",
                    "test/app.test.js"
                ]
            );

            assert.ok(
                fs.existsSync(
                    path.join(projectRoot, "final", "server.js")
                )
            );

            assert.ok(
                fs.existsSync(
                    path.join(projectRoot, "final", "test", "app.test.js")
                )
            );

            assert.ok(
                fs.existsSync(
                    path.join(projectRoot, "final", "lib", "greeting.js")
                )
            );

            assert.ok(
                !fs.existsSync(
                    path.join(projectRoot, "final", ".devteam")
                )
            );
        } finally {
            fs.rmSync(projectRoot, {
                recursive: true,
                force: true
            });
        }
    }
);
