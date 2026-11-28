import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  ExternalAnalyzerAcquisitionMarkerSchema,
  EXTERNAL_ANALYZER_CANDIDATES,
  runExternalAnalyzer,
} from "audit-tools/shared";
import { runExternalAnalyzerAcquisitionExecutor } from "../dist/audit/orchestrator/acquisitionExecutor.js";
import { analyzerSelectionRequest, currentAnalyzerSelection, analyzerRuntimeOverrides } from "../dist/audit/orchestrator/analyzerSelection.js";
import { analyzerCalibrationRequest, currentAnalyzerCalibration } from "../dist/audit/orchestrator/analyzerCalibration.js";

const semgrep = EXTERNAL_ANALYZER_CANDIDATES.find(candidate => candidate.id === "semgrep");
const result = (stdout = "", status = 0, stderr = "") => ({ stdout, stderr, status, duration_ms: 1 });
const skippedOthers = Object.fromEntries(EXTERNAL_ANALYZER_CANDIDATES
  .filter(candidate => candidate !== semgrep).map(candidate => [candidate.id, "skip"]));

async function fixture(t) {
  const temp = await realpath(tmpdir());
  const work = await mkdtemp(join(temp, "audit-analyzer-fixture-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const root = join(work, "src");
  const localRules = join(work, "rules");
  const executable = join(work, process.platform === "win32" ? "semgrep.exe" : "semgrep");
  await Promise.all([mkdir(root), mkdir(localRules), writeFile(executable, "", { mode: 0o700 })]);
  await Promise.all([writeFile(join(root, "package.json"), "{}"), writeFile(join(root, "one.js"), "const value = 1;")]);
  return { root, localRules, executable };
}

test("the selected local analyzer bypasses the package launcher and release lookup without changing its frozen target", async t => {
  const { root, executable, localRules } = await fixture(t);
  const selection = analyzerSelectionRequest({}, root, skippedOthers);
  const row = { tool: "semgrep", action: "run", reason: "Analyze the JS fixture", existing_executable: executable, local_rules: localRules };
  const decision = {
    input_sha256: selection.input_sha256, decisions: [row], additional_checks: [], gaps: [],
  };
  assert.ok(currentAnalyzerSelection(decision, selection));
  assert.equal(currentAnalyzerSelection({ ...decision, decisions: [{ ...row, action: "omit" }] }, selection), undefined);

  const calls = [];
  const outcome = await runExternalAnalyzerAcquisitionExecutor({}, root, {
    enabled: true, latestReleases: true, analyzers: skippedOthers,
    existingRuntimes: analyzerRuntimeOverrides(decision.decisions),
    consentToken: { value: "fixture", tools: ["semgrep"], existingOnlyTools: ["semgrep"] },
    fetch: async () => { throw new Error("Unexpected network acquisition"); },
    run: async (argv, cwd) => {
      assert.equal(cwd, root);
      calls.push(argv);
      return argv[1] === "--version" ? result("1.186.0") : result(
        JSON.stringify({ results: [], errors: [], paths: { scanned: [join(root, "one.js")], skipped: [] } }),
      );
    },
  });
  assert.deepEqual(calls, [
    [executable, "--version"],
    [executable, "--json", "--quiet", "--metrics=off", "--disable-version-check", "--config", localRules, root],
  ]);
  const record = ExternalAnalyzerAcquisitionMarkerSchema.parse(outcome.updated.external_analyzer_acquisition)
    .tool_statuses.find(row => row.tool === "semgrep");
  assert.equal(record.status, "success");
  assert.equal(record.version, "1.186.0");
});

test("run-only, declines, unusable executable and version failure never fall into acquisition", async t => {
  const { root, executable, localRules } = await fixture(t);
  const token = { value: "fixture", tools: ["semgrep"], existingOnlyTools: ["semgrep"] };
  const inside = join(root, basename(executable));
  await writeFile(inside, "", { mode: 0o700 });
  const neverRun = () => { assert.fail("No process should run"); };
  for (const options of [
    { consentToken: token },
    { consentToken: token, existingRuntimes: { semgrep: { executable: "semgrep", localRules } } },
    { consentToken: token, existingRuntimes: { semgrep: { executable: inside, localRules } } },
    { consentToken: token, analyzerConsent: { semgrep: "declined" }, existingRuntimes: { semgrep: { executable } } },
    { existingRuntimes: { semgrep: { executable } } },
  ]) {
    const denied = await runExternalAnalyzer(semgrep, root, { ...options, run: neverRun });
    assert.ok(["skipped", "not_resolved"].includes(denied.status.status));
    assert.doesNotMatch(denied.status.error, /No process should run/);
  }
  const didNotFetchRules = await runExternalAnalyzer(semgrep, root, {
    consentToken: token, existingRuntimes: { semgrep: { executable } },
    run: neverRun,
  });
  assert.equal(didNotFetchRules.status.status, "not_resolved");
  assert.match(didNotFetchRules.status.error, /requires approved local rules/);
  const calls = [];
  const failed = await runExternalAnalyzer(semgrep, root, {
    consentToken: token, existingRuntimes: { semgrep: { executable, localRules } },
    run: async argv => { calls.push(argv); return result("", 2, "version unavailable"); },
  });
  assert.deepEqual(calls, [[executable, "--version"]]);
  assert.equal(failed.status.status, "not_resolved");
  assert.match(failed.status.error, /version unavailable/);
});

test("failed calibration remains open until a concrete retry or a documented recovery disposition", () => {
  const bundle = { external_analyzer_acquisition: {
    enabled: true, tool_statuses: [{ tool: "semgrep", status: "not_resolved", resolved: false }],
  } };
  const request = analyzerCalibrationRequest(bundle, undefined);
  const row = { tool: "semgrep", action: "limited", reason: "scan never started", coverage: "JS rule pack and source files" };
  const answer = { input_sha256: request.input_sha256, decisions: [row], unresolved: [] };
  assert.equal(currentAnalyzerCalibration(answer, request), undefined);
  assert.equal(currentAnalyzerCalibration({ ...answer, decisions: [{ ...row, action: "accept" }] }, request), undefined);
  const retry = { ...row, action: "retry", existing_executable: "/toolchain/semgrep" };
  assert.equal(currentAnalyzerCalibration({ ...answer, decisions: [retry] }, request), undefined);
  const change = { kind: "configuration", detail: "Use the installed native analyzer rather than pipx." };
  assert.ok(currentAnalyzerCalibration({ ...answer, decisions: [{ ...retry, change }] }, request));
  assert.equal(currentAnalyzerCalibration({
    ...answer, decisions: [{ ...retry, change: { kind: "narrowed_scope", detail: "Only JS" } }],
  }, request), undefined);

  const afterFailedRetry = analyzerCalibrationRequest({
    external_analyzer_acquisition: {
      ...bundle.external_analyzer_acquisition,
      calibration_retries: [{ tools: [{ ...retry, change }] }],
    },
  }, undefined);
  const repeat = { ...answer, input_sha256: afterFailedRetry.input_sha256 };
  assert.equal(currentAnalyzerCalibration({
    ...repeat, decisions: [{ ...retry, change }],
  }, afterFailedRetry), undefined);
  // Omitting the path inherits the installed runtime and still counts as the same retry.
  assert.equal(currentAnalyzerCalibration({
    ...repeat, decisions: [{ ...row, action: "retry", change }],
  }, afterFailedRetry), undefined);
  assert.ok(currentAnalyzerCalibration({
    ...repeat, decisions: [{ ...row, action: "retry", change: { kind: "environment", detail: "Use the repaired Python environment." } }],
  }, afterFailedRetry));
  assert.ok(currentAnalyzerCalibration({
    ...repeat, decisions: [{ ...row, recovery: { disposition: "exhausted", detail: "The installed executable also failed its version probe." } }],
  }, afterFailedRetry));
  assert.ok(currentAnalyzerCalibration({
    ...answer, decisions: [{ ...row, recovery: { disposition: "exhausted", detail: "Checked both the env tool bin and the tool cache." } }],
  }, request));
});

test("native analyzer admission retains only frozen rows, including on calibration retry", async t => {
  const { root, executable, localRules } = await fixture(t);
  await writeFile(join(root, "excluded.js"), "const ignored = true;");
  const { validateArtifactBundle } = await import("../dist/audit/validation/artifacts.js");
  const manifest = { repository: "fixture", generated_at: "2026-01-01", files: [{ path: "one.js" }] };
  const fixtureRow = (path) => ({ path, check_id: "fixture-rule", start: { line: 1 }, extra: { message: "synthetic finding", severity: "WARNING" } });
  let rows = [fixtureRow("one.js"), fixtureRow("excluded.js")];
  const options = {
    enabled: true, latestReleases: true, analyzers: skippedOthers,
    existingRuntimes: { semgrep: { executable, localRules } },
    consentToken: { value: "fixture", tools: ["semgrep"], existingOnlyTools: ["semgrep"] },
    fetch: async () => { assert.fail("No network"); },
    run: async (argv) => argv[1] === "--version" ? result("1.186.0") :
      result(JSON.stringify({ results: rows, errors: [], paths: { scanned: ["one.js", "excluded.js"], skipped: [] } })),
  };
  const acquired = await runExternalAnalyzerAcquisitionExecutor({ repo_manifest: manifest }, root, options);
  const report = acquired.updated.external_analyzer_results.find(x => x.tool === "semgrep");
  assert.deepEqual(report.results.map(x => x.path), ["one.js"]);
  assert.equal(report.results[0].rule, "fixture-rule");
  assert.match(report.results[0].provenance?.snippet_hash, /^[a-f0-9]{16}$/);
  assert.deepEqual(validateArtifactBundle(acquired.updated), []);
  assert.match(acquired.progress_summary, /contributing 1 finding.*Omitted 1 finding.*frozen manifest scope/);
  const toolStatus = bundle => ExternalAnalyzerAcquisitionMarkerSchema.parse(bundle.external_analyzer_acquisition)
    .tool_statuses.find(row => row.tool === "semgrep");
  const status = toolStatus(acquired.updated);
  assert.equal(status.status, "findings");
  assert.equal(status.scope_omitted_rows, 1);
  assert.equal(status.dropped_rows, undefined);
  assert.deepEqual(status.reported_coverage.scanned, ["excluded.js", "one.js"]);

  rows = [fixtureRow("excluded.js")];
  const retry = await runExternalAnalyzerAcquisitionExecutor(acquired.updated, root, options, ["semgrep"]);
  assert.deepEqual(retry.updated.external_analyzer_results.find(x => x.tool === "semgrep").results, report.results);
  assert.match(retry.progress_summary, /contributing 0 finding.*Omitted 1 finding/);
  assert.deepEqual(validateArtifactBundle(retry.updated), []);
  const calibration = analyzerCalibrationRequest(retry.updated, null);
  assert.equal(calibration.tools.find(row => row.tool === "semgrep").incomplete, false);
  assert.ok(currentAnalyzerCalibration({
    input_sha256: calibration.input_sha256,
    decisions: [{ tool: "semgrep", action: "accept", reason: "Intentional scope filter", coverage: "Fixture" }],
    unresolved: [],
  }, calibration));

  rows = [fixtureRow("excluded.js"), null];
  const degraded = await runExternalAnalyzerAcquisitionExecutor({ repo_manifest: manifest }, root, options);
  assert.equal(toolStatus(degraded.updated).dropped_rows, 1);
  assert.equal(toolStatus(degraded.updated).scope_omitted_rows, 1);
  assert.equal(analyzerCalibrationRequest(degraded.updated, null).tools.find(x => x.tool === "semgrep").incomplete, true);
});
