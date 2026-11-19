const { askOpenRouter } = require("./providers/openrouter");

async function main() {
    console.log("Testing OpenRouter free model...");
    console.log(
        "Configured model:",
        process.env.OPENROUTER_MODEL || "openrouter/free"
    );

    const result = await askOpenRouter(
        "Explain SAP CAP in exactly 3 short bullet points.",
        "You are an expert SAP CAP developer. Be concise.",
        {
            maxTokens: 300,
            temperature: 0.1,
            timeout: 300000
        }
    );

    console.log("\n========== AI RESPONSE ==========");
    console.log(result.content);

    console.log("\n========== REQUEST DETAILS ==========");
    console.log("Actual model selected:", result.model);
    console.log("Token usage:", result.usage || "Not provided");

    console.log("\nOpenRouter connection successful!");
}

main().catch(error => {
    console.error("\nOpenRouter test failed:");
    console.error(error.message);
    process.exitCode = 1;
});
