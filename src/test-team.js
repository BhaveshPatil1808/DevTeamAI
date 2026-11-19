const fs = require("fs");
const path = require("path");
const { executeTeamTasks } = require("./orchestrator/engine");

const projectName = "ProcureFlow";

const projectDescription = `
ProcureFlow is an AI-powered enterprise procurement platform.

Technology:
- SAP CAP Node.js
- React + TypeScript
- PostgreSQL
- SAP BTP
- OpenRouter free AI models

Modules:
- Supplier onboarding and ratings
- Purchase requisitions
- RFQs and quotation comparison
- Purchase orders
- Multi-level approvals
- Inventory and goods receipts
- Invoice processing and three-way matching
- Payment tracking
- AI insights and analytics
- Notifications

Design must be practical, consistent and implementation-ready.
`;

const tasks = [
    {
        agentId: "solution-architect",
        section: "System Architecture",
        task: `
Design the overall ProcureFlow system architecture.

Include:
1. Architecture overview and component diagram in Mermaid.
2. Frontend responsibilities.
3. SAP CAP backend responsibilities.
4. PostgreSQL database responsibilities.
5. SAP BTP deployment architecture.
6. How frontend, backend and database communicate.

Keep it complete and concise. Do not discuss database table definitions.
`
    },
    {
        agentId: "solution-architect",
        section: "Services and API Design",
        task: `
Design ProcureFlow's backend service architecture.

Include:
1. CAP service boundaries for every business module.
2. Main responsibilities of each service.
3. Important OData V4 APIs and business actions.
4. Synchronous and asynchronous communication.
5. External integration architecture.
6. Recommended project folder structure.

Make every section specific to ProcureFlow.
`
    },
    {
        agentId: "solution-architect",
        section: "Security and Development Roadmap",
        task: `
Design ProcureFlow's security and implementation strategy.

Include:
1. Authentication using SAP BTP XSUAA or IAS.
2. RBAC roles and permissions.
3. CAP authorization implementation approach.
4. API security and secret management.
5. Logging, monitoring and error handling.
6. Testing and deployment strategy.
7. Development phases with dependencies.

Keep it practical for implementation.
`
    },
    {
        agentId: "database-engineer",
        section: "Entities and Relationships",
        task: `
Design the complete ProcureFlow relational database.

List entities, their important fields and data types.

Cover:
Supplier, SupplierRating, SupplierDocument,
Requisition, RequisitionItem,
RFQ, RFQItem, RFQSupplier,
Quotation, QuotationItem,
PurchaseOrder, PurchaseOrderItem,
ApprovalProcess, ApprovalStep, ApprovalHistory,
Inventory, InventoryMovement,
GoodsReceipt, GoodsReceiptItem,
Invoice, InvoiceItem,
Payment, Notification, Insight.

Explain primary keys, foreign keys and cardinality.

Do not generate lengthy SQL.
`
    },
    {
        agentId: "database-engineer",
        section: "SAP CAP CDS Data Model",
        task: `
Create implementation-ready SAP CAP CDS definitions.

Include:
1. Namespace.
2. Reusable common aspects.
3. Supplier and SupplierRating.
4. Requisition and RequisitionItem.
5. RFQ, RFQSupplier and Quotation.
6. PurchaseOrder and PurchaseOrderItem.
7. ApprovalProcess and ApprovalStep.
8. Inventory and GoodsReceipt.
9. Invoice and Payment.

Use UUID keys, appropriate CAP types,
compositions and associations.

Provide valid, concise CDS code.
Split into logical CDS files where appropriate.
`
    },
    {
        agentId: "database-engineer",
        section: "Constraints and Data Integrity",
        task: `
Define ProcureFlow database integrity and performance rules.

Include:
1. Unique constraints.
2. Foreign-key rules.
3. Quantity and amount validations.
4. Business status values.
5. Indexing strategy.
6. Audit fields and history.
7. Three-way invoice matching data requirements.
8. Inventory consistency requirements.
9. PostgreSQL-specific recommendations.

Provide concise SQL examples only where useful.
`
    }
];

async function main() {
    const docsDir = path.join(
        __dirname,
        "../workspace/procureflow/docs"
    );

    fs.mkdirSync(docsDir, { recursive: true });

    console.log("\n====================================");
    console.log("   PROCUREFLOW DOCUMENT GENERATION");
    console.log("====================================\n");

    const result = await executeTeamTasks({
        projectName,
        projectDescription,
        tasks
    });

    const documents = {
        "solution-architect": [],
        "database-engineer": []
    };

    for (let i = 0; i < result.results.length; i++) {
        const item = result.results[i];
        const task = tasks[i];

        console.log(`\n[${i + 1}/${tasks.length}] ${task.section}`);
        console.log("Agent:", item.agentName);
        console.log("Status:", item.status);

        if (item.status === "completed") {
            documents[task.agentId].push(
                `# ${task.section}\n\n${item.output}`
            );

            console.log("Model:", item.model);
        } else {
            console.log("Error:", item.error);
        }
    }

    const outputFiles = [
        {
            agentId: "solution-architect",
            filename: "solution-architect.md"
        },
        {
            agentId: "database-engineer",
            filename: "database-engineer.md"
        }
    ];

    for (const doc of outputFiles) {
        const sections = documents[doc.agentId];

        if (sections.length > 0) {
            const content = [
                `# ProcureFlow - ${doc.agentId.replace("-", " ")}`,
                "",
                `Generated: ${new Date().toISOString()}`,
                "",
                ...sections
            ].join("\n\n---\n\n");

            fs.writeFileSync(
                path.join(docsDir, doc.filename),
                content,
                "utf8"
            );

            console.log(`\nSaved: ${doc.filename}`);
        }
    }

    console.log("\n====================================");
    console.log("GENERATION SUMMARY");
    console.log("====================================");
    console.log("Tasks:", result.totalTasks);
    console.log("Completed:", result.completed);
    console.log("Failed:", result.failed);
    console.log("Documents:", docsDir);

    if (result.failed > 0) {
        process.exitCode = 1;
    }
}

main().catch(error => {
    console.error("Generation failed:", error);
    process.exitCode = 1;
});
