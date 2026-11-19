const { executeAgentTask } = require("./orchestrator/engine");

async function main() {
    console.log("\n================================");
    console.log("   BUSINESS ANALYST AGENT TEST");
    console.log("================================\n");

    const result = await executeAgentTask({
        agentId: "business-analyst",

        projectContext: `
Build ProcureFlow, an enterprise procurement platform
using SAP CAP Node.js and SAP BTP.

Modules include:
- Supplier onboarding and ratings
- Purchase requisitions
- RFQs and quotation comparison
- Purchase orders
- Multi-level approvals
- Inventory and goods receipts
- Invoice processing and three-way matching
- Payment tracking
- AI insights and analytics
`,

        task: `
Prepare the initial business requirements for ProcureFlow.

Identify:
1. User roles and responsibilities.
2. Main business workflows.
3. Functional requirements.
4. Important business rules.
5. Acceptance criteria for the procurement request workflow.

Keep the output practical and implementation-ready.
`
    });

    console.log("\n========== AGENT DELIVERABLE ==========\n");
    console.log(result.output);
    console.log("\n========== EXECUTION DETAILS ==========\n");
    console.log("Agent:", result.agentName);
    console.log("Status:", result.status);
    console.log("Model:", result.model);
    console.log("Usage:", JSON.stringify(result.usage, null, 2));
}

main().catch(error => {
    console.error("Agent test failed:", error.message);
    process.exitCode = 1;
});
