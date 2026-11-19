const { spawn } = require("node:child_process");
const { getProjectRoot } = require("./file-manager");

const ALLOWED_COMMANDS = {
    compile: {
        command: "npm",
        args: ["run", "compile"]
    },
    build: {
        command: "npm",
        args: ["run", "build"]
    }
};

function runApprovedCommand({
    projectSlug,
    commandId,
    approved = false,
    timeout = 120000
}) {
    if (!approved) {
        throw new Error("Explicit approval is required before executing commands.");
    }

    const definition = ALLOWED_COMMANDS[commandId];

    if (!definition) {
        throw new Error(`Command is not allowlisted: ${commandId}`);
    }

    const cwd = getProjectRoot(projectSlug);

    return new Promise((resolve, reject) => {
        const child = spawn(
            definition.command,
            definition.args,
            {
                cwd,
                shell: false,
                windowsHide: true,
                env: process.env
            }
        );

        let stdout = "";
        let stderr = "";
        let settled = false;

        const timer = setTimeout(() => {
            child.kill();
            finish(new Error("Command timed out."));
        }, timeout);

        function finish(error, result) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);

            if (error) return reject(error);
            resolve(result);
        }

        child.stdout.on("data", chunk => {
            stdout = (stdout + chunk.toString()).slice(-12000);
        });

        child.stderr.on("data", chunk => {
            stderr = (stderr + chunk.toString()).slice(-12000);
        });

        child.on("error", error => finish(error));

        child.on("close", code => {
            if (code !== 0) {
                return finish(new Error(
                    `Command failed with exit code ${code}.\n${stderr || stdout}`
                ));
            }

            finish(null, {
                commandId,
                exitCode: code,
                stdout,
                stderr
            });
        });
    });
}

module.exports = { runApprovedCommand };
