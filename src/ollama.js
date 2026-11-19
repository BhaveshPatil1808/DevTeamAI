const OLLAMA_URL = "http://127.0.0.1:11434";
const MODEL = "qwen2.5-coder:3b";

async function askAI(
    prompt,
    system = "You are an expert software development assistant.",
    options = {}
) {
    const {
        maxTokens = 1000,
        timeout = 180000,
        ...modelOptions
    } = options;

    const response = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model: MODEL,
            system,
            prompt,
            stream: false,
            options: {
                temperature: 0.2,
                num_predict: maxTokens,
                ...modelOptions
            }
        }),
        signal: AbortSignal.timeout(timeout)
    });

    if (!response.ok) {
        throw new Error(`Ollama HTTP error: ${response.status}`);
    }

    const data = await response.json();

    if (!data.response) {
        throw new Error("The AI returned an empty response.");
    }

    return data.response;
}

module.exports = { askAI };
