const fs = require("fs");
const path = require("path");
const { executeTeamTasks } = require("./orchestrator/engine");

const outputDir = path.join(
  __dirname,
  "../workspace/procureflow/docs"
);

const outputFile = path.join(outputDir, "database-cds-part2.md");

const projectContext = `
Project: ProcureFlow – AI-Powered Enterprise Procurement Platform.
Technology: SAP CAP Node.js with CDS.
Generate valid SAP CAP CDS model definitions.
Use namespace procureflow.
Use cuid as primary keys and managed where appropriate.
Use compositions for owned child entities and associations for references.
Use consistent naming and valid CDS syntax.
Return complete CDS code, not pseudocode.
Do not omit fields, keys, relationships, or important constraints.
Keep the response focused on the requested entities.
`;

const tasks = [
  {
    agentId: "database-engineer",
    task: `Generate complete CDS definitions for ONLY:
    PurchaseOrder and PurchaseOrderItem.

    Include supplier, requisition/RFQ references, PO number, dates,
    currency, net/gross amounts, status, delivery details, item quantity,
    unit, price, tax, material/product description.
    Define keys, associations, compositions, and appropriate data types.
    Include all necessary relationships.`
  },
  {
    agentId: "database-engineer",
    task: `Generate complete CDS definitions for ONLY:
    ApprovalProcess, ApprovalStep, ApprovalHistory.

    Support multi-level approval, document type and document ID,
    approver, approval level, sequence, status, comments,
    action timestamps, delegation if appropriate, and audit history.
    Define relationships and valid CDS types.`
  },
  {
    agentId: "database-engineer",
    task: `Generate complete CDS definitions for ONLY:
    Inventory, InventoryMovement, GoodsReceipt, GoodsReceiptItem.

    Include material/product, storage location, available and reserved
    quantities, movement type, movement date, reference document,
    goods receipt number, purchase order reference, received quantity,
    accepted/rejected quantity, and item details.
    Define relationships and valid CDS types.`
  },
  {
    agentId: "database-engineer",
    task: `Generate complete CDS definitions for ONLY:
    Invoice, InvoiceItem, Payment.

    Include supplier invoice number, invoice date, due date,
    purchase order reference, goods receipt reference, currency,
    amounts, tax, invoice status, payment status, payment date,
    payment reference, and line-item details.
    Support later three-way matching between PO, goods receipt,
    and invoice. Define relationships and valid CDS types.`
  },
  {
    agentId: "database-engineer",
    task: `Generate complete CDS definitions for ONLY:
    Notification and Insight.

    Notification should support recipient, title, message,
    notification type, read status, creation timestamp and
    related business document.
    Insight should support insight type, title, description,
    severity, metric/value, generated timestamp and related entity.
    Define keys, relationships and valid CDS types.`
  }
];

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });

  fs.writeFileSync(
    outputFile,
    "# ProcureFlow CDS Data Model – Part 2\n\n",
    "utf8"
  );

  const report = await executeTeamTasks({
    projectName: "ProcureFlow",
    projectDescription: projectContext,
    tasks
  });

  for (let i = 0; i < report.results.length; i++) {
    const result = report.results[i];

    if (result.status === "completed" && result.output) {
      fs.appendFileSync(
        outputFile,
        `\n\n## ${tasks[i].task.split("\n")[0]}\n\n${result.output}\n`,
        "utf8"
      );
    }
  }

  console.log("\nPart 2 completed:", report.completed);
  console.log("Part 2 failed:", report.failed);
  console.log("Saved:", outputFile);
}

main().catch(error => {
  console.error("Retry failed:", error.message);
  process.exitCode = 1;
});
