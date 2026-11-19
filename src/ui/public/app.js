const agents = [
    { name: "Project Manager", role: "Coordinates the entire AI team", icon: "♛" },
    { name: "Business Analyst", role: "Understands requirements and workflows", icon: "▤" },
    { name: "Solution Architect", role: "Plans technical architecture", icon: "⌘" },
    { name: "Database Engineer", role: "Designs schemas and data models", icon: "▦" },
    { name: "Backend Developer", role: "Builds APIs and business logic", icon: "⌘" },
    { name: "Frontend Developer", role: "Builds user interfaces", icon: "▣" },
    { name: "Integration Engineer", role: "Connects services and APIs", icon: "⇄" },
    { name: "QA Engineer", role: "Tests and validates applications", icon: "✓" },
    { name: "Security Engineer", role: "Reviews application security", icon: "⬡" },
    { name: "DevOps Engineer", role: "Handles build and deployment", icon: "☁" }
];

const agentGrid = document.getElementById("agentGrid");
const agentStatusNodes = new Map();

agents.forEach(agent => {
    const card = document.createElement("article");
    card.className = "agent-card";

    const icon = document.createElement("div");
    icon.className = "agent-icon";
    icon.textContent = agent.icon;

    const title = document.createElement("h3");
    title.textContent = agent.name;

    const description = document.createElement("p");
    description.textContent = agent.role;

    const status = document.createElement("div");
    status.className = "agent-status";
    status.dataset.status = "ready";
    status.textContent = "Ready";
    agentStatusNodes.set(agent.name, status);

    card.append(icon, title, description, status);
    agentGrid.appendChild(card);
});

const form = document.getElementById("chatForm");
const input = document.getElementById("promptInput");
const messages = document.getElementById("messages");
const activityList = document.getElementById("activityList");
const sendButton = document.getElementById("sendButton");
function renderMarkdown(container, markdown) {
    const escapeHTML = value =>
        value.replace(/[&<>"']/g, char => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;"
        })[char]);

    const normalized = String(markdown)
        .replace(/\\([*_#`|<>])/g, "$1")
        .replace(/<br\s*\/?>/gi, "\n");

    const inline = text => {
        let safe = escapeHTML(text);

        safe = safe.replace(/`([^`]+)`/g, "<code>$1</code>");
        safe = safe.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
        safe = safe.replace(/\*(.+?)\*/g, "<em>$1</em>");

        return safe;
    };

    container.replaceChildren();

    const lines = normalized.split(/\r?\n/);
    let list = null;
    let listType = null;

    function closeList() {
        if (list) {
            container.appendChild(list);
            list = null;
            listType = null;
        }
    }

    for (const line of lines) {
        const trimmed = line.trim();

        if (!trimmed) {
            closeList();
            continue;
        }

        const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);

        if (heading) {
            closeList();

            const element = document.createElement(
                `h${heading[1].length}`
            );

            element.innerHTML = inline(heading[2]);
            container.appendChild(element);
            continue;
        }

        if (/^---+$/.test(trimmed)) {
            closeList();
            container.appendChild(document.createElement("hr"));
            continue;
        }

        const bullet = trimmed.match(/^[-*]\s+(.+)$/);
        const numbered = trimmed.match(/^\d+[.)]\s+(.+)$/);

        if (bullet || numbered) {
            const type = bullet ? "ul" : "ol";

            if (listType !== type) {
                closeList();
                list = document.createElement(type);
                listType = type;
            }

            const item = document.createElement("li");
            item.innerHTML = inline((bullet || numbered)[1]);
            list.appendChild(item);
            continue;
        }

        closeList();

        const paragraph = document.createElement("p");
        paragraph.innerHTML = inline(trimmed);
        container.appendChild(paragraph);
    }

    closeList();
}
function addMessage(role, text) {
    const message = document.createElement("div");
    message.className = `message ${role === "user" ? "user-message" : "assistant-message"}`;

    const avatar = document.createElement("div");
    avatar.className = "message-avatar";
    avatar.textContent = role === "user" ? "B" : "✦";

    const content = document.createElement("div");
    content.className = "message-content";

    const name = document.createElement("strong");
    name.textContent = role === "user" ? "You" : "AI Project Manager";

    const paragraph = document.createElement("p");
    paragraph.textContent = text;

    content.append(name, paragraph);
    message.append(avatar, content);
    messages.appendChild(message);

    messages.scrollTop = messages.scrollHeight;
    return paragraph;
}

function addActivity(title, description) {
    const empty = activityList.querySelector(".empty-activity");
    if (empty) empty.remove();

    const item = document.createElement("div");
    item.className = "activity-item";

    const icon = document.createElement("div");
    icon.className = "activity-icon";
    icon.textContent = "✦";

    const content = document.createElement("div");
    const heading = document.createElement("strong");
    heading.textContent = title;

    const detail = document.createElement("p");
    detail.textContent = description;

    const time = document.createElement("time");
    time.textContent = new Date().toLocaleTimeString();

    content.append(heading, detail, time);
    item.append(icon, content);
    activityList.prepend(item);
}

async function submitRequest(text) {
    const prompt = text.trim();

    if (!prompt || sendButton.disabled) return;

    addMessage("user", prompt);

    input.value = "";
    sendButton.disabled = true;
    sendButton.textContent = "Thinking...";

    const replyElement = addMessage(
        "assistant",
        "Project Manager is analyzing your request..."
    );

    addActivity("Request received", "Project Manager is processing your requirements.");

    try {
        const response = await fetch("/api/chat", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                message: prompt
            })
        });

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || "AI request failed.");
        }

        renderMarkdown(replyElement, result.reply);

        addActivity(
            "Project Manager responded",
            `Model: ${result.model || "OpenRouter free"}`
        );

    } catch (error) {
        replyElement.textContent =
            "I couldn't process your request: " + error.message;

        addActivity("Request failed", error.message);

    } finally {
        sendButton.disabled = false;
        sendButton.textContent = "Send Request ↑";
        input.focus();
    }
}

form.addEventListener("submit", event => {
    event.preventDefault();
    submitRequest(input.value);
});

input.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        form.requestSubmit();
    }
});

document.querySelectorAll(".suggestion").forEach(button => {
    button.addEventListener("click", () => {
        input.value = button.dataset.prompt || "";
        input.focus();
    });
});

document.querySelectorAll(".nav-link").forEach(link => {
    link.addEventListener("click", () => {
        document.querySelectorAll(".nav-link").forEach(item =>
            item.classList.remove("active")
        );

        link.classList.add("active");
    });
});


// --------------------------------------------------
// REAL PROJECT EXECUTION DASHBOARD
// --------------------------------------------------

const projectRunForm = document.getElementById("projectRunForm");
const projectNameInput = document.getElementById("projectNameInput");
const projectDescriptionInput = document.getElementById("projectDescriptionInput");
const approveFunctionalTestsInput =
    document.getElementById("approveFunctionalTests");
const projectRunButton = document.getElementById("projectRunButton");
const projectRunMessage = document.getElementById("projectRunMessage");
const projectProgress = document.getElementById("projectProgress");
const projectProgressName = document.getElementById("projectProgressName");
const projectProgressStatus = document.getElementById("projectProgressStatus");
const projectProgressCount = document.getElementById("projectProgressCount");
const projectProgressBar = document.getElementById("projectProgressBar");
const projectProgressDetails = document.getElementById("projectProgressDetails");
const integrationStatus = document.getElementById("integrationStatus");
const qaStatus = document.getElementById("qaStatus");
const generatedFileCount = document.getElementById("generatedFileCount");

const agentDisplayNames = {
    "business-analyst": "Business Analyst",
    "solution-architect": "Solution Architect",
    "database-engineer": "Database Engineer",
    "backend-developer": "Backend Developer",
    "frontend-developer": "Frontend Developer",
    "integration-engineer": "Integration Engineer",
    "qa-engineer": "QA Engineer",
    "security-engineer": "Security Engineer",
    "devops-engineer": "DevOps Engineer"
};

let currentProjectPollTimer = null;
let currentProjectRun = null;

function setAgentStatus(agentName, status, detail) {
    const node = agentStatusNodes.get(agentName);
    if (!node) return;

    const label = status === "running" ? "Working"
        : status === "completed" ? "Completed"
        : status === "failed" ? "Failed"
        : status === "skipped" ? "Skipped"
        : status === "pending" ? "Waiting"
        : status === "ready" ? "Ready"
        : status;

    node.dataset.status = status;
    node.textContent = detail ? `${label} · ${detail}` : label;
}

function renderProjectStatus(data) {
    projectProgress.hidden = false;
    projectProgressName.textContent = data.projectName || "Project";
    projectProgressStatus.textContent = String(data.status || "planning").replaceAll("_", " ");

    const progress = data.progress || {};
    const total = progress.total || 9;
    const completed = progress.completed || 0;
    const failed = progress.failed || 0;
    const skipped = progress.skipped || 0;
    const done = completed + failed + skipped;
    const percent = total ? Math.round((done / total) * 100) : 0;

    projectProgressCount.textContent =
        `${completed} completed · ${failed} failed · ${skipped} skipped`;

    projectProgressBar.style.width = `${percent}%`;

    const taskByAgent = new Map(
        (data.tasks || []).map(task => [task.agentId, task])
    );

    for (const [agentId, agentName] of Object.entries(agentDisplayNames)) {
        const task = taskByAgent.get(agentId);

        if (!task) {
            setAgentStatus(agentName, "pending");
            continue;
        }

        const summary = task.result?.summary || task.error || "";
        setAgentStatus(
            agentName,
            task.status || "pending",
            summary.length > 65 ? summary.slice(0, 62) + "..." : summary
        );
    }

    const integration = data.integration?.status || "pending";
    const qa = data.qa?.status || "pending";
    const verification = data.verification || {};
    const verificationStatus = verification.status || "pending";

    integrationStatus.textContent = integration.replaceAll("_", " ");
    qaStatus.textContent = qa.replaceAll("_", " ");
    generatedFileCount.textContent =
        String((data.generatedFiles || []).length);

    projectProgressDetails.replaceChildren();

    for (const task of data.tasks || []) {
        const row = document.createElement("div");
        row.className = "progress-task-row";

        const name = document.createElement("strong");
        name.textContent = agentDisplayNames[task.agentId] || task.agentId;

        const status = document.createElement("span");
        status.dataset.status = task.status || "pending";
        status.textContent = task.status || "pending";

        const detail = document.createElement("p");
        detail.textContent =
            task.error ||
            task.result?.summary ||
            task.title ||
            "";

        row.append(name, status, detail);
        projectProgressDetails.appendChild(row);
    }

    if (data.fatalError) {
        projectRunMessage.textContent = `Execution error: ${data.fatalError}`;
    } else {
        projectRunMessage.textContent =
            data.terminal ? "Project execution finished." : "Project execution is running.";
    }

    const projectList = document.getElementById("projectList");
    projectList.className = "project-empty project-result";
    projectList.replaceChildren();

    const title = document.createElement("strong");
    title.textContent = data.projectName || "Project";

    const description = document.createElement("p");
    description.textContent =
        `Status: ${data.status} · ${completed}/${total} agents completed · ` +
        `${(data.generatedFiles || []).length} staged files`;

    const verificationLine = document.createElement("p");
    verificationLine.textContent =
        `Verification: ${verificationStatus.replaceAll("_", " ")} · ` +
        `Functional tests: ${(verification.functionalTests || "not_run").replaceAll("_", " ")}`;

        const runtime = data.runtime || null;
    const runtimeLine = document.createElement("p");

    if (!runtime) {
        runtimeLine.textContent = "Real run check: not run";
    } else if (runtime.status === "verified") {
        runtimeLine.textContent =
            `Real run check: PASSED (${runtime.cyclesUsed} cycle(s))` +
            (runtime.url ? ` · ${runtime.url}` : "");
    } else if (runtime.status === "running") {
        runtimeLine.textContent =
            "Real run check: installing, starting and repairing...";
    } else {
        runtimeLine.textContent =
            `Real run check: ${runtime.status}` +
            (runtime.error ? ` · ${runtime.error.slice(0, 300)}` : "");
    }

    const path = document.createElement("p");
    path.textContent = data.runnablePath
        ? `Run it: cd ${data.runnablePath} && npm install && npm start`
        : `workspace/${data.projectSlug}`;

    projectList.append(title, description, verificationLine, runtimeLine, path);
}

async function pollProjectStatus(projectSlug, runId) {
    if (
        !currentProjectRun ||
        currentProjectRun.runId !== runId
    ) {
        return;
    }

    try {
        const query = new URLSearchParams({ projectSlug, runId });
        const response = await fetch(`/api/projects/status?${query}`, {
            cache: "no-store"
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || "Could not read project status.");
        }

        renderProjectStatus(data);

        if (data.terminal) {
            currentProjectRun = null;
            localStorage.removeItem("devteamai.activeRun");
            projectRunButton.disabled = false;
            projectRunButton.textContent = "Start AI Build →";

            addActivity(
                "Project execution finished",
                `${data.projectName}: ${data.status}`
            );

            return;
        }

    } catch (error) {
        projectRunMessage.textContent =
            `Status connection issue: ${error.message}. Retrying...`;
    }

    currentProjectPollTimer = setTimeout(
        () => pollProjectStatus(projectSlug, runId),
        2000
    );
}

async function startProjectExecution(
    projectName,
    description,
    approveFunctionalTests
) {
    if (currentProjectRun) return;

    projectRunButton.disabled = true;
    projectRunButton.textContent = "Starting...";
    projectRunMessage.textContent = "Submitting project to the AI team...";

    try {
        const response = await fetch("/api/projects/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                projectName,
                description,
                approveFunctionalTests: approveFunctionalTests === true
            })
        });

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || "Could not start project.");
        }

        currentProjectRun = {
            runId: result.runId,
            projectSlug: result.projectSlug
        };

        localStorage.setItem(
            "devteamai.activeRun",
            JSON.stringify(currentProjectRun)
        );

        projectProgress.hidden = false;
        projectProgressName.textContent = result.projectName;
        projectProgressStatus.textContent = "planning";
        projectRunMessage.textContent = `Run accepted: ${result.runId}`;

        addActivity(
            "Project run started",
            `${result.projectName} · Run ${result.runId}`
        );

        await pollProjectStatus(result.projectSlug, result.runId);

    } catch (error) {
        currentProjectRun = null;
        projectRunButton.disabled = false;
        projectRunButton.textContent = "Start AI Build →";
        projectRunMessage.textContent = error.message;
        addActivity("Project start failed", error.message);
    }
}

projectRunForm.addEventListener("submit", event => {
    event.preventDefault();

    const name = projectNameInput.value.trim();
    const description = projectDescriptionInput.value.trim();

    if (!name || !description) {
        projectRunMessage.textContent =
            "Enter both a project name and project description.";
        return;
    }

    startProjectExecution(
        name,
        description,
        approveFunctionalTestsInput.checked
    );
});

// Restore tracking after a dashboard refresh.
try {
    const savedRun = JSON.parse(
        localStorage.getItem("devteamai.activeRun") || "null"
    );

    if (
        savedRun &&
        typeof savedRun.projectSlug === "string" &&
        typeof savedRun.runId === "string"
    ) {
        currentProjectRun = savedRun;
        projectRunButton.disabled = true;
        projectRunButton.textContent = "Build in Progress...";
        pollProjectStatus(savedRun.projectSlug, savedRun.runId);
    }
} catch {
    localStorage.removeItem("devteamai.activeRun");
}
