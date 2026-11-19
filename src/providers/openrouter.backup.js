
const fs = require("node:fs");
const path = require("node:path");

function loadEnv() {
    const envPath = path.resolve(__dirname, "../../.env");

    if (!fs.existsSync(envPath)) return;

    const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);

    for (const line of lines) {
        const trimmed = line.trim();

        if (!trimmed || trimmed.startsWith("#")) continue;

        const separator = trimmed.indexOf("=");
        if (separator === -1) continue;

        const key = trimmed.slice(0, separator).trim();
        const value = trimmed.slice(separator + 1).trim();

        if (key && process.env[key] === undefined) {
            process.env[key] = value;
        }
    }
}

loadEnv();

const BASE_URL =
    process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";

const MODEL =
    process.env.OPENROUTER_MODEL || "openrouter/free";

async function askOpenRouter(
    prompt,
    system = "You are a helpful expert software development assistant.",
    options = {}
) {
    const apiKey = process.env.OPENROUTER_API_KEY;

    if (!apiKey) {
        throw new Error("OPENROUTER_API_KEY is missing in .env.");
    }

    if (!prompt || typeof prompt !== "string") {
        throw new Error("A valid prompt is required.");
    }

    const {
        maxTokens = 1500,
        temperature = 0.2,
        timeout = 120000
    } = options;

    const response = await fetch(
        `${BASE_URL.replace(/\/+$/, "")}/chat/completions`,
        {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "http://localhost",
                "X-Title": "AI Coding Agent Team"
            },
            body: JSON.stringify({
                model: MODEL,
                messages: [
                    { role: "system", content: system },
                    { role: "user", content: prompt }
                ],
                temperature,
                max_tokens: maxTokens,
                stream: false
            }),
            signal: AbortSignal.timeout(timeout)
        }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(
            `OpenRouter HTTP ${response.status}: ${
                data?.error?.message || "Unknown API error"
            }`
        );
    }

    const message = data?.choices?.[0]?.message;
    const rawContent = message?.content;

    let content = "";

    if (typeof rawContent === "string") {
        content = rawContent;
    } else if (Array.isArray(rawContent)) {
        content = rawContent
            .filter(item =>
                item?.type === "text" &&
                typeof item.text === "string"
            )
            .map(item => item.text)
            .join("\n");
    }

    if (!content.trim()) {
        const diagnostics = {
            responseKeys: Object.keys(data || {}),
            error: data?.error?.message || null,
            choicesCount: data?.choices?.length || 0,
            messageKeys: message ? Object.keys(message) : [],
            contentType: typeof rawContent,
            finishReason: data?.choices?.[0]?.finish_reason || null,
            model: data?.model || null
        };

        throw new Error(
            `OpenRouter returned no usable text. Diagnostics: ${JSON.stringify(diagnostics)}`
        );
    }

    return {
        content: content.trim(),
        model: data.model || MODEL,
        usage: data.usage || null
    };
}

module.exports = { askOpenRouter };
