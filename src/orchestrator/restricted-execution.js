"use strict";

/**
 * BAS restricted process execution.
 *
 * BAS does not permit the mount operations required for filesystem
 * isolation. This module provides network namespace isolation and
 * process resource limits only.
 *
 * It is NOT a security boundary against code that can read files
 * available to the BAS user.
 */

const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

class RestrictedExecutionUnavailable extends Error {
    constructor(message) {
        super(message);
        this.name = "RestrictedExecutionUnavailable";
        this.code = "RESTRICTED_EXECUTION_UNAVAILABLE";
    }
}

let capabilityCache = null;

function findExecutable(name) {
    const entries = [
        ...String(process.env.PATH || "").split(path.delimiter),
        "/usr/sbin",
        "/sbin"
    ];
    for (const entry of entries) {
        if (!entry) continue;
        const candidate = path.join(entry, name);
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            return candidate;
        } catch { /* Continue searching. */ }
    }
    return null;
}

function probeRestrictedExecution() {
    if (capabilityCache) return capabilityCache;
    if (process.platform !== "linux") {
        capabilityCache = { available: false, reason: "Restricted execution currently requires Linux." };
        return capabilityCache;
    }
    const unsharePath = findExecutable("unshare");
    const ipPath = findExecutable("ip");
    const prlimitPath = findExecutable("prlimit");
    if (!unsharePath || !ipPath || !prlimitPath) {
        capabilityCache = {
            available: false,
            reason: "Required utilities are missing. DevTeamAI requires unshare, ip and prlimit."
        };
        return capabilityCache;
    }
    const namespaceTest = spawnSync(unsharePath, [
        "--user", "--map-root-user", "--net", "--", ipPath, "link", "set", "lo", "up"
    ], { encoding: "utf8", timeout: 5000, windowsHide: true });
    if (namespaceTest.error || namespaceTest.status !== 0) {
        capabilityCache = {
            available: false,
            reason: "User/network namespace initialization failed: " +
                (namespaceTest.error?.message || namespaceTest.stderr || `exit ${namespaceTest.status}`)
        };
        return capabilityCache;
    }
    const limitTest = spawnSync(prlimitPath, ["--version"], {
        encoding: "utf8", timeout: 3000, windowsHide: true
    });
    if (limitTest.error || limitTest.status !== 0) {
        capabilityCache = { available: false, reason: "The prlimit utility is unavailable." };
        return capabilityCache;
    }
    capabilityCache = {
        available: true, reason: null,
        profile: "linux-user-network-namespace+rlimits",
        filesystemIsolation: false, networkIsolation: true, securityBoundary: false
    };
    return capabilityCache;
}

function unsharePathForExecution() {
    const executable = findExecutable("unshare");
    if (!executable) throw new RestrictedExecutionUnavailable("The unshare utility is unavailable.");
    return executable;
}

function buildRestrictedInvocation(command, args = [], options = {}) {
    const capability = probeRestrictedExecution();
    if (!capability.available) throw new RestrictedExecutionUnavailable(capability.reason);
    if (typeof command !== "string" || !command.trim() || !Array.isArray(args)) {
        throw new TypeError("A valid command and argument array are required.");
    }
    const cpuSeconds = Math.max(1, Math.min(Number(options.cpuSeconds) || 900, 3600));
    const addressSpaceBytes = Number(options.addressSpaceBytes) || 3 * 1024 * 1024 * 1024;
    const fileSizeBytes = Number(options.fileSizeBytes) || 256 * 1024 * 1024;
    const openFiles = Math.max(16, Math.min(Number(options.openFiles) || 256, 1024));
    const networkIsolation = options.networkIsolation !== false;
    const stringArgs = args.map(value => String(value));
    const unshareArgs = ["--user", "--map-root-user"];
    if (networkIsolation) {
        const shellProgram =
            "ip link set lo up || exit $?; " +
            "exec prlimit " +
            `--cpu=${cpuSeconds} --as=${addressSpaceBytes} --fsize=${fileSizeBytes} --nofile=${openFiles} ` +
            '-- "$@"';
        unshareArgs.push("--net", "--", "/bin/sh", "-c", shellProgram,
            "devteamai-restricted", command, ...stringArgs);
    } else {
        unshareArgs.push("--", "prlimit",
            `--cpu=${cpuSeconds}`, `--as=${addressSpaceBytes}`,
            `--fsize=${fileSizeBytes}`, `--nofile=${openFiles}`, "--",
            command, ...stringArgs);
    }
    return {
        command: unsharePathForExecution(), args: unshareArgs,
        networkIsolation, filesystemIsolation: false, securityBoundary: false,
        profile: networkIsolation ? "network-namespace+resource-limits" : "user-namespace+resource-limits"
    };
}

function buildRestrictedEnv(cwd, extra = {}) {
    if (typeof cwd !== "string" || !cwd) throw new TypeError("A working directory is required.");
    const tempDir = path.join(cwd, ".devteamai-tmp");
    fs.mkdirSync(tempDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(tempDir, 0o700); } catch { /* Best effort. */ }
    const pathEntries = [path.dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
    const env = {
        PATH: [...new Set(pathEntries)].join(":"), HOME: cwd,
        TMPDIR: tempDir, TMP: tempDir, TEMP: tempDir,
        LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC",
        CI: "true", NO_COLOR: "1", FORCE_COLOR: "0",
        NODE_ENV: "test", NODE_NO_WARNINGS: "1", PYTHONDONTWRITEBYTECODE: "1",
        GOPROXY: "off", GOSUMDB: "off", CARGO_NET_OFFLINE: "true",
        npm_config_offline: "true", npm_config_audit: "false",
        npm_config_fund: "false", npm_config_update_notifier: "false"
    };
    for (const key of ["LANG", "LC_ALL", "TZ"]) if (process.env[key]) env[key] = process.env[key];
    Object.assign(env, extra);
    return env;
}

module.exports = {
    RestrictedExecutionUnavailable,
    probeRestrictedExecution,
    buildRestrictedInvocation,
    buildRestrictedEnv
};
