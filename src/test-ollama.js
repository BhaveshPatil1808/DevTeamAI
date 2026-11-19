const { askAI } = require("./ollama");

async function main() {
    console.log("\nConnecting to local AI...\n");

    const answer = await askAI(
        "What is SAP CAP? Explain in 3 simple points.",
        "You are an SAP technical assistant. CAP means SAP Cloud Application Programming Model, not SAML."
    );

    console.log("========== AI RESPONSE ==========\n");
    console.log(answer);
    console.log("\n=================================");
}

main().catch(error => {
    console.error("Test failed:", error.message);
    process.exitCode = 1;
});
