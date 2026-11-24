
"use strict";

/*
 * Trusted helper launched inside the restricted network namespace.
 * Generated application output is captured as text and is never
 * interpreted as shell commands.
 */

const { spawn, spawnSync } = require("node:child_process");
const http = require("node:http");

const MAX_OUTPUT = 200000;
const MAX_BODY = 512 * 1024;

function appendLimited(current, chunk) {
    const next = current + chunk.toString("utf8");

    return next.length > MAX_OUTPUT
        ? next.slice(-MAX_OUTPUT)
        : next;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function request(port, pathname, timeoutMs = 1500) {
    return new Promise(resolve => {
        const req = http.request(
            {
                host: "localhost",
                port,
                path: pathname,
                method: "GET",
                timeout: timeoutMs,
                headers: {
                    Accept: "text/html,*/*"
                }
            },
            response => {
                const chunks = [];
                let bytes = 0;

                response.on("data", chunk => {
                    bytes += chunk.length;

                    if (bytes <= MAX_BODY) {
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

        req.on("timeout", () => {
            req.destroy();
            resolve({
                ok: false,
                error: "timeout"
            });
        });

        req.on("error", error => {
            resolve({
                ok: false,
                error: error.code || error.message
            });
        });

        req.end();
    });
}

function extractPorts(output, preferred) {
    const ports = new Set();

    if (preferred) {
        ports.add(Number(preferred));
    }

    const pattern =
        /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]|::1?):(\d{2,5})/gi;

    for (const match of String(output).matchAll(pattern)) {
        const value = Number(match[1]);

        if (value >= 80 && value <= 65535) {
            ports.add(value);
        }
    }

    return [...ports].filter(value =>
        Number.isInteger(value) &&
        value >= 80 &&
        value <= 65535
    );
}

function localAssetPaths(html) {
    const found = new Set();

    const pattern =
        /<(script|link|img)\b[^>]*?\b(src|href)\s*=\s*["']([^"']+)["']/gi;

    for (const match of String(html || "").matchAll(pattern)) {
        const raw = match[3].trim();

        if (
            !raw ||
            raw.startsWith("#") ||
            raw.startsWith("//") ||
            /^(data:|https?:|javascript:|mailto:)/i.test(raw)
        ) {
            continue;
        }

        try {
            const url = new URL(raw, "http://localhost/");

            if (url.origin === "http://localhost") {
                found.add(url.pathname);
            }
        } catch {
            // Ignore malformed references.
        }
    }

    return [...found].slice(0, 100);
}

function killTree(child) {
    if (!child?.pid) {
        return;
    }

    try {
        process.kill(-child.pid, "SIGTERM");
    } catch {
        try {
            child.kill("SIGTERM");
        } catch {
            // Process may already have exited.
        }
    }
}

async function main() {
    let config;

    try {
        config = JSON.parse(
            process.env.DEVTEAMAI_RUNTIME_CONFIG || "{}"
        );
    } catch {
        process.stdout.write(JSON.stringify({
            outcome: "supervisor_error",
            error: "Invalid runtime configuration."
        }));

        process.exitCode = 2;
        return;
    }

    if (
        !config ||
        typeof config.command !== "string" ||
        !Array.isArray(config.args) ||
        typeof config.cwd !== "string"
    ) {
        process.stdout.write(JSON.stringify({
            outcome: "supervisor_error",
            error: "Incomplete runtime configuration."
        }));

        process.exitCode = 2;
        return;
    }

    const loopback = spawnSync(
        "ip",
        ["link", "set", "lo", "up"],
        {
            encoding: "utf8",
            timeout: 3000,
            windowsHide: true
        }
    );

    if (loopback.error || loopback.status !== 0) {
        process.stdout.write(JSON.stringify({
            outcome: "supervisor_error",
            error:
                "Could not enable loopback in the network namespace: " +
                (
                    loopback.error?.message ||
                    loopback.stderr ||
                    loopback.status
                )
        }));

        process.exitCode = 2;
        return;
    }

    let stdout = "";
    let stderr = "";
    let child = null;
    let exitCode = null;
    let spawnError = null;
    let exited = false;
    let listening = null;

    const waitMs = Math.min(
        Math.max(Number(config.waitMs) || 25000, 1000),
        60000
    );

    try {
        child = spawn(
            config.command,
            config.args.map(String),
            {
                cwd: config.cwd,
                env:
                    config.env && typeof config.env === "object"
                        ? config.env
                        : {},
                shell: false,
                detached: true,
                windowsHide: true,
                stdio: ["ignore", "pipe", "pipe"]
            }
        );
    } catch (error) {
        spawnError = error.message;
        exited = true;
    }

    if (child) {
        child.stdout.on("data", chunk => {
            stdout = appendLimited(stdout, chunk);
        });

        child.stderr.on("data", chunk => {
            stderr = appendLimited(stderr, chunk);
        });

        child.on("error", error => {
            spawnError = error.message;
            exited = true;
        });

        child.on("close", code => {
            exited = true;
            exitCode = code;
        });
    }

    const deadline = Date.now() + waitMs;

    while (
        child &&
        !exited &&
        Date.now() < deadline
    ) {
        const ports = extractPorts(
            `${stdout}\n${stderr}`,
            config.port
        );

        for (const candidate of ports) {
            const response = await request(
                candidate,
                "/",
                1200
            );

            if (response.ok) {
                listening = {
                    port: candidate,
                    response
                };

                break;
            }
        }

        if (listening) {
            break;
        }

        await sleep(300);
    }

    if (listening && child && !exited) {
        await sleep(800);

        const home = await request(
            listening.port,
            "/",
            2000
        );

        const assetIssues = [];

        if (home.status >= 500) {
            assetIssues.push({
                path: "/",
                status: home.status,
                error: "Home page returned a server error."
            });
        }

        if (home.ok && /text\/html/i.test(home.contentType)) {
            for (const assetPath of localAssetPaths(home.body)) {
                const asset = await request(
                    listening.port,
                    assetPath,
                    1500
                );

                if (
                    !asset.ok ||
                    asset.status < 200 ||
                    asset.status >= 400
                ) {
                    assetIssues.push({
                        path: assetPath,
                        status: asset.status || null,
                        error: asset.error || null
                    });
                }
            }
        }

        listening.response = home;
        listening.assetIssues = assetIssues;
    }

    const outcome = spawnError
        ? "spawn_error"
        : listening
            ? "listening"
            : exited
                ? "exited"
                : "alive";

    killTree(child);

    if (child && !exited) {
        await Promise.race([
            new Promise(resolve => child.once("close", resolve)),
            sleep(1000)
        ]);

        try {
            process.kill(-child.pid, "SIGKILL");
        } catch {
            // Already exited.
        }
    }

    process.stdout.write(JSON.stringify({
        outcome,
        exitCode,
        spawnError,

        listening: listening
            ? {
                port: listening.port,
                response: listening.response
                    ? {
                        ok: listening.response.ok,
                        status: listening.response.status,
                        contentType: listening.response.contentType
                    }
                    : null,
                assetIssues: listening.assetIssues || []
            }
            : null,

        stdout,
        stderr
    }));
}

main().catch(error => {
    process.stdout.write(JSON.stringify({
        outcome: "supervisor_error",
        error: error.message
    }));

    process.exitCode = 2;
});
