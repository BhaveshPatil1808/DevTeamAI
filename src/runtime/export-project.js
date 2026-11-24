"use strict";

/**
 * Atomically exports one immutable integrated snapshot to <project>/final.
 * The old final folder is retained unless the complete new export succeeds.
 */
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const EXPORT_DIR_NAME = "final";
const SNAPSHOT_PREFIX = ".devteam/integrated/";
const SNAPSHOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isInside(parent, candidate, allowEqual = false) {
    const relative = path.relative(parent, candidate);
    return (allowEqual && relative === "") || (
        relative !== "" && relative !== ".." &&
        !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)
    );
}

function normalizeRelative(filePath, snapshotRunId) {
    if (typeof filePath !== "string" || !filePath.trim()) throw new Error("Invalid export file path.");
    const normalized = filePath.replace(/\\/g, "/");
    const prefix = `${SNAPSHOT_PREFIX}${snapshotRunId}/`;
    if (normalized.startsWith(prefix)) return normalized.slice(prefix.length);
    if (normalized.startsWith(SNAPSHOT_PREFIX)) throw new Error("File belongs to a different integration snapshot.");
    if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized) || normalized.includes("\0")) {
        throw new Error(`Unsafe export path: ${filePath}`);
    }
    const parts = normalized.split("/");
    if (!normalized || parts.some(part => !part || part === "." || part === "..")) {
        throw new Error(`Unsafe export path: ${filePath}`);
    }
    return parts.join("/");
}

function assertNoSymlinkPath(root, target, includeTarget = true) {
    const relative = path.relative(root, target);
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
        throw new Error("Path escapes the allowed directory.");
    }
    let current = root;
    const parts = relative.split(path.sep).filter(Boolean);
    const limit = includeTarget ? parts.length : Math.max(0, parts.length - 1);
    for (const part of parts.slice(0, limit)) {
        current = path.join(current, part);
        if (!fs.existsSync(current)) continue;
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${current}`);
    }
}

function exportIntegratedProject({ projectRoot, snapshotRunId, integrationFiles }) {
    if (!SNAPSHOT_ID_PATTERN.test(String(snapshotRunId))) throw new Error("Invalid snapshot ID for export.");
    if (!Array.isArray(integrationFiles) || integrationFiles.length === 0) throw new Error("No integration files to export.");

    const realRoot = fs.realpathSync(projectRoot);
    const snapshotRoot = path.join(realRoot, ".devteam", "integrated", snapshotRunId);
    const snapshotStat = fs.lstatSync(snapshotRoot);
    if (snapshotStat.isSymbolicLink() || !snapshotStat.isDirectory()) throw new Error("Integration snapshot is not a real directory.");
    const realSnapshot = fs.realpathSync(snapshotRoot);
    if (!isInside(realRoot, realSnapshot)) throw new Error("Integration snapshot is outside the project.");

    const seen = new Set();
    const sources = [];
    for (const item of integrationFiles) {
        if (!item || typeof item.path !== "string") throw new Error("Invalid integration file record.");
        const relative = normalizeRelative(item.path, snapshotRunId);
        if (seen.has(relative)) throw new Error(`Duplicate export path: ${relative}`);
        seen.add(relative);
        const source = path.resolve(realSnapshot, ...relative.split("/"));
        if (!isInside(realSnapshot, source)) throw new Error(`Export source escapes snapshot: ${relative}`);
        assertNoSymlinkPath(realSnapshot, source, true);
        const stat = fs.lstatSync(source);
        if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Export source is not a regular file: ${relative}`);
        const realSource = fs.realpathSync(source);
        if (!isInside(realSnapshot, realSource)) throw new Error(`Export source resolves outside snapshot: ${relative}`);
        sources.push({ relative, source: realSource });
    }
    if (sources.length === 0) throw new Error("No valid files were selected for export.");

    const exportRoot = path.join(realRoot, EXPORT_DIR_NAME);
    const stageRoot = path.join(realRoot, `.final-stage-${randomUUID()}`);
    const backupRoot = path.join(realRoot, `.final-backup-${randomUUID()}`);
    let movedOld = false;
    let promoted = false;
    try {
        fs.mkdirSync(stageRoot, { recursive: false, mode: 0o700 });
        for (const item of sources) {
            const destination = path.resolve(stageRoot, ...item.relative.split("/"));
            if (!isInside(stageRoot, destination)) throw new Error(`Export destination escapes folder: ${item.relative}`);
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.copyFileSync(item.source, destination, fs.constants.COPYFILE_EXCL);
        }
        const stagedCount = sources.filter(item => fs.statSync(path.join(stageRoot, ...item.relative.split("/"))).isFile()).length;
        if (stagedCount !== sources.length || stagedCount === 0) throw new Error("Staged export validation failed.");

        if (fs.existsSync(exportRoot)) {
            const oldStat = fs.lstatSync(exportRoot);
            if (oldStat.isSymbolicLink() || !oldStat.isDirectory()) throw new Error("Existing final export is not a real directory.");
            fs.renameSync(exportRoot, backupRoot);
            movedOld = true;
        }
        fs.renameSync(stageRoot, exportRoot);
        promoted = true;
        if (movedOld) fs.rmSync(backupRoot, { recursive: true, force: true });
        return { directory: EXPORT_DIR_NAME, fileCount: sources.length, files: sources.map(item => item.relative), snapshotRunId };
    } catch (error) {
        if (promoted && fs.existsSync(exportRoot)) fs.rmSync(exportRoot, { recursive: true, force: true });
        if (movedOld && fs.existsSync(backupRoot) && !fs.existsSync(exportRoot)) fs.renameSync(backupRoot, exportRoot);
        throw error;
    } finally {
        if (fs.existsSync(stageRoot)) fs.rmSync(stageRoot, { recursive: true, force: true });
        if (fs.existsSync(backupRoot) && fs.existsSync(exportRoot)) fs.rmSync(backupRoot, { recursive: true, force: true });
    }
}

module.exports = { exportIntegratedProject, EXPORT_DIR_NAME };
