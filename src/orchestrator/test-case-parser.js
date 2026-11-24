"use strict";

function unmeasured(reason) {
    return {
        measured: false,
        executed: null,
        passed: null,
        failed: null,
        skipped: null,
        source: null,
        reason
    };
}

function makeCounts({ executed, passed, failed, skipped, source }) {
    const values = [executed, passed, failed, skipped];

    if (
        values.some(value => !Number.isInteger(value) || value < 0) ||
        executed <= 0 ||
        passed + failed + skipped !== executed
    ) {
        return unmeasured("The output did not contain consistent test totals.");
    }

    return {
        measured: true,
        executed,
        passed,
        failed,
        skipped,
        source,
        reason: null
    };
}

function parseNodeTap(output) {
    const get = name => {
        const matches = [
            ...output.matchAll(
                new RegExp(
                    `^\\s*(?:#|ℹ)\\s*${name}\\s+(\\d+)\\s*$`,
                    "gmi"
                )
            )
        ];

        return matches.length
            ? Number(matches[matches.length - 1][1])
            : null;
    };

    const tests = get("tests");
    const passed = get("pass");
    const failed = get("fail");
    const skipped = get("skipped");
    const cancelled = get("cancelled");
    const todo = get("todo");

    if (
        tests === null ||
        passed === null ||
        failed === null ||
        skipped === null
    ) {
        return unmeasured("Node test summary was not found.");
    }

    const notCompleted = (cancelled || 0) + (todo || 0);
    const total = passed + failed + skipped + notCompleted;

    if (total !== tests) {
        return unmeasured("Node test summary totals do not match.");
    }

    // TODO and cancelled cases are not counted as passed.
    return makeCounts({
        executed: tests,
        passed,
        failed,
        skipped: skipped + notCompleted,
        source: "node-test"
    });
}

function parsePytest(output) {
    const summaryLines = output
        .split(/\r?\n/)
        .filter(line =>
            /\b(?:passed|failed|skipped|error|errors|xfailed|xpassed)\b/i.test(line) &&
            /\bin\s+[\d.]+s?\s*$/i.test(line.trim())
        );

    if (!summaryLines.length) {
        return unmeasured("Pytest summary was not found.");
    }

    const line = summaryLines[summaryLines.length - 1];
    const counts = {};

    for (const match of line.matchAll(
        /(\d+)\s+(passed|failed|skipped|errors?|xfailed|xpassed)\b/gi
    )) {
        counts[match[2].toLowerCase()] =
            (counts[match[2].toLowerCase()] || 0) +
            Number(match[1]);
    }

    const passed = counts.passed || 0;
    const failed = (counts.failed || 0) + (counts.error || 0) +
        (counts.errors || 0);
    const skipped = (counts.skipped || 0) + (counts.xfailed || 0) +
        (counts.xpassed || 0);
    const executed = passed + failed + skipped;

    return makeCounts({
        executed,
        passed,
        failed,
        skipped,
        source: "pytest"
    });
}

function parseUnittest(output) {
    const ranMatches = [
        ...output.matchAll(/^\s*Ran\s+(\d+)\s+tests?\s+in\s+[\d.]+s\s*$/gmi)
    ];

    if (!ranMatches.length) {
        return unmeasured("Python unittest summary was not found.");
    }

    const executed = Number(ranMatches[ranMatches.length - 1][1]);
    const summary = output.slice(ranMatches[ranMatches.length - 1].index);

    const failureMatch = summary.match(/failures=(\d+)/i);
    const errorMatch = summary.match(/errors=(\d+)/i);
    const skippedMatch = summary.match(/skipped=(\d+)/i);

    const failed =
        Number(failureMatch?.[1] || 0) +
        Number(errorMatch?.[1] || 0);

    const skipped = Number(skippedMatch?.[1] || 0);
    const passed = executed - failed - skipped;

    return makeCounts({
        executed,
        passed,
        failed,
        skipped,
        source: "python-unittest"
    });
}
function parseGoJson(output) {
    const events = new Map();

    for (const line of output.split(/\r?\n/)) {
        let event;

        try {
            event = JSON.parse(line);
        } catch {
            continue;
        }

        if (
            !event.Test ||
            !["pass", "fail", "skip"].includes(event.Action)
        ) {
            continue;
        }

        const key = `${event.Package || ""}::${event.Test}`;

        events.set(key, {
            package: event.Package || "",
            test: event.Test,
            action: event.Action
        });
    }

    const allEvents = [...events.values()];

    if (!allEvents.length) {
        return unmeasured("Go JSON test events were not found.");
    }

    // A parent test with subtests is not counted separately.
    const leaves = allEvents.filter(parent =>
        !allEvents.some(child =>
            child.package === parent.package &&
            child.test.startsWith(`${parent.test}/`)
        )
    );

    const passed = leaves.filter(item => item.action === "pass").length;
    const failed = leaves.filter(item => item.action === "fail").length;
    const skipped = leaves.filter(item => item.action === "skip").length;

    return makeCounts({
        executed: passed + failed + skipped,
        passed,
        failed,
        skipped,
        source: "go-test-json"
    });
}
function parseRust(output) {
    const matches = [
        ...output.matchAll(
            /test result:\s*\w+\.\s*(\d+)\s+passed;\s*(\d+)\s+failed;\s*(\d+)\s+ignored/gi
        )
    ];

    if (!matches.length) {
        return unmeasured("Cargo test summary was not found.");
    }

    const totals = matches.reduce(
        (sum, match) => {
            sum.passed += Number(match[1]);
            sum.failed += Number(match[2]);
            sum.skipped += Number(match[3]);
            return sum;
        },
        { passed: 0, failed: 0, skipped: 0 }
    );

    return makeCounts({
        ...totals,
        executed: totals.passed + totals.failed + totals.skipped,
        source: "cargo-test"
    });
}

function parseMaven(output) {
    const sections = output.split(/^\s*Results:\s*$/gim);
    const section = sections[sections.length - 1] || "";

    const match = section.match(
        /Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)/i
    );

    if (!match) {
        return unmeasured("Maven aggregate test summary was not found.");
    }

    const executed = Number(match[1]);
    const failed = Number(match[2]) + Number(match[3]);
    const skipped = Number(match[4]);

    return makeCounts({
        executed,
        failed,
        skipped,
        passed: executed - failed - skipped,
        source: "maven-surefire"
    });
}

function parseDotnet(output) {
    const matches = [
        ...output.matchAll(
            /(?:Test summary:\s*)?total:\s*(\d+),\s*failed:\s*(\d+),\s*succeeded:\s*(\d+),\s*skipped:\s*(\d+)/gi
        )
    ];

    if (matches.length) {
        const match = matches[matches.length - 1];

        return makeCounts({
            executed: Number(match[1]),
            failed: Number(match[2]),
            passed: Number(match[3]),
            skipped: Number(match[4]),
            source: "dotnet-test"
        });
    }

    const legacy = [
        ...output.matchAll(
            /(?:Passed|Failed)!?\s*-\s*Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+),\s*Total:\s*(\d+)/gi
        )
    ];

    if (!legacy.length) {
        return unmeasured(".NET test summary was not found.");
    }

    const match = legacy[legacy.length - 1];

    return makeCounts({
        failed: Number(match[1]),
        passed: Number(match[2]),
        skipped: Number(match[3]),
        executed: Number(match[4]),
        source: "dotnet-test"
    });
}

function parseTestCaseCounts(strategyId, stdout = "", stderr = "") {
    const output = `${stdout}\n${stderr}`;

    switch (strategyId) {
        case "node-native-tests":
            return parseNodeTap(output);

        case "go-native-tests":
            return parseGoJson(output);

        case "python-pytest":
            return parsePytest(output);

        case "python-unittest-standard":
        case "python-unittest-suffix":
            return parseUnittest(output);

        case "rust-native-tests":
            return parseRust(output);

        case "java-maven-tests":
            return parseMaven(output);

        case "dotnet-native-tests":
            return parseDotnet(output);

        default:
            return unmeasured(
                `No test-case parser is configured for ${strategyId}.`
            );
    }
}

module.exports = {
    parseTestCaseCounts
};