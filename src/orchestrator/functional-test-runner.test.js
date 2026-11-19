
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    analyzeProject
} = require("./functional-test-runner");


test("detects Node.js projects and their test files", () => {
    const files = new Map([
        ["package.json", {
            content: JSON.stringify({
                name: "sample-node-app",
                main: "server.js"
            })
        }],
        ["server.js", { content: "console.log('app');" }],
        ["tests/app.test.js", {
            content: "const test = require('node:test');"
        }]
    ]);

    const result = analyzeProject(files);

    assert.ok(result.detectedStacks.includes("nodejs"));
    assert.ok(result.testFiles.includes("tests/app.test.js"));
    assert.ok(
        result.strategies.some(
            strategy => strategy.id === "node-native-tests"
        )
    );
});


test("detects Python projects and pytest files", () => {
    const files = new Map([
        ["requirements.txt", { content: "pytest\n" }],
        ["app.py", { content: "print('app')" }],
        ["tests/test_app.py", {
            content: "def test_example():\n    assert True\n"
        }]
    ]);

    const result = analyzeProject(files);

    assert.ok(result.detectedStacks.includes("python"));
    assert.ok(result.testFiles.includes("tests/test_app.py"));
    assert.ok(
        result.strategies.some(
            strategy => strategy.id === "python-pytest"
        )
    );
});


test("detects Go projects and native test files", () => {
    const files = new Map([
        ["go.mod", { content: "module example.com/app\n" }],
        ["main.go", { content: "package main\n" }],
        ["main_test.go", {
            content: "package main\n"
        }]
    ]);

    const result = analyzeProject(files);

    assert.ok(result.detectedStacks.includes("go"));
    assert.ok(result.testFiles.includes("main_test.go"));
    assert.ok(
        result.strategies.some(
            strategy => strategy.id === "go-native-tests"
        )
    );
});


test("detects Rust projects and native test files", () => {
    const files = new Map([
        ["Cargo.toml", { content: "[package]\nname = 'sample'\n" }],
        ["src/lib.rs", {
            content: "#[test]\nfn example() {}\n"
        }]
    ]);

    const result = analyzeProject(files);

    assert.ok(result.detectedStacks.includes("rust"));
    assert.ok(
        result.strategies.some(
            strategy => strategy.id === "rust-native-tests"
        )
    );
});


test("detects Java Maven projects and test files", () => {
    const files = new Map([
        ["pom.xml", { content: "<project></project>" }],
        ["src/main/java/App.java", {
            content: "class App {}"
        }],
        ["src/test/java/AppTest.java", {
            content: "class AppTest {}"
        }]
    ]);

    const result = analyzeProject(files);

    assert.ok(result.detectedStacks.includes("java-maven"));
    assert.ok(
        result.testFiles.includes("src/test/java/AppTest.java")
    );
    assert.ok(
        result.strategies.some(
            strategy => strategy.id === "java-maven-tests"
        )
    );
});


test("detects .NET projects and test files", () => {
    const files = new Map([
        ["Sample.sln", { content: "" }],
        ["Sample.Tests/Sample.Tests.csproj", {
            content: "<Project></Project>"
        }],
        ["Sample.Tests/AppTests.cs", {
            content: "class AppTests {}"
        }]
    ]);

    const result = analyzeProject(files);

    assert.ok(result.detectedStacks.includes("dotnet"));
    assert.ok(
        result.testFiles.includes("Sample.Tests/AppTests.cs")
    );
    assert.ok(
        result.strategies.some(
            strategy => strategy.id === "dotnet-native-tests"
        )
    );
});


test("does not claim tests exist when a project has no test suite", () => {
    const files = new Map([
        ["package.json", {
            content: JSON.stringify({
                name: "sample-app"
            })
        }],
        ["server.js", {
            content: "console.log('hello');"
        }]
    ]);

    const result = analyzeProject(files);

    assert.ok(result.detectedStacks.includes("nodejs"));
    assert.equal(result.testFiles.length, 0);
    assert.equal(result.strategies.length, 0);
});


test("detects multiple stacks in a mixed project", () => {
    const files = new Map([
        ["package.json", {
            content: JSON.stringify({ name: "mixed-app" })
        }],
        ["tests/app.test.js", {
            content: "const test = require('node:test');"
        }],
        ["requirements.txt", {
            content: "pytest\n"
        }],
        ["tests/test_api.py", {
            content: "def test_api():\n    assert True\n"
        }]
    ]);

    const result = analyzeProject(files);

    assert.ok(result.detectedStacks.includes("nodejs"));
    assert.ok(result.detectedStacks.includes("python"));
    assert.equal(result.strategies.length, 2);
});




const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const {
    runApprovedFunctionalTests
} = require("./functional-test-runner");


function createTestProject(files) {
    const projectRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "devteam-functional-test-")
    );

    const runId = randomUUID();
    const snapshotRunId = randomUUID();

    const snapshotRoot = path.join(
        projectRoot,
        ".devteam",
        "integrated",
        snapshotRunId
    );

    fs.mkdirSync(snapshotRoot, { recursive: true });

    const integrationFiles = [];

    for (const [relativePath, content] of Object.entries(files)) {
        const absolutePath = path.join(
            snapshotRoot,
            relativePath
        );

        fs.mkdirSync(path.dirname(absolutePath), {
            recursive: true
        });

        fs.writeFileSync(absolutePath, content, "utf8");

        integrationFiles.push({
            path: relativePath
        });
    }

    return {
        projectRoot,
        runId,
        snapshotRunId,
        integrationFiles
    };
}


test("executes a real Node.js test and reports passed", async () => {
    const project = createTestProject({
        "package.json": JSON.stringify({
            name: "devteam-pass-fixture",
            version: "1.0.0"
        }),

        "tests/sample.test.js": [
            'const test = require("node:test");',
            'const assert = require("node:assert/strict");',
            "",
            'test("addition works", () => {',
            "    assert.equal(2 + 3, 5);",
            "});"
        ].join("\n")
    });

    try {
        const result = await runApprovedFunctionalTests({
            ...project,
            approved: true
        });

        assert.equal(result.status, "passed");
        assert.equal(result.report.testsExecuted, 1);
        assert.equal(result.report.testsPassed, 1);
        assert.equal(result.report.testsFailed, 0);
        assert.equal(
            result.analysis.detectedStacks.includes("nodejs"),
            true
        );
    } finally {
        fs.rmSync(project.projectRoot, {
            recursive: true,
            force: true
        });
    }
});


test("executes a real failing Node.js test and reports failed", async () => {
    const project = createTestProject({
        "package.json": JSON.stringify({
            name: "devteam-fail-fixture",
            version: "1.0.0"
        }),

        "tests/sample.test.js": [
            'const test = require("node:test");',
            'const assert = require("node:assert/strict");',
            "",
            'test("intentional failure", () => {',
            "    assert.equal(2 + 2, 5);",
            "});"
        ].join("\n")
    });

    try {
        const result = await runApprovedFunctionalTests({
            ...project,
            approved: true
        });

        assert.equal(result.status, "failed");
        assert.equal(result.report.testsExecuted, 1);
        assert.equal(result.report.testsPassed, 0);
        assert.equal(result.report.testsFailed, 1);
    } finally {
        fs.rmSync(project.projectRoot, {
            recursive: true,
            force: true
        });
    }
});


test("does not claim a project without tests is verified", async () => {
    const project = createTestProject({
        "package.json": JSON.stringify({
            name: "devteam-no-tests-fixture",
            version: "1.0.0"
        }),

        "server.js": [
            'const http = require("node:http");',
            "console.log('sample server');"
        ].join("\n")
    });

    try {
        const result = await runApprovedFunctionalTests({
            ...project,
            approved: true
        });

        assert.equal(result.status, "unsupported");
        assert.equal(result.report.testsExecuted, 0);
        assert.equal(result.analysis.detectedStacks.includes("nodejs"), true);
    } finally {
        fs.rmSync(project.projectRoot, {
            recursive: true,
            force: true
        });
    }
});
