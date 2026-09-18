// The mid-run clarification round (prompt 16a, owner-reviewed 2026-09-18).
//
// Two owner decisions are pinned here:
//
//   1. ONE SOURCE — the worker question lives on the item it pauses
//      (`clarification_question`). The round is built from every item with
//      status `needs_clarification`. The retired run-level list is refused on
//      write and adopted on read.
//   2. ONE SHAPE — the resolution file is a bare JSON array. Every entry is
//      validated, and ANY bad entry refuses the WHOLE file, naming the entry
//      index and the field.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StateStore } from "../../src/remediate/state/store.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
import type { RemediationItemState } from "../../src/remediate/state/types.js";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import { ambiguityReviewPrompt, clarificationPrompt } from "../../src/remediate/steps/prompts.js";
import { createNextStepHarness } from "./helpers/nextStepHarness.js";

const IDS = ["F1", "F2"] as const;

function paused(id: string): RemediationItemState {
  return {
    finding_id: id,
    status: "needs_clarification",
    block_id: `B-${id}`,
    clarification_question: {
      category: "scope_of_fix",
      description: `Question about ${id}?`,
    },
  };
}

function twoPausedState(): RemediationState {
  return {
    status: "waiting_for_clarification",
    plan: {
      plan_id: "PLAN-CR",
      findings: IDS.map((id) => ({
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
      blocks: IDS.map((id) => ({
        block_id: `B-${id}`,
        items: [id],
        parallel_safe: true,
        dependencies: [],
        touched_files: [`src/${id}.ts`],
      })),
      project_type: "unknown",
      candidate_closing_actions: ["none"],
    },
    items: { F1: paused("F1"), F2: paused("F2") },
    closing_plan: { action: "none" },
  };
}

describe("the clarification round reads its questions from the paused items", () => {
  const harness = createNextStepHarness(".test-clarification-round-contract");
  const { REPO_DIR, ARTIFACTS_DIR } = harness;
  const resolutionPath = join(ARTIFACTS_DIR, "clarification_resolution.json");

  beforeEach(async () => {
    await harness.resetTestRepo();
  });
  afterEach(async () => {
    await harness.cleanupTestRepo();
  });

  async function start(state: RemediationState = twoPausedState()): Promise<void> {
    await new StateStore(ARTIFACTS_DIR).saveState(state);
    await harness.acknowledgeResume();
    await harness.writeIntentCheckpoint();
  }

  async function submit(resolution: unknown) {
    await writeFile(resolutionPath, JSON.stringify(resolution), "utf8");
    const step = await decideNextStep({ root: REPO_DIR });
    const state = JSON.parse(await readFile(join(ARTIFACTS_DIR, "state.json"), "utf8"));
    const prompt = await readFile(step.prompt_path, "utf8");
    return { step, state, prompt };
  }

  it("a partial answer keeps the unanswered item's question", async () => {
    // The measured wedge: the old round cleared the whole run-level list on ANY
    // applied answer, so F2 kept waiting on a question nobody could see.
    await start();
    const { state } = await submit([
      { finding_id: "F1", action: "clarified", rationale: "Only the module boundary." },
    ]);
    expect(state.items.F1.status).toBe("pending");
    expect(state.items.F1.clarification_question).toBeUndefined();
    expect(state.items.F2.status).toBe("needs_clarification");
    expect(state.items.F2.clarification_question).toEqual({
      category: "scope_of_fix",
      description: "Question about F2?",
    });
  });

  it("asks the remaining question once the other paused item is done", async () => {
    const state = twoPausedState();
    state.status = "implementing";
    state.items!.F1 = { finding_id: "F1", status: "resolved", block_id: "B-F1" };
    await start(state);
    const step = await decideNextStep({ root: REPO_DIR });
    const prompt = await readFile(step.prompt_path, "utf8");
    expect(step.step_kind).toBe("collect_clarifications");
    expect(prompt).toContain("Question about F2?");
    expect(prompt).not.toContain("Question about F1?");
    expect(prompt).toContain('"finding_id": "F2"');
  });

  it("an unknown action refuses the WHOLE file, naming the entry and the field", async () => {
    await start();
    const { step, state, prompt } = await submit([
      { finding_id: "F1", action: "approve", rationale: "the user said go" },
      { finding_id: "F2", action: "clarified", rationale: "ok" },
    ]);
    // Nothing applied — not even the valid second entry.
    expect(state.items.F1.status).toBe("needs_clarification");
    expect(state.items.F2.status).toBe("needs_clarification");
    expect(existsSync(resolutionPath)).toBe(false);
    expect(step.step_kind).toBe("collect_clarifications");
    expect(prompt).toContain("REFUSED");
    expect(prompt).toContain("entry [0] `action`");
  });

  it("refuses a clarified entry with no rationale, and scope_additions on a defer", async () => {
    await start();
    const { state, prompt } = await submit([
      { finding_id: "F1", action: "clarified", rationale: "   " },
      { finding_id: "F2", action: "defer", scope_additions: ["src/F2.test.ts"] },
    ]);
    expect(state.items.F1.status).toBe("needs_clarification");
    expect(state.items.F2.status).toBe("needs_clarification");
    expect(prompt).toContain("entry [0] `rationale`");
    expect(prompt).toContain("entry [1] `scope_additions`");
  });

  it("refuses the old object wrapper and a duplicate finding_id", async () => {
    await start();
    const wrapped = await submit({
      resolutions: [{ finding_id: "F1", action: "clarified", rationale: "x" }],
    });
    expect(wrapped.state.items.F1.status).toBe("needs_clarification");
    expect(wrapped.prompt).toContain("must be a JSON array");

    const duplicate = await submit([
      { finding_id: "F1", action: "clarified", rationale: "x" },
      { finding_id: "F1", action: "defer" },
    ]);
    expect(duplicate.state.items.F1.status).toBe("needs_clarification");
    expect(duplicate.prompt).toContain("already answered by entry [0]");
  });

  it("refuses an id that is not waiting for a clarification", async () => {
    const state = twoPausedState();
    state.items!.F2 = { finding_id: "F2", status: "pending", block_id: "B-F2" };
    await start(state);
    const { state: after, prompt } = await submit([
      { finding_id: "F1", action: "clarified", rationale: "x" },
      { finding_id: "F2", action: "reject_finding", rationale: "not real" },
    ]);
    expect(after.items.F1.status).toBe("needs_clarification");
    expect(after.items.F2.status).toBe("pending");
    expect(prompt).toContain("not waiting for a clarification: `F2`");
  });

  it("a wait with no paused item resumes implementing instead of asking nothing", async () => {
    const state = twoPausedState();
    state.items!.F1 = { finding_id: "F1", status: "pending", block_id: "B-F1" };
    state.items!.F2 = { finding_id: "F2", status: "pending", block_id: "B-F2" };
    await start(state);
    const step = await decideNextStep({ root: REPO_DIR });
    expect(step.step_kind).not.toBe("collect_clarifications");
    const after = JSON.parse(await readFile(join(ARTIFACTS_DIR, "state.json"), "utf8"));
    expect(after.status).not.toBe("waiting_for_clarification");
  });
});

describe("the state store owns the question's one home", () => {
  const harness = createNextStepHarness(".test-clarification-store-rule");
  const { ARTIFACTS_DIR } = harness;

  beforeEach(async () => {
    await harness.resetTestRepo();
  });
  afterEach(async () => {
    await harness.cleanupTestRepo();
  });

  it("refuses to write a paused item without its question", async () => {
    const state = twoPausedState();
    delete state.items!.F1!.clarification_question;
    await expect(new StateStore(ARTIFACTS_DIR).saveState(state)).rejects.toThrow(
      /items\["F1"\] is needs_clarification but carries no valid clarification_question/,
    );
  });

  it("refuses to write the retired run-level list", async () => {
    const state = { ...twoPausedState(), clarifications: [] } as RemediationState;
    await expect(new StateStore(ARTIFACTS_DIR).saveState(state)).rejects.toThrow(
      /clarifications is retired/,
    );
  });

  it("adopts a legacy state file's questions onto the paused items on read", async () => {
    const legacy = twoPausedState() as unknown as Record<string, unknown>;
    const items = legacy.items as Record<string, Record<string, unknown>>;
    delete items.F1!.clarification_question;
    delete items.F2!.clarification_question;
    // F2 has no legacy entry — the wedged shape the old partial answer left —
    // but the old ingest also wrote the question into its failure_reason.
    items.F2!.failure_reason = "Should F2 keep its alias?";
    legacy.clarifications = [
      {
        finding_id: "F1",
        category: "compatibility_policy",
        description: "Keep the legacy export?",
        options: ["keep", "drop"],
      },
    ];
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    await writeFile(join(ARTIFACTS_DIR, "state.json"), JSON.stringify(legacy), "utf8");

    const loaded = await new StateStore(ARTIFACTS_DIR).loadState();
    expect(loaded).not.toHaveProperty("clarifications");
    expect(loaded!.items!.F1!.clarification_question).toEqual({
      category: "compatibility_policy",
      description: "Keep the legacy export?",
      options: ["keep", "drop"],
    });
    expect(loaded!.items!.F2!.clarification_question).toEqual({
      category: "scope_of_fix",
      description: "Should F2 keep its alias?",
    });
  });
});

describe("the 16a prompt text", () => {
  // Line breaks in the rendered prose are layout, not content.
  const prompt = clarificationPrompt(
    [
      { finding_id: "F-007", category: "scope_of_fix", description: "How far?" },
      { finding_id: "F-009", category: "public_contract", description: "Keep it?" },
    ],
    "/run/clarification_resolution.json",
  ).replace(/[ \t]*\n(?![|\n])/g, " ");

  it("uses the first real id in its example and leaves scope_additions out of it", () => {
    expect(prompt).toContain('"finding_id": "F-007"');
    expect(prompt).not.toMatch(/"scope_additions":/);
    expect(prompt).not.toContain('"finding_id": "..."');
  });

  it("states the three actions, the scope rule, and the closed id set", () => {
    expect(prompt).toContain("| `clarified` |");
    expect(prompt).toContain("| `reject_finding` |");
    expect(prompt).toContain("| `defer` |");
    expect(prompt).toContain("its directory must already contain a file that git tracks");
    expect(prompt).toContain("`F-007`, `F-009`");
    expect(prompt).toContain("A finding with no entry stays paused");
  });
});

// Prompt 17a (owner, 2026-09-18): the up-front ambiguity gate teaches the SAME
// entry rules as 16a — its old example used "..." ids and taught
// `scope_additions` on every entry — and shows the one shared refusal banner.
describe("the 17a prompt text", () => {
  const render = (
    candidates: Parameters<typeof ambiguityReviewPrompt>[0],
    refusal?: string,
  ): string =>
    ambiguityReviewPrompt(
      candidates,
      "/run/ambiguity_resolution.json",
      ["F-003", "F-004"],
      refusal,
    ).replace(/[ \t]*\n(?![|\n])/g, " ");

  it("uses the first candidate's id, or the first real id when there is no candidate", () => {
    const withCandidate = render([
      { finding_id: "F-004", category: "scope_of_fix", description: "How far?" },
    ]);
    expect(withCandidate).toContain('"finding_id": "F-004"');
    expect(withCandidate).not.toMatch(/"scope_additions":/);
    expect(withCandidate).toContain("The tool found 1 candidate ambiguity");
    const none = render([]);
    expect(none).toContain('"finding_id": "F-003"');
    expect(none).toContain("The tool found no candidate ambiguity");
  });

  it("states the actions, the empty-array rule, the closed set, and the default", () => {
    const prompt = render([]);
    expect(prompt).toContain("| `reject_finding` |");
    expect(prompt).toContain("If no real ambiguity remains, write `[]`");
    expect(prompt).toContain("`F-003`, `F-004`");
    expect(prompt).toContain("A finding with no entry continues as planned.");
  });

  it("shows the shared refusal banner only after a refusal", () => {
    expect(render([])).not.toContain("REFUSED");
    expect(render([], "entry 0: `action` is not one of the three.")).toContain(
      "> ⚠ **Your previous resolution was REFUSED and archived — nothing was applied.**",
    );
  });
});
