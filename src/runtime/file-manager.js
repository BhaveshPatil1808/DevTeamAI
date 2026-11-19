
const fs = require("node:fs");
const path = require("node:path");

const WORKSPACE = path.resolve(__dirname, "../../workspace");

function slugify(value) {
    return String(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 50);
}

function isInside(parent, target) {
    const relative = path.relative(parent, target);

    return relative !== "" &&
        relative !== ".." &&
        !relative.startsWith(".." + path.sep) &&
        !path.isAbsolute(relative);
}

function ensureDirectoryWithoutSymlinks(baseDirectory, targetDirectory) {
    const base = fs.realpathSync(baseDirectory);
    const target = path.resolve(targetDirectory);

    if (target !== base && !isInside(base, target)) {
        throw new Error("Directory is outside the allowed workspace.");
    }

    const relative = path.relative(base, target);
    const parts = relative ? relative.split(path.sep) : [];

    let current = base;

    for (const part of parts) {
        current = path.join(current, part);

        try {
            const stats = fs.lstatSync(current);

            if (stats.isSymbolicLink() || !stats.isDirectory()) {
                throw new Error(`Unsafe directory detected: ${current}`);
            }
        } catch (error) {
            if (error.code !== "ENOENT") {
                throw error;
            }

            try {
                fs.mkdirSync(current);
            } catch (mkdirError) {
                if (mkdirError.code !== "EEXIST") {
                    throw mkdirError;
                }
            }

            const stats = fs.lstatSync(current);

            if (stats.isSymbolicLink() || !stats.isDirectory()) {
                throw new Error(`Unsafe directory detected: ${current}`);
            }
        }
    }

    const realTarget = fs.realpathSync(target);

    if (realTarget !== base && !isInside(base, realTarget)) {
        throw new Error("Directory resolves outside the allowed workspace.");
    }

    return realTarget;
}

function getProjectRoot(projectSlug) {
    const slug = slugify(projectSlug);

    if (!slug) {
        throw new Error("Invalid project name.");
    }

    fs.mkdirSync(WORKSPACE, { recursive: true });

    const workspaceRoot = fs.realpathSync(WORKSPACE);
    const projectRoot = path.resolve(workspaceRoot, slug);

    if (!isInside(workspaceRoot, projectRoot)) {
        throw new Error("Project path is outside the workspace.");
    }

    return ensureDirectoryWithoutSymlinks(
        workspaceRoot,
        projectRoot
    );
}

function validateRelativeFilePath(filePath) {
    if (typeof filePath !== "string" || !filePath.trim()) {
        throw new Error("Invalid generated file path.");
    }

    // Convert Windows separators to standard forward slashes.
    const relativePath = filePath.replace(/\\/g, "/");
    const parts = relativePath.split("/");

    if (
        relativePath.startsWith("/") ||
        /^[a-zA-Z]:/.test(relativePath) ||
        relativePath.includes("\0") ||
        parts.some(part =>
            !part ||
            part === "." ||
            part === ".." ||
            part.includes(":") ||
            part.startsWith(".env") ||
            part === "node_modules" ||
            part === ".git" ||
            part === ".devteam"
        )
    ) {
        throw new Error(`Unsafe generated file path: ${relativePath}`);
    }

    return parts;
}

/**
 * Writes agent-generated files into a run-specific staging directory.
 *
 * With runId:
 * .devteam/generated/<runId>/<taskId>/
 *
 * Without runId:
 * .devteam/generated/<taskId>/
 *
 * The default preserves compatibility with existing three-argument callers.
 */
function writeAgentFiles(projectRoot, taskId, files, runId = null) {
    if (!Array.isArray(files) || files.length < 1 || files.length > 4) {
        throw new Error("An agent must return between 1 and 4 files.");
    }

    const projectRealRoot = fs.realpathSync(projectRoot);
    const workspaceRealRoot = fs.realpathSync(WORKSPACE);

    if (!isInside(workspaceRealRoot, projectRealRoot)) {
        throw new Error("Project directory is outside the workspace.");
    }

    const taskSlug = slugify(taskId);

    if (!taskSlug) {
        throw new Error("Invalid task ID.");
    }

    // Validate the run ID before using it as a directory name.
    let runFolder = null;

    if (runId !== null && runId !== undefined) {
        runFolder = String(runId);

        if (!/^[a-zA-Z0-9_-]{1,80}$/.test(runFolder)) {
            throw new Error("Invalid project run ID.");
        }
    }

    const stagingPath = path.resolve(
        projectRealRoot,
        ".devteam",
        "generated",
        ...(runFolder ? [runFolder] : []),
        taskSlug
    );

    const stagingRoot = ensureDirectoryWithoutSymlinks(
        projectRealRoot,
        stagingPath
    );

    const preparedFiles = [];
    const destinations = new Set();

    let totalBytes = 0;

    // Validate every file before writing any file.
    for (const file of files) {
        if (!file || typeof file.content !== "string") {
            throw new Error("Invalid generated file structure.");
        }

        const parts = validateRelativeFilePath(file.path);
        const relativePath = parts.join("/");

        const destination = path.resolve(
            stagingRoot,
            ...parts
        );

        if (!isInside(stagingRoot, destination)) {
            throw new Error("Generated file escaped the staging directory.");
        }

        if (destinations.has(destination)) {
            throw new Error(`Duplicate generated file: ${relativePath}`);
        }

        destinations.add(destination);

        const bytes = Buffer.byteLength(file.content, "utf8");
        totalBytes += bytes;

        if (bytes > 60000 || totalBytes > 180000) {
            throw new Error("Generated file output exceeds the size limit.");
        }

        // lstat also detects broken symbolic links.
        try {
            fs.lstatSync(destination);

            throw new Error(
                `Refusing to overwrite existing file: ${relativePath}`
            );
        } catch (error) {
            if (error.code !== "ENOENT") {
                throw error;
            }
        }

        preparedFiles.push({
            destination,
            relativePath,
            content: file.content,
            bytes
        });
    }

    const written = [];

    for (const file of preparedFiles) {
        const parentDirectory = path.dirname(file.destination);

        ensureDirectoryWithoutSymlinks(
            stagingRoot,
            parentDirectory
        );

        // wx prevents overwriting an existing file.
        fs.writeFileSync(file.destination, file.content, {
            encoding: "utf8",
            flag: "wx"
        });

        written.push({
            path: path.relative(projectRealRoot, file.destination),
            bytes: file.bytes
        });
    }

    return written;
}

module.exports = {
    getProjectRoot,
    writeAgentFiles
};
