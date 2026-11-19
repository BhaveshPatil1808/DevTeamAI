
const { askWithFallback } = require("../providers/router");

const {
    getAgent,
    getSpecialistAgents,
    buildAgentPrompt
} = require("../agents/registry");

// --------------------------------------------------
// FALLBACK DEPENDENCIES
// Task IDs intentionally match agent IDs.
// --------------------------------------------------

const DEFAULT_DEPENDENCIES = {
    "business-analyst": [],
    "solution-architect": ["business-analyst"],
    "database-engineer": ["solution-architect"],
    "backend-developer": ["solution-architect"],
    "frontend-developer": ["solution-architect"],
    "integration-engineer": [
        "backend-developer",
        "frontend-developer"
    ],
    "qa-engineer": ["integration-engineer"],
    "security-engineer": ["backend-developer"],
    "devops-engineer": [
        "backend-developer",
        "frontend-developer",
        "security-engineer"
    ]
};

// --------------------------------------------------
// JSON EXTRACTION
// --------------------------------------------------

function extractJSON(content) {
    if (typeof content !== "string" || !content.trim()) {
        throw new Error("Planner returned empty content.");
    }

    const cleaned = content
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();

    const start = cleaned.indexOf("{");

    if (start === -1) {
        throw new Error("Planner did not return a JSON object.");
    }

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < cleaned.length; i++) {
        const char = cleaned[i];

        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (char === "\\") {
                escaped = true;
            } else if (char === '"') {
                inString = false;
            }

            continue;
        }

        if (char === '"') {
            inString = true;
        } else if (char === "{") {
            depth++;
        } else if (char === "}") {
            depth--;

            if (depth === 0) {
                return JSON.parse(cleaned.slice(start, i + 1));
            }
        }
    }

    throw new Error("Planner returned incomplete JSON.");
}

// --------------------------------------------------
// TECHNOLOGY STACK NORMALIZATION
// --------------------------------------------------

function normalizeStack(stack, description) {
    if (Array.isArray(stack) && stack.length) {
        return [...new Set(
            stack
                .filter(item => typeof item === "string")
                .map(item => item.trim())
                .filter(Boolean)
        )];
    }

    if (typeof stack === "string" && stack.trim()) {
        return stack
            .split(/[,;]+/)
            .map(item => item.trim())
            .filter(Boolean);
    }

    // Infer only explicitly requested technologies.
    const known = [
        "HTML",
        "CSS",
        "JavaScript",
        "TypeScript",
        "React",
        "Angular",
        "Vue",
        "Node.js",
        "Express",
        "Java",
        "Spring Boot",
        "Python",
        "FastAPI",
        "Flask",
        "SAP CAP",
        "SAPUI5",
        "SQLite",
        "PostgreSQL",
        "MySQL",
        "MongoDB"
    ];

    const text = description.toLowerCase();

    const detected = known.filter(technology => {
        const escaped = technology.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`\\b${escaped.toLowerCase()}\\b`, "i").test(text);
    });

    return detected.length
        ? detected
        : ["Choose the simplest suitable technology for the requirement"];
}

// --------------------------------------------------
// PLAN VALIDATION
// --------------------------------------------------

function validatePlan(plan) {
    const agents = getSpecialistAgents();

    if (!plan || !Array.isArray(plan.tasks)) {
        throw new Error("Plan must contain a tasks array.");
    }

    if (plan.tasks.length !== agents.length) {
        throw new Error(
            `Expected ${agents.length} specialist tasks, received ${plan.tasks.length}.`
        );
    }

    const requiredAgents = new Set(agents.map(agent => agent.id));
    const taskIds = new Set();
    const assignedAgents = new Set();

    const normalizedTasks = plan.tasks.map(item => {
        const agentId = item.agentId;

        if (!requiredAgents.has(agentId)) {
            throw new Error(`Unknown specialist agent: ${agentId}`);
        }

        if (assignedAgents.has(agentId)) {
            throw new Error(`Duplicate specialist task: ${agentId}`);
        }

        assignedAgents.add(agentId);

        const id = agentId;

        if (taskIds.has(id)) {
            throw new Error(`Duplicate task ID: ${id}`);
        }

        taskIds.add(id);

        const agent = getAgent(agentId);

        const taskText =
            item.task ||
            item.description ||
            item.title;

        if (typeof taskText !== "string" || !taskText.trim()) {
            throw new Error(`Missing task instructions for ${agentId}`);
        }

        // Backend must remain capable of progressing if the
        // optional Database Engineer deliverable is unavailable.
        const normalizedTaskText = agentId === "backend-developer"
            ? `${taskText.trim()}

Resilience requirement: Do not depend on a successful Database Engineer task. Use the Solution Architect's architecture as the source of truth. If the Database Engineer's data-model artifact is unavailable, define the required data model and persistence structure yourself, keeping it consistent with the architecture and project requirements.`
            : taskText.trim();

        // Execution dependencies are controlled by DevTeamAI,
        // not by the AI-generated plan.
        return {
            id,
            agentId,
            title: item.title || agent.name,
            task: normalizedTaskText,
            description: normalizedTaskText,
            dependsOn: DEFAULT_DEPENDENCIES[agentId] || []
        };
    });

    if (assignedAgents.size !== requiredAgents.size) {
        throw new Error("The plan is missing one or more specialist agents.");
    }

    // Validate dependency references.
    for (const task of normalizedTasks) {
        for (const dependency of task.dependsOn) {
            if (!taskIds.has(dependency)) {
                throw new Error(
                    `Invalid dependency ${dependency} in ${task.id}`
                );
            }

            if (dependency === task.id) {
                throw new Error(
                    `Task ${task.id} cannot depend on itself.`
                );
            }
        }
    }

    // Topological sorting.
    const ordered = [];
    const completed = new Set();

    while (ordered.length < normalizedTasks.length) {
        const next = normalizedTasks.find(task =>
            !completed.has(task.id) &&
            task.dependsOn.every(dep => completed.has(dep))
        );

        if (!next) {
            throw new Error("Circular dependency detected in project plan.");
        }

        completed.add(next.id);
        ordered.push(next);
    }

    return {
        summary:
            typeof plan.summary === "string" && plan.summary.trim()
                ? plan.summary.trim()
                : "Project plan generated from the user requirement.",

        technologyStack: normalizeStack(
            plan.technologyStack,
            plan.description || plan.summary || ""
        ),

        tasks: ordered
    };
}

// --------------------------------------------------
// DEFAULT PLAN IF AI PLANNING FAILS
// --------------------------------------------------

function createFallbackPlan(projectName, description) {
    const agents = getSpecialistAgents();

    const instructions = {
        "business-analyst":
            "Analyze the requirement, identify user stories, functional requirements, acceptance criteria and edge cases.",

        "solution-architect":
            "Define the application architecture, technology choices, module structure, interfaces and implementation contracts. Respect the technologies explicitly requested by the user.",

        "database-engineer":
            "Design the data model, persistence strategy, entities, relationships and validation rules. Use the simplest suitable persistence approach.",

        "backend-developer":
            "Implement the required backend logic and complete source files according to the architecture and data model. If the application does not need a backend, provide the appropriate application logic artifact.",

        "frontend-developer":
            "Build the complete user interface with responsive styling, interactions, accessibility and the requested visual design.",

        "integration-engineer":
            "Connect the application modules and implement the required integration code. Follow the interfaces established by earlier agents.",

        "qa-engineer":
            "Create meaningful test cases and test artifacts covering core features, validation, edge cases and expected behavior.",

        "security-engineer":
            "Review the application for security issues and provide appropriate security controls and recommendations.",

        "devops-engineer":
            "Prepare appropriate setup instructions, build configuration and deployment artifacts for the selected technology stack."
    };

    return validatePlan({
        summary: `Implementation plan for ${projectName}: ${description}`,

        technologyStack: normalizeStack(null, description),

        tasks: agents.map(agent => ({
            agentId: agent.id,
            title: agent.name,
            task: instructions[agent.id] ||
                `Complete the ${agent.name} responsibilities for this project.`,
            dependsOn: DEFAULT_DEPENDENCIES[agent.id] || []
        }))
    });
}

// --------------------------------------------------
// AI PROJECT PLANNER
// --------------------------------------------------

async function createProjectPlan({
    projectName,
    description
}) {
    if (!projectName || !description) {
        throw new Error("Project name and description are required.");
    }

    const agents = getSpecialistAgents();

    const agentList = agents.map(agent => ({
        id: agent.id,
        name: agent.name,
        outputType: agent.outputType
    }));

    const prompt = `
You are the Project Manager of DevTeamAI.

Create an implementation plan for this software project.

PROJECT NAME:
${projectName}

USER REQUIREMENT:
${description}

AVAILABLE SPECIALIST AGENTS:
${JSON.stringify(agentList, null, 2)}

RULES:
1. Assign exactly one task to every listed specialist.
2. Use each agent ID exactly as provided.
3. Do not add or remove agents.
4. Respect the technology stack explicitly requested by the user.
5. Do not introduce unnecessary frameworks or dependencies.
6. Make tasks specific, practical and implementation-focused.
7. Each task must explain what files or deliverables the agent should create.
8. Each dependency must reference another task's agent ID.
9. Create a logical dependency order.
10. The user expects autonomous execution. Do not ask questions.
11. Keep task descriptions concise but sufficiently detailed.

Return ONLY valid JSON in this exact structure:

{
  "summary": "Short project summary",
  "technologyStack": ["Technology 1", "Technology 2"],
  "tasks": [
    {
      "agentId": "business-analyst",
      "title": "Analyze requirements",
      "task": "Detailed implementation instructions",
      "dependsOn": []
    }
  ]
}

Include all nine specialists exactly once.
`;

    try {
        console.log("[PLANNER] Requesting AI project plan...");

        const result = await askWithFallback(
            prompt,
            "You are an expert autonomous software project manager. Return valid JSON only.",
            {
                maxTokens: 2500,
                temperature: 0.1,
                timeout: 120000,
                reasoningEffort: "low"
            }
        );

        const parsed = extractJSON(result.content);
        const validated = validatePlan(parsed);

        console.log(
            `[PLANNER] AI plan created using ${result.provider}`
        );

        return {
            ...validated,
            planningMode: "ai",
            provider: result.provider,
            model: result.model
        };

    } catch (error) {
        console.error(
            `[PLANNER] AI planning failed: ${error.message}`
        );

        console.log("[PLANNER] Using validated fallback plan.");

        return {
            ...createFallbackPlan(projectName, description),
            planningMode: "fallback",
            provider: "local"
        };
    }
}

// --------------------------------------------------
// EXISTING AGENT EXECUTION FUNCTIONS
// PRESERVED FOR BACKWARD COMPATIBILITY
// --------------------------------------------------

async function executeAgentTask({
    agentId,
    task,
    projectContext = ""
}) {
    const agent = getAgent(agentId);

    if (!agent) {
        throw new Error(`Unknown agent: ${agentId}`);
    }

    if (agentId === "project-manager") {
        throw new Error(
            "The Project Manager coordinates tasks and cannot be executed as a specialist."
        );
    }

    console.log(`[STARTED] ${agent.name}`);

    const prompt = buildAgentPrompt(
        agent,
        projectContext,
        task
    );

    const result = await askWithFallback(
        prompt,
        `You are ${agent.name}, a specialist in software engineering. Follow your assigned role and return practical deliverables.`,
        {
            maxTokens: 2500,
            temperature: 0.2,
            timeout: 120000,
            reasoningEffort: "low"
        }
    );

    console.log(
        `[COMPLETED] ${agent.name} using ${result.provider}`
    );

    return {
        agentId: agent.id,
        agentName: agent.name,
        status: "completed",
        output: result.content,
        model: result.model,
        provider: result.provider,
        usage: result.usage
    };
}

async function executeTeamTasks({
    projectName,
    projectDescription,
    tasks
}) {
    if (!Array.isArray(tasks) || tasks.length === 0) {
        throw new Error("At least one specialist task is required.");
    }

    const results = [];

    const projectContext = `
Project: ${projectName}

Project Description:
${projectDescription}
`;

    for (const task of tasks) {
        try {
            const result = await executeAgentTask({
                agentId: task.agentId,
                task: task.task,
                projectContext
            });

            results.push(result);

        } catch (error) {
            const agent = getAgent(task.agentId);

            results.push({
                agentId: task.agentId,
                agentName: agent?.name || task.agentId,
                status: "failed",
                error: error.message
            });

            console.error(
                `[FAILED] ${task.agentId}: ${error.message}`
            );
        }
    }

    return {
        projectName,
        totalTasks: tasks.length,
        completed: results.filter(
            item => item.status === "completed"
        ).length,
        failed: results.filter(
            item => item.status === "failed"
        ).length,
        results
    };
}

module.exports = {
    createProjectPlan,
    executeAgentTask,
    executeTeamTasks,
    validatePlan,
    createFallbackPlan
};
