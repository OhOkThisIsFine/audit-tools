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
