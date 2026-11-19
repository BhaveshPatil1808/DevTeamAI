const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runStaticQA } = require("./orchestrator/qa-runner");

async function main() {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "devteam-qa-test-")
  );

  const runId = "qa-test-run-001";
  const integrationRoot = path.join(
    tempRoot,
    ".devteam",
    "integrated",
    runId
  );

  try {
    fs.mkdirSync(path.join(integrationRoot, "src"), {
      recursive: true
    });

    const htmlPath = path.join(integrationRoot, "index.html");
    const jsPath = path.join(integrationRoot, "src", "app.js");

    fs.writeFileSync(
      htmlPath,
      `<!doctype html>
<html>
<head><title>QA Test</title></head>
<body>
  <script type="module" src="./src/app.js"></script>
</body>
</html>`
    );

    fs.writeFileSync(
      jsPath,
      `const message = "DevTeamAI QA test";
console.log(message);`
    );

    const integrationFiles = [
      {
        path: `.devteam/integrated/${runId}/index.html`
      },
      {
        path: `.devteam/integrated/${runId}/src/app.js`
      }
    ];

    console.log("\nTEST 1: Valid HTML and JavaScript");

    const validReport = await runStaticQA({
      projectRoot: tempRoot,
      runId,
      integrationFiles
    });

    console.log(JSON.stringify(validReport, null, 2));

    if (validReport.status !== "passed") {
      throw new Error("TEST 1 FAILED: Valid files did not pass QA.");
    }

    console.log("\nTEST 1 PASSED");

    console.log("\nTEST 2: Missing local asset");

    fs.writeFileSync(
      htmlPath,
      `<!doctype html>
<html>
<body>
  <script type="module" src="./src/missing.js"></script>
</body>
</html>`
    );

    const missingReport = await runStaticQA({
      projectRoot: tempRoot,
      runId,
      integrationFiles
    });

    console.log(JSON.stringify(missingReport, null, 2));

    if (missingReport.status === "passed") {
      throw new Error("TEST 2 FAILED: Missing asset was not detected.");
    }

    console.log("\nTEST 2 PASSED: Missing asset detected");

    console.log("\nTEST 3: Invalid JavaScript syntax");

    fs.writeFileSync(
      htmlPath,
      `<html><body>
<script type="module" src="./src/app.js"></script>
</body></html>`
    );

    fs.writeFileSync(
      jsPath,
      `function broken( {
  console.log("invalid");
}`
    );

    const syntaxReport = await runStaticQA({
      projectRoot: tempRoot,
      runId,
      integrationFiles
    });

    console.log(JSON.stringify(syntaxReport, null, 2));

    if (syntaxReport.status === "passed") {
      throw new Error("TEST 3 FAILED: Invalid JavaScript was not detected.");
    }

    console.log("\nTEST 3 PASSED: Invalid JavaScript detected");

    console.log("\nALL QA RUNNER TESTS PASSED");
  } finally {
    fs.rmSync(tempRoot, {
      recursive: true,
      force: true
    });
  }
}

main().catch((error) => {
  console.error("\nQA TEST FAILED:", error.message);
  process.exitCode = 1;
});
