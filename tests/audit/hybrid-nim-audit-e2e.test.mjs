/**
 * A-8 HYBRID audit-path validation (crit. 3, audit side) — a REAL end-to-end run
 * through the production audit next-step routing (`runDeterministicForNextStep`) with
 * the conversation host (`claude-code`) AND a live NIM spill pool confirmed at once.
 *
 * Unlike `nim-rolling-audit-e2e` (provider = openai-compatible → in-process ONLY), here
 * the provider is the HOST and NIM is the spill pool, so the A-8 coordinator SPLITS the
 * review frontier across BOTH pool classes:
 *  - the NIM partition is reviewed IN-PROCESS by real NIM this cycle (read-only review →
 *    `mergeAndIngest` folds the AuditResults into `audit_results.jsonl`), and
 *  - the host complement is handed back as the `semantic_review` step (the host would
 *    batch-review whatever NIM did not cover; coverage already excludes the NIM tasks).
 * Proves crit. 3 for audit: both pools active, NIM reviews live, the host gets the rest.
 *
 * SKIPPED unless RUN_NIM_E2E=1 AND a NIM key (LLM_BACKEND_API_KEY or NVIDIA_API_KEY) is
 * in the env. Run from the repo root:
 *   RUN_NIM_E2E=1 node --import tsx/esm --test tests/audit/hybrid-nim-audit-e2e.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { withTempDir } from "./helpers/withTempDir.mjs";
import { writeFixtureRepo, advanceFixtureToPlanning } from "./helpers/fixture.mjs";

const { runDeterministicForNextStep } = await import(
  "../../src/audit/cli/nextStepCommand.ts"
);
const { writeCoreArtifacts } = await import("../../src/audit/io/artifacts.ts");

const KEY_ENV = process.env.LLM_BACKEND_API_KEY
  ? "LLM_BACKEND_API_KEY"
  : "NVIDIA_API_KEY";
const RUN = process.env.RUN_NIM_E2E === "1" && Boolean(process.env[KEY_ENV]);

test(
  "A8 HYBRID: host (claude-code) + live NIM split the review frontier — NIM reviews its partition in-process, the host gets the complement",
  { skip: RUN ? false : "set RUN_NIM_E2E=1 and a NIM key (LLM_BACKEND_API_KEY/NVIDIA_API_KEY) to run" },
  async () => {
    await withTempDir("hybrid-nim-audit-e2e-", async (root) => {
      await writeFixtureRepo(root);
      // Drive the deterministic chain to planning so the next obligation is the
      // host-delegation dispatch (audit_tasks_completed), then flush the bundle.
      const { planning } = await advanceFixtureToPlanning(root);
      const artifactsDir = join(root, ".audit-tools", "audit");
      await writeCoreArtifacts(artifactsDir, planning.updated_bundle, { prune: true });

      // provider = the conversation HOST; openai_compatible = the live NIM spill pool.
      // Neither is an explicit-backend (claude-code is the host) → the host-review
      // branch activates the A-8 hybrid: NIM reviews its partition in-process, the host
      // gets the coverage-driven complement.
      const sessionConfig = {
        provider: "claude-code",
        openai_compatible: {
          base_url: "https://integrate.api.nvidia.com/v1",
          model: "openai/gpt-oss-120b",
          api_key_env: KEY_ENV,
          response_format_json: true,
        },
        dispatch: { rolling_engine: true },
        // Give the NIM pool several slots so it reviews a handful of tasks (not just
        // one), so at least one lands a contract-valid AuditResult (the strict
        // line-count contract makes a single small-model review occasionally invalid).
        quota: { unknown_hosted_concurrency: 8 },
        timeout_ms: 120_000,
      };

      const nextStep = () =>
        runDeterministicForNextStep({
          root,
          artifactsDir,
          selfCliPath: "audit-code",
          timeoutMs: 120_000,
          narrativeEnabled: false,
          analyzers: { typescript: "skip", python: "skip", css: "skip", html: "skip", sql: "skip" },
          graphLlmEdgeReasoning: false,
          sessionConfig,
        });

      const storePath = join(artifactsDir, "audit_results.jsonl");
      const promotedFindingsPath = join(root, ".audit-tools", "audit-findings.json");
      const ingestedTaskIds = () =>
        existsSync(storePath)
          ? readFileSync(storePath, "utf8")
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean)
              .map((l) => JSON.parse(l).task_id)
          : [];
      const reviewed = () => ingestedTaskIds().length > 0 || existsSync(promotedFindingsPath);

      // The hybrid reviews the NIM partition once per next-step; a pass where the model
      // returned every assigned result invalid lands nothing (the all-invalid → no-progress
      // path), but the NIM tasks stay pending, so re-entering next-step re-splits +
      // re-dispatches them. Bounded retry absorbs the rare invalid first pass (the
      // in-process e2e does the same). Each pass still hands the host its complement.
      let result;
      for (let attempt = 0; attempt < 3 && !reviewed(); attempt += 1) {
        result = await nextStep();
      }
      const nimReviewed = reviewed();
      const taskIds = ingestedTaskIds();

      // eslint-disable-next-line no-console
      console.log(
        `[hybrid-nim-audit-e2e] LIVE SPLIT — NIM reviewed in-process: ${taskIds.length} task(s) ` +
          `[${taskIds.slice(0, 5).join(", ")}] | last next step: ${result?.kind}`,
      );

      // Crit. 3 (audit) — the NIM pool reviewed its partition LIVE this cycle (real
      // AuditResults folded into the cumulative store, or promoted on a complete run).
      assert.ok(
        nimReviewed,
        "the NIM partition must review live — AuditResults in audit_results.jsonl (or promoted findings)",
      );
      // The split routed work to BOTH pools: after NIM ingested its partition, the host
      // gets the coverage-driven complement as the `semantic_review` step (unless NIM
      // happened to cover the whole frontier, which `transition`s — both are valid hybrid
      // outcomes; the split + the live NIM review above is the crit-3 proof).
      assert.ok(
        result?.kind === "semantic_review" || result?.kind === "transition",
        `expected the host complement (semantic_review) or a covered-frontier transition, got ${result?.kind}`,
      );

      // The host review must be re-derived from coverage as the COMPLEMENT — not the
      // reused NIM partition run. Read the host run's task list: it must EXCLUDE every
      // task NIM already covered (a reused NIM run would still list its covered task and
      // would orphan the never-assigned complement). This is the clean-split guarantee.
      if (result?.kind === "semantic_review") {
        const hostTasksPath = join(artifactsDir, "dispatch", "current-tasks.json");
        const hostTaskIds = existsSync(hostTasksPath)
          ? JSON.parse(readFileSync(hostTasksPath, "utf8")).map((t) => t.task_id)
          : [];
        assert.ok(hostTaskIds.length > 0, "the host complement review must list tasks");
        for (const covered of taskIds) {
          assert.ok(
            !hostTaskIds.includes(covered),
            `host review must exclude NIM-covered task ${covered} (it re-derives the complement, not reuses the NIM run)`,
          );
        }
      }
    });
  },
);
