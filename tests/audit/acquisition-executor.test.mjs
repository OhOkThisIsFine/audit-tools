import { test, expect } from "vitest";

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
  expect(spawned, "no subprocess may spawn when disabled").toBe(false);
  expect(result.artifacts_written).toEqual([
    "external_analyzer_acquisition.json",
  ]);
  const marker = result.updated.external_analyzer_acquisition;
  expect(marker.enabled).toBe(false);
  expect(marker.tool_statuses).toEqual([]);
  expect(result.updated.external_analyzer_results).toBe(undefined);
});

test("enabled but no root ⇒ empty marker (defence-in-depth)", async () => {
  const result = await runExternalAnalyzerAcquisitionExecutor(
    bundleAfterIntake(),
    undefined,
    { enabled: true },
  );
  expect(result.updated.external_analyzer_acquisition.enabled).toBe(false);
  expect(result.artifacts_written).toEqual([
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
  expect(marker.enabled).toBe(true);
  const gitleaksStatus = marker.tool_statuses.find((s) => s.tool === "gitleaks");
  expect(gitleaksStatus, "marker must carry a gitleaks status").toBeTruthy();
  expect(gitleaksStatus.status).toBe("findings");

  // Findings upserted into external_analyzer_results, raw secret dropped.
  expect(result.artifacts_written.includes("external_analyzer_results.json")).toBeTruthy();
  const gitleaksResults = result.updated.external_analyzer_results.find(
    (r) => r.tool === "gitleaks",
  );
  expect(gitleaksResults, "external_analyzer_results must contain gitleaks").toBeTruthy();
  expect(gitleaksResults.results.length).toBe(1);
  const finding = gitleaksResults.results[0];
  expect(finding.path).toBe("src/a.ts");
  expect(finding.category).toBe("security");
  expect(!JSON.stringify(finding).includes("SHOULD-NOT-LEAK"), "raw secret value must never be carried into the artifact").toBeTruthy();
});
