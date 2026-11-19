
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { verifyRuntime } = require("./runtime-verifier");

const TEST_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_OUTPUT_BYTES = 512 * 1024;
const MAX_FILES = 100;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const UUID_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const INTEGRATION_PREFIX = ".devteam/integrated/";


function isValidUuid(value) {
    return typeof value === "string" && UUID_REGEX.test(value);
}


function isInside(parent, candidate) {
    const relative = path.relative(parent, candidate);

    return (
        relative === "" ||
        (
            relative !== ".." &&
            !relative.startsWith(".." + path.sep) &&
            !path.isAbsolute(relative)
        )
    );
}


function makeResult(status, details = {}) {
    return {
        status,
        mode: "native-test-runner",
        approval: "granted",
        ...details
    };
}


function normalizeSnapshotPath(filePath, snapshotRunId) {
    if (
        typeof filePath !== "string" ||
        !filePath.trim()
    ) {
        throw new Error("Invalid integration file path.");
    }

    const normalized = filePath.replace(/\\/g, "/");

    if (
        normalized.startsWith("/") ||
        /^[a-zA-Z]:/.test(normalized) ||
        normalized.includes("\0")
    ) {
        throw new Error("Absolute or invalid integration paths are not allowed.");
    }

    const expectedPrefix =
        `${INTEGRATION_PREFIX}${snapshotRunId}/`;

    if (normalized.startsWith(expectedPrefix)) {
        return normalized.slice(expectedPrefix.length);
    }

    // Reject paths that point into a different integration snapshot.
    if (normalized.startsWith(INTEGRATION_PREFIX)) {
        throw new Error("File belongs to a different integration snapshot.");
    }

    return normalized;
}


function validateRelativePath(relativePath) {
    const normalized = relativePath.replace(/\\/g, "/");

    if (
        !normalized ||
        normalized.startsWith("/") ||
        normalized.includes("\0") ||
        /^[a-zA-Z]:/.test(normalized)
    ) {
        throw new Error("Invalid relative file path.");
    }

    const parts = normalized.split("/");

    if (
        parts.some(part =>
            !part ||
            part === "." ||
            part === ".."
        )
    ) {
        throw new Error("Unsafe relative file path.");
    }

    return parts;
}


function assertNoSymlinks(root, target) {
    const relative = path.relative(root, target);

    if (
        relative === ".." ||
        relative.startsWith(".." + path.sep) ||
        path.isAbsolute(relative)
    ) {
        throw new Error("Path escapes the allowed directory.");
    }

    const rootStats = fs.lstatSync(root);

    if (
        rootStats.isSymbolicLink() ||
        !rootStats.isDirectory()
    ) {
        throw new Error("Invalid project or snapshot directory.");
    }

    let current = root;

    for (const segment of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);

        if (!fs.existsSync(current)) {
            continue;
        }

        const stats = fs.lstatSync(current);

        if (stats.isSymbolicLink()) {
            throw new Error(
                `Symbolic links are not allowed: ${current}`
            );
        }
    }
}


function assertSafeFile(snapshotRoot, relativePath) {
    const parts = validateRelativePath(relativePath);

    let current = snapshotRoot;

    for (const part of parts) {
        current = path.join(current, part);

        const stats = fs.lstatSync(current);

        if (stats.isSymbolicLink()) {
            throw new Error(
                `Symbolic links are not allowed: ${relativePath}`
            );
        }
    }

    const realPath = fs.realpathSync(current);

    if (
        !isInside(snapshotRoot, realPath) ||
        realPath === snapshotRoot
    ) {
        throw new Error(
            `File is outside the integration snapshot: ${relativePath}`
        );
    }

    const stats = fs.statSync(realPath);

    if (!stats.isFile()) {
        throw new Error(
            `Integration path is not a regular file: ${relativePath}`
        );
    }

    if (stats.size > MAX_FILE_BYTES) {
        throw new Error(
            `File exceeds the test-runner size limit: ${relativePath}`
        );
    }

    return {
        absolutePath: realPath,
        stats
    };
}


function readJsonManifest(fileMap, fileName) {
    const file = fileMap.get(fileName);

    if (!file) {
        return null;
    }

    try {
        return JSON.parse(file.content);
    } catch (error) {
        throw new Error(
            `Could not parse ${fileName}: ${error.message}`
        );
    }
}


function hasPath(fileMap, fileName) {
    return fileMap.has(fileName);
}


function findFiles(fileMap, predicate) {
    return [...fileMap.keys()].filter(predicate).sort();
}


// --------------------------------------------------
// PROJECT ANALYZER
// --------------------------------------------------

function analyzeProject(fileMap) {
    const paths = [...fileMap.keys()];

    const project = {
        detectedStacks: [],
        manifests: [],
        entryPoints: [],
        testFiles: [],
        strategies: [],
        unsupportedCapabilities: [
            "browser_e2e",
            "visual_browser_testing",
            "live_deployment_testing"
        ]
    };

    const packageJson = readJsonManifest(fileMap, "package.json");

    if (packageJson) {
        project.detectedStacks.push("nodejs");
        project.manifests.push("package.json");

        if (packageJson.main) {
            project.entryPoints.push(packageJson.main);
        }

        if (hasPath(fileMap, "server.js")) {
            project.entryPoints.push("server.js");
        }

        if (hasPath(fileMap, "src/index.js")) {
            project.entryPoints.push("src/index.js");
        }
    }

    const pythonManifest = [
        "pyproject.toml",
        "requirements.txt",
        "setup.py",
        "Pipfile"
    ].find(fileName => hasPath(fileMap, fileName));

    if (pythonManifest) {
        project.detectedStacks.push("python");
        project.manifests.push(pythonManifest);

        if (hasPath(fileMap, "main.py")) {
            project.entryPoints.push("main.py");
        }

        if (hasPath(fileMap, "app.py")) {
            project.entryPoints.push("app.py");
        }
    }

    if (hasPath(fileMap, "go.mod")) {
        project.detectedStacks.push("go");
        project.manifests.push("go.mod");
    }

    if (hasPath(fileMap, "Cargo.toml")) {
        project.detectedStacks.push("rust");
        project.manifests.push("Cargo.toml");
    }

    if (hasPath(fileMap, "pom.xml")) {
        project.detectedStacks.push("java-maven");
        project.manifests.push("pom.xml");
    }

    if (
        paths.some(fileName =>
            fileName.endsWith(".sln") ||
            fileName.endsWith(".csproj")
        )
    ) {
        project.detectedStacks.push("dotnet");

        project.manifests.push(
            ...paths.filter(fileName =>
                fileName.endsWith(".sln") ||
                fileName.endsWith(".csproj")
            )
        );
    }

    // Node.js built-in test runner.
    const nodeTests = findFiles(
        fileMap,
        fileName =>
            /\.(test|spec)\.(js|mjs|cjs)$/i.test(fileName) ||
            /(^|\/)(__tests__|tests?)\/.*\.(js|mjs|cjs)$/i.test(fileName)
    );

    if (
        nodeTests.length > 0 &&
        project.detectedStacks.includes("nodejs")
    ) {
        project.testFiles.push(...nodeTests);

        project.strategies.push({
            id: "node-native-tests",
            stack: "nodejs",
            command: process.execPath,
            args: ["--test", ...nodeTests],
            testFiles: nodeTests
        });
    }

    // Python unittest or pytest.
    const pythonTests = findFiles(
        fileMap,
        fileName =>
            /(^|\/)test_[^/]+\.py$/i.test(fileName) ||
            /_test\.py$/i.test(fileName)
    );

    if (
        pythonTests.length > 0 &&
        project.detectedStacks.includes("python")
    ) {
        project.testFiles.push(...pythonTests);

        const pyproject = fileMap.get("pyproject.toml")?.content || "";
        const requirements = fileMap.get("requirements.txt")?.content || "";

        const usesPytest =
            hasPath(fileMap, "pytest.ini") ||
            hasPath(fileMap, "conftest.py") ||
            pyproject.includes("[tool.pytest") ||
            /(^|\n)\s*pytest([<=>~!;\s]|$)/i.test(requirements);

        const pythonCommand =
            process.platform === "win32" ? "python" : "python3";

        project.strategies.push({
            id: usesPytest ? "python-pytest" : "python-unittest",
            stack: "python",
            command: pythonCommand,
            args: usesPytest
                ? ["-m", "pytest", "-q"]
                : ["-m", "unittest", "discover", "-v"],
            testFiles: pythonTests
        });
    }

    // Go native tests.
    const goTests = findFiles(
        fileMap,
        fileName => /(^|\/)[^/]+_test\.go$/i.test(fileName)
    );

    if (
        goTests.length > 0 &&
        project.detectedStacks.includes("go")
    ) {
        project.testFiles.push(...goTests);

        project.strategies.push({
            id: "go-native-tests",
            stack: "go",
            command: "go",
            args: ["test", "./..."],
            testFiles: goTests
        });
    }

    // Rust native tests.
    const rustTests = findFiles(
        fileMap,
        fileName =>
            fileName.endsWith(".rs") &&
            (
                /(^|\/)tests?\//i.test(fileName) ||
                /#\s*\[(tokio::)?test\]/.test(
                    fileMap.get(fileName)?.content || ""
                )
            )
    );

    if (
        rustTests.length > 0 &&
        project.detectedStacks.includes("rust")
    ) {
        project.testFiles.push(...rustTests);

        project.strategies.push({
            id: "rust-native-tests",
            stack: "rust",
            command: "cargo",
            args: ["test", "--offline"],
            testFiles: rustTests
        });
    }

    // Java Maven tests.
    const javaTests = findFiles(
        fileMap,
        fileName =>
            fileName.endsWith(".java") &&
            fileName.startsWith("src/test/java/")
    );

    if (
        javaTests.length > 0 &&
        project.detectedStacks.includes("java-maven")
    ) {
        project.testFiles.push(...javaTests);

        project.strategies.push({
            id: "java-maven-tests",
            stack: "java-maven",
            command: "mvn",
            args: ["-o", "test"],
            testFiles: javaTests
        });
    }

    // .NET tests.
    const dotnetTests = findFiles(
    fileMap,
    fileName =>
        fileName.endsWith(".cs") &&
        (
            /(^|\/)(tests?|[^/]+\.(tests?|test))\//i.test(fileName) ||
            /(?:Tests?|Test)\.cs$/i.test(fileName)
        )
);

    if (
        dotnetTests.length > 0 &&
        project.detectedStacks.includes("dotnet")
    ) {
        project.testFiles.push(...dotnetTests);

        project.strategies.push({
            id: "dotnet-native-tests",
            stack: "dotnet",
            command: "dotnet",
            args: ["test", "--no-restore"],
            testFiles: dotnetTests
        });
    }

    project.testFiles = [...new Set(project.testFiles)];

    project.detectedStacks = [
        ...new Set(project.detectedStacks)
    ];

    return project;
}


// --------------------------------------------------
// SAFE NATIVE COMMAND EXECUTION
// --------------------------------------------------

function buildTestEnvironment() {
    return {
        PATH: process.env.PATH || "",
        CI: "true",
        NODE_ENV: "test",
        NODE_NO_WARNINGS: "1",
        PYTHONDONTWRITEBYTECODE: "1",
        GOPROXY: "off",
        GOSUMDB: "off",
        CARGO_NET_OFFLINE: "true",
        npm_config_offline: "true"
    };
}


function runCommand({
    command,
    args,
    cwd,
    strategyId
}) {
    return new Promise(resolve => {
        const startedAt = Date.now();

        let stdout = "";
        let stderr = "";
        let outputBytes = 0;
        let outputExceeded = false;
        let timedOut = false;
        let settled = false;
        let timeout;

        let child;

        function finish(value) {
            if (settled) {
                return;
            }

            settled = true;

            if (timeout) {
                clearTimeout(timeout);
            }

            resolve({
                strategy: strategyId,
                command,
                args,
                durationMs: Date.now() - startedAt,
                stdout: stdout.slice(-12000),
                stderr: stderr.slice(-12000),
                ...value
            });
        }

        try {
            child = spawn(command, args, {
                cwd,
                shell: false,
                windowsHide: true,
                stdio: ["ignore", "pipe", "pipe"],
                env: buildTestEnvironment()
            });
        } catch (error) {
            finish({
                status: "error",
                error: error.message
            });

            return;
        }

        timeout = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
        }, TEST_TIMEOUT_MS);

        function collectOutput(target, chunk) {
            outputBytes += chunk.length;

            if (outputBytes > MAX_OUTPUT_BYTES) {
                outputExceeded = true;
                child.kill("SIGKILL");
                return target;
            }

            return target + chunk.toString("utf8");
        }

        child.stdout.on("data", chunk => {
            stdout = collectOutput(stdout, chunk);
        });

        child.stderr.on("data", chunk => {
            stderr = collectOutput(stderr, chunk);
        });

        child.on("error", error => {
            finish({
                status: "error",
                error:
                    `Could not start ${command}: ${error.message}`
            });
        });

        child.on("close", (code, signal) => {
            if (timedOut) {
                finish({
                    status: "error",
                    error: `Test command exceeded ${TEST_TIMEOUT_MS} ms.`,
                    exitCode: code,
                    signal
                });

                return;
            }

            if (outputExceeded) {
                finish({
                    status: "error",
                    error: "Test output exceeded the configured limit.",
                    exitCode: code,
                    signal
                });

                return;
            }

            finish({
                status: code === 0 ? "passed" : "failed",
                exitCode: code,
                signal,
                error: code === 0
                    ? null
                    : `Test command exited with code ${code}.`
            });
        });
    });
}


// --------------------------------------------------
// MAIN UNIVERSAL FUNCTIONAL TEST RUNNER
// --------------------------------------------------

async function runApprovedFunctionalTests({
    projectRoot,
    runId,
    snapshotRunId,
    integrationFiles,
    approved,
    runtimeVerification = false,
    runtimeOptions = {}
}) {
    if (approved !== true) {
        return {
            status: "approval_required",
            mode: "not_run",
            approval: "not_granted",
            error: "Functional test execution was not approved."
        };
    }

    if (!isValidUuid(runId)) {
        return makeResult("error", {
            error: "Invalid project run ID."
        });
    }

    if (!isValidUuid(snapshotRunId)) {
        return makeResult("error", {
            error: "Invalid integration snapshot ID."
        });
    }

    if (
        !Array.isArray(integrationFiles) ||
        integrationFiles.length === 0
    ) {
        return makeResult("error", {
            snapshotRunId,
            error: "No integration files were supplied."
        });
    }

    if (integrationFiles.length > MAX_FILES) {
        return makeResult("error", {
            snapshotRunId,
            error: `Integration exceeds the ${MAX_FILES}-file limit.`
        });
    }

    let realProjectRoot;
    let snapshotRoot;

    try {
        realProjectRoot = fs.realpathSync(projectRoot);

        const integrationBase = path.join(
            realProjectRoot,
            ".devteam",
            "integrated"
        );

        assertNoSymlinks(realProjectRoot, integrationBase);

        const realIntegrationBase = fs.realpathSync(integrationBase);

        if (
            !isInside(realProjectRoot, realIntegrationBase) ||
            realIntegrationBase === realProjectRoot
        ) {
            throw new Error(
                "Integration directory is outside the project."
            );
        }

        snapshotRoot = path.join(
            realIntegrationBase,
            snapshotRunId
        );

        assertNoSymlinks(realProjectRoot, snapshotRoot);

        const snapshotStats = fs.lstatSync(snapshotRoot);

        if (
            snapshotStats.isSymbolicLink() ||
            !snapshotStats.isDirectory()
        ) {
            throw new Error(
                "Integration snapshot must be a real directory."
            );
        }

        snapshotRoot = fs.realpathSync(snapshotRoot);

        if (
            !isInside(realIntegrationBase, snapshotRoot) ||
            snapshotRoot === realIntegrationBase
        ) {
            throw new Error(
                "Integration snapshot is outside the integration directory."
            );
        }

    } catch (error) {
        return makeResult("error", {
            snapshotRunId,
            error: `Snapshot validation failed: ${error.message}`
        });
    }

    const fileMap = new Map();
    const seenPaths = new Set();
    let totalBytes = 0;

    try {
        for (const item of integrationFiles) {
            if (
                !item ||
                typeof item.path !== "string"
            ) {
                throw new Error("Invalid integration file record.");
            }

            const relativePath = normalizeSnapshotPath(
                item.path,
                snapshotRunId
            );

            const parts = validateRelativePath(relativePath);
            const normalizedPath = parts.join("/");

            if (seenPaths.has(normalizedPath)) {
                throw new Error(
                    `Duplicate integration file: ${normalizedPath}`
                );
            }

            seenPaths.add(normalizedPath);

            const resolved = assertSafeFile(
                snapshotRoot,
                normalizedPath
            );

            totalBytes += resolved.stats.size;

            if (totalBytes > MAX_TOTAL_BYTES) {
                throw new Error(
                    "Integration exceeds the total test-runner size limit."
                );
            }

            const content = fs.readFileSync(
                resolved.absolutePath,
                "utf8"
            );

            fileMap.set(normalizedPath, {
                path: normalizedPath,
                absolutePath: resolved.absolutePath,
                bytes: resolved.stats.size,
                content
            });
        }

    } catch (error) {
        return makeResult("error", {
            snapshotRunId,
            error: `Integration validation failed: ${error.message}`
        });
    }

    let project;

    try {
        project = analyzeProject(fileMap);
    } catch (error) {
        return makeResult("error", {
            snapshotRunId,
            error: `Project analysis failed: ${error.message}`
        });
    }

    const analysis = {
        detectedStacks: project.detectedStacks,
        manifests: project.manifests,
        entryPoints: project.entryPoints,
        discoveredTestFiles: project.testFiles,
        availableStrategies: project.strategies.map(strategy => ({
            id: strategy.id,
            stack: strategy.stack,
            testFiles: strategy.testFiles
        })),
        unsupportedCapabilities: project.unsupportedCapabilities
    };

    // ------------------------------------------------------------
    // RUNTIME VERIFICATION: install the project and actually start it.
    // ------------------------------------------------------------
    const executionResults = [];
    let runtimeSummary = null;

    if (runtimeVerification === true) {
        console.log("[FUNCTIONAL TESTS] Running runtime-verification");

        const contentMap = new Map();

        for (const [name, entry] of fileMap) {
            contentMap.set(name, entry.content);
        }

        let runtime;

        try {
            runtime = await verifyRuntime({
                files: contentMap,
                ...runtimeOptions
            });
        } catch (error) {
            runtime = {
                status: "error",
                summary: `Runtime verifier crashed: ${error.message}`,
                steps: [],
                issues: []
            };
        }

        if (runtime.status !== "unsupported") {
            runtimeSummary = {
                status: runtime.status,
                projectType: runtime.projectType || null,
                summary: runtime.summary,
                url: runtime.url || null,
                steps: runtime.steps,
                issues: runtime.issues
            };

            analysis.availableStrategies.unshift({
                id: "runtime-verification",
                stack: runtime.projectType || "unknown",
                testFiles: []
            });

            executionResults.push({
                strategy: "runtime-verification",
                command: "install + start + probe",
                args: [],
                durationMs: 0,
                status: runtime.status,
                exitCode: runtime.status === "passed" ? 0 : 1,
                signal: null,
                stdout: String(runtime.stdout || "").slice(-12000),
                stderr: String(runtime.stderr || "").slice(-12000),
                error: runtime.status === "passed"
                    ? null
                    : runtime.summary,
                issues: runtime.issues || [],
                steps: runtime.steps || []
            });
        }
    }

    if (
        project.strategies.length === 0 &&
        executionResults.length === 0
    ) {
        return {
            status: "unsupported",
            mode: "analysis_only",
            approval: "granted",
            snapshotRunId,
            analysis,
            report: {
                summary: "Project analyzed, but no supported native test suite was found.",
                testsExecuted: 0,
                testsPassed: 0,
                testsFailed: 0
            },
            error:
                "No supported native test files were detected. " +
                "Add tests for the detected stack or configure a supported test strategy. " +
                "No functional tests were executed."
        };
    }

    // Run every detected test suite. A failure in one suite does not
    // prevent the other detected suites from producing their results.
    // If the project does not even start, its tests would only repeat
    // the same failure, so they are skipped until it runs.
    const runtimeBlocked =
        executionResults.length > 0 &&
        executionResults[0].status !== "passed";

    for (const strategy of runtimeBlocked ? [] : project.strategies) {
        console.log(
            `[FUNCTIONAL TESTS] Running ${strategy.id}`
        );

        const execution = await runCommand({
            command: strategy.command,
            args: strategy.args,
            cwd: snapshotRoot,
            strategyId: strategy.id
        });

        executionResults.push(execution);
    }

    const failedResults = executionResults.filter(
        item => item.status !== "passed"
    );

    const allPassed =
        executionResults.length > 0 &&
        failedResults.length === 0;

    const status = allPassed ? "passed" : "failed";

    const report = {
        summary: allPassed
            ? "All detected native test suites passed."
            : "One or more detected native test suites failed or could not execute.",

        testsExecuted: executionResults.length,
        testsSkipped: runtimeBlocked ? project.strategies.length : 0,
        testsPassed: executionResults.filter(
            item => item.status === "passed"
        ).length,
        testsFailed: failedResults.length,

        results: executionResults
    };

    console.log(
        `[FUNCTIONAL TESTS] ${status.toUpperCase()} | ` +
        `${report.testsPassed} passed | ` +
        `${report.testsFailed} failed`
    );

    return {
        status,
        mode: "native-test-runner",
        approval: "granted",
        snapshotRunId,
        analysis,
        report,
        runtime: runtimeSummary,
        visualBrowserTesting: "not_run",
        apiBrowserTesting: "not_run"
    };
}


module.exports = {
    runApprovedFunctionalTests,
    analyzeProject,
    normalizeSnapshotPath,
    assertSafeFile
};
