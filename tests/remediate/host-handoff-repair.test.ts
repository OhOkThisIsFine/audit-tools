// Packet 13 — handoff repair is bounded and actionable (open-bugs "Host-handoff
// residuals" item (a), and item (h) at tests/remediate/host-handoff.test.ts).
//
// A malformed block ON the implement dispatch frontier used to rethrow out of
// the fold (and through the CLI to an exit code) as a bare stack: a run sat on a
// plan no step could read, and every retry reproduced the crash. The dispatcher
// now emits a bounded `blocked` step naming the malformed block and its repair —
// a producer defect routed to the plan, never a hand-edit of the tool's own
// binding.
//
// The ONE sanctioned repair is re-derivation: the workload is by construction
// rebuilt from the authoritative state, so a moved digest (a clarification
// answer, a widened scope) re-mints the binding — never accepts a stale result
// to make progress, and never throws a raw "no longer matches".
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
import type {
  RemediationBlock,
  RemediationItemState,
} from "../../src/remediate/state/types.js";
import { createNextStepHarness } from "./helpers/nextStepHarness.js";

function block(
  id: string,
  items: string[],
  touched_files: string[],
): RemediationBlock {
  return {
    block_id: id,
    items,
    parallel_safe: true,
    dependencies: [],
    touched_files,
    targeted_commands: ['node -e "process.exit(0)"'],
    phase_ordinal: 0,
    token_estimate: 100,
  };
}

function item(
  findingId: string,
  blockId: string,
  status: RemediationItemState["status"] = "pending",
): RemediationItemState {
  return { finding_id: findingId, status, block_id: blockId };
}

function stateWith(
  blocks: RemediationBlock[],
  items: Record<string, RemediationItemState>,
): RemediationState {
  return {
    status: "implementing",
    plan: {
      plan_id: "PLAN-REPAIR",
      findings: blocks.flatMap((b) =>
        b.items.map((id) => ({
          id,
          title: id,
          category: "correctness",
          severity: "medium" as const,
          confidence: "high" as const,
          lens: "correctness",
          summary: id,
          affected_files: [{ path: `src/${id}.ts` }],
          evidence: [`src/${id}.ts:1`],
        })),
      ),
      blocks,
      project_type: "typescript",
      candidate_closing_actions: ["none"],
    },
    items,
    closing_plan: { action: "none" },
  } as RemediationState;
}

describe("a malformed frontier block emits a bounded repair step, not a crash", () => {
  const harness = createNextStepHarness(".test-host-handoff-repair");
  const { REPO_DIR } = harness;

  beforeEach(async () => {
    await harness.resetTestRepo();
  });
  afterEach(async () => {
    await harness.cleanupTestRepo();
  });

  async function seedImplementingState(
    touchedFiles: string[],
  ): Promise<void> {
    await harness.saveState(
      stateWith([block("B1", ["F1"], touchedFiles)], {
        F1: item("F1", "B1", "pending"),
      }),
    );
    await harness.acknowledgeResume();
    await harness.writeIntentCheckpoint();
  }

  it("emits a blocked step naming the malformed block instead of throwing", async () => {
    await seedImplementingState([resolve("/etc/passwd")]);
    const step = await decideNextStep({ root: REPO_DIR });
    expect(step.step_kind).toBe("blocked");
    expect(step.prompt_path).toBeTruthy();
  });

  it("names the malformed block in the emitted prompt", async () => {
    await seedImplementingState([resolve("/etc/passwd")]);
    const step = await decideNextStep({ root: REPO_DIR });
    expect(step.step_kind).toBe("blocked");
    const prompt = await (await import("node:fs/promises")).readFile(
      step.prompt_path,
      "utf8",
    );
    expect(prompt).toMatch(/Cannot prepare a remediation host workload/u);
    expect(prompt).toMatch(/block 'B1' is outside the normalized write-scope contract/u);
    expect(prompt).toMatch(/next-step/u);
  });

  it("an ordinary frontier still dispatches — the repair arm never fires on a clean plan", async () => {
    await seedImplementingState(["src/F1.ts"]);
    // A normalized, resolvable touched_file: the block is well-formed, so the
    // implement dispatch emits its own step kind, never the blocked repair.
    const step = await decideNextStep({ root: REPO_DIR });
    expect(step.step_kind).not.toBe("blocked");
  });
});
