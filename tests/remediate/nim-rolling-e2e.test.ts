// A8 provider-path validation — REAL end-to-end run through the production
// next-step routing (`decideNextStep`) over a live OpenAI-compatible provider
// (NVIDIA NIM). This is the gate the `rolling_engine` default-ON flip was waiting
// on, validated through the REAL path (not by calling the engine directly):
//
//  - decideNextStep, with rolling_engine ON and an EXPLICIT backend provider
//    configured, routes the implement phase to the in-process provider engine
//    (driveRollingImplementDispatch) — taking precedence over the host-subagent
//    driver even when the host CAN dispatch.
//  - The configured provider (NIM) is the per-node worker: ≥2 disjoint nodes land
//    via worktree→commit→verify→merge.
//  - A verify-FAIL node routes to triage (status "blocked"), NOT a silent
//    false-resolve (OBL-DS-06 / the f18138fe gate on the provider path).
//
// SKIPPED unless RUN_NIM_E2E=1 (and NVIDIA_API_KEY is set): it hits the live NIM
// endpoint, so it must never run in the normal suite / CI. Run it with:
//   RUN_NIM_E2E=1 npx vitest run tests/remediate/nim-rolling-e2e.test.ts
// from the repo root (NVIDIA_API_KEY must be in the environment).

import { afterAll, describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import { StateStore } from "../../src/remediate/state/store.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
import { createNextStepHarness } from "./helpers/nextStepHarness.js";

const RUN = process.env.RUN_NIM_E2E === "1" && Boolean(process.env.NVIDIA_API_KEY);

// Three disjoint nodes. The two "pass" nodes verify by RUNNING the file NIM writes
// (proves a real edit landed and is valid JS); the "fail" node has a
// deterministically-failing verify so the verify-fail→triage routing is proven
// regardless of model output. verifyNodeInWorktree splits commands on spaces, so
// every command token is space-free.
const NODES = [
  { id: "F-001", block: "B-001", file: "alpha.mjs", content: "export const alpha = 1;", verify: ["node alpha.mjs"] },
  { id: "F-002", block: "B-002", file: "beta.mjs", content: "export const beta = 2;", verify: ["node beta.mjs"] },
  { id: "F-003", block: "B-003", file: "gamma.mjs", content: "export const gamma = 3;", verify: ["node -e process.exit(1)"] },
];

function buildState(): RemediationState {
  return {
    status: "implementing",
    plan: {
      plan_id: "PLAN-NIM",
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
        targeted_commands: n.verify,
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

describe.runIf(RUN)("A8 in-process provider rolling dispatch over live NIM", () => {
  const harness = createNextStepHarness(".test-nim-rolling-e2e");
  afterAll(async () => {
    await harness.cleanupTestRepo();
  });

  it(
    "decideNextStep routes an explicit backend provider through the in-process engine: passing nodes land, a verify-fail routes to triage",
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
      await writeFile(
        join(REPO_DIR, "session-config.json"),
        JSON.stringify({
          provider: "openai-compatible",
          openai_compatible: {
            base_url: "https://integrate.api.nvidia.com/v1",
            model: "openai/gpt-oss-120b",
            api_key_env: "NVIDIA_API_KEY",
          },
          dispatch: { rolling_engine: true },
          timeout_ms: 120_000,
        }),
        "utf8",
      );

      // Defect-1: hostCanDispatchSubagents:false declares this a HEADLESS run (no
      // attended host to fan out subagents), so the explicit backend provider drives
      // the WHOLE implement frontier in-process. With the attended default the backend
      // would instead be DEMOTED to a source pool and the host would review the
      // complement — the opposite of what this headless in-process capstone asserts.
      // One next-step call drives the whole implement frontier through the in-process
      // engine, then advances.
      await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: false });

      // Merged edits are on main; the verify-fail node's file is not.
      expect(git("show", "HEAD:alpha.mjs").status).toBe(0);
      expect(git("show", "HEAD:beta.mjs").status).toBe(0);
      expect(git("show", "HEAD:gamma.mjs").status).not.toBe(0);

      // Terminal dispositions: passing nodes resolved; the verify-fail node is
      // blocked (routed to triage), NOT false-resolved from its self-report.
      const finalState = await new StateStore(ARTIFACTS_DIR).loadState();
      expect(finalState?.items?.["F-001"]?.status).toBe("resolved");
      expect(finalState?.items?.["F-002"]?.status).toBe("resolved");
      expect(finalState?.items?.["F-003"]?.status).toBe("blocked");
    },
    300_000,
  );
});
