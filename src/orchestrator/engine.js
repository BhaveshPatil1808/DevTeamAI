
const { askWithFallback } = require("../providers/router");

const {
    getAgent,
    buildAgentPrompt
} = require("../agents/registry");

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

    // Sequential execution preserves predictable quota usage.
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
    executeAgentTask,
    executeTeamTasks
};
