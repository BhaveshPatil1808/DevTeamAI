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

    const match = message.match(
        /try again in\s+([\d.]+)\s*(ms|s|seconds?|minutes?|m)/i
    );

    if (match) {
        const value = Number(match[1]);
        const unit = match[2].toLowerCase();

        if (unit === "ms") return value;
        if (unit === "m" || unit.startsWith("minute")) {
            return value * 60000;
        }

        return value * 1000;
    }

    return null;
}

function extractContent(value, depth = 0) {
    if (depth > 8 || value == null) return "";

    if (typeof value === "string") {
        return value;
    }

    if (Array.isArray(value)) {
        return value
            .map(item => extractContent(item, depth + 1))
            .filter(Boolean)
            .join("\n");
    }

    if (typeof value === "object") {
        for (const key of ["text", "output_text", "content", "parts"]) {
            if (value[key] !== undefined) {
                const result = extractContent(
                    value[key],
                    depth + 1
                );

                if (result.trim()) return result;
            }
        }
    }

    return "";
}

async function askBazaarLink(
    userPrompt,
    systemPrompt = "You are a helpful software engineering assistant.",
    options = {}
) {
    const apiKey = process.env.BAZAARLINK_API_KEY;

    if (!apiKey) {
        const error = new Error(
            "BAZAARLINK_API_KEY is missing from .env"
        );

        error.provider = "bazaarlink";
        throw error;
    }

    const baseUrl = (
        process.env.BAZAARLINK_BASE_URL ||
        "https://api.bazaarlink.ai/v1"
    ).replace(/\/+$/, "");

    const model =
        options.model ||
        process.env.BAZAARLINK_MODEL ||
        "openai/gpt-oss-120b";

    const configuredTimeout = Number(
        process.env.BAZAARLINK_TIMEOUT_MS || 3600000
    );

    const timeoutMs = Math.max(
        Number(options.timeout) || 0,
        Number.isFinite(configuredTimeout) && configuredTimeout > 0
            ? configuredTimeout
            : 3600000
    );

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
            // deepseek-style reasoning models spend most of this budget on
            // hidden reasoning, so enforce a generous floor.
            max_tokens: Math.max(
                options.maxTokens || 2500,
                Number(process.env.BAZAARLINK_MIN_TOKENS) || 16000
            ),
            temperature: options.temperature ?? 0.1,
            stream: false
        };

        const response = await fetch(
            `${baseUrl}/chat/completions`,
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
        let rawBody = "";

        try {
            rawBody = await response.text();
            data = JSON.parse(rawBody);
        } catch {
            const error = new Error(
                `BazaarLink returned invalid JSON. HTTP ${response.status}` +
                (rawBody ? ` | Body starts: ${JSON.stringify(rawBody.slice(0, 200))}` : " | Empty body")
            );

            error.provider = "bazaarlink";
            error.status = response.status;

            throw error;
        }

        if (!response.ok) {
            const message =
                data.error?.message ||
                data.message ||
                JSON.stringify(data.error || data);

            const error = new Error(
                `BazaarLink HTTP ${response.status}: ${message}`
            );

            error.provider = "bazaarlink";
            error.status = response.status;
            error.retryAfterMs = getRetryDelayMs(
                response,
                message
            );

            throw error;
        }

        const choice = data.choices?.[0];
        const content = extractContent(
            choice?.message?.content
        ).trim();

        const finishReason = choice?.finish_reason || null;

        const truncated =
            finishReason === "length" ||
            finishReason === "max_tokens";

        if (!content && !truncated) {
            const error = new Error(
                "BazaarLink returned no usable text. " +
                `Model: ${data.model || model}; ` +
                `finish reason: ${finishReason || "unknown"}`
            );

            error.provider = "bazaarlink";
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
                `BazaarLink request timed out after ${timeoutMs}ms`
            );

            timeoutError.provider = "bazaarlink";
            timeoutError.code = "PROVIDER_TIMEOUT";

            throw timeoutError;
        }

        if (!error.provider) {
            error.provider = "bazaarlink";
        }

        throw error;

    } finally {
        clearTimeout(timeout);
    }
}

module.exports = { askBazaarLink };
