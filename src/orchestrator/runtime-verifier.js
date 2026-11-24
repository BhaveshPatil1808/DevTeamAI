
"use strict";

/**
 * DevTeamAI Runtime Verifier
 *
 * Verification stages:
 * 1. Static completeness checks.
 * 2. Dependency installation, when required.
 * 3. Restricted application startup.
 * 4. HTTP response and referenced asset verification.
 *
 * Important security limitation:
 * Network isolation and process limits are used where supported.
 * Filesystem isolation is NOT provided by the current BAS environment.
 * This is not a secure sandbox for untrusted code.
 */

const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const http = require("node:http");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { builtinModules } = require("node:module");

const {
    buildRestrictedInvocation,
    buildRestrictedEnv
} = require("./restricted-execution");

const IS_WINDOWS = process.platform === "win32";

const INSTALL_TIMEOUT_MS =
    Number(process.env.RUNTIME_INSTALL_TIMEOUT_MS) || 5 * 60 * 1000;

const START_WAIT_MS =
    Number(process.env.RUNTIME_START_WAIT_MS) || 25 * 1000;

const MAX_CAPTURE_CHARS = 24000;
const MAX_ISSUES = 8;

const BUILTINS = new Set([
    ...builtinModules,
    ...builtinModules.map(name => `node:${name}`)
]);

const REPAIRABLE_NPM_CODES = new Set([
    "E404",
    "ETARGET",
    "ERESOLVE",
    "EJSONPARSE",
    "EUNSUPPORTEDPROTOCOL",
    "EINVALIDTAGNAME",
    "ENOVERSIONS",
    "EBADENGINE",
    "EINVALIDPACKAGENAME",
    "ENOLOCAL"
]);

const WEB_ROOT_DIRS = [
    "",
    "public",
    "static",
    "client",
    "www",
    "dist",
    "build",
    "app",
    "web",
    "src/public"
];

const ENTRY_CANDIDATES = [
    "server.js",
    "index.js",
    "app.js",
    "main.js",
    "src/server.js",
    "src/index.js",
    "src/app.js",
    "src/main.js"
];


// ==================================================
// SMALL HELPERS
// ==================================================

function toPosix(value) {
    return String(value).replace(/\\/g, "/");
}

function tail(value, max = MAX_CAPTURE_CHARS) {
    const text = String(value || "");
    return text.length > max ? text.slice(-max) : text;
}

function normalizeRelative(value) {
    const parts = [];

    for (const part of toPosix(value).split("/")) {
        if (!part || part === ".") continue;

        if (part === "..") {
            if (parts.length === 0) return null;
            parts.pop();
            continue;
        }

        parts.push(part);
    }

    return parts.length > 0 ? parts.join("/") : null;
}

function joinRelative(baseDir, spec) {
    return normalizeRelative(
        path.posix.join(baseDir || ".", toPosix(spec))
    );
}

function dirnameOf(relativePath) {
    const dir = path.posix.dirname(relativePath);
    return dir === "." ? "" : dir;
}

function makeIssue(kind, targetPath, message, extra = {}) {
    return {
        kind,
        targetPath,
        message,
        ...extra
    };
}

function dedupeIssues(issues) {
    const seen = new Set();
    const result = [];

    for (const issue of issues) {
        if (!issue || !issue.targetPath) continue;

        const key = `${issue.kind}:${issue.targetPath}`;

        if (seen.has(key)) continue;

        seen.add(key);
        result.push(issue);

        if (result.length >= MAX_ISSUES) break;
    }

    return result;
}

function buildRuntimeEnv(extra = {}, cwd = os.tmpdir()) {
    return buildRestrictedEnv(cwd, {
        NODE_ENV: "development",
        BROWSER: "none",
        CI: "true",
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        npm_config_update_notifier: "false",
        ...extra
    });
}

function findFreePort() {
    return new Promise(resolve => {
        const server = net.createServer();

        server.unref();

        server.on("error", () => resolve(0));

        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = address?.port || 0;

            server.close(() => resolve(port));
        });
    });
}

function killTree(child) {
    if (!child || child.exitCode !== null || !child.pid) {
        return;
    }

    try {
        if (IS_WINDOWS) {
            spawnSync(
                "taskkill",
                ["/pid", String(child.pid), "/T", "/F"],
                { windowsHide: true }
            );
        } else {
            process.kill(-child.pid, "SIGKILL");
        }
    } catch {
        try {
            child.kill("SIGKILL");
        } catch {
            // Process already ended.
        }
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


// ==================================================
// PROJECT DETECTION
// ==================================================

function readJson(files, name) {
    const entry = files.get(name);

    if (!entry) {
        return {
            exists: false,
            value: null,
            error: null
        };
    }

    try {
        return {
            exists: true,
            value: JSON.parse(entry),
            error: null
        };
    } catch (error) {
        return {
            exists: true,
            value: null,
            error: error.message
        };
    }
}

function detectProject(files) {
    const pkg = readJson(files, "package.json");

    if (pkg.exists) {
        return {
            type: "node",
            pkg
        };
    }

    const hasPython =
        files.has("requirements.txt") ||
        files.has("pyproject.toml") ||
        [...files.keys()].some(name => name.endsWith(".py"));

    if (hasPython) {
        return {
            type: "python",
            pkg
        };
    }

    const hasHtml = [...files.keys()].some(name =>
        /\.html?$/i.test(name)
    );

    if (hasHtml) {
        return {
            type: "static",
            pkg
        };
    }

    const hasLooseNode = [...files.keys()].some(name =>
        /\.(js|mjs|cjs)$/i.test(name)
    );

    if (hasLooseNode) {
        return {
            type: "node",
            pkg
        };
    }

    return {
        type: "unknown",
        pkg
    };
}

function guessScriptEntry(script, files) {
    const match = String(script).match(
        /(?:^|\s)(?:node|nodemon|ts-node|tsx)\s+(?:--?[\w-]+(?:=\S+)?\s+)*([^\s&|;]+\.(?:c|m)?[jt]s)/
    );

    if (match) {
        const normalized = normalizeRelative(match[1]);

        if (normalized) return normalized;
    }

    return ENTRY_CANDIDATES.find(candidate =>
        files.has(candidate)
    ) || null;
}

function pickNodeStart(files, pkg) {
    const scripts = pkg?.value?.scripts || {};

    if (
        typeof scripts.start === "string" &&
        scripts.start.trim()
    ) {
        return {
            command: "npm",
            args: ["start"],
            label: "npm start",
            entry: guessScriptEntry(scripts.start, files)
        };
    }

    const main = pkg?.value?.main;

    if (typeof main === "string") {
        const normalized = normalizeRelative(main);

        if (normalized && files.has(normalized)) {
            return {
                command: process.execPath,
                args: [normalized],
                label: `node ${normalized}`,
                entry: normalized
            };
        }
    }

    for (const candidate of ENTRY_CANDIDATES) {
        if (files.has(candidate)) {
            return {
                command: process.execPath,
                args: [candidate],
                label: `node ${candidate}`,
                entry: candidate
            };
        }
    }

    return null;
}


// ==================================================
// STATIC COMPLETENESS CHECK
// ==================================================

function stripJsComments(source) {
    return String(source)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
}

function extractModuleSpecifiers(source) {
    const code = stripJsComments(source);
    const specifiers = new Set();

    const patterns = [
        /\brequire\s*\(\s*(["'`])([^"'`\n]+)\1\s*\)/g,
        /\bimport\s+(?:[\w*{}\s,$]+?\s+from\s+)?(["'])([^"'\n]+)\1/g,
        /\bexport\s+(?:\*|\{[^}]*\})\s+from\s+(["'])([^"'\n]+)\1/g,
        /\bimport\s*\(\s*(["'`])([^"'`\n]+)\1\s*\)/g
    ];

    for (const pattern of patterns) {
        for (const match of code.matchAll(pattern)) {
            specifiers.add(match[2]);
        }
    }

    return [...specifiers];
}

function resolveModuleFile(files, baseDir, spec) {
    const base = joinRelative(baseDir, spec);

    if (!base) {
        return {
            found: null,
            wanted: null
        };
    }

    const candidates = [
        base,
        `${base}.js`,
        `${base}.json`,
        `${base}.mjs`,
        `${base}.cjs`,
        `${base}.ts`,
        `${base}/index.js`,
        `${base}/index.json`,
        `${base}/index.mjs`,
        `${base}/index.ts`
    ];

    const found = candidates.find(candidate =>
        files.has(candidate)
    );

    const hasExtension =
        /\.[a-z0-9]+$/i.test(path.posix.basename(base));

    return {
        found: found || null,
        wanted: hasExtension ? base : `${base}.js`
    };
}

function packageNameOf(spec) {
    if (spec.startsWith("@")) {
        return spec.split("/").slice(0, 2).join("/");
    }

    return spec.split("/")[0];
}

function nearestDependencies(files, fromFile) {
    let dir = dirnameOf(fromFile);

    for (;;) {
        const manifestPath = dir
            ? `${dir}/package.json`
            : "package.json";

        const manifest = readJson(files, manifestPath);

        if (manifest.value) {
            const value = manifest.value;

            return {
                manifestPath,
                names: new Set([
                    ...Object.keys(value.dependencies || {}),
                    ...Object.keys(value.devDependencies || {}),
                    ...Object.keys(value.peerDependencies || {}),
                    ...Object.keys(value.optionalDependencies || {})
                ])
            };
        }

        if (!dir) break;

        dir = dirnameOf(dir);
    }

    return {
        manifestPath: "package.json",
        names: null
    };
}

function isLocalReference(ref) {
    const value = String(ref || "").trim();

    return Boolean(
        value &&
        !value.startsWith("#") &&
        !value.startsWith("//") &&
        !/^[a-z][a-z0-9+.-]*:/i.test(value) &&
        !value.includes("{{") &&
        !value.includes("${") &&
        !value.includes("<%")
    );
}

function decodeUriSafe(value) {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function resolveHtmlReference(files, htmlPath, ref) {
    const clean = decodeUriSafe(
        String(ref).split(/[?#]/)[0]
    );

    if (!clean) {
        return {
            found: true,
            wanted: null
        };
    }

    const htmlDir = dirnameOf(htmlPath);

    if (clean.startsWith("/")) {
        const rootRelative = clean.replace(/^\/+/, "");
        const roots = new Set(WEB_ROOT_DIRS);

        if (htmlDir) roots.add(htmlDir);

        for (const root of roots) {
            const candidate = joinRelative(root, rootRelative);

            if (candidate && files.has(candidate)) {
                return {
                    found: true,
                    wanted: candidate
                };
            }
        }

        return {
            found: false,
            wanted: joinRelative(htmlDir, rootRelative)
        };
    }

    const candidate = joinRelative(htmlDir, clean);

    return {
        found: Boolean(candidate && files.has(candidate)),
        wanted: candidate
    };
}

function extractHtmlReferences(html) {
    const refs = [];

    const tagPattern =
        /<(script|link|img|source|video|audio)\b[^>]*>/gi;

    for (const tag of String(html).matchAll(tagPattern)) {
        const element = tag[1].toLowerCase();
        const attribute = element === "link" ? "href" : "src";

        const match = tag[0].match(
            new RegExp(
                `\\b${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
                "i"
            )
        );

        const value = match
            ? (match[1] ?? match[2])
            : null;

        if (isLocalReference(value)) {
            refs.push({
                element,
                ref: value
            });
        }
    }

    return refs;
}

function analyzeStatic(files, project) {
    const issues = [];
    const pkg = project.pkg;

    // package.json
    if (pkg?.exists && pkg.error) {
        issues.push(makeIssue(
            "invalid_json",
            "package.json",
            `package.json is not valid JSON (${pkg.error}). Return a complete, valid package.json.`
        ));
    }

    if (pkg?.value) {
        const value = pkg.value;

        if (typeof value.main === "string") {
            const main = normalizeRelative(value.main);

            if (
                main &&
                !files.has(main) &&
                !files.has(`${main}.js`)
            ) {
                issues.push(makeIssue(
                    "missing_file",
                    main,
                    `package.json "main" points to ${main}, which does not exist. Create ${main}.`,
                    { requiredBy: "package.json" }
                ));
            }
        }

        const startScript = value.scripts?.start;

        if (typeof startScript === "string") {
            const direct = startScript.match(
                /(?:^|\s)(?:node|nodemon)\s+(?:--?[\w-]+(?:=\S+)?\s+)*([^\s&|;]+\.(?:c|m)?js)/
            );

            if (direct) {
                const wanted = normalizeRelative(direct[1]);

                if (wanted && !files.has(wanted)) {
                    issues.push(makeIssue(
                        "missing_file",
                        wanted,
                        `The start script runs ${wanted}, but that file does not exist.`,
                        { requiredBy: "package.json" }
                    ));
                }
            }
        } else if (
            !value.main &&
            !pickNodeStart(files, pkg)
        ) {
            issues.push(makeIssue(
                "no_start",
                "package.json",
                'package.json has no "start" script, no "main", and no recognizable entry file.'
            ));
        }
    }

    // JavaScript imports
    for (const [filePath, content] of files) {
        if (!/\.(js|mjs|cjs)$/i.test(filePath)) {
            continue;
        }

        const baseDir = dirnameOf(filePath);
        const dependencyInfo = nearestDependencies(
            files,
            filePath
        );

        for (const spec of extractModuleSpecifiers(content)) {
            if (spec.startsWith(".")) {
                const { found, wanted } = resolveModuleFile(
                    files,
                    baseDir,
                    spec
                );

                if (!found && wanted) {
                    issues.push(makeIssue(
                        "missing_file",
                        wanted,
                        `${filePath} imports "${spec}", but ${wanted} does not exist.`,
                        { requiredBy: filePath }
                    ));
                }

                continue;
            }

            if (
                spec.startsWith("/") ||
                BUILTINS.has(spec) ||
                spec.startsWith("node:")
            ) {
                continue;
            }

            const name = packageNameOf(spec);

            if (!name || BUILTINS.has(name)) continue;

            if (/(^|\/)(public|static|client|www)\//.test(filePath)) {
                continue;
            }

            if (
                dependencyInfo.names &&
                !dependencyInfo.names.has(name)
            ) {
                issues.push(makeIssue(
                    "missing_dependency",
                    dependencyInfo.manifestPath,
                    `${filePath} requires "${name}", but it is not declared in ${dependencyInfo.manifestPath}.`,
                    {
                        requiredBy: filePath,
                        packageName: name
                    }
                ));
            } else if (
                !dependencyInfo.names &&
                project.type === "node"
            ) {
                issues.push(makeIssue(
                    "missing_dependency",
                    "package.json",
                    `${filePath} requires "${name}", but package.json is missing.`,
                    {
                        requiredBy: filePath,
                        packageName: name
                    }
                ));
            }
        }
    }

    // Other JSON files
    for (const [filePath, content] of files) {
        if (
            !/\.json$/i.test(filePath) ||
            filePath === "package.json"
        ) {
            continue;
        }

        if (/(^|\/)(tsconfig|jsconfig)[^/]*\.json$/i.test(filePath)) {
            continue;
        }

        try {
            JSON.parse(content);
        } catch (error) {
            issues.push(makeIssue(
                "invalid_json",
                filePath,
                `${filePath} is not valid JSON (${error.message}).`
            ));
        }
    }

    // HTML references
    for (const [filePath, content] of files) {
        if (!/\.html?$/i.test(filePath)) continue;

        for (const { element, ref } of extractHtmlReferences(content)) {
            const { found, wanted } = resolveHtmlReference(
                files,
                filePath,
                ref
            );

            if (found || !wanted) continue;

            issues.push(makeIssue(
                "missing_file",
                wanted,
                `${filePath} references ${ref} (<${element}>), but ${wanted} does not exist.`,
                { requiredBy: filePath }
            ));
        }
    }

    return dedupeIssues(issues);
}


// ==================================================
// PROCESS EXECUTION
// ==================================================

function spawnOptions(cwd, env, detached) {
    return {
        cwd,
        env,
        detached,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        shell: IS_WINDOWS
    };
}

function runProcess({
    command,
    args,
    cwd,
    env,
    timeoutMs,
    networkIsolation = false
}) {
    return new Promise(resolve => {
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let settled = false;
        let child;
        let timer;

        function finish(result) {
            if (settled) return;

            settled = true;

            if (timer) clearTimeout(timer);

            resolve({
                stdout: tail(stdout),
                stderr: tail(stderr),
                timedOut,
                ...result
            });
        }

        try {
            const invocation = buildRestrictedInvocation(
                command,
                args,
                {
                    networkIsolation,
                    cpuSeconds: Math.ceil(timeoutMs / 1000) + 30
                }
            );

            child = spawn(
                invocation.command,
                invocation.args,
                spawnOptions(cwd, env, !IS_WINDOWS)
            );
        } catch (error) {
            resolve({
                code: null,
                stdout: "",
                stderr: "",
                timedOut: false,
                spawnError: error.message,
                outcome:
                    error.code === "RESTRICTED_EXECUTION_UNAVAILABLE"
                        ? "unsupported"
                        : "spawn_error"
            });

            return;
        }

        timer = setTimeout(() => {
            timedOut = true;
            killTree(child);
        }, timeoutMs);

        child.stdout.on("data", chunk => {
            stdout = tail(
                stdout + chunk.toString("utf8"),
                200000
            );
        });

        child.stderr.on("data", chunk => {
            stderr = tail(
                stderr + chunk.toString("utf8"),
                200000
            );
        });

        child.on("error", error => {
            finish({
                code: null,
                spawnError: error.message,
                outcome:
                    error.code === "RESTRICTED_EXECUTION_UNAVAILABLE"
                        ? "unsupported"
                        : "spawn_error"
            });
        });

        child.on("close", (code, signal) => {
            finish({
                code,
                signal,
                outcome: "exited"
            });
        });
    });
}


// ==================================================
// HTTP PROBES
// ==================================================

function httpProbe(port, urlPath = "/", timeoutMs = 2500) {
    return new Promise(resolve => {
        const request = http.request(
            {
                host: "localhost",
                port,
                path: urlPath,
                method: "GET",
                timeout: timeoutMs,
                headers: {
                    Accept: "text/html,*/*"
                }
            },
            response => {
                const chunks = [];
                let size = 0;

                response.on("data", chunk => {
                    size += chunk.length;

                    if (size <= 512 * 1024) {
                        chunks.push(chunk);
                    }
                });

                response.on("end", () => {
                    resolve({
                        ok: true,
                        status: response.statusCode,
                        contentType: String(
                            response.headers["content-type"] || ""
                        ),
                        body: Buffer.concat(chunks).toString("utf8")
                    });
                });
            }
        );

        request.on("timeout", () => {
            request.destroy();
            resolve({
                ok: false,
                error: "timeout"
            });
        });

        request.on("error", error => {
            resolve({
                ok: false,
                error: error.code || error.message
            });
        });

        request.end();
    });
}

function portsFromOutput(output) {
    const ports = new Set();

    const patterns = [
        /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]|::1?):(\d{2,5})/gi,
        /\bports?\b[^\d\n]{0,12}(\d{2,5})/gi
    ];

    for (const pattern of patterns) {
        for (const match of String(output).matchAll(pattern)) {
            const port = Number(match[1]);

            if (port >= 80 && port <= 65535) {
                ports.add(port);
            }
        }
    }

    return [...ports];
}

const FATAL_OUTPUT_PATTERN =
    /(Cannot find module|ERR_MODULE_NOT_FOUND|Cannot find package|SyntaxError|ReferenceError|TypeError|Unhandled|UnhandledPromiseRejection|ENOENT|EADDRINUSE|MODULE_NOT_FOUND|Error: listen|Traceback \(most recent call last\)|ModuleNotFoundError|ImportError)/;


// ==================================================
// RESTRICTED RUNTIME SUPERVISOR
// ==================================================

async function startAndProbe({
    command,
    args,
    cwd,
    env,
    port,
    waitMs
}) {
    const helperPath = path.join(
        __dirname,
        "restricted-runtime-child.js"
    );

    const config = {
        command,
        args,
        cwd,
        env,
        port,
        waitMs
    };

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child;

    try {
        const invocation = buildRestrictedInvocation(
            process.execPath,
            [helperPath],
            {
                networkIsolation: true,
                cpuSeconds: Math.ceil(waitMs / 1000) + 60
            }
        );

        child = spawn(
            invocation.command,
            invocation.args,
            spawnOptions(
                cwd,
                buildRuntimeEnv(
                    {
                        DEVTEAMAI_RUNTIME_CONFIG:
                            JSON.stringify(config)
                    },
                    cwd
                ),
                !IS_WINDOWS
            )
        );
    } catch (error) {
        return {
            outcome:
                error.code === "RESTRICTED_EXECUTION_UNAVAILABLE"
                    ? "unsupported"
                    : "spawn_error",
            spawnError: error.message,
            stdout: "",
            stderr: "",
            isolation: {
                network: "unavailable",
                filesystem: "not_isolated",
                securityBoundary: false
            }
        };
    }

    const processResult = await new Promise(resolve => {
        const timer = setTimeout(() => {
            timedOut = true;
            killTree(child);
        }, waitMs + 10000);

        child.stdout.on("data", chunk => {
            stdout = tail(
                stdout + chunk.toString("utf8"),
                300000
            );
        });

        child.stderr.on("data", chunk => {
            stderr = tail(
                stderr + chunk.toString("utf8"),
                30000
            );
        });

        child.on("error", error => {
            clearTimeout(timer);

            resolve({
                error: error.message,
                code: null
            });
        });

        child.on("close", code => {
            clearTimeout(timer);

            resolve({
                code
            });
        });
    });

    if (timedOut) {
        return {
            outcome: "timeout",
            stdout,
            stderr,
            spawnError: "Restricted runtime verification timed out.",
            isolation: {
                network: "isolated",
                filesystem: "not_isolated",
                securityBoundary: false
            }
        };
    }

    let parsed;

    try {
        parsed = JSON.parse(stdout.trim());
    } catch {
        return {
            outcome: "supervisor_error",
            exitCode: processResult.code,
            spawnError:
                processResult.error ||
                "Restricted runtime supervisor returned invalid output.",
            stdout,
            stderr,
            isolation: {
                network: "isolated",
                filesystem: "not_isolated",
                securityBoundary: false
            }
        };
    }

    return {
        ...parsed,
        spawnError: parsed.spawnError || parsed.error || null,
        stdout: tail(parsed.stdout || ""),
        stderr: tail(
            `${parsed.stderr || ""}\n${stderr}`
        ),
        isolation: {
            network: "isolated",
            filesystem: "not_isolated",
            securityBoundary: false
        }
    };
}


// ==================================================
// ERROR OUTPUT -> STRUCTURED ISSUES
// ==================================================

function makeRelativeResolver(workDir) {
    const roots = new Set([toPosix(workDir)]);

    try {
        roots.add(toPosix(fs.realpathSync(workDir)));
    } catch {
        // Use the original path.
    }

    return function toRelative(absoluteLike) {
        const value = toPosix(absoluteLike)
            .replace(/^file:\/\/\/?/, "/");

        for (const root of roots) {
            const normalizedRoot = root.replace(/\/+$/, "");

            if (
                value.toLowerCase().startsWith(
                    `${normalizedRoot.toLowerCase()}/`
                )
            ) {
                const relative = value.slice(
                    normalizedRoot.length + 1
                );

                if (relative.startsWith("node_modules/")) {
                    return null;
                }

                return normalizeRelative(relative);
            }
        }

        return null;
    };
}

function extractIssuesFromOutput(
    output,
    workDir,
    files,
    entry
) {
    const text = toPosix(output || "");
    const toRelative = makeRelativeResolver(workDir);
    const issues = [];

    // CommonJS missing modules
    for (const match of text.matchAll(
        /Cannot find module '([^']+)'(?:\s*\nRequire stack:\n((?:\s*- .*\n?)+))?/g
    )) {
        const spec = match[1];

        let requirer = null;

        if (match[2]) {
            const first = match[2]
                .split("\n")
                .map(line => line.replace(/^\s*-\s*/, "").trim())
                .find(Boolean);

            requirer = first ? toRelative(first) : null;
        }

        if (
            spec.startsWith(".") ||
            spec.startsWith("/") ||
            /^[A-Za-z]:\//.test(spec)
        ) {
            let wanted = null;

            if (spec.startsWith(".")) {
                const base = requirer
                    ? dirnameOf(requirer)
                    : "";

                wanted = resolveModuleFile(
                    files,
                    base,
                    spec
                ).wanted;
            } else {
                const relative = toRelative(spec);

                wanted = relative
                    ? (
                        /\.[a-z0-9]+$/i.test(relative)
                            ? relative
                            : `${relative}.js`
                    )
                    : null;
            }

            if (wanted) {
                issues.push(makeIssue(
                    "missing_file",
                    wanted,
                    `Startup failed: Cannot find module '${spec}'. Create ${wanted}.`,
                    {
                        requiredBy: requirer || undefined
                    }
                ));
            }
        } else {
            const name = packageNameOf(spec);

            issues.push(makeIssue(
                "missing_dependency",
                "package.json",
                `Startup failed: Cannot find module '${name}'. Add "${name}" to package.json dependencies.`,
                {
                    requiredBy: requirer || undefined,
                    packageName: name
                }
            ));
        }
    }

    // ESM missing modules
    for (const match of text.matchAll(
        /Cannot find (module|package) '([^']+)' imported from ([^\s\n]+)/g
    )) {
        const spec = match[2];
        const requirer = toRelative(match[3]);

        if (match[1] === "package") {
            issues.push(makeIssue(
                "missing_dependency",
                "package.json",
                `Startup failed: Cannot find package '${spec}'. Add it to package.json dependencies.`,
                {
                    requiredBy: requirer || undefined,
                    packageName: spec
                }
            ));

            continue;
        }

        const relative = toRelative(spec);

        if (relative) {
            issues.push(makeIssue(
                "missing_file",
                relative,
                `Startup failed: Cannot find module '${spec}'. Create ${relative}.`,
                {
                    requiredBy: requirer || undefined
                }
            ));
        }
    }

    // ENOENT
    for (const match of text.matchAll(
        /ENOENT[^\n]*?(?:open|stat|scandir|readFile|access)?\s*'([^']+)'/g
    )) {
        const relative = toRelative(match[1]);

        if (
            relative &&
            /\.[a-z0-9]+$/i.test(path.posix.basename(relative)) &&
            !files.has(relative)
        ) {
            issues.push(makeIssue(
                "missing_file",
                relative,
                `Startup failed: ${relative} does not exist. Create it.`
            ));
        }
    }

    // JavaScript stack frames
    const fatalMarker = text.search(
        /(SyntaxError|ReferenceError|TypeError|RangeError|Error:)/
    );

    if (fatalMarker !== -1 && issues.length === 0) {
        const candidates = [];

        for (const match of text.matchAll(
            /(?:^|\n)\s*(?:at\s+(?:.*?\()?|file:\/\/)?((?:[A-Za-z]:)?\/[^\s():]+\.(?:c|m)?js):(\d+)(?::(\d+))?/g
        )) {
            const relative = toRelative(match[1]);

            if (relative && files.has(relative)) {
                candidates.push({
                    relative,
                    line: Number(match[2])
                });
            }
        }

        if (candidates.length > 0) {
            const first = candidates[0];

            issues.push(makeIssue(
                "runtime_error",
                first.relative,
                `The application crashed in ${first.relative}:${first.line}. Fix the startup error.`
            ));
        }
    }

    // Python traceback
    for (const match of text.matchAll(
        /File "([^"]+\.py)", line (\d+)/g
    )) {
        const relative = toRelative(match[1]);

        if (relative && files.has(relative)) {
            issues.push(makeIssue(
                "runtime_error",
                relative,
                `Python raised an error in ${relative} at line ${match[2]}.`
            ));
        }
    }

    // Generic fallback
    if (
        issues.length === 0 &&
        FATAL_OUTPUT_PATTERN.test(text)
    ) {
        const fallback = entry && files.has(entry)
            ? entry
            : "package.json";

        issues.push(makeIssue(
            "runtime_error",
            fallback,
            `The application failed to start. Fix ${fallback} or the code it loads.`
        ));
    }

    return dedupeIssues(issues);
}

function issuesFromNpmFailure(output) {
    const text = String(output || "");

    const codeMatch = text.match(
        /npm (?:error|ERR!) code (E[A-Z0-9_]+)/
    );

    const code = codeMatch ? codeMatch[1] : null;

    if (
        !code ||
        !REPAIRABLE_NPM_CODES.has(code)
    ) {
        return {
            repairable: false,
            code,
            issues: []
        };
    }

    const packageMatch =
        text.match(
            /(?:404|notarget)[^\n]*?['"]?((?:@[\w.-]+\/)?[\w.-]+)@?([^\s'"\n]*)/i
        ) ||
        text.match(
            /No matching version found for ((?:@[\w.-]+\/)?[\w.-]+)@([^\s.\n]+)/i
        );

    const name = packageMatch
        ? packageMatch[1]
        : null;

    const detail = text
        .split("\n")
        .filter(line => /npm (?:error|ERR!)/.test(line))
        .map(line =>
            line.replace(/^npm (?:error|ERR!)\s*/, "").trim()
        )
        .filter(Boolean)
        .slice(0, 6)
        .join(" | ");

    return {
        repairable: true,
        code,
        issues: [
            makeIssue(
                "install_failed",
                "package.json",
                `npm install failed (${code}). ${detail} ${name ? `The package "${name}" may not exist or its version is invalid. ` : ""}Use real published packages and valid version ranges.`,
                {
                    packageName: name || undefined
                }
            )
        ]
    };
}


// ==================================================
// WORK DIRECTORY
// ==================================================

function materialize(files) {
    const workDir = fs.mkdtempSync(
        path.join(
            os.tmpdir(),
            `devteam-run-${randomUUID().slice(0, 8)}-`
        )
    );

    try {
        for (const [relativePath, content] of files) {
            const normalized = normalizeRelative(relativePath);

            if (!normalized) {
                throw new Error(
                    `Unsafe file path: ${relativePath}`
                );
            }

            const destination = path.resolve(
                workDir,
                ...normalized.split("/")
            );

            if (
                destination !== workDir &&
                !destination.startsWith(workDir + path.sep)
            ) {
                throw new Error(
                    `Unsafe file path: ${relativePath}`
                );
            }

            fs.mkdirSync(
                path.dirname(destination),
                { recursive: true }
            );

            fs.writeFileSync(
                destination,
                content,
                "utf8"
            );
        }

        return workDir;
    } catch (error) {
        removeWorkDir(workDir);
        throw error;
    }
}

function removeWorkDir(workDir) {
    if (!workDir) return;

    try {
        fs.rmSync(workDir, {
            recursive: true,
            force: true,
            maxRetries: 3
        });
    } catch {
        // Best-effort cleanup.
    }
}

function hasInstallableDependencies(pkg) {
    const value = pkg?.value;

    if (!value) return false;

    return (
        Object.keys(value.dependencies || {}).length > 0 ||
        Object.keys(value.devDependencies || {}).length > 0 ||
        Object.keys(value.optionalDependencies || {}).length > 0
    );
}


// ==================================================
// PYTHON VERIFICATION
// ==================================================

async function verifyPython({
    files,
    workDir,
    steps,
    waitMs
}) {
    const python = IS_WINDOWS
        ? "python"
        : "python3";

    const env = buildRuntimeEnv(
        {
            PYTHONDONTWRITEBYTECODE: "1"
        },
        workDir
    );

    const pyFiles = [...files.keys()].filter(name =>
        name.endsWith(".py")
    );

    const issues = [];

    // Python syntax checks
    for (const file of pyFiles) {
        const result = await runProcess({
            command: python,
            args: ["-m", "py_compile", file],
            cwd: workDir,
            env,
            timeoutMs: 30000,
            networkIsolation: true
        });

        if (result.outcome === "unsupported") {
            steps.push({
                name: "python-syntax",
                status: "unsupported",
                error: result.spawnError
            });

            return {
                status: "unsupported",
                issues: []
            };
        }

        if (result.spawnError) {
            steps.push({
                name: "python-syntax",
                status: "error",
                error: result.spawnError
            });

            return {
                status: "error",
                issues: []
            };
        }

        if (result.code !== 0) {
            issues.push(makeIssue(
                "runtime_error",
                file,
                `Python syntax error in ${file}: ${tail(result.stderr, 800)}`
            ));
        }
    }

    steps.push({
        name: "python-syntax",
        status: issues.length === 0 ? "passed" : "failed",
        checked: pyFiles.length
    });

    if (issues.length > 0) {
        return {
            status: "failed",
            issues: dedupeIssues(issues)
        };
    }

    const entry = [
        "main.py",
        "app.py",
        "manage.py"
    ].find(name => files.has(name));

    if (!entry) {
        return {
            status: "unsupported",
            issues: [],
            summary: "Python files passed syntax checks, but no supported application entry point was found."
        };
    }

    let pythonCommand = python;

    if (files.has("requirements.txt")) {
        const venv = await runProcess({
            command: python,
            args: ["-m", "venv", ".venv"],
            cwd: workDir,
            env,
            timeoutMs: 120000,
            networkIsolation: true
        });

        if (venv.outcome === "unsupported") {
            return {
                status: "unsupported",
                issues: []
            };
        }

        if (venv.code !== 0) {
            steps.push({
                name: "python-venv",
                status: "failed",
                error: tail(venv.stderr || venv.spawnError, 1500)
            });

            return {
                status: "error",
                issues: []
            };
        }

        pythonCommand = IS_WINDOWS
            ? path.join(workDir, ".venv", "Scripts", "python.exe")
            : path.join(workDir, ".venv", "bin", "python");

        const install = await runProcess({
            command: pythonCommand,
            args: [
                "-m",
                "pip",
                "install",
                "--only-binary=:all:",
                "-r",
                "requirements.txt",
                "--disable-pip-version-check",
                "-q"
            ],
            cwd: workDir,
            env,
            timeoutMs: INSTALL_TIMEOUT_MS,
            networkIsolation: false
        });

        steps.push({
            name: "pip-install",
            status: install.code === 0 ? "passed" : "failed",
            exitCode: install.code,
            stderr: tail(install.stderr, 3000)
        });

        if (install.outcome === "unsupported") {
            return {
                status: "unsupported",
                issues: []
            };
        }

        if (install.code !== 0) {
            return {
                status: "failed",
                issues: [
                    makeIssue(
                        "install_failed",
                        "requirements.txt",
                        `pip install failed: ${tail(install.stderr, 1200)}`
                    )
                ]
            };
        }
    }

    const port = await findFreePort();

    const probe = await startAndProbe({
        command: pythonCommand,
        args:
            entry === "manage.py"
                ? [entry, "runserver", `127.0.0.1:${port}`]
                : [entry],
        cwd: workDir,
        env: buildRuntimeEnv(
            {
                PORT: String(port),
                PYTHONDONTWRITEBYTECODE: "1"
            },
            workDir
        ),
        port,
        waitMs
    });

    steps.push({
        name: "python-start",
        status:
            probe.outcome === "listening" ||
            (probe.outcome === "exited" && probe.exitCode === 0)
                ? "passed"
                : probe.outcome === "unsupported"
                    ? "unsupported"
                    : "failed",
        outcome: probe.outcome,
        exitCode: probe.exitCode,
        port: probe.listening?.port || null,
        httpStatus: probe.listening?.response?.status || null,
        stdout: tail(probe.stdout, 3000),
        stderr: tail(probe.stderr, 3000)
    });

    if (probe.outcome === "unsupported") {
        return {
            status: "unsupported",
            issues: [],
            isolation: probe.isolation || null
        };
    }

    if (probe.spawnError) {
        return {
            status: "error",
            issues: []
        };
    }

    const output = `${probe.stdout}\n${probe.stderr}`;

    if (
        probe.outcome === "exited" &&
        probe.exitCode !== 0
    ) {
        const found = extractIssuesFromOutput(
            output,
            workDir,
            files,
            entry
        );

        return {
            status: "failed",
            issues: found.length > 0
                ? found
                : [
                    makeIssue(
                        "runtime_error",
                        entry,
                        `Python application exited with code ${probe.exitCode}: ${tail(output, 1500)}`
                    )
                ]
        };
    }

    if (probe.outcome === "listening") {
        const assetIssues = Array.isArray(probe.assetIssues)
            ? probe.assetIssues
            : [];

        if (assetIssues.length > 0) {
            return {
                status: "failed",
                issues: assetIssues,
                isolation: probe.isolation || null
            };
        }

        return {
            status: "passed",
            issues: [],
            url: probe.url || null,
            isolation: probe.isolation || null
        };
    }

    if (
        probe.outcome === "exited" &&
        probe.exitCode === 0
    ) {
        return {
            status: "passed",
            issues: [],
            isolation: probe.isolation || null
        };
    }

    if (FATAL_OUTPUT_PATTERN.test(output)) {
        const found = extractIssuesFromOutput(
            output,
            workDir,
            files,
            entry
        );

        return {
            status: "failed",
            issues: found.length > 0
                ? found
                : [
                    makeIssue(
                        "runtime_error",
                        entry,
                        `Python application failed: ${tail(output, 1500)}`
                    )
                ]
        };
    }

    return {
        status: "unsupported",
        issues: [],
        isolation: probe.isolation || null
    };
}


// ==================================================
// MAIN ENTRY POINT
// ==================================================

async function verifyRuntime({
    files,
    startWaitMs = START_WAIT_MS,
    skipInstall = false
}) {
    if (!(files instanceof Map) || files.size === 0) {
        return {
            status: "error",
            summary: "No files supplied to the runtime verifier.",
            steps: [],
            issues: []
        };
    }

    const project = detectProject(files);
    const steps = [];

    if (project.type === "unknown") {
        return {
            status: "unsupported",
            summary: "No runnable project type detected.",
            steps,
            issues: []
        };
    }

    // --------------------------------------------------
    // 1. STATIC COMPLETENESS
    // --------------------------------------------------

    const staticIssues = analyzeStatic(files, project);

    steps.push({
        name: "static-completeness",
        status: staticIssues.length === 0 ? "passed" : "failed",
        issues: staticIssues.length
    });

    if (staticIssues.length > 0) {
        return {
            status: "failed",
            projectType: project.type,
            summary:
                `Static check found ${staticIssues.length} problem(s) that would stop the project from running.`,
            steps,
            issues: staticIssues,
            stderr: staticIssues.map(issue => issue.message).join("\n")
        };
    }

    // Static-only projects are NOT runtime verified.
    if (project.type === "static") {
        steps.push({
            name: "static-site",
            status: "passed",
            note: "Static files and references were checked, but browser execution was not performed."
        });

        return {
            status: "unsupported",
            projectType: "static",
            summary:
                "Static checks passed, but browser execution is not configured. Runtime verification is not complete.",
            steps,
            issues: [],
            executionIsolation: {
                network: "not_applicable",
                filesystem: "not_isolated",
                securityBoundary: false
            }
        };
    }

    let workDir;

    try {
        workDir = materialize(files);
    } catch (error) {
        return {
            status: "error",
            summary: `Could not prepare a work directory: ${error.message}`,
            steps,
            issues: []
        };
    }

    try {
        // --------------------------------------------------
        // PYTHON PROJECT
        // --------------------------------------------------

        if (project.type === "python") {
            const result = await verifyPython({
                files,
                workDir,
                steps,
                waitMs: startWaitMs
            });

            return {
                status: result.status,
                projectType: "python",
                summary:
                    result.status === "passed"
                        ? "Python application executed successfully."
                        : result.status === "unsupported"
                            ? "Python runtime verification is unsupported in this environment or the project has no verifiable entry point."
                            : "Python project did not pass runtime verification.",
                steps,
                issues: result.issues || [],
                stderr: (result.issues || [])
                    .map(issue => issue.message)
                    .join("\n"),
                isolation: result.isolation || {
                    network: "isolated",
                    filesystem: "not_isolated",
                    securityBoundary: false
                }
            };
        }

        // --------------------------------------------------
        // 2. NODE DEPENDENCY INSTALL
        // --------------------------------------------------

        const env = buildRuntimeEnv({}, workDir);

        if (
            !skipInstall &&
            project.pkg.exists &&
            hasInstallableDependencies(project.pkg)
        ) {
            const install = await runProcess({
                command: "npm",
                args: [
                    "install",
                    "--ignore-scripts",
                    "--no-audit",
                    "--no-fund",
                    "--no-progress",
                    "--loglevel=error"
                ],
                cwd: workDir,
                env,
                timeoutMs: INSTALL_TIMEOUT_MS,
                networkIsolation: false
            });

            const installOutput =
                `${install.stderr}\n${install.stdout}`;

            steps.push({
                name: "npm-install",
                status:
                    install.code === 0
                        ? "passed"
                        : install.outcome === "unsupported"
                            ? "unsupported"
                            : "failed",
                exitCode: install.code,
                stdout: tail(install.stdout, 3000),
                stderr: tail(install.stderr, 3000)
            });

            if (install.outcome === "unsupported") {
                return {
                    status: "unsupported",
                    projectType: "node",
                    summary: "Restricted dependency installation is unavailable.",
                    steps,
                    issues: [],
                    isolation: {
                        network: "not_isolated_for_install",
                        filesystem: "not_isolated",
                        securityBoundary: false
                    }
                };
            }

            if (install.spawnError || install.timedOut) {
                return {
                    status: "error",
                    projectType: "node",
                    summary: install.timedOut
                        ? "npm install timed out."
                        : `Could not run npm: ${install.spawnError}`,
                    steps,
                    issues: []
                };
            }

            if (install.code !== 0) {
                const diagnosis = issuesFromNpmFailure(
                    installOutput
                );

                if (!diagnosis.repairable) {
                    return {
                        status: "error",
                        projectType: "node",
                        summary:
                            "npm install failed for a reason that cannot be repaired automatically: " +
                            tail(installOutput, 600),
                        steps,
                        issues: [],
                        stderr: tail(installOutput)
                    };
                }

                return {
                    status: "failed",
                    projectType: "node",
                    summary: `npm install failed (${diagnosis.code}).`,
                    steps,
                    issues: diagnosis.issues,
                    stderr: tail(installOutput)
                };
            }
        }

        // --------------------------------------------------
        // 3. NODE APPLICATION STARTUP
        // --------------------------------------------------

        const start = pickNodeStart(files, project.pkg);

        if (!start) {
            const issue = makeIssue(
                "no_start",
                "package.json",
                'No application start command was found. Add a "start" script and make sure its entry file exists.'
            );

            steps.push({
                name: "start",
                status: "failed",
                issues: 1
            });

            return {
                status: "failed",
                projectType: "node",
                summary: "No start command could be determined.",
                steps,
                issues: [issue],
                stderr: issue.message
            };
        }

        const port = await findFreePort();

        let probe = await startAndProbe({
            command: start.command,
            args: start.args,
            cwd: workDir,
            env: buildRuntimeEnv(
                {
                    PORT: String(port)
                },
                workDir
            ),
            port,
            waitMs: startWaitMs
        });

        // Retry once if the selected port is busy.
        if (
            probe.outcome === "exited" &&
            /EADDRINUSE/.test(
                `${probe.stdout}\n${probe.stderr}`
            )
        ) {
            const retryPort = await findFreePort();

            probe = await startAndProbe({
                command: start.command,
                args: start.args,
                cwd: workDir,
                env: buildRuntimeEnv(
                    {
                        PORT: String(retryPort)
                    },
                    workDir
                ),
                port: retryPort,
                waitMs: startWaitMs
            });
        }

        const output =
            `${probe.stderr}\n${probe.stdout}`;

        const startStepStatus =
            probe.outcome === "listening" ||
            (probe.outcome === "exited" && probe.exitCode === 0)
                ? "passed"
                : probe.outcome === "unsupported"
                    ? "unsupported"
                    : "failed";

        steps.push({
            name: `start (${start.label})`,
            status: startStepStatus,
            outcome: probe.outcome,
            exitCode: probe.exitCode,
            port: probe.listening?.port || null,
            httpStatus: probe.listening?.response?.status || null,
            stdout: tail(probe.stdout, 3000),
            stderr: tail(probe.stderr, 3000)
        });

        // Restricted execution unavailable.
        if (probe.outcome === "unsupported") {
            return {
                status: "unsupported",
                projectType: "node",
                summary:
                    "Restricted runtime execution is unavailable in this environment.",
                steps,
                issues: [],
                isolation: probe.isolation || null
            };
        }

        if (probe.spawnError) {
            return {
                status: "error",
                projectType: "node",
                summary:
                    `Could not start the application: ${probe.spawnError}`,
                steps,
                issues: [],
                isolation: probe.isolation || null
            };
        }

        // Startup timeout.
        if (probe.outcome === "timeout") {
            return {
                status: "failed",
                projectType: "node",
                summary: "The application did not finish startup within the allowed time.",
                steps,
                issues: [
                    makeIssue(
                        "runtime_timeout",
                        start.entry || "package.json",
                        "The application exceeded the startup time limit. Fix startup logic so it becomes available within the allowed time."
                    )
                ],
                stdout: probe.stdout,
                stderr: probe.stderr,
                isolation: probe.isolation || null
            };
        }

        // Application crashed.
        if (
            probe.outcome === "exited" &&
            probe.exitCode !== 0
        ) {
            const issues = extractIssuesFromOutput(
                output,
                workDir,
                files,
                start.entry
            );

            const fallback = issues.length > 0
                ? issues
                : [
                    makeIssue(
                        "runtime_error",
                        start.entry && files.has(start.entry)
                            ? start.entry
                            : "package.json",
                        `The application exited with code ${probe.exitCode}. Output: ${tail(output, 1800)}`
                    )
                ];

            return {
                status: "failed",
                projectType: "node",
                summary:
                    `The application crashed on startup (exit code ${probe.exitCode}).`,
                steps,
                issues: fallback,
                stdout: probe.stdout,
                stderr: tail(output),
                isolation: probe.isolation || null
            };
        }

        // CLI / script-style project completed successfully.
        if (
            probe.outcome === "exited" &&
            probe.exitCode === 0
        ) {
            return {
                status: "passed",
                projectType: "node",
                summary:
                    "The application script executed and exited successfully.",
                steps,
                issues: [],
                stdout: probe.stdout,
                stderr: probe.stderr,
                isolation: probe.isolation || null
            };
        }

        // HTTP application must actually respond.
        if (probe.outcome === "listening") {
            const assetIssues = Array.isArray(probe.assetIssues)
                ? probe.assetIssues
                : [];

            steps.push({
                name: "http-assets",
                status:
                    assetIssues.length === 0
                        ? "passed"
                        : "failed",
                homeStatus:
                    probe.listening?.response?.status || null,
                issues: assetIssues.length
            });

            if (assetIssues.length > 0) {
                return {
                    status: "failed",
                    projectType: "node",
                    summary:
                        "The server runs, but referenced assets could not be verified.",
                    steps,
                    issues: assetIssues,
                    stderr: assetIssues
                        .map(issue => issue.message)
                        .join("\n"),
                    isolation: probe.isolation || null
                };
            }

            return {
                status: "passed",
                projectType: "node",
                summary:
                    "The application started, responded to HTTP, and referenced assets were verified.",
                steps,
                issues: [],
                stdout: probe.stdout,
                stderr: probe.stderr,
                url:
                    probe.url ||
                    `http://localhost:${probe.listening?.port || port}`,
                isolation: probe.isolation || null
            };
        }

        // Alive but no verifiable HTTP endpoint.
        const fatalInOutput =
            FATAL_OUTPUT_PATTERN.test(output);

        if (fatalInOutput) {
            const issues = extractIssuesFromOutput(
                output,
                workDir,
                files,
                start.entry
            );

            if (issues.length > 0) {
                return {
                    status: "failed",
                    projectType: "node",
                    summary:
                        "The application printed fatal errors while running.",
                    steps,
                    issues,
                    stderr: tail(output),
                    isolation: probe.isolation || null
                };
            }
        }

        return {
            status: "unsupported",
            projectType: "node",
            summary:
                "The application remained alive but did not expose a verifiable HTTP endpoint.",
            steps,
            issues: [],
            stdout: probe.stdout,
            stderr: probe.stderr,
            isolation: probe.isolation || null
        };

    } finally {
        removeWorkDir(workDir);
    }
}


// ==================================================
// EXPORTS
// ==================================================

module.exports = {
    verifyRuntime,
    analyzeStatic,
    detectProject,
    extractIssuesFromOutput,
    issuesFromNpmFailure,
    buildRuntimeEnv
};
