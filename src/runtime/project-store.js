const fs = require("node:fs");
const path = require("node:path");

function getStoreDirectory(projectRoot) {
    const directory = path.resolve(projectRoot, ".devteam");
    fs.mkdirSync(directory, { recursive: true });
    return directory;
}

function saveProjectState(projectRoot, state) {
    const directory = getStoreDirectory(projectRoot);
    const destination = path.join(directory, "project.json");
    const temporary = destination + ".tmp";

    fs.writeFileSync(
        temporary,
        JSON.stringify(state, null, 2),
        "utf8"
    );

    fs.renameSync(temporary, destination);
}

function loadProjectState(projectRoot) {
    const directory = path.resolve(projectRoot, ".devteam");
    const destination = path.join(directory, "project.json");

    try {
        const directoryStats = fs.lstatSync(directory);
        if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
            throw new Error("Invalid project state directory.");
        }

        const fileStats = fs.lstatSync(destination);
        if (!fileStats.isFile() || fileStats.isSymbolicLink()) {
            throw new Error("Invalid project state file.");
        }

        const state = JSON.parse(
            fs.readFileSync(destination, "utf8")
        );

        if (!state || typeof state !== "object" || Array.isArray(state)) {
            throw new Error("Invalid saved project state.");
        }

        return state;
    } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
    }
}

function recordEvent(projectRoot, event) {
    const directory = getStoreDirectory(projectRoot);
    const file = path.join(directory, "events.jsonl");

    fs.appendFileSync(
        file,
        JSON.stringify({
            timestamp: new Date().toISOString(),
            ...event
        }) + "\n",
        "utf8"
    );
}

module.exports = {
    saveProjectState,
    loadProjectState,
    recordEvent
};
