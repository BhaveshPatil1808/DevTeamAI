
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    evaluateAccuracy
} = require("./accuracy-evaluator");

const snapshotRunId = "snapshot-001";

function completeEvidence() {
    return {
        plan: {
            acceptanceCriteria: [
                {
                    status: "passed",
                    evidence: "Requirement verified by test A."
                },
                {
                    status: "passed",
                    evidence: "Requirement verified by test B."
                }
            ]
        },

        integration: {
            status: "completed",
            snapshotRunId,
            files: [
                { path: "src/index.js" },
                { path: "package.json" }
            ]
        },

        qa: {
            status: "passed",
            report: {
                securityFindings: []
            }
        },

        verification: {
            status: "verified",
            report: {
                snapshotRunId,
                report: {
                    testCases: {
                        measured: true,
                        executed: 10,
                        passed: 10,
                        failed: 0,
                        skipped: 0
                    }
                }
            }
        },

        export: {
            status: "completed",
            snapshotRunId,
            fileCount: 2,
            files: [
                { path: "src/index.js" },
                { path: "package.json" }
            ]
        }
    };
}

test("missing evidence produces incomplete accuracy", () => {
    const result = evaluateAccuracy({});

    assert.equal(result.status, "incomplete");
    assert.equal(result.score, null);
    assert.ok(result.unmeasured.length > 0);
});

test("complete same-snapshot evidence produces 100", () => {
    const result = evaluateAccuracy({
        ...completeEvidence(),
        snapshotRunId
    });

    assert.equal(result.status, "measured");
    assert.equal(result.score, 100);
    assert.equal(result.sameSnapshot, true);
    assert.equal(result.perfectScoreEligible, true);
});

test("requirements without evidence are not counted as passed", () => {
    const evidence = completeEvidence();

    evidence.plan.acceptanceCriteria[0].evidence = "";

    const result = evaluateAccuracy({
        ...evidence,
        snapshotRunId
    });

    assert.equal(
        result.dimensions.requirements.passed,
        1
    );

    assert.equal(
        result.dimensions.requirements.allPassed,
        false
    );

    assert.equal(result.perfectScoreEligible, false);
});

test("unmeasured test counters remain unmeasured", () => {
    const evidence = completeEvidence();

    evidence.verification.report.report.testCases = {
        measured: false,
        executed: 10,
        passed: 10,
        failed: 0,
        skipped: 0
    };

    const result = evaluateAccuracy({
        ...evidence,
        snapshotRunId
    });

    assert.equal(result.dimensions.tests.measured, false);
    assert.equal(result.score, null);
    assert.ok(result.unmeasured.includes("tests"));
});

test("inconsistent test counters remain unmeasured", () => {
    const evidence = completeEvidence();

    evidence.verification.report.report.testCases = {
        measured: true,
        executed: 10,
        passed: 8,
        failed: 1,
        skipped: 0
    };

    const result = evaluateAccuracy({
        ...evidence,
        snapshotRunId
    });

    assert.equal(result.dimensions.tests.measured, false);
    assert.equal(result.score, null);
});

test("different snapshot prevents perfect eligibility", () => {
    const evidence = completeEvidence();

    evidence.export.snapshotRunId = "another-snapshot";

    const result = evaluateAccuracy({
        ...evidence,
        snapshotRunId
    });

    assert.equal(result.sameSnapshot, false);
    assert.equal(result.perfectScoreEligible, false);
});

test("security findings reduce security score", () => {
    const evidence = completeEvidence();

    evidence.qa.report.securityFindings = [
        { severity: "high" },
        { severity: "medium" }
    ];

    const result = evaluateAccuracy({
        ...evidence,
        snapshotRunId
    });

    assert.equal(result.dimensions.security.score, 75);
});

test("invalid security severity remains unmeasured", () => {
    const evidence = completeEvidence();

    evidence.qa.report.securityFindings = [
        { severity: "unknown" }
    ];

    const result = evaluateAccuracy({
        ...evidence,
        snapshotRunId
    });

    assert.equal(result.dimensions.security.measured, false);
    assert.equal(result.score, null);
});

test("invalid export file evidence remains unmeasured", () => {
    const evidence = completeEvidence();

    evidence.export.files = [
        { path: "" },
        { path: "package.json" }
    ];

    const result = evaluateAccuracy({
        ...evidence,
        snapshotRunId
    });

    assert.equal(result.dimensions.export.measured, false);
    assert.equal(result.score, null);
});
