const fs = require("fs");
const path = require("path");

const { executeTeamTasks } = require("./orchestrator/engine");

async function main() {
    const docsDir = path.join(
        __dirname,
        "../workspace/procureflow/docs"
    );

    fs.mkdirSync(docsDir, { recursive: true });

    const tasks = [
        {
            agentId: "database-engineer",
            task: `
Create SAP CAP CDS definitions for the first group of ProcureFlow entities.

Include:
- Namespace procureflow
- Supplier
- SupplierRating
- SupplierDocument
- Requisition
- RequisitionItem
- RFQ
- RFQItem
- RFQSupplier
- Quotation
- QuotationItem

Requirements:
Use cuid and managed aspects where appropriate.
Use compositions for owned child entities.
Use associations for references.
Use valid CAP CDS syntax.
Include important fields, status fields and relationships.

Return complete CDS code in one code block.
Avoid SQL and lengthy explanations.
`
        },
        {
            agentId: "database-engineer",
            task: `
Create SAP CAP CDS definitions for the second group of ProcureFlow entities.

Include:
- PurchaseOrder
- PurchaseOrderItem
- ApprovalProcess
- ApprovalStep
- ApprovalHistory
- Inventory
- InventoryMovement
- GoodsReceipt
- GoodsReceiptItem
- Invoice
- InvoiceItem
- Payment
- Notification
- Insight

Requirements:
Use cuid and managed aspects where appropriate.
Use compositions for owned child entities.
Use associations for references.
Use valid CAP CDS syntax.
Include important fields, status fields and relationships.

Return complete CDS code in one code block.
Avoid SQL and lengthy explanations.
`
        }
    ];

    const result = await executeTeamTasks({
        projectName: "ProcureFlow",
        projectDescription: `
SAP CAP Node.js enterprise procurement platform.
React TypeScript frontend, PostgreSQL database,
SAP BTP deployment and OpenRouter AI integration.
`,
        tasks
    });

    const sections = [];

    for (let i = 0; i < result.results.length; i++) {
        const item = result.results[i];

        console.log("\nAgent:", item.agentName);
        console.log("Status:", item.status);

        if (item.status === "completed") {
            sections.push(
                `# CDS Model - Part ${i + 1}\n\n${item.output}`
            );

            if (item.truncated) {
                console.log("Warning: Model reports a length-limited response.");
            }

            console.log("Model:", item.model);
        } else {
            console.log("Error:", item.error);
        }
    }

    if (sections.length) {
        const outputPath = path.join(
            docsDir,
            "database-cds-model.md"
        );

        fs.writeFileSync(
            outputPath,
            `# ProcureFlow - SAP CAP CDS Data Model\n\n${sections.join("\n\n---\n\n")}`,
            "utf8"
        );

        console.log("\nCDS document saved:", outputPath);
    }

    console.log("\nCompleted:", result.completed);
    console.log("Failed:", result.failed);

    if (result.failed > 0) {
        process.exitCode = 1;
    }
}

main().catch(error => {
    console.error("CDS generation failed:", error);
    process.exitCode = 1;
});
