const { askAI } = require("./ollama");
const fs = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");

const WORKSPACE = path.resolve(__dirname, "../workspace");

const SYSTEM = `You are an autonomous software project architect.
Turn the user's application request into a practical project structure.
Return ONLY valid JSON. Do not use Markdown fences.
Use a reasonable, simple technology stack.
Generate a small but complete first version of the requested application.
Do not include absolute paths.
Return this exact structure:
{
  "projectName": "short-project-name",
  "files": [
    {
      "path": "relative/path/to/file",
      "purpose": "what this file should contain"
    }
  ]
}
Include all essential source, configuration, and documentation files.
Maximum N files.`;

function extractJSON(text) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");

    if (start === -1 || end <= start) {
        throw new Error("AI did not return a valid project plan.");
    }

    return JSON.parse(text.slice(start, end + 1));
}

function safeProjectName(name) {
    return String(name)
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 50) || "generated-app";
}

function safeFilePath(projectDir, relativePath) {
    if (
        typeof relativePath !== "string" ||
        path.isAbsolute(relativePath) ||
        relativePath.includes("\\")
    ) {
        throw new Error(`Unsafe file path: ${relativePath}`);
    }

    const destination = path.resolve(projectDir, relativePath);

    if (!destination.startsWith(projectDir + path.sep)) {
        throw new Error(`File path escapes project directory: ${relativePath}`);
    }

    return destination;
}

async function generateProject(userPrompt) {
    console.log("\n[1/3] Understanding your application request...\n");

    const planText = await askAI(
        `Create a project plan for this application:\n${userPrompt}`,
        SYSTEM,
        { maxTokens: 300, timeout: 180000 }
    );

    const plan = extractJSON(planText);

    if (!Array.isArray(plan.files) || plan.files.length === 0) {
        throw new Error("The AI returned an empty project plan.");
    }

    if (plan.files.length > 12) {
        throw new Error("Project plan exceeded the 12-file safety limit.");
    }

    const projectName = safeProjectName(plan.projectName);
    const projectDir = path.join(WORKSPACE, projectName);

    await fs.mkdir(projectDir, { recursive: true });

    console.log(`[2/3] Creating ${plan.files.length} project files...\n`);

    for (let i = 0; i < plan.files.length; i++) {
        const file = plan.files[i];

        if (!file.path || !file.purpose) {
            console.log(`Skipping invalid file entry ${i + 1}`);
            continue;
        }

        console.log(`Generating: ${file.path}`);

        const content = await askAI(
            `Application request:\n${userPrompt}\n\n` +
            `Project file: ${file.path}\n` +
            `Purpose: ${file.purpose}\n\n` +
            `Write the COMPLETE contents of this file.\n` +
            `Return only the file contents. Do not explain your answer.`,
            "You are an expert software developer. Generate complete, consistent, working source code. Do not use Markdown code fences.",
            { maxTokens: 3000 }
        );

        const destination = safeFilePath(projectDir, file.path);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, content.trim() + "\n", "utf8");
    }

    console.log("\n[3/3] Project file generation finished.");
    console.log("\n========================================");
    console.log(" APPLICATION GENERATION FINISHED");
    console.log("========================================");
    console.log(`Project: ${projectName}`);
    console.log(`Location: ${projectDir}`);
    console.log("\nGenerated files:");

    await showFiles(projectDir);
}

async function showFiles(directory, prefix = "") {
    const entries = await fs.readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
        const relative = path.join(prefix, entry.name);

        if (entry.isDirectory()) {
            await showFiles(path.join(directory, entry.name), relative);
        } else {
            console.log("  " + relative);
        }
    }
}

async function main() {
    await fs.mkdir(WORKSPACE, { recursive: true });

    const rl = readline.createInterface({ input: stdin, output: stdout });

    console.log("\n========================================");
    console.log("       AUTONOMOUS AI APP BUILDER");
    console.log("========================================");
    console.log("Powered by local Qwen 2.5 1.5B");
    console.log("Your projects will be created in workspace/");
    console.log("\n");

    try {
        const prompt = await rl.question("Describe the application you want to build:\n> ");

        if (!prompt.trim()) {
            console.log("Please enter an application description.");
            return;
        }

        await generateProject(prompt);
    } catch (error) {
        console.error("\nAgent error:", error.message);
    } finally {
        rl.close();
    }
}

main();
