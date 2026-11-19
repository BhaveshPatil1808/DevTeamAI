
const assert = require("node:assert/strict");

// Mock the AI provider BEFORE loading the delegator.
const routerPath = require.resolve("./providers/router");

let callCount = 0;
let repairPromptReceived = false;

const malformedResponse =
    '{"summary":"broken","files":[}';

const validResponse = JSON.stringify({
    summary: "Generated frontend component",
    files: [
        {
            path: "src/frontend/TaskDashboard.jsx",
            content: [
                "function TaskDashboard() {",
                "  return { success: true };",
                "}",
                "",
                "module.exports = TaskDashboard;"
            ].join("\n")
        }
    ]
});

// Install the mock provider.
require.cache[routerPath] = {
    id: routerPath,
    filename: routerPath,
    loaded: true,
    exports: {
        askWithFallback: async (prompt, systemPrompt, options = {}) => {
            callCount++;

            console.log(
                `[MOCK AI] Attempt ${callCount}, maxTokens: ${options.maxTokens}`
            );

            // Attempt 1: Initial generation returns malformed JSON.
            if (callCount === 1) {
                return {
                    content: malformedResponse,
                    model: "mock-model",
                    finishReason: "stop",
                    truncated: false,
                    usage: { total_tokens: 100 }
                };
            }

            // Attempt 2: Focused retry also returns malformed JSON.
            if (callCount === 2) {
                return {
                    content: malformedResponse,
                    model: "mock-model",
                    finishReason: "stop",
                    truncated: false,
                    usage: { total_tokens: 120 }
                };
            }

            // Attempt 3: JSON repair returns valid JSON.
            if (callCount === 3) {
                const combinedPrompt =
                    `${prompt || ""}\n${systemPrompt || ""}`;

                const containsMalformedResponse =
                    combinedPrompt.includes(malformedResponse);

                const containsRepairInstruction =
                    /json repair specialist|repair.*json|valid json/i.test(
                        combinedPrompt
                    );

                console.log(
                    "[DEBUG] Malformed response included:",
                    containsMalformedResponse
                );

                console.log(
                    "[DEBUG] Repair instruction included:",
                    containsRepairInstruction
                );

                repairPromptReceived =
                    containsMalformedResponse &&
                    containsRepairInstruction;

                return {
                    content: validResponse,
                    model: "mock-model",
                    finishReason: "stop",
                    truncated: false,
                    usage: { total_tokens: 150 }
                };
            }

            throw new Error("Unexpected additional AI call.");
        }
    }
};

// Load delegator only after installing the mock.
const {
    executePlannedTask
} = require("./orchestrator/delegator");

async function runTest() {
    console.log("\n=== DevTeamAI JSON Repair Test ===\n");

    const result = await executePlannedTask({
        task: {
            id: "frontend-development",
            agentId: "frontend-developer",
            title: "Create responsive UI",
            description: "Generate a task dashboard component."
        },
        projectContext: "Demo task management application."
    });

    // Verify all expected behavior.
    assert.equal(
        callCount,
        3,
        "Expected exactly three AI calls."
    );

    assert.equal(
        repairPromptReceived,
        true,
        "Repair prompt must contain the malformed response and repair instructions."
    );

    assert.equal(
        result.attempts,
        3,
        "Expected three generation attempts."
    );

    assert.equal(
        result.agentId,
        "frontend-developer"
    );

    assert.equal(
        result.files.length,
        1,
        "Expected exactly one generated file."
    );

    assert.equal(
        result.files[0].path,
        "src/frontend/TaskDashboard.jsx"
    );

    assert.ok(
        result.files[0].content.includes("TaskDashboard"),
        "Generated file should contain the TaskDashboard component."
    );

    console.log("\nPASS: Initial generation attempted.");
    console.log("PASS: Focused retry attempted.");
    console.log("PASS: Repair prompt validated.");
    console.log("PASS: Repaired JSON accepted.");
    console.log("PASS: Generated file validated.");
    console.log("PASS: Exactly three mocked AI calls.");

    console.log("\n=== FINAL RESULT: ALL TESTS PASSED ===\n");
}

runTest().catch(error => {
    console.error("\n=== TEST FAILED ===");
    console.error(error);
    process.exitCode = 1;
});
