/**
 * A8(a) provider-path validation — the audit-code mirror of remediate's
 * `nim-rolling-e2e`. A REAL end-to-end run through the production audit next-step
 * routing (`runDeterministicForNextStep`) over a live OpenAI-compatible provider
 * (NVIDIA NIM):
 *
 *  - The deterministic pipeline is advanced to planning in-process
 *    (`advanceFixtureToPlanning`), so the next obligation is
 *    `audit_tasks_completed` (the sole host-delegation dispatch obligation).
 *  - `runDeterministicForNextStep`, with `rolling_engine` ON and an EXPLICIT
 *    backend provider configured (openai-compatible), routes the semantic-review
 *    dispatch to the in-process provider engine (`driveRollingAuditDispatch`) —
 *    the configured provider (NIM) IS the per-packet review worker — instead of
 *    emitting a host-subagent `semantic_review` dispatch step.
 *  - Audit dispatch is READ-ONLY review (no worktree / commit / merge): every
 *    packet's worker writes an `AuditResult[]`; the deterministic `mergeAndIngest`
 *    folds the accepted results into the cumulative `audit_results.jsonl` store.
 *
 * This is the live-provider gate the audit-side A8(a) wiring was missing (the
 * `rolling-audit-dispatch.test.mjs` unit coverage stubs the provider/dispatcher;
 * this exercises the REAL next-step routing + the REAL provider end to end).
 *
 * SKIPPED unless RUN_NIM_E2E=1 (and NVIDIA_API_KEY is set): it hits the live NIM
 * endpoint, so it must never run in the normal suite / CI. Run it with:
 *   RUN_NIM_E2E=1 NVIDIA_API_KEY=... \
 *     node --import tsx/esm --test tests/audit/nim-rolling-audit-e2e.test.mjs
 * from the repo root.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { withTempDir } from "./helpers/withTempDir.mjs";
import { writeFixtureRepo, advanceFixtureToPlanning } from "./helpers/fixture.mjs";

const { runDeterministicForNextStep } = await import(
  "../../src/audit/cli/nextStepCommand.ts"
);
const { writeCoreArtifacts } = await import("../../src/audit/io/artifacts.ts");

const RUN =
  process.env.RUN_NIM_E2E === "1" && Boolean(process.env.NVIDIA_API_KEY);

// Skip the whole suite (not just assert inside) when the live env is absent, so
// the normal CI run never touches the network.
test(
  "A8a: runDeterministicForNextStep routes an explicit backend provider through the in-process audit engine over live NIM — review results land in audit_results.jsonl",
  { skip: RUN ? false : "set RUN_NIM_E2E=1 and NVIDIA_API_KEY to run the live NIM e2e" },
  async () => {
    await withTempDir("nim-rolling-audit-e2e-", async (root) => {
      await writeFixtureRepo(root);
      // Drive the deterministic chain (intake → … → planning) and persist the
      // resulting bundle to disk so the next obligation is the host-delegation
      // dispatch (audit_tasks_completed). `advanceAudit` returns an in-memory
      // bundle and the host-delegation steps (intent checkpoint / design review /
      // planning) aren't written by the executors themselves, so flush the whole
      // planning bundle with `writeCoreArtifacts` for the disk-based next-step.
      const { planning } = await advanceFixtureToPlanning(root);
      const artifactsDir = join(root, ".audit-tools", "audit");
      await writeCoreArtifacts(artifactsDir, planning.updated_bundle, { prune: true });

      // rolling_engine ON + an explicit openai-compatible backend → the in-process
      // driver takes precedence over the host-subagent dispatch step. One
      // next-step call drives the whole review frontier through NIM, then folds.
      const sessionConfig = {
        provider: "openai-compatible",
        openai_compatible: {
          base_url: "https://integrate.api.nvidia.com/v1",
          model: "openai/gpt-oss-120b",
          api_key_env: "NVIDIA_API_KEY",
          // Force strict JSON: gpt-oss occasionally appends a stray closing brace
          // under a free-form instruction, which the loose parser can't recover.
          response_format_json: true,
        },
        dispatch: { rolling_engine: true },
        timeout_ms: 120_000,
      };

      const nextStep = () =>
        runDeterministicForNextStep({
          root,
          artifactsDir,
          selfCliPath: "audit-code",
          timeoutMs: 120_000,
          narrativeEnabled: false,
          analyzers: {
            typescript: "skip",
            python: "skip",
            css: "skip",
            html: "skip",
            sql: "skip",
          },
          graphLlmEdgeReasoning: false,
          sessionConfig,
        });

      // NIM's review results can land in one of two places depending on how far
      // the fold gets in a single call: the cumulative `audit_results.jsonl` store
      // (when the run BLOCKS — e.g. a later retry pass fully fails) or the promoted
      // parent `audit-findings.json` machine contract (when the run COMPLETES, which
      // removes the artifacts dir and promotes the synthesized findings). Either is
      // proof the in-process NIM review round-tripped real data through ingestion.
      const storePath = join(artifactsDir, "audit_results.jsonl");
      const promotedFindingsPath = join(root, ".audit-tools", "audit-findings.json");
      const ingestedLines = () =>
        existsSync(storePath)
          ? readFileSync(storePath, "utf8").split("\n").map((l) => l.trim()).filter(Boolean)
          : [];
      const landed = () => ingestedLines().length > 0 || existsSync(promotedFindingsPath);

      // One next-step drives the whole review frontier through NIM in-process. A
      // pass where the model returned every assigned result invalid blocks cleanly
      // (no crash — the robustness fix) with nothing ingested; re-entering next-step
      // re-dispatches the still-pending tasks. Bounded retry absorbs that rare
      // first-pass total failure so the gated live test is stable.
      let result;
      for (let attempt = 0; attempt < 3 && !landed(); attempt += 1) {
        result = await nextStep();
        // The in-process driver ran instead of emitting a host-subagent dispatch
        // step: the fold consumed audit_tasks_completed itself, so the emitted step
        // is NEVER the host `semantic_review` dispatch.
        assert.notEqual(
          result.kind,
          "semantic_review",
          "explicit backend provider must drive review in-process, not emit a host dispatch step",
        );
      }

      assert.ok(
        landed(),
        "NIM's in-process review must land real results — either ingested into " +
          "audit_results.jsonl (blocked terminal) or promoted to audit-findings.json (complete terminal)",
      );

      // Validate the contract of whichever artifact landed.
      const lines = ingestedLines();
      if (lines.length === 0) {
        // Completed terminal: validate the promoted machine contract instead.
        const findings = JSON.parse(await readFile(promotedFindingsPath, "utf8"));
        assert.ok(
          Array.isArray(findings.findings) || Array.isArray(findings.work_blocks),
          "promoted audit-findings.json must carry a findings/work_blocks array",
        );
        return;
      }
      // Each ingested line is a valid AuditResult JSON object with the contract keys.
      for (const line of lines) {
        const parsed = JSON.parse(line);
        assert.equal(typeof parsed.task_id, "string");
        assert.ok(Array.isArray(parsed.findings), "each result carries a findings[] array");
      }
    });
  },
);
