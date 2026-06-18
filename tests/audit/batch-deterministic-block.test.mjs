/**
 * N-A02: Batch-deterministic block — one next-step call advances through all
 * pending deterministic obligations (repo_manifest → file_disposition →
 * auto_fixes_applied → syntax_resolved → structure_artifacts →
 * graph_enrichment_current → design_assessment_current) and halts at the first
 * host_delegation: intent_checkpoint_executor → kind "confirm_intent".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const { runDeterministicForNextStep } = await import("../../src/audit/cli/nextStepCommand.ts");
const { loadArtifactBundle } = await import("../../src/audit/io/artifacts.ts");
const { ensureSupervisorDirs } = await import("../../src/audit/io/runArtifacts.ts");
const { deriveAuditState } = await import("../../src/audit/orchestrator/state.ts");

const { withTempDir } = await import("./helpers/withTempDir.mjs");

/** Minimal fixture repo — a tiny TS project with two source files. */
async function writeFixture(root) {
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify(
      {
        name: "batch-det-fixture",
        version: "0.0.0",
        scripts: { test: 'node -e "process.exit(0)"' },
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    join(root, "src", "index.ts"),
    "export function hello(): string {\n  return 'hello';\n}\n",
  );
  await writeFile(
    join(root, "src", "utils.ts"),
    "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
  );
}

test("runDeterministicForNextStep advances through all deterministic obligations in one call and halts at confirm_intent", async () => {
  await withTempDir("audit-code-batch-det-", async (root) => {
    await writeFixture(root);
    const artifactsDir = join(root, ".audit-tools", "audit");
    await mkdir(artifactsDir, { recursive: true });
    await ensureSupervisorDirs(artifactsDir);

    const result = await runDeterministicForNextStep({
      root,
      artifactsDir,
      selfCliPath: "audit-code",
      timeoutMs: 30_000,
      narrativeEnabled: false,
      // Skip all analyzers so the test is self-contained and doesn't require
      // external tools (e.g. tsc) to be on PATH in CI.
      analyzers: { typescript: "skip", python: "skip", css: "skip", html: "skip", sql: "skip" },
      graphLlmEdgeReasoning: false,
    });

    // (1) First host-delegation after the deterministic block must be confirm_intent.
    assert.equal(
      result.kind,
      "confirm_intent",
      `Expected kind "confirm_intent" but got "${result.kind}"`,
    );

    // (2) Must not have returned a blocked or semantic_review kind.
    assert.notEqual(result.kind, "blocked");
    assert.notEqual(result.kind, "semantic_review");

    // (3) The result bundle should reflect deterministic obligations satisfied.
    //     Re-derive state from the bundle to inspect obligations.
    const bundle = await loadArtifactBundle(artifactsDir);
    const state = deriveAuditState(bundle);

    const DETERMINISTIC_OBLIGATIONS = [
      "repo_manifest",
      "file_disposition",
      "auto_fixes_applied",
      "syntax_resolved",
      "structure_artifacts",
      "graph_enrichment_current",
      "design_assessment_current",
    ];

    for (const id of DETERMINISTIC_OBLIGATIONS) {
      const obl = state.obligations.find((o) => o.id === id);
      if (obl) {
        assert.ok(
          obl.state === "satisfied" || obl.state === "present",
          `Obligation ${id} should be satisfied/present after the deterministic block, but got "${obl.state}"`,
        );
      }
      // If the obligation is absent from state it was satisfied and pruned — OK.
    }

    // (4) The bundle must have repo_manifest (confirms intake ran).
    assert.ok(bundle.repo_manifest, "repo_manifest must be present after deterministic block");

    // (5) No agent obligation (audit_tasks_completed) should be pending yet —
    //     planning hasn't run (it comes after intent_checkpoint). design_review_completed
    //     and planning_artifacts obligations naturally appear as "missing" here because
    //     they are downstream of intent_checkpoint, which is what we just halted at.
    const agentObl = state.obligations.find(
      (o) =>
        (o.state === "missing" || o.state === "stale") &&
        o.id === "audit_tasks_completed",
    );
    assert.equal(
      agentObl,
      undefined,
      `audit_tasks_completed obligation should not be pending before intent checkpoint; found: ${JSON.stringify(agentObl)}`,
    );

    // (6) intent_checkpoint_current must be missing (it's the obligation the call halted at).
    const intentObl = state.obligations.find((o) => o.id === "intent_checkpoint_current");
    assert.ok(
      intentObl == null || intentObl.state === "missing" || intentObl.state === "stale",
      `intent_checkpoint_current should be unsatisfied (the stop point), but got: ${JSON.stringify(intentObl)}`,
    );
  });
});
