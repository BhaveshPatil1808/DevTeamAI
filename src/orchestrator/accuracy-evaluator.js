
"use strict";

const WEIGHTS = Object.freeze({
    requirements: 25,
    integration: 15,
    tests: 25,
    runtime: 15,
    security: 10,
    export: 10
});

function isObject(value) {
    return value !== null &&
        typeof value === "object" &&
        !Array.isArray(value);
}

function hasEvidence(value) {
    return typeof value === "string" && value.trim().length > 0;
}

function validCount(value) {
    return Number.isInteger(value) && value >= 0;
}

function evaluateRequirements(plan) {
    const criteria = plan?.acceptanceCriteria;

    if (!Array.isArray(criteria) || criteria.length === 0) {
        return {
            measured: false,
            score: null,
            reason: "Acceptance criteria are missing."
        };
    }

    const passed = criteria.filter(item =>
        isObject(item) &&
        item.status === "passed" &&
        hasEvidence(item.evidence)
    ).length;

    return {
        measured: true,
        score: Math.round((passed / criteria.length) * 100),
        passed,
        total: criteria.length,
        allPassed: passed === criteria.length
    };
}

function evaluateIntegration(integration, snapshotRunId) {
    if (
        !isObject(integration) ||
        integration.status !== "completed" ||
        !snapshotRunId ||
        integration.snapshotRunId !== snapshotRunId ||
        !Array.isArray(integration.files) ||
        integration.files.length === 0
    ) {
        return {
            measured: false,
            score: null,
            reason: "Valid integration evidence for the current snapshot is missing."
        };
    }

    const validFiles = integration.files.every(file =>
        isObject(file) &&
        typeof file.path === "string" &&
        file.path.trim().length > 0
    );

    return {
        measured: validFiles,
        score: validFiles ? 100 : null,
        fileCount: integration.files.length,
        reason: validFiles ? null : "Integration file evidence is invalid."
    };
}

function evaluateTests(verification, snapshotRunId) {
    const report = verification?.report;
    const data = report?.report;
    const testCases = data?.testCases;

    if (
        !isObject(report) ||
        !snapshotRunId ||
        report.snapshotRunId !== snapshotRunId ||
        !isObject(testCases) ||
        testCases.measured !== true
    ) {
        return {
            measured: false,
            score: null,
            reason: "Measured structured test-case evidence for this snapshot is missing."
        };
    }

    const {
        executed,
        passed,
        failed,
        skipped
    } = testCases;

    if (
        !validCount(executed) ||
        !validCount(passed) ||
        !validCount(failed) ||
        !validCount(skipped) ||
        executed === 0 ||
        passed + failed + skipped !== executed
    ) {
        return {
            measured: false,
            score: null,
            reason: "Test-case counters are missing or inconsistent."
        };
    }

    return {
        measured: true,
        score: Math.round((passed / executed) * 100),
        executed,
        passed,
        failed,
        skipped
    };
}

function evaluateRuntime(verification) {
    if (
        !isObject(verification) ||
        verification.status !== "verified"
    ) {
        return {
            measured: false,
            score: null,
            reason: "Successful runtime verification is missing."
        };
    }

    return {
        measured: true,
        score: 100
    };
}

function evaluateSecurity(qa) {
    const findings = qa?.report?.securityFindings;

    if (
        qa?.status !== "passed" ||
        !Array.isArray(findings)
    ) {
        return {
            measured: false,
            score: null,
            reason: "Structured security findings are missing."
        };
    }

    const penalties = {
        critical: 40,
        high: 20,
        medium: 5,
        low: 1
    };

    let score = 100;

    for (const finding of findings) {
        if (
            !isObject(finding) ||
            !Object.prototype.hasOwnProperty.call(
                penalties,
                finding.severity
            )
        ) {
            return {
                measured: false,
                score: null,
                reason: "Security findings contain invalid severity values."
            };
        }

        score -= penalties[finding.severity];
    }

    return {
        measured: true,
        score: Math.max(0, score),
        findingCount: findings.length
    };
}

function evaluateExport(exportState, snapshotRunId) {
    if (
        !isObject(exportState) ||
        exportState.status !== "completed" ||
        !snapshotRunId ||
        exportState.snapshotRunId !== snapshotRunId ||
        !Number.isInteger(exportState.fileCount) ||
        exportState.fileCount <= 0 ||
        !Array.isArray(exportState.files) ||
        exportState.files.length !== exportState.fileCount
    ) {
        return {
            measured: false,
            score: null,
            reason: "Valid export evidence for the current snapshot is missing."
        };
    }

    const validFiles = exportState.files.every(file =>
        isObject(file) &&
        typeof file.path === "string" &&
        file.path.trim().length > 0
    );

    return {
        measured: validFiles,
        score: validFiles ? 100 : null,
        fileCount: exportState.fileCount,
        reason: validFiles ? null : "Export file evidence is invalid."
    };
}

function evaluateAccuracy({
    plan,
    integration,
    qa,
    verification,
    export: exportState,
    snapshotRunId
} = {}) {
    const dimensions = {
        requirements: evaluateRequirements(plan),
        integration: evaluateIntegration(integration, snapshotRunId),
        tests: evaluateTests(verification, snapshotRunId),
        runtime: evaluateRuntime(verification),
        security: evaluateSecurity(qa),
        export: evaluateExport(exportState, snapshotRunId)
    };

    const unmeasured = Object.entries(dimensions)
        .filter(([, result]) => !result.measured)
        .map(([name]) => name);

    const allMeasured = unmeasured.length === 0;

    let weightedScore = 0;

    for (const [name, result] of Object.entries(dimensions)) {
        if (result.measured) {
            weightedScore +=
                result.score * WEIGHTS[name] / 100;
        }
    }

    const score = allMeasured
        ? Math.round(weightedScore)
        : null;

    const sameSnapshot = Boolean(
        snapshotRunId &&
        integration?.snapshotRunId === snapshotRunId &&
        verification?.report?.snapshotRunId === snapshotRunId &&
        exportState?.snapshotRunId === snapshotRunId
    );

    const allCriteriaPassed =
        dimensions.requirements.measured &&
        dimensions.requirements.allPassed;

    const perfectScoreEligible =
        score === 100 &&
        sameSnapshot &&
        allCriteriaPassed &&
        verification?.status === "verified" &&
        qa?.status === "passed" &&
        integration?.status === "completed" &&
        exportState?.status === "completed";

    return {
        status: allMeasured ? "measured" : "incomplete",
        score,
        dimensions,
        weights: WEIGHTS,
        unmeasured,
        sameSnapshot,
        allCriteriaPassed,
        perfectScoreEligible
    };
}

module.exports = {
    evaluateAccuracy
};
