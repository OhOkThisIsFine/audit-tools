import { canonicalPlanFixture, canonicalUnitFixture, writeApprovedPlanFixture } from "./helpers/canonicalPlanFixture.js";
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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, rm, readdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { StateStore } from "../../src/remediate/state/store.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
import type { RemediationItemState } from "../../src/remediate/state/types.js";
import { runTriagePhase } from "../../src/remediate/phases/triage.js";
import { conformanceReviewPaths } from "../../src/remediate/steps/dispatch/contractConformanceReview.js";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import { ambiguityReviewPrompt, clarificationPrompt } from "../../src/remediate/steps/prompts.js";
import { createNextStepHarness } from "./helpers/nextStepHarness.js";

const IDS = ["F1", "F2"] as const;

function paused(id: string): RemediationItemState {
  return {
    unit_id: id,
    status: "needs_clarification",
    clarification_question: {
      category: "scope_of_fix",
      description: `Question about ${id}?`,
    },
  };
}

function twoPausedState(): RemediationState {
  return {
    status: "waiting_for_clarification",
    plan: canonicalPlanFixture({
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
      units: IDS.map(id => canonicalUnitFixture(id, { source_finding_ids: [id], allowed_files: [`src/${id}.ts`] })),
      requirements: IDS.map(id => ({ id: `REQ-${id}`, description: `Resolve ${id}`, source_finding_ids: [id], change_kind: "structural", assertions: [], inapplicable_reason: "Fixture exercises clarification lifecycle" })),
      project_type: "unknown",
      candidate_closing_actions: ["none"],
    }),
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
    await harness.writeIntentCheckpoint();
    await writeApprovedPlanFixture(ARTIFACTS_DIR, state);
    await new StateStore(ARTIFACTS_DIR).saveState(state);
    await harness.acknowledgeResume();
  }

  async function submit(resolution: unknown) {
    await writeFile(resolutionPath, JSON.stringify(resolution), "utf8");
    const step = await decideNextStep({ root: REPO_DIR });
    const state = JSON.parse(await readFile(join(ARTIFACTS_DIR, "state.json"), "utf8"));
    const prompt = await readFile(step.prompt_path, "utf8");
    return { step, state, prompt };
  }

  it.each(["immediate", "resumed"] as const)("a %s durable owner halt does not reexecute a stale prior triage success", async (mode) => {
    const state = twoPausedState();
    state.status = "triage";
    state.conformance_review = { run_id: state.plan!.plan_id, enabled: true };
    for (const id of IDS) state.items![id] = { unit_id: id, status: "blocked", rework_count: 2, failure_reason: "still open" };
    await mkdir(join(REPO_DIR, "src"));
    for (const name of ["a", ...IDS]) await writeFile(join(REPO_DIR, "src", `${name}.ts`), "export const value = 1;\n");
    await writeFile(join(REPO_DIR, ".gitignore"), ".audit-tools/\n");
    const script = join(ARTIFACTS_DIR, "triage-halt.cjs");
    const counter = join(ARTIFACTS_DIR, "triage-halt-count");
    const scriptBody = "const fs=require('node:fs');const p='.audit-tools/remediation/triage-halt-count';const n=fs.existsSync(p)?Number(fs.readFileSync(p)):0;fs.writeFileSync(p,String(n+1));";
    await writeFile(script, scriptBody + "process.exit(0);");
    state.plan!.units[0]!.required_tests = ["node .audit-tools/remediation/triage-halt.cjs"];
    await start(state);
    await runTriagePhase(state, { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });
    const reviewPaths = conformanceReviewPaths(ARTIFACTS_DIR, state.plan!.plan_id, "F1");
    const request = JSON.parse(await readFile(reviewPaths.request, "utf8"));
    await writeFile(reviewPaths.response, JSON.stringify({ ...request.response_template,
      declaration: { mode: "independent", reason: "Explicit independent test reviewer" },
      summary: "The stable source and passing required test satisfy F1", obligations: [{ obligation_id: "REQ-F1", verdict: "satisfied", evidence: ["src/F1.ts exports the reviewed value; the exact required test passed"] }],
    }));
    const accepted = await runTriagePhase(state, { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });
    expect(accepted.items!.F1.status).toBe("resolved_no_change");
    await new StateStore(ARTIFACTS_DIR).saveState(accepted);
    // The already-reviewed command changes before the halt; the exact subject
    // is stale, so reporting it as success would also be dishonest.
    await writeFile(script, scriptBody + "process.exit(1);");
    if (mode === "immediate") {
      await writeFile(join(ARTIFACTS_DIR, "triage_resolution.json"), JSON.stringify({ plan_id: state.plan!.plan_id, items: [{ unit_id: "F2", action: "halt" }] }));
    } else {
      accepted.status = "closing";
      accepted.closing_context = "user_halted";
      accepted.items!.F2.status = "abandoned";
      accepted.items!.F2.completed_at = new Date().toISOString();
      await new StateStore(ARTIFACTS_DIR).saveState(accepted);
    }
    await decideNextStep({ root: REPO_DIR, finalGateRunner: harness.finalGateRunner });
    const after = await new StateStore(ARTIFACTS_DIR).loadState();
    expect(after!.closing_context).toBe("user_halted");
    expect(await readFile(counter, "utf8")).toBe("1");
    expect(after!.status).not.toBe("triage");
    expect(after!.status).not.toBe("waiting_for_triage");
    expect(after!.items!.F1.status).toBe("abandoned");
    expect(after!.items!.F1.conformance_review).toEqual(accepted.items!.F1.conformance_review);
    expect(after!.items!.F1.completed_at).toBeTruthy();
    expect(JSON.parse(await readFile(reviewPaths.request, "utf8"))).toEqual(request);
    expect(after!.status).toBe("complete");
    const outcomes = JSON.parse(await readFile(join(dirname(ARTIFACTS_DIR), "remediation-outcomes.json"), "utf8"));
    expect(outcomes.execution_outcomes.find((item: { unit_id: string }) => item.unit_id === "F1")).toMatchObject({
      status: "abandoned", conformance_review: accepted.items!.F1.conformance_review,
    });
    const report = await readFile(join(dirname(ARTIFACTS_DIR), "remediation-report.md"), "utf8");
    expect(report).toContain("abandoned");
    expect(report).toContain("owner halted");
  });

  it("keeps a partial answer discoverable when its applied state cannot commit", async () => {
    await start();
    await writeFile(resolutionPath, JSON.stringify([
      { unit_id: "F1", action: "clarified", rationale: "Only the module boundary." },
    ]));
    const save = StateStore.prototype.saveState;
    const fault = vi.spyOn(StateStore.prototype, "saveState").mockImplementation(async function (this: StateStore, state) {
      if (state.items?.F1?.clarification_context) throw new Error("injected answered-state failure");
      return save.call(this, state);
    });
    try {
      await expect(decideNextStep({ root: REPO_DIR })).rejects.toThrow("injected answered-state failure");
    } finally { fault.mockRestore(); }
    expect(existsSync(resolutionPath)).toBe(true);
    await decideNextStep({ root: REPO_DIR });
    const recovered = await new StateStore(ARTIFACTS_DIR).loadState();
    expect(recovered?.items?.F1?.clarification_context).toBe("Only the module boundary.");
    expect(recovered?.items?.F2?.status).toBe("needs_clarification");
  });

  it.each(["retry", "ignore", "halt"] as const)("opted-in triage %s survives an answered-state commit failure", async (action) => {
    const state = twoPausedState();
    state.status = "waiting_for_triage";
    state.conformance_review = { run_id: state.plan!.plan_id, enabled: true };
    state.items!.F2 = { unit_id: "F2", status: "blocked", rework_count: 2, failure_reason: "second failure" };
    state.items!.F1 = { unit_id: "F1", status: "blocked", rework_count: 2, failure_reason: "still open" };
    await start(state);
    const input = join(ARTIFACTS_DIR, "triage_resolution.json");
    await writeFile(input, JSON.stringify({ plan_id: state.plan!.plan_id, items: [{ unit_id: "F1", action }] }));
    const save = StateStore.prototype.saveState;
    const fault = vi.spyOn(StateStore.prototype, "saveState").mockImplementation(async function (this: StateStore, next) {
      if (next.items?.F1?.status !== "blocked") throw new Error("injected triage commit failure");
      return save.call(this, next);
    });
    try { await expect(decideNextStep({ root: REPO_DIR })).rejects.toThrow("injected triage commit failure"); }
    finally { fault.mockRestore(); }
    expect(existsSync(input)).toBe(true);
    const unchanged = await new StateStore(ARTIFACTS_DIR).loadState();
    expect(unchanged?.items?.F1?.rework_count).toBe(2);
    await decideNextStep({ root: REPO_DIR });
    const recovered = await new StateStore(ARTIFACTS_DIR).loadState();
    if (action === "retry") expect(recovered?.items?.F1?.rework_count).toBe(3);
    else if (action === "ignore") expect(recovered?.items?.F1?.status).toBe("ignored");
    else expect(recovered?.closing_context).toBe("user_halted");
  });

  it("committed retry recovers projection and cleanup exactly once before resuming", async () => {
    const state = twoPausedState();
    state.status = "waiting_for_triage";
    state.conformance_review = { run_id: state.plan!.plan_id, enabled: true };
    state.items!.F2 = { unit_id: "F2", status: "blocked", rework_count: 2, failure_reason: "second failure" };
    state.items!.F1 = { unit_id: "F1", status: "blocked", rework_count: 2, failure_reason: "still open" };
    await start(state);
    const input = join(ARTIFACTS_DIR, "triage_resolution.json");
    await writeFile(input, JSON.stringify({ plan_id: state.plan!.plan_id, items: [{ unit_id: "F1", action: "retry" }] }));
    const obstruction = join(ARTIFACTS_DIR, "triage-outcome.json");
    await mkdir(obstruction);
    await expect(decideNextStep({ root: REPO_DIR })).rejects.toThrow("pending cleanup");
    const committed = await new StateStore(ARTIFACTS_DIR).loadState();
    expect(committed?.items?.F1?.rework_count).toBe(3);
    expect(committed?.decision_applications?.[0]?.cleanup_complete).toBeUndefined();
    expect(existsSync(input)).toBe(true);
    await rm(obstruction, { recursive: true });
    await decideNextStep({ root: REPO_DIR });
    await decideNextStep({ root: REPO_DIR });
    const recovered = await new StateStore(ARTIFACTS_DIR).loadState();
    expect(recovered?.items?.F1?.rework_count).toBe(3);
    expect(recovered?.decision_applications?.[0]?.cleanup_complete).toBe(true);
    expect(existsSync(input)).toBe(false);
    expect(JSON.parse(await readFile(obstruction, "utf8")).items).toEqual([{ unit_id: "F1", action: "retried" }]);
  });

  it("a durable owner halt reconciles failed cleanup without reexecuting a stale prior success", async () => {
    const state = twoPausedState();
    state.status = "triage";
    state.conformance_review = { run_id: state.plan!.plan_id, enabled: true };
    for (const id of IDS) state.items![id] = { unit_id: id, status: "blocked", rework_count: 2, failure_reason: "still open" };
    await mkdir(join(REPO_DIR, "src"));
    for (const name of ["a", ...IDS]) await writeFile(join(REPO_DIR, "src", `${name}.ts`), "export const value = 1;\n");
    await writeFile(join(REPO_DIR, ".gitignore"), ".audit-tools/\n");
    const script = join(ARTIFACTS_DIR, "triage-halt.cjs");
    const counter = join(ARTIFACTS_DIR, "triage-halt-count");
    const scriptBody = "const fs=require('node:fs');const p='.audit-tools/remediation/triage-halt-count';const n=fs.existsSync(p)?Number(fs.readFileSync(p)):0;fs.writeFileSync(p,String(n+1));";
    await writeFile(script, scriptBody + "process.exit(0);");
    state.plan!.units[0]!.required_tests = ["node .audit-tools/remediation/triage-halt.cjs"];
    await start(state);
    await runTriagePhase(state, { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });
    const reviewPaths = conformanceReviewPaths(ARTIFACTS_DIR, state.plan!.plan_id, "F1");
    const request = JSON.parse(await readFile(reviewPaths.request, "utf8"));
    await writeFile(reviewPaths.response, JSON.stringify({ ...request.response_template,
      declaration: { mode: "independent", reason: "Explicit independent test reviewer" },
      summary: "The stable source and passing required test satisfy F1", obligations: [{ obligation_id: "REQ-F1", verdict: "satisfied", evidence: ["src/F1.ts exports the reviewed value; the exact required test passed"] }],
    }));
    const accepted = await runTriagePhase(state, { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });
    expect(accepted.items!.F1.status).toBe("resolved_no_change");
    await new StateStore(ARTIFACTS_DIR).saveState(accepted);
    // The already-reviewed command changes before the halt; the exact subject
    // is stale, so reporting it as success would also be dishonest.
    await writeFile(script, scriptBody + "process.exit(1);");
    await writeFile(join(ARTIFACTS_DIR, "triage_resolution.json"), JSON.stringify({ plan_id: state.plan!.plan_id, items: [{ unit_id: "F2", action: "halt" }] }));
    const input = join(ARTIFACTS_DIR, "triage_resolution.json");
    const obstruction = join(ARTIFACTS_DIR, "triage-outcome.json");
    await mkdir(obstruction);
    await expect(decideNextStep({ root: REPO_DIR, finalGateRunner: harness.finalGateRunner })).rejects.toThrow("pending cleanup");
    const committed = (await new StateStore(ARTIFACTS_DIR).loadState())!;
    expect(committed.closing_context).toBe("user_halted");
    expect(committed.items!.F1.status).toBe("abandoned");
    expect(committed.items!.F1.conformance_review).toEqual(accepted.items!.F1.conformance_review);
    expect(committed.items!.F2.status).toBe("abandoned");
    expect(committed.decision_applications?.[0]?.cleanup_complete).toBeUndefined();
    expect(existsSync(input)).toBe(true);
    await rm(obstruction, { recursive: true });
    await decideNextStep({ root: REPO_DIR, finalGateRunner: harness.finalGateRunner });
    const after = (await new StateStore(ARTIFACTS_DIR).loadState())!;
    expect(after.closing_context).toBe("user_halted");
    expect(await readFile(counter, "utf8")).toBe("1");
    expect(after.status).not.toBe("triage");
    expect(after.status).not.toBe("waiting_for_triage");
    expect(after.items!.F1.status).toBe("abandoned");
    expect(after.items!.F1.conformance_review).toEqual(accepted.items!.F1.conformance_review);
    expect(after.decision_applications?.[0]?.cleanup_complete).toBe(true);
    expect(existsSync(input)).toBe(false);
    expect(JSON.parse(await readFile(obstruction, "utf8")).items).toEqual([{ unit_id: "F2", action: "halted" }]);
  });

  it("a consumed answer restored at the live path cannot answer a later question", async () => {
    await start();
    await submit([{ unit_id: "F1", action: "clarified", rationale: "Only the module boundary." }]);
    const store = new StateStore(ARTIFACTS_DIR);
    const later = (await store.loadState())!;
    later.items!.F1 = paused("F1");
    later.items!.F1.clarification_question!.description = "A later question about F1?";
    later.status = "waiting_for_clarification";
    delete later.host_handoff;
    await store.saveState(later);
    const consumed = (await readdir(ARTIFACTS_DIR)).find(name => name.startsWith("clarification_resolution.json.consumed-"))!;
    await rename(join(ARTIFACTS_DIR, consumed), resolutionPath);
    const step = await decideNextStep({ root: REPO_DIR });
    expect(step.step_kind).toBe("collect_clarifications");
    expect((await new StateStore(ARTIFACTS_DIR).loadState())?.items?.F1?.status).toBe("needs_clarification");
    expect(await readFile(step.prompt_path, "utf8")).toContain("A later question about F1?");
  });

  it("a fresh identical answer can answer a later question for the same unit", async () => {
    await start();
    const answer = [{ unit_id: "F1", action: "clarified", rationale: "Only the module boundary." }];
    await submit(answer);
    const store = new StateStore(ARTIFACTS_DIR);
    const later = (await store.loadState())!;
    later.items!.F1 = paused("F1");
    later.items!.F1.clarification_question!.description = "A later question about F1?";
    later.status = "waiting_for_clarification";
    delete later.host_handoff;
    await store.saveState(later);
    await writeFile(resolutionPath, JSON.stringify(answer));
    const step = await decideNextStep({ root: REPO_DIR });
    expect((await new StateStore(ARTIFACTS_DIR).loadState())?.items?.F1?.status).toBe("pending");
    expect((await new StateStore(ARTIFACTS_DIR).loadState())?.decision_applications).toHaveLength(2);
    expect(step.step_kind).toBe("dispatch_implement");
  });

  it("a partial answer keeps the unanswered item's question", async () => {
    // The measured wedge: the old round cleared the whole run-level list on ANY
    // applied answer, so F2 kept waiting on a question nobody could see.
    await start();
    const { state } = await submit([
      { unit_id: "F1", action: "clarified", rationale: "Only the module boundary." },
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
    state.items!.F1 = { unit_id: "F1", status: "resolved" };
    await start(state);
    const step = await decideNextStep({ root: REPO_DIR });
    const prompt = await readFile(step.prompt_path, "utf8");
    expect(step.step_kind).toBe("collect_clarifications");
    expect(prompt).toContain("Question about F2?");
    expect(prompt).not.toContain("Question about F1?");
    expect(prompt).toContain('"unit_id": "F2"');
  });

  it("an unknown action refuses the WHOLE file, naming the entry and the field", async () => {
    await start();
    const { step, state, prompt } = await submit([
      { unit_id: "F1", action: "approve", rationale: "the user said go" },
      { unit_id: "F2", action: "clarified", rationale: "ok" },
    ]);
    // Nothing applied — not even the valid second entry.
    expect(state.items.F1.status).toBe("needs_clarification");
    expect(state.items.F2.status).toBe("needs_clarification");
    expect(existsSync(resolutionPath)).toBe(false);
    expect(step.step_kind).toBe("collect_clarifications");
    expect(prompt).toContain("REFUSED");
    expect(prompt).toContain("entry [0] `action`");
  });

  it("refuses a clarified entry with no rationale", async () => {
    await start();
    const { state, prompt } = await submit([
      { unit_id: "F1", action: "clarified", rationale: "   " },
      { unit_id: "F2", action: "defer" },
    ]);
    expect(state.items.F1.status).toBe("needs_clarification");
    expect(state.items.F2.status).toBe("needs_clarification");
    expect(prompt).toContain("entry [0] `rationale`");
  });

  it("refuses the removed scope_additions field as an unknown field", async () => {
    await start();
    const { state, prompt } = await submit([
      { unit_id: "F1", action: "defer", scope_additions: ["src/F1.test.ts"] },
    ]);
    expect(state.items.F1.status).toBe("needs_clarification");
    expect(prompt).toContain("REFUSED");
    expect(prompt).toContain("scope_additions");
  });

  it("refuses the old object wrapper and a duplicate unit_id", async () => {
    await start();
    const wrapped = await submit({
      resolutions: [{ unit_id: "F1", action: "clarified", rationale: "x" }],
    });
    expect(wrapped.state.items.F1.status).toBe("needs_clarification");
    expect(wrapped.prompt).toContain("must be a JSON array");

    const duplicate = await submit([
      { unit_id: "F1", action: "clarified", rationale: "x" },
      { unit_id: "F1", action: "defer" },
    ]);
    expect(duplicate.state.items.F1.status).toBe("needs_clarification");
    expect(duplicate.prompt).toContain("already answered by entry [0]");
  });

  it("refuses an id that is not waiting for a clarification", async () => {
    const state = twoPausedState();
    state.items!.F2 = { unit_id: "F2", status: "pending" };
    await start(state);
    const { state: after, prompt } = await submit([
      { unit_id: "F1", action: "clarified", rationale: "x" },
      { unit_id: "F2", action: "reject_finding", rationale: "not real" },
    ]);
    expect(after.items.F1.status).toBe("needs_clarification");
    expect(after.items.F2.status).toBe("pending");
    expect(prompt).toContain("not waiting for a clarification: `F2`");
  });

  it("a wait with no paused item resumes implementing instead of asking nothing", async () => {
    const state = twoPausedState();
    state.items!.F1 = { unit_id: "F1", status: "pending" };
    state.items!.F2 = { unit_id: "F2", status: "pending" };
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

  it("refuses retired question authority without rewriting its evidence", async () => {
    const legacy = { ...twoPausedState(), clarifications: [{ unit_id: "F1", description: "Original question" }] };
    const path = join(ARTIFACTS_DIR, "state.json");
    const bytes = JSON.stringify(legacy);
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    await writeFile(path, bytes);
    await expect(new StateStore(ARTIFACTS_DIR).loadState()).rejects.toThrow(/clarifications is retired/);
    expect(await readFile(path, "utf8")).toBe(bytes);
  });
});

describe("the 16a prompt text", () => {
  // Line breaks in the rendered prose are layout, not content.
  const prompt = clarificationPrompt(
    [
      { unit_id: "F-007", category: "scope_of_fix", description: "How far?" },
      { unit_id: "F-009", category: "public_contract", description: "Keep it?" },
    ],
    "/run/clarification_resolution.json",
  ).replace(/[ \t]*\n(?![|\n])/g, " ");

  it("uses the first real id in its example and never asks for scope_additions", () => {
    expect(prompt).toContain('"unit_id": "F-007"');
    expect(prompt).not.toContain("scope_additions");
    expect(prompt).not.toContain('"unit_id": "..."');
  });

  it("states the three actions, the scope rule, and the closed id set", () => {
    expect(prompt).toContain("| `clarified` |");
    expect(prompt).toContain("| `reject_finding` |");
    expect(prompt).toContain("| `defer` |");
    // The scope rule: an answer never widens a unit's write scope.
    expect(prompt).toContain("An answer cannot widen a unit's write scope");
    expect(prompt).toContain("needs a revised plan and a fresh review");
    expect(prompt).not.toMatch(/adds to the fix's write scope|a test the fix must create|may name a new file/);
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
      { unit_id: "F-004", category: "scope_of_fix", description: "How far?" },
    ]);
    expect(withCandidate).toContain('"unit_id": "F-004"');
    expect(withCandidate).not.toMatch(/"scope_additions":/);
    expect(withCandidate).toContain("The tool found 1 candidate ambiguity");
    const none = render([]);
    expect(none).toContain('"unit_id": "F-003"');
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
