"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const MAX_FILES = 300;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024;
const COMMAND_TIMEOUT = 15000;
const MAX_OUTPUT = 12000;

const UUID_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isInside(parent, target) {
    const relative = path.relative(parent, target);

    return (
        relative !== ".." &&
        !relative.startsWith(".." + path.sep) &&
        !path.isAbsolute(relative)
    );
}

function assertNoSymlinks(root, target) {
    const relative = path.relative(root, target);

    if (
        relative === ".." ||
        relative.startsWith(".." + path.sep) ||
        path.isAbsolute(relative)
    ) {
        throw new Error("Path escapes the project directory.");
    }

    const rootStats = fs.lstatSync(root);

    if (
        !rootStats.isDirectory() ||
        rootStats.isSymbolicLink()
    ) {
        throw new Error("Invalid project root.");
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

function resolveIntegrationDirectory(projectRoot, snapshotRunId) {
    if (
        typeof snapshotRunId !== "string" ||
        !UUID_REGEX.test(snapshotRunId)
    ) {
        throw new Error("Invalid QA snapshot ID.");
    }

    const root = path.resolve(projectRoot);

    const directory = path.resolve(
        root,
        ".devteam",
        "integrated",
        snapshotRunId
    );

    if (!isInside(root, directory)) {
        throw new Error(
            "Integration directory escapes project root."
        );
    }

    assertNoSymlinks(root, directory);

    if (!fs.existsSync(directory)) {
        throw new Error(
            "Integrated output directory does not exist."
        );
    }

    const stats = fs.lstatSync(directory);

    if (
        !stats.isDirectory() ||
        stats.isSymbolicLink()
    ) {
        throw new Error(
            "Integration output path is not a regular directory."
        );
    }

    return directory;
}

function resolveIntegratedFile(
    projectRoot,
    integrationRoot,
    filePath
) {
    if (
        typeof filePath !== "string" ||
        !filePath.trim()
    ) {
        throw new Error("Invalid integrated file path.");
    }

    const normalized = filePath.replace(/\\/g, "/");

    if (
        normalized.startsWith("/") ||
        normalized.includes("\0") ||
        normalized.split("/").some(segment =>
            !segment ||
            segment === "." ||
            segment === ".."
        )
    ) {
        throw new Error(
            `Unsafe integrated file path: ${filePath}`
        );
    }

    const absolutePath = path.resolve(
        projectRoot,
        normalized
    );

    if (!isInside(integrationRoot, absolutePath)) {
        throw new Error(
            `File is outside this integration snapshot: ${filePath}`
        );
    }

    assertNoSymlinks(projectRoot, absolutePath);

    const stats = fs.lstatSync(absolutePath);

    if (
        !stats.isFile() ||
        stats.isSymbolicLink()
    ) {
        throw new Error(
            `Not a regular integrated file: ${filePath}`
        );
    }

    if (stats.size > MAX_FILE_BYTES) {
        throw new Error(
            `File exceeds QA size limit: ${filePath}`
        );
    }

    return {
        absolutePath,
        relativePath: path.relative(
            integrationRoot,
            absolutePath
        ),
        stats
    };
}

function runNodeSyntaxCheck(content, moduleMode, fileName) {
    return new Promise(resolve => {
        const args = ["--check"];

        if (moduleMode) {
            args.push("--input-type=module");
        }

        const child = spawn(
            process.execPath,
            args,
            {
                shell: false,
                windowsHide: true,
                env: {
                    PATH: process.env.PATH || "",
                    NODE_NO_WARNINGS: "1"
                },
                stdio: ["pipe", "pipe", "pipe"]
            }
        );

        let stdout = "";
        let stderr = "";
        let settled = false;

        let timer;

        function finish(result) {
            if (settled) return;

            settled = true;

            if (timer) clearTimeout(timer);

            resolve({
                file: fileName,
                ...result
            });
        }

        timer = setTimeout(() => {
            child.kill("SIGKILL");

            finish({
                status: "failed",
                message: "JavaScript syntax check timed out."
            });
        }, COMMAND_TIMEOUT);

        child.stdout.on("data", chunk => {
            stdout = (
                stdout + chunk.toString()
            ).slice(-MAX_OUTPUT);
        });

        child.stderr.on("data", chunk => {
            stderr = (
                stderr + chunk.toString()
            ).slice(-MAX_OUTPUT);
        });

        child.on("error", error => {
            finish({
                status: "failed",
                message: error.message
            });
        });

        child.on("close", code => {
            finish({
                status: code === 0 ? "passed" : "failed",
                message: code === 0
                    ? "JavaScript syntax is valid."
                    : (
                        stderr ||
                        stdout ||
                        `Node exited with code ${code}.`
                    )
            });
        });

        child.stdin.on("error", () => {});

        child.stdin.end(content);
    });
}

function extractHtmlReferences(html) {
    const references = [];

    const moduleScripts = new Set();

    const tagRegex =
        /<(script|link|img|source|audio|video)\b([^>]*)>/gi;

    let match;

    while ((match = tagRegex.exec(html)) !== null) {
        const tagName = match[1].toLowerCase();
        const attributes = match[2];

        const referenceMatch = attributes.match(
            /\b(src|href)\s*=\s*["']([^"']+)["']/i
        );

        if (!referenceMatch) continue;

        const reference = referenceMatch[2].trim();

        if (!reference) continue;

        references.push({
            tagName,
            reference
        });

        if (tagName === "script") {
            const typeMatch = attributes.match(
                /\btype\s*=\s*["']([^"']+)["']/i
            );

            if (
                typeMatch &&
                typeMatch[1].toLowerCase() === "module"
            ) {
                moduleScripts.add(reference);
            }
        }
    }

    return {
        references,
        moduleScripts
    };
}

function resolveLocalReference(
    integrationRoot,
    htmlPath,
    reference
) {
    if (
        reference.startsWith("//") ||
        /^[a-z][a-z0-9+.-]*:/i.test(reference)
    ) {
        return null;
    }

    const withoutQuery = reference.split(/[?#]/)[0];

    if (!withoutQuery) return null;

    let decoded;

    try {
        decoded = decodeURIComponent(withoutQuery);
    } catch {
        throw new Error(
            `Invalid URL encoding in reference: ${reference}`
        );
    }

    if (
        decoded.includes("\0") ||
        decoded.includes("\\")
    ) {
        throw new Error(
            `Unsafe asset reference: ${reference}`
        );
    }

    const isRootRelative = decoded.startsWith("/");

    const base = isRootRelative
        ? integrationRoot
        : path.dirname(htmlPath);

    const target = path.resolve(
        base,
        decoded.replace(/^\/+/, "")
    );

    if (!isInside(integrationRoot, target)) {
        throw new Error(
            `Asset reference escapes integration directory: ${reference}`
        );
    }

    return target;
}

function detectTechnologyStack(files) {
    const paths = files.map(file =>
        file.relativePath.replace(/\\/g, "/").toLowerCase()
    );

    const has = name => paths.includes(name.toLowerCase());

    const hasSuffix = suffix =>
        paths.some(file => file.endsWith(suffix));

    const technologies = new Set();
    const frameworks = new Set();
    const manifests = [];

    if (has("package.json")) {
        technologies.add("Node.js");
        manifests.push("package.json");
    }

    if (
        has("pom.xml") ||
        hasSuffix(".java")
    ) {
        technologies.add("Java");
    }

    if (
        has("build.gradle") ||
        has("build.gradle.kts") ||
        has("settings.gradle") ||
        has("settings.gradle.kts")
    ) {
        technologies.add("Gradle");
    }

    if (has("pom.xml")) {
        technologies.add("Maven");
    }

    if (
        has("requirements.txt") ||
        has("pyproject.toml") ||
        has("setup.py") ||
        hasSuffix(".py")
    ) {
        technologies.add("Python");
    }

    if (has("go.mod") || hasSuffix(".go")) {
        technologies.add("Go");
    }

    if (
        has("cargo.toml") ||
        hasSuffix(".rs")
    ) {
        technologies.add("Rust");
    }

    if (
        has("composer.json") ||
        hasSuffix(".php")
    ) {
        technologies.add("PHP");
    }

    if (
        has("gemfile") ||
        hasSuffix(".rb")
    ) {
        technologies.add("Ruby");
    }

    if (
        has("package.json") ||
        hasSuffix(".ts") ||
        hasSuffix(".tsx")
    ) {
        if (
            hasSuffix(".ts") ||
            hasSuffix(".tsx")
        ) {
            technologies.add("TypeScript");
        }
    }

    if (
        hasSuffix(".html") ||
        hasSuffix(".htm")
    ) {
        technologies.add("HTML");
    }

    if (
        hasSuffix(".css") ||
        hasSuffix(".scss") ||
        hasSuffix(".sass")
    ) {
        technologies.add("CSS");
    }

    if (
        hasSuffix(".sql") ||
        has("schema.prisma")
    ) {
        technologies.add("Database / SQL");
    }

    if (
        has("cds.yaml") ||
        hasSuffix(".cds")
    ) {
        technologies.add("SAP CAP");
    }

    if (
        has("mta.yaml") ||
        has("xs-app.json")
    ) {
        technologies.add("SAP BTP");
    }

    if (
        hasSuffix(".csproj") ||
        hasSuffix(".sln") ||
        hasSuffix(".cs")
    ) {
        technologies.add(".NET / C#");
    }

    if (
        has("dockerfile") ||
        has("docker-compose.yml") ||
        has("compose.yml")
    ) {
        technologies.add("Docker");
    }

    if (
        has("index.html") ||
        hasSuffix(".html")
    ) {
        frameworks.add("HTML frontend");
    }

    if (
        has("package.json") &&
        hasSuffix(".tsx")
    ) {
        frameworks.add("React / possible React");
    }

    if (
        has("package.json") &&
        hasSuffix(".vue")
    ) {
        frameworks.add("Vue");
    }

    if (
        has("package.json") &&
        hasSuffix(".svelte")
    ) {
        frameworks.add("Svelte");
    }

    if (hasSuffix(".cds")) {
        frameworks.add("SAP CAP application");
    }

    return {
        technologies: [...technologies].sort(),
        frameworks: [...frameworks].sort(),
        manifests
    };
}

function parseJsonFiles(files) {
    const results = [];

    for (const file of files) {
        if (
            path.extname(file.relativePath).toLowerCase() !== ".json"
        ) {
            continue;
        }

        try {
            JSON.parse(file.content);

            results.push({
                file: file.relativePath,
                status: "passed",
                message: "Valid JSON."
            });

        } catch (error) {
            results.push({
                file: file.relativePath,
                status: "failed",
                message: error.message
            });
        }
    }

    return results;
}

function addCheck(report, name, status, message, details = {}) {
    report.checks.push({
        name,
        status,
        message,
        ...details
    });
}

async function runStaticQA({
    projectRoot,
    runId,
    integrationFiles
}) {
    const startedAt = new Date().toISOString();

    const report = {
        mode: "universal-static",
        status: "running",
        runId,
        startedAt,
        completedAt: null,

        checkedFiles: 0,

        detected: {
            technologies: [],
            frameworks: [],
            manifests: []
        },

        checks: [],

        summary: {
            passed: 0,
            failed: 0,
            skipped: 0
        },

        functionalTests: "not_run",
        build: "not_run",
        runtime: "not_run",

        limitations: [
            "Static QA does not prove that the application starts.",
            "Static QA does not prove database connectivity or API behavior.",
            "Build, runtime, browser and functional tests are separate verification stages."
        ]
    };

    try {
        const root = path.resolve(projectRoot);

        const integrationRoot = resolveIntegrationDirectory(
            root,
            runId
        );

        if (
            !Array.isArray(integrationFiles) ||
            integrationFiles.length === 0
        ) {
            throw new Error(
                "No integrated files were supplied for QA."
            );
        }

        if (integrationFiles.length > MAX_FILES) {
            throw new Error(
                "Integrated file count exceeds QA limit."
            );
        }

        const seenPaths = new Set();

        const files = [];

        let totalBytes = 0;

        for (const item of integrationFiles) {
            if (
                !item ||
                typeof item.path !== "string" ||
                !item.path.trim()
            ) {
                throw new Error(
                    "Invalid integrated file record."
                );
            }

            if (seenPaths.has(item.path)) {
                throw new Error(
                    `Duplicate integrated file: ${item.path}`
                );
            }

            seenPaths.add(item.path);

            const resolved = resolveIntegratedFile(
                root,
                integrationRoot,
                item.path
            );

            totalBytes += resolved.stats.size;

            if (totalBytes > MAX_TOTAL_BYTES) {
                throw new Error(
                    "Integrated files exceed total QA size limit."
                );
            }

            const content = fs.readFileSync(
                resolved.absolutePath,
                "utf8"
            );

            files.push({
                path: item.path,
                relativePath: resolved.relativePath,
                absolutePath: resolved.absolutePath,
                content,
                bytes: resolved.stats.size
            });
        }

        report.checkedFiles = files.length;

        addCheck(
            report,
            "integrated_files",
            "passed",
            `Verified ${files.length} integrated regular files.`
        );

        const emptyFiles = files.filter(
            file => !file.content.trim()
        );

        addCheck(
            report,
            "non_empty_files",
            emptyFiles.length ? "failed" : "passed",
            emptyFiles.length
                ? "Empty integrated files were found."
                : "All integrated files contain content.",
            {
                files: emptyFiles.map(file => file.relativePath)
            }
        );

        report.detected = detectTechnologyStack(files);

        addCheck(
            report,
            "technology_detection",
            "passed",
            report.detected.technologies.length
                ? `Detected: ${report.detected.technologies.join(", ")}`
                : "No recognized technology manifest or source extension was detected.",
            {
                technologies: report.detected.technologies,
                frameworks: report.detected.frameworks,
                manifests: report.detected.manifests
            }
        );

        // --------------------------------------------------
        // JSON VALIDATION
        // --------------------------------------------------

        const jsonResults = parseJsonFiles(files);

        if (!jsonResults.length) {
            addCheck(
                report,
                "json_syntax",
                "skipped",
                "No JSON files were found."
            );

        } else {
            const failed = jsonResults.filter(
                item => item.status === "failed"
            );

            addCheck(
                report,
                "json_syntax",
                failed.length ? "failed" : "passed",
                failed.length
                    ? `${failed.length} JSON file(s) contain invalid JSON.`
                    : `Valid JSON in ${jsonResults.length} file(s).`,
                {
                    results: jsonResults
                }
            );
        }

        // --------------------------------------------------
        // HTML ASSET VALIDATION
        // --------------------------------------------------

        const htmlFiles = files.filter(file =>
            [".html", ".htm"].includes(
                path.extname(file.relativePath).toLowerCase()
            )
        );

        if (!htmlFiles.length) {
            addCheck(
                report,
                "html_references",
                "skipped",
                "No HTML files were found."
            );

        } else {
            const missingReferences = [];
            const unsafeReferences = [];

            for (const file of htmlFiles) {
                const extracted = extractHtmlReferences(
                    file.content
                );

                for (const item of extracted.references) {
                    try {
                        const target = resolveLocalReference(
                            integrationRoot,
                            file.absolutePath,
                            item.reference
                        );

                        if (!target) continue;

                        assertNoSymlinks(root, target);

                        if (!fs.existsSync(target)) {
                            missingReferences.push({
                                html: file.relativePath,
                                reference: item.reference
                            });

                            continue;
                        }

                        const stats = fs.lstatSync(target);

                        if (
                            !stats.isFile() ||
                            stats.isSymbolicLink()
                        ) {
                            unsafeReferences.push({
                                html: file.relativePath,
                                reference: item.reference,
                                error: "Referenced path is not a regular file."
                            });
                        }

                    } catch (error) {
                        unsafeReferences.push({
                            html: file.relativePath,
                            reference: item.reference,
                            error: error.message
                        });
                    }
                }
            }

            const failed =
                missingReferences.length > 0 ||
                unsafeReferences.length > 0;

            addCheck(
                report,
                "html_references",
                failed ? "failed" : "passed",
                failed
                    ? "Some local HTML references are missing or unsafe."
                    : "All checked local HTML references exist.",
                {
                    missing: missingReferences,
                    unsafe: unsafeReferences
                }
            );
        }

        // --------------------------------------------------
        // JAVASCRIPT SYNTAX
        // --------------------------------------------------

        const packageManifest = files.find(
            file =>
                file.relativePath.toLowerCase() === "package.json"
        );

        let rootPackageType = null;

        if (packageManifest) {
            try {
                rootPackageType =
                    JSON.parse(packageManifest.content).type || null;
            } catch {
                // JSON validation already records this failure.
            }
        }

        const moduleReferences = new Set();

        for (const file of htmlFiles) {
            const extracted = extractHtmlReferences(
                file.content
            );

            for (const reference of extracted.moduleScripts) {
                try {
                    const target = resolveLocalReference(
                        integrationRoot,
                        file.absolutePath,
                        reference
                    );

                    if (target) {
                        moduleReferences.add(target);
                    }
                } catch {
                    // The HTML reference check records unsafe paths.
                }
            }
        }

        const javascriptFiles = files.filter(file =>
            [".js", ".mjs", ".cjs"].includes(
                path.extname(file.relativePath).toLowerCase()
            )
        );

        if (!javascriptFiles.length) {
            addCheck(
                report,
                "javascript_syntax",
                "skipped",
                "No JavaScript files were found."
            );

        } else {
            const syntaxResults = [];

            for (const file of javascriptFiles) {
                const extension = path.extname(
                    file.relativePath
                ).toLowerCase();

                const moduleMode =
                    extension === ".mjs" ||
                    (
                        extension === ".js" &&
                        (
                            moduleReferences.has(file.absolutePath) ||
                            rootPackageType === "module"
                        )
                    );

                const result = await runNodeSyntaxCheck(
                    file.content,
                    moduleMode,
                    file.relativePath
                );

                syntaxResults.push(result);
            }

            const failed = syntaxResults.filter(
                item => item.status !== "passed"
            );

            addCheck(
                report,
                "javascript_syntax",
                failed.length ? "failed" : "passed",
                failed.length
                    ? `${failed.length} JavaScript syntax check(s) failed.`
                    : `JavaScript syntax passed for ${syntaxResults.length} file(s).`,
                {
                    results: syntaxResults
                }
            );
        }

        // --------------------------------------------------
        // TRANSPARENT UNSUPPORTED CHECKS
        // --------------------------------------------------

        const sourceTypes = new Set(
            files.map(file =>
                path.extname(file.relativePath).toLowerCase()
            )
        );

        const unsupportedStaticTypes = [
            {
                extensions: [".ts", ".tsx"],
                name: "typescript_compilation",
                message: "TypeScript files detected. A TypeScript compiler/build check is not performed by static QA."
            },
            {
                extensions: [".py"],
                name: "python_syntax",
                message: "Python files detected. Python compilation is not performed by this static QA stage."
            },
            {
                extensions: [".java"],
                name: "java_compilation",
                message: "Java files detected. Java compilation is not performed by this static QA stage."
            },
            {
                extensions: [".go"],
                name: "go_compilation",
                message: "Go files detected. Go compilation is not performed by this static QA stage."
            },
            {
                extensions: [".rs"],
                name: "rust_compilation",
                message: "Rust files detected. Rust compilation is not performed by this static QA stage."
            },
            {
                extensions: [".cs"],
                name: "dotnet_compilation",
                message: ".NET source detected. .NET compilation is not performed by this static QA stage."
            },
            {
                extensions: [".php"],
                name: "php_syntax",
                message: "PHP files detected. PHP syntax checking is not performed by this static QA stage."
            }
        ];

        for (const item of unsupportedStaticTypes) {
            if (
                item.extensions.some(extension =>
                    sourceTypes.has(extension)
                )
            ) {
                addCheck(
                    report,
                    item.name,
                    "skipped",
                    item.message
                );
            }
        }

    } catch (error) {
        addCheck(
            report,
            "qa_execution",
            "failed",
            error.message
        );
    }

    report.summary = {
        passed: report.checks.filter(
            check => check.status === "passed"
        ).length,

        failed: report.checks.filter(
            check => check.status === "failed"
        ).length,

        skipped: report.checks.filter(
            check => check.status === "skipped"
        ).length
    };

    // A static QA pass means only that all executed static checks passed.
    // It does not mean the application is fully verified.
    report.status = report.summary.failed === 0
        ? "passed"
        : "failed";

    report.completedAt = new Date().toISOString();

    console.log(
        `[QA] ${report.status.toUpperCase()}: ` +
        `${report.summary.passed} passed, ` +
        `${report.summary.failed} failed, ` +
        `${report.summary.skipped} skipped`
    );

    console.log(
        `[QA] Technologies: ${
            report.detected.technologies.join(", ") || "Unknown"
        }`
    );

    return report;
}

module.exports = {
    runStaticQA,
    detectTechnologyStack
};