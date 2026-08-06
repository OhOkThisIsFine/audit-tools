// A8 HYBRID provider-path validation (crit. 3) — a REAL end-to-end run through the
// production next-step routing (`decideNextStep`) with the conversation host
// (`claude-code`) AND a live in-process backend (NVIDIA NIM) confirmed at once.
//
// Unlike `nim-rolling-e2e` (provider = openai-compatible → in-process ONLY), here the
// provider is the HOST and NIM is the spill pool, so the A-8 coordinator SPLITS the
// eligible frontier across BOTH pool classes in one cycle:
//  - the NIM partition is reviewed/fixed IN-PROCESS by real NIM this cycle (worktree →
//    commit → verify → merge → resolved), and
//  - the host partition is handed back in the `dispatch_implement_rolling` step (the
//    host would spawn a subagent per node; in this headless run it stays pending).
// Proves crit. 3: both pools active, nodes land via NIM, the split routes work to both.
//
// SKIPPED unless RUN_NIM_E2E=1 AND a NIM key (LLM_BACKEND_API_KEY or NVIDIA_API_KEY) is
// in the env. Run from the repo root:
//   RUN_NIM_E2E=1 npx vitest run tests/remediate/hybrid-nim-e2e.test.ts

import { afterAll, describe, it, expect } from "vitest";
import { spawnSyncHidden as spawnSync } from "../helpers/spawn.mjs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import { StateStore } from "../../src/remediate/state/store.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
import { createNextStepHarness } from "./helpers/nextStepHarness.js";

const KEY_ENV = process.env.LLM_BACKEND_API_KEY
  ? "LLM_BACKEND_API_KEY"
  : "NVIDIA_API_KEY";
const RUN = process.env.RUN_NIM_E2E === "1" && Boolean(process.env[KEY_ENV]);

// Four disjoint, independent nodes — each creates one trivial valid .mjs file. No
// verify gimmick: every node's per-node verify auto-passes (touches no test), so the
// only thing that decides whether a node lands is whether its pool actually ran it.
const NODES = [
  { id: "F-001", block: "B-001", file: "n1.mjs", content: "export const n1 = 1;" },
  { id: "F-002", block: "B-002", file: "n2.mjs", content: "export const n2 = 2;" },
  { id: "F-003", block: "B-003", file: "n3.mjs", content: "export const n3 = 3;" },
  { id: "F-004", block: "B-004", file: "n4.mjs", content: "export const n4 = 4;" },
];

function buildState(): RemediationState {
  return {
    status: "implementing",
    plan: {
      plan_id: "PLAN-HYB-NIM",
      findings: NODES.map((n) => ({
        id: n.id,
        title: `Create ${n.file}`,
        category: "correctness",
        severity: "low",
        confidence: "high",
        lens: "correctness",
        summary: `Create ${n.file}.`,
        affected_files: [{ path: n.file }],
        evidence: [`${n.file}:1`],
      })),
      blocks: NODES.map((n) => ({
        block_id: n.block,
        items: [n.id],
        parallel_safe: true,
        dependencies: [],
      })),
      project_type: "unknown",
      candidate_closing_actions: ["none"],
    },
    items: Object.fromEntries(
      NODES.map((n) => [
        n.id,
        {
          finding_id: n.id,
          status: "pending",
          block_id: n.block,
          item_spec: {
            finding_id: n.id,
            concrete_change:
              `Create a new file named ${n.file} whose entire contents are exactly the following single line:\n${n.content}\n`,
            no_change: false,
            touched_files: [n.file],
            tests_to_write: [],
            not_applicable_steps: [],
          },
        },
      ]),
    ),
    closing_plan: { action: "none" },
  } as unknown as RemediationState;
}

describe.runIf(RUN)("A8 HYBRID host+NIM split over live NIM (crit. 3)", () => {
  const harness = createNextStepHarness(".test-hybrid-nim-e2e");
  afterAll(async () => {
    await harness.cleanupTestRepo();
  });

  it(
    "splits the frontier across the host pool + the live NIM pool: NIM nodes land in-process, host nodes are handed off",
    async () => {
      await harness.resetTestRepo();
      const { REPO_DIR, ARTIFACTS_DIR } = harness;

      const git = (...args: string[]) =>
        spawnSync("git", args, { cwd: REPO_DIR, encoding: "utf8", shell: false });
      expect(git("init").status).toBe(0);
      git("config", "user.email", "t@t");
      git("config", "user.name", "t");
      git("commit", "--allow-empty", "-m", "base");

      await new StateStore(ARTIFACTS_DIR).saveState(buildState());
      await harness.acknowledgeResume();
      await harness.writeIntentCheckpoint();
      // provider = the conversation HOST; openai_compatible = the live NIM spill pool.
      // Both confirmed → the host-subagent branch activates the A-8 hybrid split.
      await writeFile(
        join(REPO_DIR, "session-config.json"),
        JSON.stringify({
          provider: "claude-code",
          openai_compatible: {
            base_url: "https://integrate.api.nvidia.com/v1",
            model: "openai/gpt-oss-120b",
            api_key_env: KEY_ENV,
          },
          dispatch: { rolling_engine: true },
          timeout_ms: 120_000,
        }),
        "utf8",
      );

      // hostMaxConcurrent caps the host pool's slots, so the coordinator gives the host
      // ~2 nodes and spills the rest to NIM — both pools get work in this one cycle.
      await decideNextStep({
        root: REPO_DIR,
        hostCanDispatchSubagents: true,
        hostMaxConcurrent: 2,
      });

      // The NIM (in-process) partition merges into git THIS cycle (acceptNodeWorktree
      // cherry-picks each node) — so the live-NIM proof is the file on HEAD. State
      // items stay `pending` until the host finishes ITS partition and the run-level
      // mergeImplementResults folds both (deferred by design; no host runs here).
      const inProcessLanded = NODES.filter((n) => git("show", `HEAD:${n.file}`).status === 0);
      const handedToHost = NODES.filter((n) => git("show", `HEAD:${n.file}`).status !== 0);

      // Observation log (this is the live split).
      // eslint-disable-next-line no-console
      console.log(
        `[hybrid-nim-e2e] LIVE SPLIT — landed in-process via NIM (on HEAD): ` +
          `${inProcessLanded.map((n) => `${n.block}/${n.file}`).join(", ") || "(none)"} ` +
          `| handed to host: ${handedToHost.map((n) => n.block).join(", ") || "(none)"}`,
      );

      // Crit. 3 — the NIM pool did REAL work this cycle: ≥1 node fixed by LIVE NIM
      // landed via worktree → commit → verify → cherry-pick merge (file on HEAD).
      expect(inProcessLanded.length).toBeGreaterThanOrEqual(1);
      // The split routed work to BOTH pools: NOT every node landed in-process — the
      // rest were handed to the host partition (the `dispatch_implement_rolling` step).
      expect(inProcessLanded.length).toBeLessThan(NODES.length);
      expect(handedToHost.length).toBeGreaterThanOrEqual(1);
    },
    300_000,
  );
});
