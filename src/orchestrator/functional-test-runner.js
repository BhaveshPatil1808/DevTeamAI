
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { buildRestrictedInvocation, buildRestrictedEnv, RestrictedExecutionUnavailable } = require("./restricted-execution");

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
        throw new Error(
            "Absolute or invalid integration paths are not allowed."
        );
    }

    const expectedPrefix =
        `${INTEGRATION_PREFIX}${snapshotRunId}/`;

    if (normalized.startsWith(expectedPrefix)) {
        return normalized.slice(expectedPrefix.length);
    }

    if (normalized.startsWith(INTEGRATION_PREFIX)) {
        throw new Error(
            "File belongs to a different integration snapshot."
        );
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
        throw new Error(
            "Invalid project or snapshot directory."
        );
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
    return [...fileMap.keys()]
        .filter(predicate)
        .sort();
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

    const packageJson = readJsonManifest(
        fileMap,
        "package.json"
    );

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

        const nodeTests = findFiles(
            fileMap,
            fileName =>
                /\.(test|spec)\.(js|mjs|cjs)$/i.test(fileName) ||
                /(^|\/)(__tests__|tests?)\/.*\.(js|mjs|cjs)$/i.test(fileName)
        );

        if (nodeTests.length > 0) {
            project.testFiles.push(...nodeTests);

            project.strategies.push({
                id: "node-native-tests",
                stack: "nodejs",
                command: process.execPath,
                args: ["--test", ...nodeTests],
                testFiles: nodeTests
            });
        }
    }

    // Python
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

        const pythonTests = findFiles(
            fileMap,
            fileName =>
                /(^|\/)test_[^/]+\.py$/i.test(fileName) ||
                /_test\.py$/i.test(fileName)
        );

        if (pythonTests.length > 0) {
            project.testFiles.push(...pythonTests);

            const pyproject =
                fileMap.get("pyproject.toml")?.content || "";

            const requirements =
                fileMap.get("requirements.txt")?.content || "";

            const usesPytest =
                hasPath(fileMap, "pytest.ini") ||
                hasPath(fileMap, "conftest.py") ||
                pyproject.includes("[tool.pytest") ||
                /(^|\n)\s*pytest([<=>~!;\s]|$)/i.test(requirements);

            const pythonCommand =
                process.platform === "win32"
                    ? "python"
                    : "python3";

            if (usesPytest) {
                project.strategies.push({
                    id: "python-pytest",
                    stack: "python",
                    command: pythonCommand,
                    args: ["-m", "pytest", "-q"],
                    testFiles: pythonTests
                });
            } else {
                const standardTests = pythonTests.filter(
                    fileName =>
                        /(^|\/)test_[^/]+\.py$/i.test(fileName)
                );

                const suffixTests = pythonTests.filter(
                    fileName =>
                        /_test\.py$/i.test(fileName)
                );

                if (standardTests.length > 0) {
                    project.strategies.push({
                        id: "python-unittest-standard",
                        stack: "python",
                        command: pythonCommand,
                        args: [
                            "-m",
                            "unittest",
                            "discover",
                            "-v",
                            "-p",
                            "test*.py"
                        ],
                        testFiles: standardTests
                    });
                }

                if (suffixTests.length > 0) {
                    project.strategies.push({
                        id: "python-unittest-suffix",
                        stack: "python",
                        command: pythonCommand,
                        args: [
                            "-m",
                            "unittest",
                            "discover",
                            "-v",
                            "-p",
                            "*_test.py"
                        ],
                        testFiles: suffixTests
                    });
                }
            }
        }
    }

    // Go
    if (hasPath(fileMap, "go.mod")) {
        project.detectedStacks.push("go");
        project.manifests.push("go.mod");

        const goTests = findFiles(
            fileMap,
            fileName => /(^|\/)[^/]+_test\.go$/i.test(fileName)
        );

        if (goTests.length > 0) {
            project.testFiles.push(...goTests);

            project.strategies.push({
                id: "go-native-tests",
                stack: "go",
                command: "go",
                args: ["test", "./..."],
                testFiles: goTests
            });
        }
    }

    // Rust
    if (hasPath(fileMap, "Cargo.toml")) {
        project.detectedStacks.push("rust");
        project.manifests.push("Cargo.toml");

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

        if (rustTests.length > 0) {
            project.testFiles.push(...rustTests);

            project.strategies.push({
                id: "rust-native-tests",
                stack: "rust",
                command: "cargo",
                args: ["test", "--offline"],
                testFiles: rustTests
            });
        }
    }

    // Java Maven
    if (hasPath(fileMap, "pom.xml")) {
        project.detectedStacks.push("java-maven");
        project.manifests.push("pom.xml");

        const javaTests = findFiles(
            fileMap,
            fileName =>
                fileName.endsWith(".java") &&
                fileName.startsWith("src/test/java/")
        );

        if (javaTests.length > 0) {
            project.testFiles.push(...javaTests);

            project.strategies.push({
                id: "java-maven-tests",
                stack: "java-maven",
                command: "mvn",
                args: ["-o", "test"],
                testFiles: javaTests
            });
        }
    }

    // .NET
    const dotnetManifests = paths.filter(
        fileName =>
            fileName.endsWith(".sln") ||
            fileName.endsWith(".csproj")
    );

    if (dotnetManifests.length > 0) {
        project.detectedStacks.push("dotnet");
        project.manifests.push(...dotnetManifests);

        const dotnetTests = findFiles(
            fileMap,
            fileName =>
                fileName.endsWith(".cs") &&
                (
                    /(^|\/)(tests?|[^/]+\.(tests?|test))\//i.test(fileName) ||
                    /(?:Tests?|Test)\.cs$/i.test(fileName)
                )
        );

        if (dotnetTests.length > 0) {
            project.testFiles.push(...dotnetTests);

            project.strategies.push({
                id: "dotnet-native-tests",
                stack: "dotnet",
                command: "dotnet",
                args: ["test", "--no-restore"],
                testFiles: dotnetTests
            });
        }
    }

    project.testFiles = [
        ...new Set(project.testFiles)
    ];

    project.detectedStacks = [
        ...new Set(project.detectedStacks)
    ];

    return project;
}

// --------------------------------------------------
// TEST ENVIRONMENT
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
        npm_config_offline: "true",
        npm_config_audit: "false",
        npm_config_fund: "false"
    };
}

// --------------------------------------------------
// PROCESS MANAGEMENT
// --------------------------------------------------

function killProcessTree(child) {
    if (!child || child.killed) {
        return;
    }

    try {
        if (
            process.platform !== "win32" &&
            child.pid
        ) {
            process.kill(-child.pid, "SIGKILL");
        } else {
            child.kill("SIGKILL");
        }
    } catch {
        try {
            child.kill("SIGKILL");
        } catch {
            // Process may already have exited.
        }
    }
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
            const invocation = buildRestrictedInvocation(command, args, {
                networkIsolation: true,
                cpuSeconds: Math.ceil(TEST_TIMEOUT_MS / 1000),
                addressSpaceBytes: 3 * 1024 * 1024 * 1024,
                fileSizeBytes: 256 * 1024 * 1024,
                openFiles: 256
            });
            child = spawn(invocation.command, invocation.args, {
                cwd,
                shell: false,
                detached: process.platform !== "win32",
                windowsHide: true,
                stdio: ["ignore", "pipe", "pipe"],
                env: buildRestrictedEnv(cwd, buildTestEnvironment())
            });
        } catch (error) {
            finish({
                status: error instanceof RestrictedExecutionUnavailable || error.code === "RESTRICTED_EXECUTION_UNAVAILABLE"
                    ? "unsupported"
                    : "error",
                error: error.message
            });
            return;
        }

        timeout = setTimeout(() => {
            timedOut = true;
            killProcessTree(child);
        }, TEST_TIMEOUT_MS);

        function collectOutput(target, chunk) {
            outputBytes += chunk.length;

            if (outputBytes > MAX_OUTPUT_BYTES) {
                outputExceeded = true;
                killProcessTree(child);
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
                    error:
                        `Test command exceeded ${TEST_TIMEOUT_MS} ms.`,
                    exitCode: code,
                    signal
                });

                return;
            }

            if (outputExceeded) {
                finish({
                    status: "error",
                    error:
                        "Test output exceeded the configured limit.",
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
// TEMPORARY TEST WORKSPACE
// --------------------------------------------------

function createTestWorkspace(fileMap) {
    const workspace = fs.mkdtempSync(
        path.join(os.tmpdir(), "devteamai-tests-")
    );

    try {
        for (const [relativePath, entry] of fileMap) {
            const parts = validateRelativePath(relativePath);

            const destination = path.join(
                workspace,
                ...parts
            );

            if (!isInside(workspace, destination)) {
                throw new Error(
                    `Test file escapes workspace: ${relativePath}`
                );
            }

            fs.mkdirSync(
                path.dirname(destination),
                { recursive: true }
            );

            fs.writeFileSync(
                destination,
                entry.content,
                { encoding: "utf8", flag: "wx" }
            );
        }

        return workspace;
    } catch (error) {
        fs.rmSync(workspace, {
            recursive: true,
            force: true
        });

        throw error;
    }
}

// --------------------------------------------------
// MAIN FUNCTIONAL TEST RUNNER
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
            error:
                "Functional test execution was not approved."
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
            error:
                `Integration exceeds the ${MAX_FILES}-file limit.`
        });
    }

    // --------------------------------------------------
    // VALIDATE SNAPSHOT DIRECTORY
    // --------------------------------------------------

    let realProjectRoot;
    let snapshotRoot;

    try {
        realProjectRoot = fs.realpathSync(projectRoot);

        const integrationBase = path.join(
            realProjectRoot,
            ".devteam",
            "integrated"
        );

        assertNoSymlinks(
            realProjectRoot,
            integrationBase
        );

        const realIntegrationBase =
            fs.realpathSync(integrationBase);

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

        assertNoSymlinks(
            realProjectRoot,
            snapshotRoot
        );

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
            error:
                `Snapshot validation failed: ${error.message}`
        });
    }

    // --------------------------------------------------
    // VALIDATE INTEGRATION FILES
    // --------------------------------------------------

    const fileMap = new Map();
    const seenPaths = new Set();

    let totalBytes = 0;

    try {
        for (const item of integrationFiles) {
            if (
                !item ||
                typeof item.path !== "string"
            ) {
                throw new Error(
                    "Invalid integration file record."
                );
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
            error:
                `Integration validation failed: ${error.message}`
        });
    }

    // --------------------------------------------------
    // ANALYZE PROJECT
    // --------------------------------------------------

    let project;

    try {
        project = analyzeProject(fileMap);
    } catch (error) {
        return makeResult("error", {
            snapshotRunId,
            error:
                `Project analysis failed: ${error.message}`
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
        unsupportedCapabilities:
            project.unsupportedCapabilities
    };

    const executionResults = [];
    let runtimeSummary = null;

    // --------------------------------------------------
    // RUNTIME VERIFICATION
    // --------------------------------------------------

    if (runtimeVerification === true) {
        console.log(
            "[FUNCTIONAL TESTS] Running runtime verification."
        );

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
                summary:
                    `Runtime verifier crashed: ${error.message}`,
                steps: [],
                issues: []
            };
        }

        runtimeSummary = {
            status: runtime.status || "error",
            projectType: runtime.projectType || null,
            summary: runtime.summary || null,
            url: runtime.url || null,
            steps: Array.isArray(runtime.steps)
                ? runtime.steps
                : [],
            issues: Array.isArray(runtime.issues)
                ? runtime.issues
                : []
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
            status: runtime.status || "error",
            exitCode:
                runtime.status === "passed" ? 0 : 1,
            signal: null,
            stdout: String(runtime.stdout || "").slice(-12000),
            stderr: String(runtime.stderr || "").slice(-12000),
            error:
                runtime.status === "passed"
                    ? null
                    : runtime.summary || "Runtime verification did not pass.",
            issues: runtime.issues || [],
            steps: runtime.steps || []
        });
    }

    // --------------------------------------------------
    // CHECK FOR MISSING TEST STRATEGIES
    // --------------------------------------------------

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
                summary:
                    "No supported runtime or native test strategy was available.",
                testsExecuted: 0,
                testsSkipped: 0,
                testsPassed: 0,
                testsFailed: 0,
                results: []
            },
            error:
                "No supported test strategy was found. " +
                "Add tests for the detected stack or configure a supported verification strategy. " +
                "No functional tests were executed."
        };
    }

    // --------------------------------------------------
    // RUNTIME BLOCKING
    // --------------------------------------------------

    const runtimeResult = executionResults.find(
        item => item.strategy === "runtime-verification"
    );

    const runtimeBlocked =
        runtimeResult &&
        runtimeResult.status !== "passed" &&
        runtimeResult.status !== "unsupported";

    // Unsupported runtime does not hide native test results.
    // A failed or errored runtime prevents further test execution.
    const strategiesToRun = runtimeBlocked
        ? []
        : project.strategies;

    // --------------------------------------------------
    // RUN NATIVE TEST SUITES IN A TEMPORARY COPY
    // --------------------------------------------------

    let testWorkspace = null;

    try {
        if (strategiesToRun.length > 0) {
            testWorkspace = createTestWorkspace(fileMap);

            for (const strategy of strategiesToRun) {
                console.log(
                    `[FUNCTIONAL TESTS] Running ${strategy.id}`
                );

                const execution = await runCommand({
                    command: strategy.command,
                    args: strategy.args,
                    cwd: testWorkspace,
                    strategyId: strategy.id
                });

                executionResults.push(execution);
            }
        }
    } catch (error) {
        executionResults.push({
            strategy: "test-workspace",
            command: null,
            args: [],
            durationMs: 0,
            status: "error",
            exitCode: null,
            signal: null,
            stdout: "",
            stderr: "",
            error:
                `Could not execute native tests: ${error.message}`
        });
    } finally {
        if (testWorkspace) {
            try {
                fs.rmSync(testWorkspace, {
                    recursive: true,
                    force: true
                });
            } catch (error) {
                console.error(
                    "[FUNCTIONAL TESTS] Workspace cleanup failed:",
                    error.message
                );
            }
        }
    }

    // --------------------------------------------------
    // CALCULATE FINAL STATUS
    // --------------------------------------------------

    const nativeResults = executionResults.filter(
        item => item.strategy !== "runtime-verification"
    );

    const failedResults = executionResults.filter(
        item => item.status === "failed"
    );

    const errorResults = executionResults.filter(
        item => item.status === "error"
    );

    const unsupportedResults = executionResults.filter(
        item => item.status === "unsupported"
    );

    const allExecutedPassed =
        executionResults.length > 0 &&
        executionResults.every(
            item => item.status === "passed"
        );

    const runtimeUnsupported =
        runtimeResult &&
        runtimeResult.status === "unsupported";

    let status;

    if (failedResults.length > 0) {
        status = "failed";
    } else if (errorResults.length > 0) {
        status = "error";
    } else if (
        unsupportedResults.length > 0 ||
        runtimeUnsupported
    ) {
        status = "unsupported";
    } else if (allExecutedPassed && nativeResults.length > 0) {
        status = "passed";
    } else {
        status = "unsupported";
    }

    const testsPassed = executionResults.filter(
        item => item.status === "passed"
    ).length;

    const testsFailed = failedResults.length;

    const testsSkipped = runtimeBlocked
        ? project.strategies.length
        : Math.max(0, project.strategies.length - nativeResults.length);

    let summary;

    if (status === "passed") {
        summary = "Runtime verification and all executed native test suites passed.";
    } else if (status === "failed") {
        summary =
            "One or more application or native test checks failed.";
    } else if (status === "error") {
        summary =
            "Verification encountered an execution or environment error.";
    } else {
        summary =
            "Verification is incomplete because a required verification capability is unsupported.";
    }

    const report = {
        summary,
        testsExecuted: executionResults.length,
        testsSkipped,
        testsPassed,
        testsFailed,
        results: executionResults
    };

    console.log(
        `[FUNCTIONAL TESTS] ${status.toUpperCase()} | ` +
        `${testsPassed} passed | ${testsFailed} failed`
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
