import test from "node:test";
import assert from "node:assert/strict";

// Slice D — production wiring of the external-analyzer acquisition engine.
// Covers the hermeticity gate (disabled ⇒ empty marker, nothing spawned) and the
// enabled path with an injected fetch + command runner (gitleaks via a fake
// PATH-resolved binary), asserting the marker + the upserted findings.

const { runExternalAnalyzerAcquisitionExecutor } = await import(
  "../../src/audit/orchestrator/acquisitionExecutor.ts"
);

function bundleAfterIntake() {
  return {
    provider_confirmation: {},
    repo_manifest: { files: [{ path: "src/a.ts" }] },
    file_disposition: { files: [{ path: "src/a.ts", status: "included" }] },
    auto_fixes_applied: {},
    syntax_resolution_status: {},
  };
}

test("disabled (no option) ⇒ hermetic empty marker, nothing spawned, results untouched", async () => {
  let spawned = false;
  const run = () => {
    spawned = true;
    return { status: 0, stdout: "", stderr: "", argv: [], duration_ms: 1 };
  };
  const result = await runExternalAnalyzerAcquisitionExecutor(
    bundleAfterIntake(),
    "/repo",
    { run },
  );
  assert.equal(spawned, false, "no subprocess may spawn when disabled");
  assert.deepEqual(result.artifacts_written, [
    "external_analyzer_acquisition.json",
  ]);
  const marker = result.updated.external_analyzer_acquisition;
  assert.equal(marker.enabled, false);
  assert.deepEqual(marker.tool_statuses, []);
  assert.equal(result.updated.external_analyzer_results, undefined);
});

test("enabled but no root ⇒ empty marker (defence-in-depth)", async () => {
  const result = await runExternalAnalyzerAcquisitionExecutor(
    bundleAfterIntake(),
    undefined,
    { enabled: true },
  );
  assert.equal(result.updated.external_analyzer_acquisition.enabled, false);
  assert.deepEqual(result.artifacts_written, [
    "external_analyzer_acquisition.json",
  ]);
});

test("enabled ⇒ gitleaks (PATH-resolved) findings upserted + marker records status", async () => {
  // gitleaks writes a JSON report file, not stdout. The engine reads
  // candidate.reportFile() — so the fake runner must create that file. We
  // intercept the report path from the spawn argv (`--report-path <path>`).
  const { writeFileSync } = await import("node:fs");
  const gitleaksReport = JSON.stringify([
    {
      RuleID: "generic-api-key",
      File: "src/a.ts",
      StartLine: 7,
      EndLine: 7,
      Description: "Generic API key",
      Fingerprint: "fp-1",
      Secret: "SHOULD-NOT-LEAK",
    },
  ]);

  const run = (argv) => {
    // PATH probe for gitleaks (`gitleaks version`) succeeds so resolveBinary
    // returns the on-PATH binary and never downloads.
    if (argv.includes("version") && argv.includes("gitleaks")) {
      return { status: 0, stdout: "8.21.2", stderr: "", argv, duration_ms: 1 };
    }
    // npx/pipx probes (semgrep/eslint) — report unavailable so they degrade.
    if (argv.includes("--version")) {
      return {
        status: 1,
        stdout: "",
        stderr: "not found",
        argv,
        duration_ms: 1,
        error: new Error("ENOENT"),
      };
    }
    // The gitleaks tool spawn: write the report file it was told to.
    const reportIdx = argv.indexOf("--report-path");
    if (reportIdx >= 0) {
      writeFileSync(argv[reportIdx + 1], gitleaksReport, "utf8");
    }
    return { status: 0, stdout: "", stderr: "", argv, duration_ms: 1 };
  };

  // Fetcher must never be called (gitleaks resolves on PATH); fail loudly if it is.
  const fetchAdapter = async () => {
    throw new Error("fetch must not run when the binary resolves on PATH");
  };

  const result = await runExternalAnalyzerAcquisitionExecutor(
    bundleAfterIntake(),
    process.cwd(),
    { enabled: true, run, fetch: fetchAdapter },
  );

  const marker = result.updated.external_analyzer_acquisition;
  assert.equal(marker.enabled, true);
  const gitleaksStatus = marker.tool_statuses.find((s) => s.tool === "gitleaks");
  assert.ok(gitleaksStatus, "marker must carry a gitleaks status");
  assert.equal(gitleaksStatus.status, "findings");

  // Findings upserted into external_analyzer_results, raw secret dropped.
  assert.ok(result.artifacts_written.includes("external_analyzer_results.json"));
  const gitleaksResults = result.updated.external_analyzer_results.find(
    (r) => r.tool === "gitleaks",
  );
  assert.ok(gitleaksResults, "external_analyzer_results must contain gitleaks");
  assert.equal(gitleaksResults.results.length, 1);
  const finding = gitleaksResults.results[0];
  assert.equal(finding.path, "src/a.ts");
  assert.equal(finding.category, "security");
  assert.ok(
    !JSON.stringify(finding).includes("SHOULD-NOT-LEAK"),
    "raw secret value must never be carried into the artifact",
  );
});
