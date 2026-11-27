import { expect, test } from "vitest";
import { EXTERNAL_ANALYZER_CANDIDATES } from "../../src/shared/analyzers/candidates.js";
import { readParseOutcome } from "../../src/shared/analyzers/types.js";
import { analyzerCalibrationRequest, currentAnalyzerCalibration } from "../../src/audit/orchestrator/analyzerCalibration.js";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";

test("a zero-exit scan that reports an admitted file skipped cannot be accepted as complete", () => {
  const semgrep = EXTERNAL_ANALYZER_CANDIDATES.find(row => row.id === "semgrep")!;
  const output = (skipped: string[]) => readParseOutcome(semgrep.parse!(JSON.stringify({
    results: [], errors: [], paths: { scanned: ["src/main.ts"], skipped: skipped.map(path => ({ path })) },
  })));
  const first = output(["src/other.ts", "dist/ignored.ts"]);
  const bundle: ArtifactBundle = {
    file_disposition: { files: [
      { path: "src/main.ts", status: "included" },
      { path: "src/other.ts", status: "included" },
      { path: "dist/ignored.ts", status: "excluded" },
    ] },
    external_analyzer_acquisition: { enabled: true, tool_statuses: [
      { tool: "semgrep", status: "success", resolved: true, exit_code: 0, reported_coverage: first.reported_coverage },
    ] },
  };
  const req = analyzerCalibrationRequest(bundle, {});
  expect(req.tools[0]).toMatchObject({ incomplete: true, admittedSkipped: ["src/other.ts"] });
  const answer = (action: string) => ({ input_sha256: req.input_sha256, decisions: [
    { tool: "semgrep", action, reason: "Diagnostic evidence", coverage: "Only src/main.ts scanned" },
  ], unresolved: ["src/other.ts not covered"] });
  expect(currentAnalyzerCalibration(answer("accept"), req)).toBeUndefined();
  expect(currentAnalyzerCalibration(answer("retry"), req)).toBeDefined();
  expect(currentAnalyzerCalibration(answer("limited"), req)).toBeDefined();
  bundle.external_analyzer_acquisition!.tool_statuses[0]!.reported_coverage = output(["dist/ignored.ts"]).reported_coverage;
  const next = analyzerCalibrationRequest(bundle, {});
  expect(next.tools[0]).toMatchObject({ incomplete: false, admittedSkipped: [] });
  expect(currentAnalyzerCalibration(answer("limited"), next)).toBeUndefined();
});

test("calibration records skipped selected tools as limited, never approved for retry", () => {
  const bundle: ArtifactBundle = {
    external_analyzer_acquisition: { enabled: true, tool_statuses: [
      { tool: "semgrep", status: "skipped", resolved: false, error: "Consent declined" },
      { tool: "eslint", status: "skipped", resolved: false, error: "Omitted by policy" },
    ] },
  };
  const request = analyzerCalibrationRequest(bundle, {
    input_sha256: "a".repeat(64),
    decisions: [
      { tool: "semgrep", action: "run", reason: "Selected for review" },
      { tool: "eslint", action: "omit", reason: "Not relevant for this review" },
    ],
    additional_checks: [], gaps: [],
  });
  expect(request.tools).toMatchObject([{ tool: "semgrep", incomplete: true, status: "skipped" }]);
  const answer = (action: string) => ({
    input_sha256: request.input_sha256, decisions: [{
      tool: "semgrep", action, reason: "Operator declined", coverage: "No Semgrep coverage",
    }], unresolved: [],
  });
  expect(currentAnalyzerCalibration(answer("limited"), request)).toBeDefined();
  expect(currentAnalyzerCalibration(answer("retry"), request)).toBeUndefined();
  expect(currentAnalyzerCalibration(answer("accept"), request)).toBeUndefined();
});
