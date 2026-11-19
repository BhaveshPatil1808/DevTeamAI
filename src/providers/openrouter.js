
const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "../../.env");

// Load .env without overwriting existing environment variables.
if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);

    for (const line of lines) {
        const trimmed = line.trim();

        if (!trimmed || trimmed.startsWith("#")) continue;

        const index = trimmed.indexOf("=");

        if (index === -1) continue;

        const key = trimmed.slice(0, index).trim();
        let value = trimmed.slice(index + 1).trim();

        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }

        if (key && process.env[key] === undefined) {
            process.env[key] = value;
        }
    }
}

function extractText(value, depth = 0) {
    if (depth > 8 || value == null) return "";

    if (typeof value === "string") {
        return value;
    }

    if (Array.isArray(value)) {
        return value
            .map(item => extractText(item, depth + 1))
            .filter(Boolean)
            .join("\n");
    }

    if (typeof value === "object") {
        for (const key of ["text", "output_text", "content", "parts"]) {
            if (value[key] !== undefined) {
                const result = extractText(
                    value[key],
                    depth + 1
                );

                if (result.trim()) return result;
            }
        }
    }

    return "";
}

function getRetryDelayMs(response) {
    const retryAfter = response.headers.get("retry-after");

    if (!retryAfter) return null;

    const seconds = Number(retryAfter);

    if (Number.isFinite(seconds)) {
        return Math.max(0, seconds * 1000);
    }

    const dateDelay = Date.parse(retryAfter) - Date.now();

    return Number.isFinite(dateDelay) && dateDelay > 0
        ? dateDelay
        : null;
}

async function askOpenRouter(
    userPrompt,
    systemPrompt = "You are a helpful software engineering assistant.",
    options = {}
) {
    const apiKey = process.env.OPENROUTER_API_KEY;

    if (!apiKey) {
        const error = new Error(
            "OPENROUTER_API_KEY is missing from .env"
        );

        error.provider = "openrouter";
        throw error;
    }

    const baseUrl = (
        process.env.OPENROUTER_BASE_URL ||
        "https://openrouter.ai/api/v1"
    ).replace(/\/+$/, "");

    const model =
        options.model ||
        process.env.OPENROUTER_MODEL ||
        "recursive/flint-v1.0:free";

    const timeoutMs = options.timeout || 120000;

    const controller = new AbortController();

    const timeout = setTimeout(
        () => controller.abort(),
        timeoutMs
    );

    try {
        const requestBody = {
            model,
            messages: [
                {
                    role: "system",
                    content: systemPrompt
                },
                {
                    role: "user",
                    content: userPrompt
                }
            ],
            max_tokens: options.maxTokens || 2500,
            temperature: options.temperature ?? 0.1,
            stream: false
        };

        if (options.reasoning) {
            requestBody.reasoning = options.reasoning;
        }

        const response = await fetch(
            `${baseUrl}/chat/completions`,
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                    "HTTP-Referer": "http://localhost:4173",
                    "X-Title": "DevTeamAI"
                },
                body: JSON.stringify(requestBody),
                signal: controller.signal
            }
        );

        let data;

        try {
            data = await response.json();
        } catch {
            const error = new Error(
                `OpenRouter returned invalid JSON. HTTP ${response.status}`
            );

            error.provider = "openrouter";
            error.status = response.status;

            throw error;
        }

        if (!response.ok) {
            const message =
                data.error?.message ||
                JSON.stringify(data.error || data);

            const error = new Error(
                `OpenRouter HTTP ${response.status}: ${message}`
            );

            error.provider = "openrouter";
            error.status = response.status;
            error.retryAfterMs = getRetryDelayMs(response);

            throw error;
        }

        const choice = data.choices?.[0];
        const message = choice?.message;

        const content = extractText(
            message?.content
        ).trim();

        const finishReason = choice?.finish_reason || null;

        const truncated =
            finishReason === "length" ||
            finishReason === "max_tokens";

        if (!content && !truncated) {
            const error = new Error(
                "OpenRouter returned no usable text. " +
                `Model: ${data.model || model}; ` +
                `finish reason: ${finishReason || "unknown"}`
            );

            error.provider = "openrouter";
            error.status = response.status;

            throw error;
        }

        return {
            content,
            model: data.model || model,
            usage: data.usage || null,
            truncated,
            finishReason
        };

    } catch (error) {
        if (error.name === "AbortError") {
            const timeoutError = new Error(
                `OpenRouter request timed out after ${timeoutMs}ms`
            );

            timeoutError.provider = "openrouter";
            timeoutError.code = "PROVIDER_TIMEOUT";

            throw timeoutError;
        }

        if (!error.provider) {
            error.provider = "openrouter";
        }

        throw error;

    } finally {
        clearTimeout(timeout);
    }
}

module.exports = { askOpenRouter };
