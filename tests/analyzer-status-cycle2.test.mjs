import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runTrackedAsync } from "audit-tools/shared";
import { runSyntaxResolutionExecutor } from "../dist/audit/orchestrator/syntaxResolutionExecutor.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "audit-analyzer-status-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "sample.js"), "const sample = true;\n");
  return root;
}

test("syntax resolution only calls a complete clean lint report a success", async t => {
  const root = await fixture(t);
  const bin = join(root, "node_modules", "eslint", "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(root, "eslint.config.mjs"), "export default [];\n");

  const filePath = join(root, "sample.js");
  const validRow = { message: "sample lint diagnostic", severity: 2, line: 1, ruleId: "fixture-rule" };
  const cases = [
    { name: "valid empty report", stdout: "[]", exit: 0, status: "success" },
    { name: "valid zero-message file", stdout: JSON.stringify([{ filePath, messages: [] }]), exit: 0, status: "success" },
    { name: "missing report despite zero exit", stdout: "", exit: 0, status: "failed" },
    { name: "nonzero without report", stdout: "", exit: 2, status: "failed", stderr: "bad configuration\n" },
    { name: "nonzero with empty report", stdout: "[]", exit: 1, status: "failed" },
    { name: "legitimate rule exit with separate stderr", stdout: JSON.stringify([{ filePath, messages: [validRow] }]), exit: 1, status: "findings", stderr: "fixture warning\n", findings: 1 },
    { name: "failed exit with retained finding", stdout: JSON.stringify([{ filePath, messages: [validRow] }]), exit: 2, status: "failed", findings: 1 },
    { name: "invalid report shape", stdout: '"not a report"', exit: 0, status: "parse_error" },
    { name: "incomplete report with retained finding", stdout: JSON.stringify([{ filePath, messages: [validRow, { severity: 2 }] }]), exit: 0, status: "parse_error", findings: 1, dropped: 1 },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      await writeFile(join(bin, "eslint.js"), `
const fs = require("node:fs");
fs.writeSync(1, ${JSON.stringify(entry.stdout)});
fs.writeSync(2, ${JSON.stringify(entry.stderr ?? "")});
process.exitCode = ${entry.exit};
`);
      const run = await runSyntaxResolutionExecutor({ file_disposition: { files: [{ path: "sample.js" }] } }, root);
      const [status] = run.updated.syntax_resolution_status.tool_statuses;
      const [{ results }] = run.updated.external_analyzer_results;
      assert.equal(status.status, entry.status, JSON.stringify(status));
      assert.equal(status.exit_code, entry.exit);
      assert.equal(status.stderr_snippet, entry.stderr?.trim());
      assert.equal(status.dropped_rows, entry.dropped);
      assert.equal(results.length, entry.findings ?? 0);
      if (entry.findings) {
        assert.equal(results[0].rule, validRow.ruleId);
        assert.equal(results[0].summary, validRow.message);
      }
      assert.equal(/1 analyzer diagnostic/.test(run.progress_summary), !["success", "findings"].includes(entry.status));
    });
  }
});

test("external analyzer CLI reports received rows without claiming duplicate findings were imported", async t => {
  const root = await fixture(t);
  const artifacts = join(root, ".audit-tools", "audit");
  const source = join(root, "input.json");
  const row = { id: "fixture", category: "maintainability", severity: "medium", path: "sample.js", summary: "Fixture analyzer lead" };
  await writeFile(source, JSON.stringify({ tool: "fixture-analyzer", results: [row, row] }));

  const command = [
    process.execPath, fileURLToPath(new URL("../audit-code.mjs", import.meta.url)),
    "import-external-analyzer", "--root", root, "--artifacts-dir", artifacts,
    "--external-analyzer-results", source,
  ];
  const stored = join(artifacts, "external_analyzer_results.json");
  for (let attempt = 0; attempt < 2; attempt++) {
    const run = await runTrackedAsync(command, { cwd: root, timeout: 20000 });
    assert.equal(run.status, 0, run.stderr);
    const response = JSON.parse(run.stdout);
    assert.equal(response.selected_executor, "external_analyzer_import_executor");
    assert.equal(response.received_count, 2);
    assert.equal(Object.hasOwn(response, "imported_count"), false);
    const reports = JSON.parse(await readFile(stored, "utf8"));
    assert.deepEqual(reports.find(report => report.tool === "fixture-analyzer").results, [row]);
  }
});

const sampleRow = (path) => ({ id: path, category: "maintainability", severity: "medium", path, summary: "Fixture analyzer lead", rule: "fixture-rule" });
const sampleManifest = { repository: "fixture", generated_at: "2026-01-01", files: [{ path: "sample.js" }] };

test("syntax resolution diagnoses frozen-scope omissions without degrading the synthetic scan", async t => {
  const root = await fixture(t);
  const excluded = join(root, "excluded.js");
  await writeFile(excluded, "const ignored = true;");
  const bin = join(root, "node_modules", "eslint", "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(root, "eslint.config.mjs"), "export default [];");
  const message = { message: "synthetic diagnostic", severity: 2, line: 1, ruleId: "fixture-rule" };
  for (const paths of [[join(root, "sample.js"), excluded], [excluded]]) {
    await writeFile(join(bin, "eslint.js"), `console.log(${JSON.stringify(JSON.stringify(paths.map(filePath => ({ filePath, messages: [message] }))))});`);
    const run = await runSyntaxResolutionExecutor({
      repo_manifest: sampleManifest,
      file_disposition: { files: [{ path: "sample.js" }] },
    }, root);
    const status = run.updated.syntax_resolution_status.tool_statuses[0];
    assert.equal(status.status, "findings");
    assert.equal(status.scope_omitted_rows, 1);
    assert.equal(status.dropped_rows, undefined);
    assert.deepEqual(run.updated.external_analyzer_results[0].results.map(x => x.path), paths.length === 2 ? ["sample.js"] : []);
    assert.match(run.progress_summary, /Omitted 1 finding.*frozen manifest scope/);
    if (paths.length === 1) assert.doesNotMatch(run.progress_summary, /triggering high-priority/);
  }
});

test("import executor distinguishes missing/empty manifests, scoped omissions and malformed rows", async () => {
  const { runExternalAnalyzerImportExecutor } = await import("../dist/audit/orchestrator/ingestionExecutors.js");
  const { validateArtifactBundle } = await import("../dist/audit/validation/artifacts.js");
  const admitted = sampleRow("sample.js");
  const omitted = sampleRow("excluded.js");
  const input = { tool: "fixture", results: [admitted, omitted] };
  const existing = { repo_manifest: sampleManifest, audit_report: {}, external_analyzer_results: [{tool: "earlier", results: [admitted]}] };
  assert.deepEqual(runExternalAnalyzerImportExecutor({}, input).updated.external_analyzer_results[0].results, [admitted, omitted]);
  const mixed = runExternalAnalyzerImportExecutor({ repo_manifest: sampleManifest }, input);
  assert.deepEqual(mixed.updated.external_analyzer_results[0].results, [admitted]);
  assert.deepEqual(validateArtifactBundle(mixed.updated), []);
  assert.match(validateArtifactBundle({ ...mixed.updated, external_analyzer_results: [input] })[0].message, /unknown path excluded.js/);
  const empty = runExternalAnalyzerImportExecutor({ repo_manifest: { ...sampleManifest, files: [] } }, input);
  assert.equal(empty.updated.external_analyzer_results, undefined);
  assert.match(empty.progress_summary, /Omitted 2 finding/);

  const provenance = { analyzer_id: "fixture", path: admitted.path, snippet_hash: "synthetic", comparison_fingerprint: "fixture-receipt" };
  const received = { ...admitted, provenance };
  const receiptTest = runExternalAnalyzerImportExecutor({ repo_manifest: sampleManifest }, { ...input, results: [received] });
  const { comparison_fingerprint, ...expectedProvenance } = provenance;
  assert.deepEqual(receiptTest.updated.external_analyzer_results[0].results, [{ ...received, provenance: expectedProvenance }]);
  const withNativeReceipt = { ...existing, external_analyzer_results: [{ ...input, results: [received] }] };
  const duplicate = runExternalAnalyzerImportExecutor(withNativeReceipt, { ...input, results: [received, omitted] });
  assert.equal(duplicate.updated, withNativeReceipt);
  assert.deepEqual(duplicate.artifacts_written, []);
  assert.match(duplicate.progress_summary, /Reused.*Omitted 1 finding/);

  const omissionInput = { ...input, results: [omitted] };
  const noop = runExternalAnalyzerImportExecutor(existing, omissionInput);
  assert.equal(noop.updated, existing);
  assert.deepEqual(noop.artifacts_written, []);
  assert.match(noop.progress_summary, /Omitted 1 finding/);
  const graph = [{ from: "sample.js", to: "excluded.js", kind: "dataflow", confidence: 0.9 }];
  const graphOnly = runExternalAnalyzerImportExecutor(existing, { ...omissionInput, graph_edges: graph });
  assert.deepEqual(graphOnly.artifacts_written, ["external_analyzer_results.json"]);
  assert.equal(graphOnly.updated.audit_report, undefined);
  assert.deepEqual(graphOnly.updated.external_analyzer_results.find(x => x.tool === "fixture").graph_edges, graph);
  const roots = [{ root: ".", paths: ["sample.js"] }];
  const ownershipOnly = runExternalAnalyzerImportExecutor(existing, { ...omissionInput, ownership_roots: roots });
  assert.deepEqual(ownershipOnly.artifacts_written, ["external_analyzer_results.json"]);
  assert.deepEqual(ownershipOnly.updated.external_analyzer_results.find(x => x.tool === "fixture").ownership_roots, roots);

  for (const malformed of [{}, null]) {
    assert.throws(() => runExternalAnalyzerImportExecutor(existing, { ...input, results: [admitted, malformed] }),
      /Invalid external analyzer result at results\[1\]/);
    assert.deepEqual(existing.external_analyzer_results, [{tool: "earlier", results: [admitted]}]);
  }
});

test("import CLI persists only admitted results, reports all received rows, and rejects malformed input", async t => {
  const root = await fixture(t);
  const artifacts = join(root, ".audit-tools", "audit");
  const source = join(root, "input.json");
  const stored = join(artifacts, "external_analyzer_results.json");
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(artifacts, "repo_manifest.json"), JSON.stringify(sampleManifest));
  const command = [process.execPath, fileURLToPath(new URL("../audit-code.mjs", import.meta.url)),
    "import-external-analyzer", "--root", root, "--artifacts-dir", artifacts, "--external-analyzer-results", source];
  const call = async results => {
    await writeFile(source, JSON.stringify({ tool: "fixture", results }));
    return runTrackedAsync(command, { cwd: root, timeout: 20000 });
  };
  const admitted = sampleRow("sample.js");
  const omitted = sampleRow("excluded.js");
  const noop = await call([omitted]);
  assert.equal(noop.status, 0, noop.stderr);
  assert.equal(JSON.parse(noop.stdout).received_count, 1);
  assert.match(JSON.parse(noop.stdout).progress_summary, /Omitted 1 finding/);
  await assert.rejects(readFile(stored, "utf8"), { code: "ENOENT" });
  const malformed = await call([admitted, null]);
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /Invalid external analyzer result at results\[1\]/);
  await assert.rejects(readFile(stored, "utf8"), { code: "ENOENT" });
  for (let attempt = 0; attempt < 2; attempt++) {
    const mixed = await call([admitted, omitted]);
    assert.equal(mixed.status, 0, mixed.stderr);
    const response = JSON.parse(mixed.stdout);
    assert.equal(response.received_count, 2);
    assert.match(response.progress_summary, /Omitted 1 finding/);
    assert.deepEqual(JSON.parse(await readFile(stored, "utf8"))[0].results, [admitted]);
  }
});
