
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

function getRetryDelayMs(response, message = "") {
    const retryAfter = response.headers.get("retry-after");

    if (retryAfter) {
        const seconds = Number(retryAfter);

        if (Number.isFinite(seconds)) {
            return Math.max(0, seconds * 1000);
        }

        const dateDelay = Date.parse(retryAfter) - Date.now();

        if (Number.isFinite(dateDelay) && dateDelay > 0) {
            return dateDelay;
        }
    }

    const resetHeaders = [
        "x-ratelimit-reset-tokens",
        "x-ratelimit-reset-requests"
    ];

    for (const headerName of resetHeaders) {
        const resetValue = response.headers.get(headerName);

        if (!resetValue) continue;

        const match = resetValue.match(/^([\d.]+)(ms|s|m)?$/i);

        if (match) {
            const value = Number(match[1]);
            const unit = (match[2] || "s").toLowerCase();

            if (Number.isFinite(value)) {
                return value * (
                    unit === "ms" ? 1 :
                    unit === "m" ? 60000 :
                    1000
                );
            }
        }
    }

    const messageMatch = message.match(
        /try again in\s+([\d.]+)\s*(ms|s|seconds?)/i
    );

    if (messageMatch) {
        const value = Number(messageMatch[1]);
        const unit = messageMatch[2].toLowerCase();

        return value * (unit === "ms" ? 1 : 1000);
    }

    return null;
}

async function askGroq(
    userPrompt,
    systemPrompt = "You are a helpful software engineering assistant.",
    options = {}
) {
    const apiKey = process.env.GROQ_API_KEY;

    if (!apiKey) {
        const error = new Error("GROQ_API_KEY is missing from .env");
        error.provider = "groq";
        throw error;
    }

    const model =
        options.model ||
        process.env.GROQ_MODEL ||
        "openai/gpt-oss-120b";

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
            max_completion_tokens: options.maxTokens || 2500,
            temperature: options.temperature ?? 0.1,
            stream: false
        };

        // GPT-OSS and other Groq models use different reasoning settings.
        if (model.toLowerCase().includes("gpt-oss")) {
            requestBody.reasoning_effort =
                options.reasoningEffort || "low";
        } else {
            requestBody.reasoning_effort = "none";
            requestBody.reasoning_format = "hidden";
        }

        const response = await fetch(
            "https://api.groq.com/openai/v1/chat/completions",
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    "Content-Type": "application/json"
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
                `Groq returned invalid JSON. HTTP ${response.status}`
            );

            error.provider = "groq";
            error.status = response.status;

            throw error;
        }

        if (!response.ok) {
            const message =
                data.error?.message ||
                JSON.stringify(data.error || data);

            const error = new Error(
                `Groq HTTP ${response.status}: ${message}`
            );

            error.provider = "groq";
            error.status = response.status;
            error.retryAfterMs = getRetryDelayMs(response, message);

            throw error;
        }

        const choice = data.choices?.[0];
        const content = choice?.message?.content || "";
        const finishReason = choice?.finish_reason || null;

        return {
            content: typeof content === "string"
                ? content.trim()
                : "",
            model: data.model || model,
            usage: data.usage || null,
            finishReason,
            truncated:
                finishReason === "length" ||
                finishReason === "max_tokens"
        };

    } catch (error) {
        if (error.name === "AbortError") {
            const timeoutError = new Error(
                `Groq request timed out after ${timeoutMs}ms`
            );

            timeoutError.provider = "groq";
            timeoutError.code = "PROVIDER_TIMEOUT";

            throw timeoutError;
        }

        if (!error.provider) {
            error.provider = "groq";
        }

        throw error;

    } finally {
        clearTimeout(timeout);
    }
}

module.exports = { askGroq };
