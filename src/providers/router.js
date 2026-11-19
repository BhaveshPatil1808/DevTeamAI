const { askGroq } = require("./groq");
const { askOpenRouter } = require("./openrouter");
const { askBazaarLink } = require("./bazaarlink");

// Groq limits tokens per rolling 60s window, so waiting up to ~65s
// is enough for the quota to free up. Waiting beats falling back to a
// provider that may be broken (expired key, truncating reasoning model).
const MAX_RATE_LIMIT_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 65000;
const DEFAULT_RETRY_WAIT_MS = 3000;

const SUPPORTED_PROVIDERS = [
    "groq",
    "openrouter",
    "bazaarlink"
];

function getProviderOrder() {
    const configured = (
        process.env.AI_PROVIDER_ORDER ||
        "groq,openrouter,bazaarlink"
    );

    return [
        ...new Set(
            configured
                .split(",")
                .map(name => name.trim().toLowerCase())
                .filter(name => SUPPORTED_PROVIDERS.includes(name))
        )
    ];
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getRetryDelay(error) {
    const hintedDelay = Number(error?.retryAfterMs);

    if (
        error?.retryAfterMs !== null &&
        error?.retryAfterMs !== undefined &&
        Number.isFinite(hintedDelay) &&
        hintedDelay >= 0
    ) {
        return hintedDelay;
    }

    return DEFAULT_RETRY_WAIT_MS;
}

async function callProvider(
    provider,
    userPrompt,
    systemPrompt,
    options
) {
    if (provider === "groq") {
        return askGroq(userPrompt, systemPrompt, {
            ...options,
            reasoningEffort: options.reasoningEffort || "low"
        });
    }

    if (provider === "openrouter") {
        return askOpenRouter(userPrompt, systemPrompt, {
            ...options,
            reasoning: options.reasoning || { effort: "low" }
        });
    }

    if (provider === "bazaarlink") {
        return askBazaarLink(userPrompt, systemPrompt, options);
    }

    throw new Error(`Unsupported provider: ${provider}`);
}

async function askWithFallback(
    userPrompt,
    systemPrompt,
    options = {}
) {
    const providers = getProviderOrder();
    const failures = [];

    if (!providers.length) {
        throw new Error(
            "No valid AI providers configured. " +
            "Set AI_PROVIDER_ORDER to groq,openrouter,bazaarlink."
        );
    }

    for (const provider of providers) {
        let rateLimitRetries = 0;

        while (true) {
            try {
                console.log(
                    `[AI ROUTER] Trying provider: ${provider}`
                );

                const result = await callProvider(
                    provider,
                    userPrompt,
                    systemPrompt,
                    options
                );

                if (
                    !result ||
                    typeof result.content !== "string"
                ) {
                    throw new Error(
                        "Provider returned an invalid response structure."
                    );
                }

                if (!result.content.trim() && !result.truncated) {
                    throw new Error(
                        "Provider returned empty content."
                    );
                }

                if (result.truncated) {
                    const reason = result.finishReason || "unknown";

                    const message =
                        `${provider}: Response truncated ` +
                        `(finish reason: ${reason}).`;

                    console.warn(
                        `[AI ROUTER] ${message} Trying fallback.`
                    );

                    failures.push(message);
                    break;
                }

                console.log(
                    `[AI ROUTER] Success using ${provider}`
                );

                return {
                    ...result,
                    provider
                };

            } catch (error) {
                const status = Number(error?.status);

                console.error(
                    `[AI ROUTER] ${provider} failed: ${error.message}`
                );

                if (status === 429) {
                    const delay = getRetryDelay(error);

                    if (
                        rateLimitRetries < MAX_RATE_LIMIT_RETRIES &&
                        delay <= MAX_RETRY_WAIT_MS
                    ) {
                        rateLimitRetries++;

                        console.warn(
                            `[AI ROUTER] ${provider} rate limited. ` +
                            `Retrying in ${Math.ceil(delay / 1000)} seconds.`
                        );

                        await sleep(delay);
                        continue;
                    }

                    const reason = delay > MAX_RETRY_WAIT_MS
                        ? `Retry delay (${Math.ceil(delay / 1000)}s) exceeds configured limit`
                        : "Rate-limit retry exhausted";

                    failures.push(`${provider}: ${reason}.`);

                } else {
                    failures.push(
                        `${provider}: ${error.message || "Unknown error"}`
                    );
                }

                break;
            }
        }
    }

    throw new Error(
        "All AI providers failed:\n" +
        failures
            .map((failure, index) => `${index + 1}. ${failure}`)
            .join("\n")
    );
}

module.exports = {
    askWithFallback,
    getProviderOrder
};
