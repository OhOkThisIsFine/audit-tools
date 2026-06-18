/**
 * Regression guard for A3 step 4 slice 2b — the Linux-only false-cycle.
 *
 * ATTEMPT 1 (reverted, commit 0903a000) rewrote audit's deterministic next-step
 * fold onto shared `advance`, collapsing the hand loop's TWO cycle guards
 * (`checkNoProgressBeforeDispatch`, which SKIPS the `no-metadata` bootstrap state,
 * and `checkFinalizationCycle`, tolerance 16) into a single 0-tolerance
 * visited-state signature. On a FRESH Linux env the first `next-step` folded
 * straight to `blocked` ("unexpected step kind 'blocked' (iteration 1)") instead
 * of advancing.
 *
 * Why it slipped through: the failure is environment-dependent. With analyzers
 * resolved to the regex FLOOR (fresh env, no `~/.audit-tools/analyzer-cache`),
 * the early artifact chain produces colliding content signatures that the
 * 0-tolerance guard false-trips on. On a dev Windows box the host's POPULATED
 * analyzer cache makes those early signatures artificially distinct, so the local
 * suite (and a careful diff review) stayed green — only Linux CI caught it.
 *
 * This test removes that masking by pinning an EMPTY analyzer cache via
 * `AUDIT_TOOLS_ANALYZER_CACHE`, forcing the floor-only path that Linux CI runs.
 * It must hold on EVERY OS: the first next-step (and the whole structure-phase
 * chain) must progress through legitimate pause/terminal kinds and must NEVER
 * fold to `blocked`. Run it against `slice-2b-wip` to confirm it reproduces the
 * failure (it should go red there); it stays green on `main` and must stay green
 * through the slice-2b re-attempt.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWrapper } from "./helpers/run-wrapper.mjs";

// A fresh repo with a `.ts` file but an EMPTY, pinned analyzer cache → the
// `typescript` analyzer resolves "absent" deterministically and the pipeline
// runs the regex floor, exactly as on a fresh Linux CI runner.
async function withFloorOnlyRepo(fn) {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-linux-cycle-"));
  const root = join(tempDir, "repo");
  const analyzerCache = join(tempDir, "empty-analyzer-cache");
  try {
    await mkdir(join(root, "src", "api"), { recursive: true });
    await mkdir(analyzerCache, { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "linux-cycle-fixture", version: "0.0.0" }, null, 2) + "\n",
    );
    await writeFile(
      join(root, "src", "api", "auth.ts"),
      [
        "export function authenticate(token: string): boolean {",
        "  return token.trim().length > 0;",
        "}",
        "",
      ].join("\n"),
    );
    return await fn(root, { AUDIT_TOOLS_ANALYZER_CACHE: analyzerCache });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

// Legitimate non-pause kinds the early chain may terminate at.
const TERMINAL_KINDS = new Set([
  "dispatch_review",
  "single_task_fallback",
  "single_task",
  "synthesis",
  "present_report",
]);

const MAX_PAUSES = 8;

test("regression: floor-only first next-step never false-cycles to blocked (Linux CI repro)", async () => {
  await withFloorOnlyRepo(async (root, env) => {
    const artifactsDir = join(root, ".audit-tools/audit");
    const incomingDir = join(artifactsDir, "incoming");

    // The decisive assertion: iteration 1 must not be `blocked`. This is the
    // exact symptom ATTEMPT 1 produced on Linux.
    let firstKind;

    for (let i = 0; i < MAX_PAUSES; i++) {
      const step = JSON.parse((await runWrapper(["next-step"], { cwd: root, env })).stdout);
      if (i === 0) firstKind = step.step_kind;

      assert.notEqual(
        step.step_kind,
        "blocked",
        `floor-only next-step folded to 'blocked' at iteration ${i + 1} — the slice-2b ` +
          `false-cycle regression. Cycle detection must exempt the 'no-metadata' bootstrap ` +
          `state and tolerate content-signature revisits (see HANDOFF ⚠️ block).`,
      );

      if (step.step_kind === "analyzer_install") {
        await mkdir(incomingDir, { recursive: true });
        await writeFile(
          step.artifact_paths.analyzer_decisions,
          JSON.stringify({ typescript: "skip" }, null, 2) + "\n",
        );
        continue;
      }
      if (step.step_kind === "design_review") {
        await mkdir(incomingDir, { recursive: true });
        await writeFile(
          join(incomingDir, "design-review-findings.json"),
          JSON.stringify([], null, 2) + "\n",
        );
        continue;
      }
      if (step.step_kind === "design_review_parallel") {
        await mkdir(incomingDir, { recursive: true });
        await writeFile(
          join(incomingDir, "design-review-contract-findings.json"),
          JSON.stringify([], null, 2) + "\n",
        );
        await writeFile(
          join(incomingDir, "design-review-conceptual-findings.json"),
          JSON.stringify([], null, 2) + "\n",
        );
        continue;
      }
      if (step.step_kind === "design_review_contract") {
        await mkdir(incomingDir, { recursive: true });
        await writeFile(
          join(incomingDir, "design-review-contract-findings.json"),
          JSON.stringify([], null, 2) + "\n",
        );
        continue;
      }
      if (step.step_kind === "design_review_conceptual") {
        await mkdir(incomingDir, { recursive: true });
        await writeFile(
          join(incomingDir, "design-review-conceptual-findings.json"),
          JSON.stringify([], null, 2) + "\n",
        );
        continue;
      }
      if (step.step_kind === "edge_reasoning" || step.step_kind === "edge_reasoning_dispatch") {
        await mkdir(incomingDir, { recursive: true });
        await writeFile(
          step.artifact_paths.edge_reasoning_results,
          JSON.stringify([], null, 2) + "\n",
        );
        continue;
      }
      if (step.step_kind === "confirm_intent") {
        await writeFile(
          step.artifact_paths.intent_checkpoint,
          JSON.stringify(
            {
              schema_version: "intent-checkpoint/v1",
              confirmed_at: "2026-04-22T00:00:00Z",
              confirmed_by: "host",
              scope_summary: "test scope",
              intent_summary: "full-audit",
            },
            null,
            2,
          ) + "\n",
        );
        continue;
      }
      if (TERMINAL_KINDS.has(step.step_kind)) {
        // Reached a legitimate terminal without ever folding to blocked.
        assert.ok(firstKind && firstKind !== "blocked");
        return;
      }
      throw new Error(
        `unexpected step kind '${step.step_kind}' at iteration ${i + 1} (floor-only repro)`,
      );
    }
    throw new Error("floor-only next-step did not reach a terminal kind within the pause budget");
  });
});
