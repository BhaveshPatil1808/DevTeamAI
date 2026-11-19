"use strict";

/**
 * Exports the latest integrated snapshot into a normal, runnable folder:
 *
 *     workspace/<project>/final/
 *
 * Until now the finished project only existed inside
 * .devteam/integrated/<uuid>/, next to internal bookkeeping files.
 * The exported folder contains only the project files, so it can be
 * opened, zipped, or started directly (npm install && npm start).
 */

const fs = require("node:fs");
const path = require("node:path");

const EXPORT_DIR_NAME = "final";
const SNAPSHOT_PREFIX = ".devteam/integrated/";

const SNAPSHOT_ID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;


function isInside(parent, candidate) {
    const relative = path.relative(parent, candidate);

    return (
        relative !== "" &&
        relative !== ".." &&
        !relative.startsWith(".." + path.sep) &&
        !path.isAbsolute(relative)
    );
}

function toSnapshotRelative(filePath, snapshotRunId) {
    const normalized = String(filePath).replace(/\\/g, "/");
    const prefix = `${SNAPSHOT_PREFIX}${snapshotRunId}/`;

    if (normalized.startsWith(prefix)) {
        return normalized.slice(prefix.length);
    }

    if (normalized.startsWith(SNAPSHOT_PREFIX)) {
        throw new Error("File belongs to a different integration snapshot.");
    }

    return normalized;
}

function exportIntegratedProject({
    projectRoot,
    snapshotRunId,
    integrationFiles
}) {
    if (!SNAPSHOT_ID_PATTERN.test(String(snapshotRunId))) {
        throw new Error("Invalid snapshot ID for export.");
    }

    if (!Array.isArray(integrationFiles) || integrationFiles.length === 0) {
        throw new Error("No integration files to export.");
    }

    const realRoot = fs.realpathSync(projectRoot);

    const snapshotRoot = path.join(
        realRoot,
        ".devteam",
        "integrated",
        snapshotRunId
    );

    const snapshotStat = fs.lstatSync(snapshotRoot);

    if (snapshotStat.isSymbolicLink() || !snapshotStat.isDirectory()) {
        throw new Error("Integration snapshot is not a real directory.");
    }

    const realSnapshot = fs.realpathSync(snapshotRoot);

    if (!isInside(realRoot, realSnapshot)) {
        throw new Error("Integration snapshot is outside the project.");
    }

    const exportRoot = path.join(realRoot, EXPORT_DIR_NAME);

    // Start from a clean folder so removed files do not linger.
    fs.rmSync(exportRoot, { recursive: true, force: true });
    fs.mkdirSync(exportRoot, { recursive: true });

    const exported = [];

    for (const item of integrationFiles) {
        if (!item || typeof item.path !== "string") continue;

        const relative = toSnapshotRelative(item.path, snapshotRunId);

        if (
            !relative ||
            relative.startsWith("/") ||
            /^[a-zA-Z]:/.test(relative) ||
            relative.includes("\0") ||
            relative.split("/").some(part => part === ".." || part === "")
        ) {
            throw new Error(`Unsafe export path: ${item.path}`);
        }

        const source = path.resolve(realSnapshot, ...relative.split("/"));

        if (!isInside(realSnapshot, source)) {
            throw new Error(`Export source escapes snapshot: ${relative}`);
        }

        const sourceStat = fs.lstatSync(source);

        if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
            throw new Error(`Export source is not a regular file: ${relative}`);
        }

        const destination = path.resolve(exportRoot, ...relative.split("/"));

        if (!isInside(exportRoot, destination)) {
            throw new Error(`Export destination escapes folder: ${relative}`);
        }

        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(source, destination);

        exported.push(relative);
    }

    return {
        directory: EXPORT_DIR_NAME,
        fileCount: exported.length,
        files: exported,
        snapshotRunId
    };
}

module.exports = {
    exportIntegratedProject,
    EXPORT_DIR_NAME
};
