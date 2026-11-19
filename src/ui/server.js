
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const {
    askWithFallback,
    getProviderOrder
} = require("../providers/router");

const { runProject } = require("../orchestrator/project-runner");
const { getProjectRoot } = require("../runtime/file-manager");

const {
    loadProjectState,
    saveProjectState,
    recordEvent
} = require("../runtime/project-store");

const PUBLIC_DIR = path.resolve(__dirname, "public");
const PORT = Number(process.env.UI_PORT || 4173);

const MAX_BODY_SIZE = 12000;
const MAX_CHAT_REQUESTS = 12;
const CHAT_WINDOW_MS = 60000;

const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".ico": "image/x-icon"
};

const RUN_ID_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PROJECT_SLUG_REGEX =
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

let requestCount = 0;
let windowStarted = Date.now();

let projectRunActive = false;
let activeRun = null;


// --------------------------------------------------
// HTTP HELPERS
// --------------------------------------------------

function sendJSON(res, status, data) {
    if (res.headersSent || res.destroyed) return;

    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
    });

    res.end(JSON.stringify(data));
}


function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = "";
        let rejected = false;

        req.on("data", chunk => {
            if (rejected) return;

            body += chunk.toString("utf8");

            if (Buffer.byteLength(body, "utf8") > MAX_BODY_SIZE) {
                rejected = true;
                reject(new Error("Request too large."));
                req.destroy();
            }
        });

        req.on("end", () => {
            if (rejected) return;

            try {
                resolve(JSON.parse(body || "{}"));
            } catch {
                reject(new Error("Invalid JSON."));
            }
        });

        req.on("error", error => {
            if (!rejected) reject(error);
        });
    });
}


function isInsideDirectory(parent, target) {
    const relative = path.relative(parent, target);

    return relative === "" ||
        (
            relative !== ".." &&
            !relative.startsWith(".." + path.sep) &&
            !path.isAbsolute(relative)
        );
}


function slugifyProjectName(value) {
    return String(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 50);
}


function isTerminalProjectStatus(status) {
    return [
        "completed",
        "verification_required",
        "functional_tests_failed",
        "verification_failed",
        "integration_completed",
        "partially_completed",
        "failed",
        "integration_failed",
        "qa_failed",
        "runtime_failed"
    ].includes(status);
}


// --------------------------------------------------
// PROJECT MANAGER CHAT
// --------------------------------------------------

function getProjectManagerPrompt() {
    return `
You are the AI Project Manager of DevTeamAI.

You coordinate a team of nine specialist software engineering agents:

1. Business Analyst
2. Solution Architect
3. Database Engineer
4. Backend Developer
5. Frontend Developer
6. Integration Engineer
7. QA Engineer
8. Security Engineer
9. DevOps Engineer

You are the tenth logical role: Project Manager / Orchestrator.

YOUR RESPONSIBILITIES:

- Understand the user's software requirements.
- Identify the application type, features and constraints.
- Break large projects into clear development phases.
- Identify which specialist agents should handle each task.
- Explain architecture and technical decisions in simple language.
- Ask concise clarification questions when essential requirements are missing.
- Prefer SAP CAP, SAP BTP, Node.js and Fiori when the user requests SAP applications.
- Maintain consistency across the project's architecture and implementation.

EXECUTION RULES:

- Project execution is handled by a separate execution API.
- Never claim that an agent has executed a task unless the execution system confirms it.
- Never claim files were generated or tests passed without actual execution results.
- Do not claim deployment or publishing has happened unless explicitly performed and confirmed.
- Generated files are staged for review and are not automatically deployed.
- Destructive operations, external publishing, deployment and credential changes require explicit approval.

CHAT BEHAVIOR:

- Help users refine requirements before project execution.
- Explain proposed features, architecture, dependencies and technology choices.
- Keep responses structured, practical and concise.
- Do not fabricate project status or execution progress.

You are responsible for coordinating the complete DevTeamAI development workflow.
`;
}


async function handleChat(req, res) {
    if (Date.now() - windowStarted >= CHAT_WINDOW_MS) {
        requestCount = 0;
        windowStarted = Date.now();
    }

    if (++requestCount > MAX_CHAT_REQUESTS) {
        return sendJSON(res, 429, {
            success: false,
            error: "Too many requests. Please wait a minute."
        });
    }

    let body;

    try {
        body = await readBody(req);
    } catch (error) {
        return sendJSON(res, 400, {
            success: false,
            error: error.message
        });
    }

    const message = body.message;

    if (typeof message !== "string" || !message.trim()) {
        return sendJSON(res, 400, {
            success: false,
            error: "Please enter a project request."
        });
    }

    if (message.length > 8000) {
        return sendJSON(res, 400, {
            success: false,
            error: "Message is too long. Maximum 8000 characters."
        });
    }

    try {
        const result = await askWithFallback(
            message.trim(),
            getProjectManagerPrompt(),
            {
                maxTokens: 2500,
                temperature: 0.3,
                timeout: 120000,
                reasoningEffort: "low"
            }
        );

        return sendJSON(res, 200, {
            success: true,
            reply: result.content,
            model: result.model,
            usage: result.usage,
            provider: result.provider || null
        });

    } catch (error) {
        console.error("[AI CHAT ERROR]", error.message);

        return sendJSON(res, 502, {
            success: false,
            error: "AI request failed. Please try again."
        });
    }
}


// --------------------------------------------------
// PROJECT EXECUTION
// --------------------------------------------------

async function handleProjectRun(req, res) {
    if (projectRunActive) {
        return sendJSON(res, 409, {
            success: false,
            error: "Another project run is already in progress."
        });
    }

    let body;

    try {
        body = await readBody(req);
    } catch (error) {
        return sendJSON(res, 400, {
            success: false,
            error: error.message
        });
    }

    const projectName = body.projectName;
    const description = body.description;

    const approveFunctionalTests =
        body.approveFunctionalTests === true;

    if (
        typeof projectName !== "string" ||
        !projectName.trim() ||
        projectName.length > 80
    ) {
        return sendJSON(res, 400, {
            success: false,
            error: "Provide a project name of at most 80 characters."
        });
    }

    if (
        typeof description !== "string" ||
        !description.trim() ||
        description.length > 8000
    ) {
        return sendJSON(res, 400, {
            success: false,
            error: "Provide a project description of at most 8000 characters."
        });
    }

    const cleanName = projectName.trim();
    const cleanDescription = description.trim();

    const projectSlug = slugifyProjectName(cleanName);

    if (!projectSlug) {
        return sendJSON(res, 400, {
            success: false,
            error: "Project name must contain letters or numbers."
        });
    }

    const runId = randomUUID();

    projectRunActive = true;

    activeRun = {
        runId,
        projectSlug,
        projectName: cleanName,
        startedAt: new Date().toISOString(),
        mode: "new"
    };

    console.log("[DEVTEAM] New project accepted:", cleanName);
    console.log("[DEVTEAM] Run ID:", runId);

    const execution = runProject({
        projectName: cleanName,
        description: cleanDescription,
        runId,
        resume: false,
        approveFunctionalTests
    });

    execution
        .then(result => {
            console.log(
                `[DEVTEAM] Project finished: ${result.status} | ` +
                `Completed: ${result.completed}/${result.totalTasks} | ` +
                `QA: ${result.qaStatus}`
            );
        })
        .catch(error => {
            console.error("[DEVTEAM] Project run failed:", error.message);

            try {
                const projectRoot = getProjectRoot(projectSlug);
                const state = loadProjectState(projectRoot);

                if (state && state.runId === runId) {
                    state.status = "failed";
                    state.fatalError = error.message;
                    state.completedAt = new Date().toISOString();
                    state.updatedAt = new Date().toISOString();

                    saveProjectState(projectRoot, state);

                    recordEvent(projectRoot, {
                        type: "project.fatal_error",
                        runId,
                        error: error.message
                    });
                }
            } catch (stateError) {
                console.error(
                    "[DEVTEAM] Could not save fatal run status:",
                    stateError.message
                );
            }
        })
        .finally(() => {
            projectRunActive = false;
            activeRun = null;
        });

    return sendJSON(res, 202, {
        success: true,
        accepted: true,
        runId,
        projectName: cleanName,
        projectSlug,
        status: "planning"
    });
}


// --------------------------------------------------
// PROJECT RESUME
// --------------------------------------------------

async function handleProjectResume(req, res) {
    if (projectRunActive) {
        return sendJSON(res, 409, {
            success: false,
            error: "Another project run is already in progress."
        });
    }

    let body;

    try {
        body = await readBody(req);
    } catch (error) {
        return sendJSON(res, 400, {
            success: false,
            error: error.message
        });
    }

    const projectSlug = body.projectSlug;
    const runId = body.runId;

    const approveFunctionalTests =
        body.approveFunctionalTests === true;

    if (
        typeof projectSlug !== "string" ||
        !PROJECT_SLUG_REGEX.test(projectSlug) ||
        projectSlug.length > 50
    ) {
        return sendJSON(res, 400, {
            success: false,
            error: "Invalid project slug."
        });
    }

    if (
        typeof runId !== "string" ||
        !RUN_ID_REGEX.test(runId)
    ) {
        return sendJSON(res, 400, {
            success: false,
            error: "Invalid project run ID."
        });
    }

    let projectRoot;
    let savedState;

    try {
        projectRoot = getProjectRoot(projectSlug);
        savedState = loadProjectState(projectRoot);
    } catch (error) {
        console.error("[RESUME] Project lookup failed:", error.message);

        return sendJSON(res, 500, {
            success: false,
            error: "Unable to load the saved project."
        });
    }

    if (!savedState || savedState.runId !== runId) {
        return sendJSON(res, 404, {
            success: false,
            error: "No matching saved project run was found."
        });
    }

    if (
        typeof savedState.projectName !== "string" ||
        typeof savedState.description !== "string" ||
        !savedState.description.trim()
    ) {
        return sendJSON(res, 400, {
            success: false,
            error: "Saved project details are incomplete."
        });
    }

    const projectName = savedState.projectName;
    const description = savedState.description;

    projectRunActive = true;

    activeRun = {
        runId,
        projectSlug,
        projectName,
        startedAt: new Date().toISOString(),
        mode: "resume"
    };

    console.log("[DEVTEAM] Resuming project:", projectName);
    console.log("[DEVTEAM] Original Run ID:", runId);

    try {
        recordEvent(projectRoot, {
            type: "project.resume_requested",
            runId,
            projectSlug
        });
    } catch (error) {
        projectRunActive = false;
        activeRun = null;

        console.error("[RESUME] Could not record resume event:", error.message);

        return sendJSON(res, 500, {
            success: false,
            error: "Unable to record the resume request."
        });
    }

    const execution = runProject({
        projectName,
        description,
        runId,
        resume: true,
        approveFunctionalTests
    });

    execution
        .then(result => {
            console.log(
                `[DEVTEAM] Resumed project finished: ${result.status} | ` +
                `Completed: ${result.completed}/${result.totalTasks}`
            );
        })
        .catch(error => {
            console.error(
                "[DEVTEAM] Project resume failed:",
                error.message
            );

            try {
                const state = loadProjectState(projectRoot);

                if (state && state.runId === runId) {
                    state.status = "failed";
                    state.fatalError = error.message;
                    state.completedAt = new Date().toISOString();
                    state.updatedAt = new Date().toISOString();

                    saveProjectState(projectRoot, state);

                    recordEvent(projectRoot, {
                        type: "project.resume_failed",
                        runId,
                        error: error.message
                    });
                }
            } catch (stateError) {
                console.error(
                    "[RESUME] Could not save failure status:",
                    stateError.message
                );
            }
        })
        .finally(() => {
            projectRunActive = false;
            activeRun = null;
        });

    return sendJSON(res, 202, {
        success: true,
        accepted: true,
        resumed: true,
        runId,
        projectName,
        projectSlug,
        status: "executing"
    });
}


// --------------------------------------------------
// PROJECT STATUS
// --------------------------------------------------

function handleProjectStatus(req, res, url) {
    const projectSlug = url.searchParams.get("projectSlug");
    const runId = url.searchParams.get("runId");

    if (
        !projectSlug ||
        !PROJECT_SLUG_REGEX.test(projectSlug) ||
        projectSlug.length > 50
    ) {
        return sendJSON(res, 400, {
            success: false,
            error: "Invalid project slug."
        });
    }

    if (!runId || !RUN_ID_REGEX.test(runId)) {
        return sendJSON(res, 400, {
            success: false,
            error: "Invalid run ID."
        });
    }

    try {
        const projectRoot = getProjectRoot(projectSlug);
        const state = loadProjectState(projectRoot);

        if (!state || state.runId !== runId) {
            return sendJSON(res, 404, {
                success: false,
                error: "Project run was not found."
            });
        }

        const tasks = Array.isArray(state.tasks) ? state.tasks : [];

        const completed =
            tasks.filter(task => task.status === "completed").length;

        const failed =
            tasks.filter(task => task.status === "failed").length;

        const skipped =
            tasks.filter(task => task.status === "skipped").length;

        return sendJSON(res, 200, {
            success: true,
            terminal: isTerminalProjectStatus(state.status),

            projectName: state.projectName,
            projectSlug: state.projectSlug,
            runId: state.runId,

            status: state.status,
            // Folder that can be run directly (npm install && npm start).
            runnablePath: state.runtime && state.runtime.projectPath
                ? state.runtime.projectPath
                : null,

            runtime: state.runtime ? {
                status: state.runtime.status,
                cyclesUsed: state.runtime.cyclesUsed || 0,
                command: state.runtime.command || null,
                url: state.runtime.url || null,
                note: state.runtime.note || null,
                error: state.runtime.error
                    ? String(state.runtime.error).slice(0, 1500)
                    : null
            } : null,

            createdAt: state.createdAt,
            updatedAt: state.updatedAt,
            completedAt: state.completedAt || null,

            plan: state.plan ? {
                summary: state.plan.summary || "",
                technologyStack: state.plan.technologyStack || []
            } : null,

            progress: {
                total: tasks.length,
                completed,
                failed,
                skipped,

                running:
                    tasks.filter(task => task.status === "running").length,

                pending:
                    tasks.filter(task => task.status === "pending").length
            },

            tasks: tasks.map(task => ({
                id: task.id,
                title: task.title,
                agentId: task.agentId,
                status: task.status,
                error: task.error || null,

                result: task.result ? {
                    agentName: task.result.agentName,
                    summary: task.result.summary,
                    files: task.result.files || [],
                    model: task.result.model || null
                } : null
            })),

            generatedFiles: state.generatedFiles || [],

            integration: state.integration || {
                status: "pending"
            },

            qa: state.qa || {
                status: "pending"
            },

            verification: state.verification || {
                status: "pending",
                build: "not_run",
                functionalTests: "not_run",
                evidence: []
            },

            recovery: state.recovery || null,
            fatalError: state.fatalError || null
        });

    } catch (error) {
        console.error("[DEVTEAM] Status lookup failed:", error.message);

        return sendJSON(res, 500, {
            success: false,
            error: "Unable to read project status."
        });
    }
}


// --------------------------------------------------
// HEALTH
// --------------------------------------------------

function handleHealth(req, res) {
    return sendJSON(res, 200, {
        success: true,
        application: "DevTeamAI",
        status: "running",
        projectExecutionActive: projectRunActive,
        activeRun,
        providerOrder: getProviderOrder()
    });
}


// --------------------------------------------------
// STATIC FILE SERVER
// --------------------------------------------------

function serveStaticFile(req, res, pathname) {
    if (pathname === "/") {
        pathname = "/index.html";
    }

    let decodedPath;

    try {
        decodedPath = decodeURIComponent(pathname);
    } catch {
        res.writeHead(400);
        return res.end("Bad request");
    }

    if (decodedPath.includes("\0")) {
        res.writeHead(400);
        return res.end("Bad request");
    }

    const filePath = path.resolve(PUBLIC_DIR, "." + decodedPath);

    if (!isInsideDirectory(PUBLIC_DIR, filePath)) {
        res.writeHead(403);
        return res.end("Forbidden");
    }

    fs.stat(filePath, (statError, stats) => {
        if (statError || !stats.isFile()) {
            res.writeHead(404);
            return res.end("File not found");
        }

        fs.readFile(filePath, (error, content) => {
            if (error) {
                res.writeHead(500);
                return res.end("Unable to read file");
            }

            res.writeHead(200, {
                "Content-Type":
                    MIME_TYPES[path.extname(filePath).toLowerCase()] ||
                    "application/octet-stream",

                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff"
            });

            if (req.method === "HEAD") {
                return res.end();
            }

            return res.end(content);
        });
    });
}


// --------------------------------------------------
// ROUTER
// --------------------------------------------------

const server = http.createServer(async (req, res) => {
    let url;

    try {
        url = new URL(req.url, "http://localhost");
    } catch {
        return sendJSON(res, 400, {
            success: false,
            error: "Invalid request URL."
        });
    }


    // Health
    if (url.pathname === "/api/health") {
        if (req.method !== "GET") {
            return sendJSON(res, 405, {
                success: false,
                error: "Method not allowed."
            });
        }

        return handleHealth(req, res);
    }


    // Start new project
    if (url.pathname === "/api/projects/run") {
        if (req.method !== "POST") {
            return sendJSON(res, 405, {
                success: false,
                error: "Method not allowed."
            });
        }

        return handleProjectRun(req, res);
    }


    // Resume existing project
    if (url.pathname === "/api/projects/resume") {
        if (req.method !== "POST") {
            return sendJSON(res, 405, {
                success: false,
                error: "Method not allowed."
            });
        }

        return handleProjectResume(req, res);
    }


    // Project status
    if (url.pathname === "/api/projects/status") {
        if (req.method !== "GET") {
            return sendJSON(res, 405, {
                success: false,
                error: "Method not allowed."
            });
        }

        return handleProjectStatus(req, res, url);
    }


    // AI chat
    if (url.pathname === "/api/chat") {
        if (req.method !== "POST") {
            return sendJSON(res, 405, {
                success: false,
                error: "Method not allowed."
            });
        }

        return handleChat(req, res);
    }


    // Static frontend
    if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405);
        return res.end("Method not allowed");
    }

    return serveStaticFile(req, res, url.pathname);
});


// --------------------------------------------------
// START SERVER
// --------------------------------------------------

server.listen(PORT, "0.0.0.0", () => {
    console.log("==================================");
    console.log("       DEVTEAMAI SERVER");
    console.log("==================================");

    console.log(`Dashboard: http://localhost:${PORT}`);

    console.log("API: POST /api/chat");
    console.log("API: POST /api/projects/run");
    console.log("API: POST /api/projects/resume");
    console.log("API: GET /api/projects/status");
    console.log("API: GET /api/health");

    console.log("Provider order:", getProviderOrder());

    console.log("==================================");
});


server.on("error", error => {
    console.error("[SERVER ERROR]", error.message);
    process.exitCode = 1;
});
