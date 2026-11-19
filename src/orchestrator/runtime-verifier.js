"use strict";

/**
 * Runtime verifier.
 *
 * Answers one question about a generated project: "does it actually run?"
 *
 *   1. Static completeness check (no network, no execution):
 *        - every relative require()/import resolves to a real file
 *        - every local <script>/<link>/<img> in HTML exists
 *        - package.json is valid, `main` / `start` targets exist
 *        - every bare import is declared as a dependency
 *   2. npm install (only when the project declares dependencies)
 *   3. Start the app, wait for it to listen / stay alive, probe it over HTTP
 *      and make sure the assets its home page references are really served.
 *
 * Every failure is converted into structured "issues" that point at the
 * file that must be created or fixed ({ kind, targetPath, message }). The
 * repair engine uses those to drive the agents until the project runs.
 *
 * The generated code is executed in a throw-away temp directory with
 * secrets (API keys, tokens ...) removed from the environment.
 */

const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const http = require("node:http");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { builtinModules } = require("node:module");

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


// --------------------------------------------------
// SMALL HELPERS
// --------------------------------------------------

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
    return { kind, targetPath, message, ...extra };
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

function buildRuntimeEnv(extra = {}) {
    const env = {};

    for (const [key, value] of Object.entries(process.env)) {
        // Never expose provider keys or other secrets to generated code.
        if (/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PASSPHRASE)/i.test(key)) {
            continue;
        }

        if (/^npm_config_offline$/i.test(key)) continue;

        env[key] = value;
    }

    env.NODE_ENV = "development";
    env.BROWSER = "none";
    env.CI = "true";
    env.NO_COLOR = "1";
    env.FORCE_COLOR = "0";
    env.npm_config_update_notifier = "false";

    return { ...env, ...extra };
}

function findFreePort() {
    return new Promise(resolve => {
        const server = net.createServer();

        server.unref();
        server.on("error", () => resolve(0));

        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

function killTree(child) {
    if (!child || child.exitCode !== null || !child.pid) return;

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


// --------------------------------------------------
// PROJECT DETECTION
// --------------------------------------------------

function readJson(files, name) {
    const entry = files.get(name);
    if (!entry) return { exists: false, value: null, error: null };

    try {
        return {
            exists: true,
            value: JSON.parse(entry),
            error: null
        };
    } catch (error) {
        return { exists: true, value: null, error: error.message };
    }
}

function detectProject(files) {
    const pkg = readJson(files, "package.json");

    if (pkg.exists) return { type: "node", pkg };

    const hasPython =
        files.has("requirements.txt") ||
        files.has("pyproject.toml") ||
        [...files.keys()].some(name => name.endsWith(".py"));

    if (hasPython) return { type: "python", pkg };

    const hasHtml = [...files.keys()].some(name => /\.html?$/i.test(name));

    if (hasHtml) return { type: "static", pkg };

    const hasLooseNode = [...files.keys()].some(
        name => /\.(js|mjs|cjs)$/i.test(name)
    );

    if (hasLooseNode) return { type: "node", pkg };

    return { type: "unknown", pkg };
}

function pickNodeStart(files, pkg) {
    const scripts = pkg?.value?.scripts || {};

    if (typeof scripts.start === "string" && scripts.start.trim()) {
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

function guessScriptEntry(script, files) {
    const match = String(script).match(
        /(?:^|\s)(?:node|nodemon|ts-node|tsx)\s+(?:--?[\w-]+(?:=\S+)?\s+)*([^\s&|;]+\.(?:c|m)?[jt]s)/
    );

    if (match) {
        const normalized = normalizeRelative(match[1]);
        if (normalized) return normalized;
    }

    return ENTRY_CANDIDATES.find(candidate => files.has(candidate)) || null;
}


// --------------------------------------------------
// STATIC COMPLETENESS CHECK
// --------------------------------------------------

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

    if (!base) return { found: null, wanted: null };

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

    const found = candidates.find(candidate => files.has(candidate));

    const hasExtension = /\.[a-z0-9]+$/i.test(path.posix.basename(base));

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
        const manifestPath = dir ? `${dir}/package.json` : "package.json";
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

    return { manifestPath: "package.json", names: null };
}

function isLocalReference(ref) {
    const value = String(ref || "").trim();

    return (
        value &&
        !value.startsWith("#") &&
        !value.startsWith("//") &&
        !/^[a-z][a-z0-9+.-]*:/i.test(value) &&
        !value.includes("{{") &&
        !value.includes("${") &&
        !value.includes("<%")
    );
}

function resolveHtmlReference(files, htmlPath, ref) {
    const clean = decodeUriSafe(String(ref).split(/[?#]/)[0]);

    if (!clean) return { found: true, wanted: null };

    const htmlDir = dirnameOf(htmlPath);

    if (clean.startsWith("/")) {
        const rootRelative = clean.replace(/^\/+/, "");
        const roots = new Set(WEB_ROOT_DIRS);

        if (htmlDir) roots.add(htmlDir);

        for (const root of roots) {
            const candidate = joinRelative(root, rootRelative);
            if (candidate && files.has(candidate)) {
                return { found: true, wanted: candidate };
            }
        }

        const wanted = joinRelative(htmlDir, rootRelative);

        return { found: false, wanted };
    }

    const candidate = joinRelative(htmlDir, clean);

    return {
        found: Boolean(candidate && files.has(candidate)),
        wanted: candidate
    };
}

function decodeUriSafe(value) {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function extractHtmlReferences(html) {
    const refs = [];

    const tagPattern =
        /<(script|link|img|source|video|audio)\b[^>]*>/gi;

    for (const tag of String(html).matchAll(tagPattern)) {
        const element = tag[1].toLowerCase();
        const attribute = element === "link" ? "href" : "src";

        const match = tag[0].match(
            new RegExp(`\\b${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i")
        );

        const value = match ? (match[1] ?? match[2]) : null;

        if (isLocalReference(value)) {
            refs.push({ element, ref: value });
        }
    }

    return refs;
}

function analyzeStatic(files, project) {
    const issues = [];

    // ---- package.json ------------------------------------------------
    const pkg = project.pkg;

    if (pkg?.exists && pkg.error) {
        issues.push(makeIssue(
            "invalid_json",
            "package.json",
            `package.json is not valid JSON (${pkg.error}). ` +
            `Return a complete, valid package.json.`
        ));
    }

    if (pkg?.value) {
        const value = pkg.value;

        if (typeof value.main === "string") {
            const main = normalizeRelative(value.main);

            if (main && !files.has(main) && !files.has(`${main}.js`)) {
                issues.push(makeIssue(
                    "missing_file",
                    main,
                    `package.json "main" points to ${main}, which does not exist. ` +
                    `Create ${main} as the working entry point of the application.`,
                    { requiredBy: "package.json" }
                ));
            }
        }

        const startScript = value.scripts?.start;

        if (typeof startScript === "string") {
            const entry = guessScriptEntry(startScript, files);
            const direct = startScript.match(
                /(?:^|\s)(?:node|nodemon)\s+(?:--?[\w-]+(?:=\S+)?\s+)*([^\s&|;]+\.(?:c|m)?js)/
            );

            if (direct) {
                const wanted = normalizeRelative(direct[1]);

                if (wanted && !files.has(wanted)) {
                    issues.push(makeIssue(
                        "missing_file",
                        wanted,
                        `The "start" script runs ${wanted}, which does not exist. ` +
                        `Create ${wanted} as the working entry point of the application.`,
                        { requiredBy: "package.json" }
                    ));
                }
            }

            void entry;
        } else if (!value.main && !pickNodeStart(files, pkg)) {
            issues.push(makeIssue(
                "no_start",
                "package.json",
                `package.json has no "start" script, no "main" and no ` +
                `recognizable entry file. Add a "start" script that launches ` +
                `the application (for example "node server.js") and make sure ` +
                `the entry file exists.`
            ));
        }
    }

    // ---- JavaScript modules -----------------------------------------
    for (const [filePath, content] of files) {
        if (!/\.(js|mjs|cjs)$/i.test(filePath)) continue;

        const baseDir = dirnameOf(filePath);
        const dependencyInfo = nearestDependencies(files, filePath);

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
                        `${filePath} imports "${spec}" but ${wanted} does not ` +
                        `exist. Create ${wanted} with a complete working ` +
                        `implementation that matches how ${filePath} uses it.`,
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

            // Browser files may legitimately use bare specifiers via import maps.
            if (/(^|\/)(public|static|client|www)\//.test(filePath)) continue;

            if (
                dependencyInfo.names &&
                !dependencyInfo.names.has(name)
            ) {
                issues.push(makeIssue(
                    "missing_dependency",
                    dependencyInfo.manifestPath,
                    `${filePath} requires the package "${name}" but it is not ` +
                    `listed in ${dependencyInfo.manifestPath}. Add "${name}" to ` +
                    `"dependencies" with a real, published version range ` +
                    `and return the complete package.json.`,
                    { requiredBy: filePath, packageName: name }
                ));
            } else if (!dependencyInfo.names && project.type === "node") {
                issues.push(makeIssue(
                    "missing_dependency",
                    "package.json",
                    `${filePath} requires the package "${name}" but the project ` +
                    `has no package.json. Create a complete package.json that ` +
                    `declares "${name}" and a "start" script.`,
                    { requiredBy: filePath, packageName: name }
                ));
            }
        }
    }

    // ---- Other JSON files -------------------------------------------
    for (const [filePath, content] of files) {
        if (!/\.json$/i.test(filePath) || filePath === "package.json") {
            continue;
        }

        if (/(^|\/)(tsconfig|jsconfig)[^/]*\.json$/i.test(filePath)) continue;

        try {
            JSON.parse(content);
        } catch (error) {
            issues.push(makeIssue(
                "invalid_json",
                filePath,
                `${filePath} is not valid JSON (${error.message}). ` +
                `Return the complete, valid file.`
            ));
        }
    }

    // ---- HTML references --------------------------------------------
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
                `${filePath} references ${ref} (<${element}>) but ${wanted} ` +
                `does not exist. Create ${wanted} with a complete working ` +
                `implementation that matches how ${filePath} uses it.`,
                { requiredBy: filePath }
            ));
        }
    }

    return dedupeIssues(issues);
}


// --------------------------------------------------
// PROCESS EXECUTION
// --------------------------------------------------

function spawnOptions(cwd, env, detached) {
    return {
        cwd,
        env,
        detached,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        // npm is a .cmd shim on Windows. Arguments here are fixed, never
        // user supplied, so using a shell is safe for that platform only.
        shell: IS_WINDOWS
    };
}

function runProcess({ command, args, cwd, env, timeoutMs }) {
    return new Promise(resolve => {
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let settled = false;
        let child;

        function finish(result) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);

            resolve({
                stdout: tail(stdout),
                stderr: tail(stderr),
                timedOut,
                ...result
            });
        }

        try {
            child = spawn(
                command,
                args,
                spawnOptions(cwd, env, !IS_WINDOWS)
            );
        } catch (error) {
            resolve({
                code: null,
                stdout: "",
                stderr: "",
                timedOut: false,
                spawnError: error.message
            });
            return;
        }

        const timer = setTimeout(() => {
            timedOut = true;
            killTree(child);
        }, timeoutMs);

        child.stdout.on("data", chunk => {
            stdout = tail(stdout + chunk.toString("utf8"), 200000);
        });

        child.stderr.on("data", chunk => {
            stderr = tail(stderr + chunk.toString("utf8"), 200000);
        });

        child.on("error", error => {
            finish({ code: null, spawnError: error.message });
        });

        child.on("close", (code, signal) => {
            finish({ code, signal });
        });
    });
}

function httpProbe(port, urlPath = "/", timeoutMs = 2500) {
    return new Promise(resolve => {
        const request = http.request(
            {
                host: "localhost",
                port,
                path: urlPath,
                method: "GET",
                timeout: timeoutMs,
                headers: { Accept: "text/html,*/*" }
            },
            response => {
                const chunks = [];
                let size = 0;

                response.on("data", chunk => {
                    size += chunk.length;
                    if (size <= 512 * 1024) chunks.push(chunk);
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
            resolve({ ok: false, error: "timeout" });
        });

        request.on("error", error => {
            resolve({ ok: false, error: error.code || error.message });
        });

        request.end();
    });
}

function tcpProbe(port, timeoutMs = 1000) {
    return new Promise(resolve => {
        const socket = net.connect({ host: "localhost", port });

        socket.setTimeout(timeoutMs);

        socket.on("connect", () => {
            socket.destroy();
            resolve(true);
        });

        socket.on("timeout", () => {
            socket.destroy();
            resolve(false);
        });

        socket.on("error", () => resolve(false));
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
            if (port >= 80 && port <= 65535) ports.add(port);
        }
    }

    return [...ports];
}

const FATAL_OUTPUT_PATTERN =
    /(Cannot find module|ERR_MODULE_NOT_FOUND|Cannot find package|SyntaxError|ReferenceError|TypeError|Unhandled|UnhandledPromiseRejection|ENOENT|EADDRINUSE|MODULE_NOT_FOUND|Error: listen|Traceback \(most recent call last\)|ModuleNotFoundError|ImportError)/;

async function startAndProbe({
    command,
    args,
    cwd,
    env,
    port,
    waitMs
}) {
    let stdout = "";
    let stderr = "";
    let exited = false;
    let exitCode = null;
    let spawnError = null;
    let child;

    try {
        child = spawn(command, args, spawnOptions(cwd, env, !IS_WINDOWS));
    } catch (error) {
        return {
            outcome: "spawn_error",
            spawnError: error.message,
            stdout: "",
            stderr: ""
        };
    }

    child.stdout.on("data", chunk => {
        stdout = tail(stdout + chunk.toString("utf8"), 200000);
    });

    child.stderr.on("data", chunk => {
        stderr = tail(stderr + chunk.toString("utf8"), 200000);
    });

    child.on("error", error => {
        spawnError = error.message;
        exited = true;
    });

    child.on("close", code => {
        exited = true;
        exitCode = code;
    });

    const deadline = Date.now() + waitMs;
    let listening = null;

    try {
        while (Date.now() < deadline && !exited) {
            const ports = [
                port,
                ...portsFromOutput(`${stdout}\n${stderr}`)
            ].filter(Boolean);

            for (const candidate of [...new Set(ports)]) {
                const response = await httpProbe(candidate, "/", 2000);

                if (response.ok) {
                    listening = { port: candidate, response };
                    break;
                }

                if (await tcpProbe(candidate, 800)) {
                    listening = { port: candidate, response: null };
                    break;
                }
            }

            if (listening) break;

            await sleep(500);
        }

        // Give a freshly started server a moment to crash after binding.
        if (listening && !exited) {
            await sleep(1200);
        }

        return {
            outcome: exited
                ? "exited"
                : listening
                    ? "listening"
                    : "alive",
            exitCode,
            spawnError,
            listening,
            stdout: tail(stdout),
            stderr: tail(stderr)
        };
    } finally {
        killTree(child);
    }
}


// --------------------------------------------------
// ERROR OUTPUT -> STRUCTURED ISSUES
// --------------------------------------------------

function makeRelativeResolver(workDir) {
    const roots = new Set([toPosix(workDir)]);

    try {
        roots.add(toPosix(fs.realpathSync(workDir)));
    } catch {
        // Ignore: use the plain path only.
    }

    return function toRelative(absoluteLike) {
        const value = toPosix(absoluteLike).replace(/^file:\/\/\/?/, "/");

        for (const root of roots) {
            const normalizedRoot = root.replace(/\/+$/, "");

            if (
                value.toLowerCase().startsWith(
                    `${normalizedRoot.toLowerCase()}/`
                )
            ) {
                const relative = value.slice(normalizedRoot.length + 1);

                if (relative.startsWith("node_modules/")) return null;

                return normalizeRelative(relative);
            }
        }

        return null;
    };
}

function extractIssuesFromOutput(output, workDir, files, entry) {
    const text = toPosix(output || "");
    const toRelative = makeRelativeResolver(workDir);
    const issues = [];

    // ---- Cannot find module (CommonJS) ------------------------------
    for (const match of text.matchAll(
        /Cannot find module '([^']+)'(?:\s*\nRequire stack:\n((?:\s*- .*\n?)+))?/g
    )) {
        const spec = match[1];

        let requirer = null;

        if (match[2]) {
            const first = match[2].split("\n").map(line =>
                line.replace(/^\s*-\s*/, "").trim()
            ).find(Boolean);

            requirer = first ? toRelative(first) : null;
        }

        if (spec.startsWith(".") || spec.startsWith("/") || /^[A-Za-z]:\//.test(spec)) {
            let wanted = null;

            if (spec.startsWith(".")) {
                const base = requirer ? dirnameOf(requirer) : "";
                wanted = resolveModuleFile(files, base, spec).wanted;
            } else {
                const relative = toRelative(spec);
                wanted = relative
                    ? (/\.[a-z0-9]+$/i.test(relative) ? relative : `${relative}.js`)
                    : null;
            }

            if (wanted) {
                issues.push(makeIssue(
                    "missing_file",
                    wanted,
                    `Startup failed: Cannot find module '${spec}'` +
                    `${requirer ? ` (required by ${requirer})` : ""}. ` +
                    `Create ${wanted} with a complete working implementation.`,
                    { requiredBy: requirer || undefined }
                ));
            }
        } else {
            const name = packageNameOf(spec);

            issues.push(makeIssue(
                "missing_dependency",
                "package.json",
                `Startup failed: Cannot find module '${name}'. Add "${name}" ` +
                `to "dependencies" in package.json with a real, published ` +
                `version range and return the complete package.json.`,
                { requiredBy: requirer || undefined, packageName: name }
            ));
        }
    }

    // ---- Cannot find module / package (ESM) -------------------------
    for (const match of text.matchAll(
        /Cannot find (module|package) '([^']+)' imported from ([^\s\n]+)/g
    )) {
        const spec = match[2];
        const requirer = toRelative(match[3]);

        if (match[1] === "package") {
            issues.push(makeIssue(
                "missing_dependency",
                "package.json",
                `Startup failed: Cannot find package '${spec}'. Add it to ` +
                `"dependencies" in package.json and return the complete file.`,
                { requiredBy: requirer || undefined, packageName: spec }
            ));
            continue;
        }

        const relative = toRelative(spec);

        if (relative) {
            issues.push(makeIssue(
                "missing_file",
                relative,
                `Startup failed: Cannot find module '${spec}'. Create ` +
                `${relative} with a complete working implementation.`,
                { requiredBy: requirer || undefined }
            ));
        }
    }

    // ---- ENOENT for a project file ----------------------------------
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
                `Startup failed: ENOENT, ${relative} does not exist. ` +
                `Create it with complete working content.`
            ));
        }
    }

    // ---- Stack frames / syntax errors in project files --------------
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
            const errorLine = text
                .split("\n")
                .find(line =>
                    /(Error|Exception)\b.*:/.test(line) ||
                    /^\w*Error\b/.test(line.trim())
                );

            issues.push(makeIssue(
                "runtime_error",
                first.relative,
                `The application crashed at startup in ${first.relative}` +
                `:${first.line}. ${errorLine ? `Error: ${errorLine.trim()}. ` : ""}` +
                `Fix the code so the application starts and keeps running.`
            ));
        }
    }

    // ---- Python tracebacks -------------------------------------------
    for (const match of text.matchAll(
        /File "([^"]+\.py)", line (\d+)/g
    )) {
        const relative = toRelative(match[1]);

        if (relative && files.has(relative)) {
            issues.push(makeIssue(
                "runtime_error",
                relative,
                `Python raised an error in ${relative} line ${match[2]}. ` +
                `Fix the code so the application starts.`
            ));
        }
    }

    // ---- Generic fallback ---------------------------------------------
    if (issues.length === 0 && FATAL_OUTPUT_PATTERN.test(text)) {
        const fallback = entry && files.has(entry)
            ? entry
            : "package.json";

        issues.push(makeIssue(
            "runtime_error",
            fallback,
            `The application failed to start. Fix ${fallback} (or the code ` +
            `it loads) so the application starts and keeps running.`
        ));
    }

    return dedupeIssues(issues);
}

function issuesFromNpmFailure(output) {
    const text = String(output || "");
    const codeMatch = text.match(/npm (?:error|ERR!) code (E[A-Z0-9_]+)/);
    const code = codeMatch ? codeMatch[1] : null;

    if (!code || !REPAIRABLE_NPM_CODES.has(code)) {
        return { repairable: false, code, issues: [] };
    }

    const packageMatch =
        text.match(/(?:404|notarget)[^\n]*?['"]?((?:@[\w.-]+\/)?[\w.-]+)@?([^\s'"\n]*)/i) ||
        text.match(/No matching version found for ((?:@[\w.-]+\/)?[\w.-]+)@([^\s.\n]+)/i);

    const name = packageMatch ? packageMatch[1] : null;

    const detail = text
        .split("\n")
        .filter(line => /npm (?:error|ERR!)/.test(line))
        .map(line => line.replace(/^npm (?:error|ERR!)\s*/, "").trim())
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
                `npm install failed (${code}). ${detail} ` +
                `${name ? `The package "${name}" may not exist or the version ` +
                    `range is invalid. ` : ""}` +
                `Return a complete package.json that only uses real, ` +
                `published packages and valid version ranges.`,
                { packageName: name || undefined }
            )
        ]
    };
}


// --------------------------------------------------
// HOME PAGE ASSET CHECK (while the server is running)
// --------------------------------------------------

async function checkServedAssets(port, files, entry) {
    const issues = [];
    const home = await httpProbe(port, "/", 3000);

    if (!home.ok || !/text\/html/i.test(home.contentType)) {
        return { home, issues };
    }

    const refs = extractHtmlReferences(home.body).slice(0, 25);

    for (const { ref } of refs) {
        const clean = String(ref).split(/[?#]/)[0];
        const urlPath = clean.startsWith("/") ? clean : `/${clean}`;
        const response = await httpProbe(port, urlPath, 3000);

        if (response.ok && response.status < 400) continue;

        const wanted = joinRelative(
            files.has("public/index.html") ? "public" : "",
            clean.replace(/^\/+/, "")
        );

        if (!wanted) continue;

        if (files.has(wanted)) {
            issues.push(makeIssue(
                "asset_not_served",
                entry && files.has(entry) ? entry : wanted,
                `The home page references ${ref}; the file ${wanted} exists ` +
                `but the server answered ${response.status || response.error} ` +
                `for ${urlPath}. Fix the server so it serves static files ` +
                `from the correct folder.`
            ));
        } else {
            issues.push(makeIssue(
                "missing_file",
                wanted,
                `The home page references ${ref} but the server answered ` +
                `${response.status || response.error} for ${urlPath} and ` +
                `${wanted} does not exist. Create ${wanted} with complete ` +
                `working content.`,
                { requiredBy: "home page" }
            ));
        }
    }

    return { home, issues: dedupeIssues(issues) };
}


// --------------------------------------------------
// WORK DIRECTORY
// --------------------------------------------------

function materialize(files) {
    const workDir = fs.mkdtempSync(
        path.join(os.tmpdir(), `devteam-run-${randomUUID().slice(0, 8)}-`)
    );

    for (const [relativePath, content] of files) {
        const destination = path.resolve(workDir, ...relativePath.split("/"));

        if (
            destination !== workDir &&
            !destination.startsWith(workDir + path.sep)
        ) {
            throw new Error(`Unsafe file path: ${relativePath}`);
        }

        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, content, "utf8");
    }

    return workDir;
}

function removeWorkDir(workDir) {
    try {
        fs.rmSync(workDir, {
            recursive: true,
            force: true,
            maxRetries: 3
        });
    } catch {
        // Temp directory cleanup is best effort.
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


// --------------------------------------------------
// PYTHON
// --------------------------------------------------

async function verifyPython({ files, workDir, steps, waitMs }) {
    const python = IS_WINDOWS ? "python" : "python3";
    const env = buildRuntimeEnv({ PYTHONDONTWRITEBYTECODE: "1" });
    const pyFiles = [...files.keys()].filter(name => name.endsWith(".py"));
    const issues = [];

    for (const file of pyFiles) {
        const result = await runProcess({
            command: python,
            args: ["-m", "py_compile", file],
            cwd: workDir,
            env,
            timeoutMs: 30000
        });

        if (result.spawnError) {
            steps.push({
                name: "python",
                status: "error",
                error: `Python is not available: ${result.spawnError}`
            });

            return { status: "error", issues: [] };
        }

        if (result.code !== 0) {
            issues.push(makeIssue(
                "runtime_error",
                file,
                `Python syntax error in ${file}: ` +
                `${tail(result.stderr, 800)}`
            ));
        }
    }

    steps.push({
        name: "python-syntax",
        status: issues.length === 0 ? "passed" : "failed",
        checked: pyFiles.length
    });

    if (issues.length > 0) {
        return { status: "failed", issues: dedupeIssues(issues) };
    }

    const entry = ["main.py", "app.py", "manage.py"].find(name =>
        files.has(name)
    );

    if (!entry) return { status: "passed", issues: [] };

    let pythonCommand = python;

    if (files.has("requirements.txt")) {
        const venv = await runProcess({
            command: python,
            args: ["-m", "venv", ".venv"],
            cwd: workDir,
            env,
            timeoutMs: 120000
        });

        if (venv.code !== 0) {
            steps.push({
                name: "venv",
                status: "error",
                error: tail(venv.stderr || venv.spawnError, 1500)
            });

            return { status: "error", issues: [] };
        }

        pythonCommand = IS_WINDOWS
            ? path.join(workDir, ".venv", "Scripts", "python.exe")
            : path.join(workDir, ".venv", "bin", "python");

        const install = await runProcess({
            command: pythonCommand,
            args: [
                "-m", "pip", "install", "-r", "requirements.txt",
                "--disable-pip-version-check", "-q"
            ],
            cwd: workDir,
            env,
            timeoutMs: INSTALL_TIMEOUT_MS
        });

        steps.push({
            name: "pip install",
            status: install.code === 0 ? "passed" : "failed",
            exitCode: install.code,
            stderr: tail(install.stderr, 3000)
        });

        if (install.code !== 0) {
            return {
                status: "failed",
                issues: [makeIssue(
                    "install_failed",
                    "requirements.txt",
                    `pip install failed. ${tail(install.stderr, 1200)} ` +
                    `Return a complete requirements.txt that only lists ` +
                    `real, published packages.`
                )]
            };
        }
    }

    const port = await findFreePort();

    const probe = await startAndProbe({
        command: pythonCommand,
        args: entry === "manage.py" ? [entry, "runserver", String(port)] : [entry],
        cwd: workDir,
        env: buildRuntimeEnv({ PORT: String(port), PYTHONDONTWRITEBYTECODE: "1" }),
        port,
        waitMs
    });

    const output = `${probe.stdout}\n${probe.stderr}`;

    steps.push({
        name: "python-start",
        status: "completed",
        outcome: probe.outcome,
        exitCode: probe.exitCode,
        stdout: tail(probe.stdout, 3000),
        stderr: tail(probe.stderr, 3000)
    });

    const crashed =
        probe.outcome === "exited" && probe.exitCode !== 0;

    if (crashed || (probe.outcome !== "listening" && FATAL_OUTPUT_PATTERN.test(output))) {
        const found = extractIssuesFromOutput(output, workDir, files, entry);

        return {
            status: "failed",
            issues: found.length > 0
                ? found
                : [makeIssue(
                    "runtime_error",
                    entry,
                    `The application failed to start. ${tail(output, 1500)}`
                )]
        };
    }

    return { status: "passed", issues: [] };
}


// --------------------------------------------------
// MAIN ENTRY POINT
// --------------------------------------------------

/**
 * @param {Object}   options
 * @param {Map<string,string>} options.files  relative path -> text content
 * @returns {Promise<Object>} { status, summary, steps, issues, ... }
 *   status: "passed" | "failed" | "error" | "unsupported"
 */
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

    // ---- 1. static completeness ------------------------------------
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
                `Static check found ${staticIssues.length} problem(s) that ` +
                `would stop the project from running.`,
            steps,
            issues: staticIssues,
            stderr: staticIssues.map(issue => issue.message).join("\n")
        };
    }

    if (project.type === "static") {
        steps.push({
            name: "static-site",
            status: "passed",
            note: "All referenced local files exist."
        });

        return {
            status: "passed",
            projectType: "static",
            summary: "Static site: every referenced local file exists.",
            steps,
            issues: []
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
                        ? "Python project compiled and started."
                        : "Python project did not start.",
                steps,
                issues: result.issues,
                stderr: result.issues.map(issue => issue.message).join("\n")
            };
        }

        // ---- 2. npm install ----------------------------------------
        const env = buildRuntimeEnv();

        if (
            !skipInstall &&
            project.pkg.exists &&
            hasInstallableDependencies(project.pkg)
        ) {
            const install = await runProcess({
                command: "npm",
                args: [
                    "install",
                    "--no-audit",
                    "--no-fund",
                    "--loglevel=error"
                ],
                cwd: workDir,
                env,
                timeoutMs: INSTALL_TIMEOUT_MS
            });

            const installOutput = `${install.stderr}\n${install.stdout}`;

            steps.push({
                name: "npm install",
                status: install.code === 0 ? "passed" : "failed",
                exitCode: install.code,
                stdout: tail(install.stdout, 3000),
                stderr: tail(install.stderr, 3000)
            });

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
                const diagnosis = issuesFromNpmFailure(installOutput);

                if (!diagnosis.repairable) {
                    return {
                        status: "error",
                        projectType: "node",
                        summary:
                            "npm install failed for a reason the agents " +
                            "cannot fix (network, permissions or registry): " +
                            `${tail(installOutput, 600)}`,
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

        // ---- 3. start and probe ------------------------------------
        const start = pickNodeStart(files, project.pkg);

        if (!start) {
            const issue = makeIssue(
                "no_start",
                "package.json",
                "No way to start the application was found. Add a " +
                '"start" script to package.json and make sure the entry ' +
                "file exists."
            );

            steps.push({ name: "start", status: "failed", issues: 1 });

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
            env: buildRuntimeEnv({ PORT: String(port) }),
            port,
            waitMs: startWaitMs
        });

        // A busy port is an environment problem, not a code bug: retry once.
        if (
            probe.outcome === "exited" &&
            /EADDRINUSE/.test(`${probe.stdout}${probe.stderr}`)
        ) {
            const retryPort = await findFreePort();

            probe = await startAndProbe({
                command: start.command,
                args: start.args,
                cwd: workDir,
                env: buildRuntimeEnv({ PORT: String(retryPort) }),
                port: retryPort,
                waitMs: startWaitMs
            });
        }

        const output = `${probe.stderr}\n${probe.stdout}`;

        steps.push({
            name: `start (${start.label})`,
            status: "completed",
            outcome: probe.outcome,
            exitCode: probe.exitCode,
            port: probe.listening?.port || null,
            httpStatus: probe.listening?.response?.status || null,
            stdout: tail(probe.stdout, 3000),
            stderr: tail(probe.stderr, 3000)
        });

        if (probe.spawnError) {
            return {
                status: "error",
                projectType: "node",
                summary: `Could not start the application: ${probe.spawnError}`,
                steps,
                issues: []
            };
        }

        // Crashed on startup.
        if (probe.outcome === "exited" && probe.exitCode !== 0) {
            const issues = extractIssuesFromOutput(
                output,
                workDir,
                files,
                start.entry
            );

            const fallback = issues.length > 0
                ? issues
                : [makeIssue(
                    "runtime_error",
                    start.entry && files.has(start.entry)
                        ? start.entry
                        : "package.json",
                    `The application exited with code ${probe.exitCode} ` +
                    `right after starting. Output:\n${tail(output, 1800)}`
                )];

            return {
                status: "failed",
                projectType: "node",
                summary:
                    `The application crashed on startup ` +
                    `(exit code ${probe.exitCode}).`,
                steps,
                issues: fallback,
                stdout: probe.stdout,
                stderr: tail(output)
            };
        }

        // Ran and finished cleanly (CLI / script style project).
        if (probe.outcome === "exited") {
            return {
                status: "passed",
                projectType: "node",
                summary:
                    "The application ran and exited cleanly " +
                    "(exit code 0).",
                steps,
                issues: [],
                stdout: probe.stdout,
                stderr: probe.stderr
            };
        }

        // Listening: also make sure the home page assets are served.
        if (probe.outcome === "listening") {
            return await finishListening({
                probe,
                start,
                files,
                steps,
                workDir,
                env,
                startWaitMs
            });
        }

        // Alive but never answered on any port.
        const fatalInOutput = FATAL_OUTPUT_PATTERN.test(output);

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
                    summary: "The application printed fatal errors while running.",
                    steps,
                    issues,
                    stderr: tail(output)
                };
            }
        }

        return {
            status: "passed",
            projectType: "node",
            summary:
                "The application started and kept running, but it does not " +
                "expose an HTTP port, so only startup stability was verified.",
            steps,
            issues: [],
            stdout: probe.stdout,
            stderr: probe.stderr
        };

    } finally {
        removeWorkDir(workDir);
    }
}

async function finishListening({
    probe,
    start,
    files,
    steps,
    workDir,
    startWaitMs
}) {
    // The first probe killed the process, so start it once more to
    // verify the served assets while it is still alive.
    const port = await findFreePort();

    let child;
    let stderr = "";
    let stdout = "";

    try {
        child = spawn(
            start.command,
            start.args,
            spawnOptions(
                workDir,
                buildRuntimeEnv({ PORT: String(port) }),
                !IS_WINDOWS
            )
        );

        child.stdout.on("data", chunk => {
            stdout = tail(stdout + chunk.toString("utf8"), 200000);
        });

        child.stderr.on("data", chunk => {
            stderr = tail(stderr + chunk.toString("utf8"), 200000);
        });

        const livePort = await waitForPort(
            child,
            [port],
            () => `${stdout}\n${stderr}`,
            startWaitMs
        );

        if (!livePort) {
            return {
                status: "passed",
                projectType: "node",
                summary:
                    `The application started and listened on port ` +
                    `${probe.listening.port}.`,
                steps,
                issues: []
            };
        }

        const { home, issues } = await checkServedAssets(
            livePort,
            files,
            start.entry
        );

        steps.push({
            name: "http-assets",
            status: issues.length === 0 ? "passed" : "failed",
            homeStatus: home?.status || null,
            issues: issues.length
        });

        if (issues.length > 0) {
            return {
                status: "failed",
                projectType: "node",
                summary:
                    "The server runs, but files referenced by its home " +
                    "page are missing or not served.",
                steps,
                issues,
                stderr: issues.map(issue => issue.message).join("\n")
            };
        }

        return {
            status: "passed",
            projectType: "node",
            summary:
                `The application started and answered HTTP ` +
                `${home?.status ?? "on"} at port ${livePort}; referenced ` +
                `assets are served.`,
            steps,
            issues: [],
            url: `http://localhost:${livePort}`
        };
    } finally {
        killTree(child);
    }
}

async function waitForPort(child, initialPorts, getOutput, waitMs) {
    const deadline = Date.now() + waitMs;

    while (Date.now() < deadline && child.exitCode === null) {
        const ports = [
            ...initialPorts,
            ...portsFromOutput(getOutput())
        ];

        for (const candidate of [...new Set(ports)]) {
            const response = await httpProbe(candidate, "/", 2000);

            if (response.ok) return candidate;
        }

        await sleep(500);
    }

    return null;
}


module.exports = {
    verifyRuntime,
    analyzeStatic,
    detectProject,
    extractIssuesFromOutput,
    issuesFromNpmFailure,
    buildRuntimeEnv
};
