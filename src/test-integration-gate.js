const assert = require("node:assert/strict");

const {
    evaluateIntegrationGate
} = require("./orchestrator/project-runner");

const tasks = [
    "business-analyst",
    "solution-architect",
    "database-engineer",
    "backend-developer",
    "frontend-developer",
    "integration-engineer",
    "qa-engineer",
    "security-engineer",
    "devops-engineer"
].map(agentId => ({
    id: agentId,
    agentId
}));

function completed(...agentIds) {
    return new Set(agentIds);
}

function check(name, condition) {
    assert.equal(condition, true, name);
    console.log(`PASS: ${name}`);
}

const coreCompleted = [
    "business-analyst",
    "solution-architect",
    "backend-developer",
    "frontend-developer",
    "integration-engineer"
];

// 1. Database Engineer may fail without blocking integration.
const databaseFailed = evaluateIntegrationGate(
    tasks,
    completed(...coreCompleted),
    [{ path: "backend.js" }]
);
check(
    "Database Engineer failure does not block integration",
    databaseFailed.allowed
);

// 2. Backend is required.
const backendMissing = evaluateIntegrationGate(
    tasks,
    completed(
        "business-analyst",
        "solution-architect",
        "frontend-developer",
        "integration-engineer"
    ),
    [{ path: "frontend.js" }]
);
check(
    "Missing Backend blocks integration",
    !backendMissing.allowed &&
    backendMissing.missingRequiredAgents.includes("backend-developer")
);

// 3. Frontend is required.
const frontendMissing = evaluateIntegrationGate(
    tasks,
    completed(
        "business-analyst",
        "solution-architect",
        "backend-developer",
        "integration-engineer"
    ),
    [{ path: "backend.js" }]
);
check(
    "Missing Frontend blocks integration",
    !frontendMissing.allowed &&
    frontendMissing.missingRequiredAgents.includes("frontend-developer")
);

// 4. Integration Engineer is required.
const integrationMissing = evaluateIntegrationGate(
    tasks,
    completed(
        "business-analyst",
        "solution-architect",
        "backend-developer",
        "frontend-developer"
    ),
    [{ path: "backend.js" }]
);
check(
    "Missing Integration Engineer blocks integration",
    !integrationMissing.allowed &&
    integrationMissing.missingRequiredAgents.includes("integration-engineer")
);

// 5. Generated files are required.
const noFiles = evaluateIntegrationGate(
    tasks,
    completed(...coreCompleted),
    []
);
check(
    "No generated files blocks integration",
    !noFiles.allowed
);

console.log("\nIntegration Gate Tests: 5/5 passed.");
