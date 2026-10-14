import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type { AuditState } from "../../src/audit/types/auditState.js";

const mocks = vi.hoisted(() => ({
  omit: vi.fn(), apply: vi.fn(), dispatch: vi.fn(), derive: vi.fn(),
}));
vi.mock("../../src/audit/orchestrator/obligationPolicy.js", async (original) => ({
  ...await original<typeof import("../../src/audit/orchestrator/obligationPolicy.js")>(),
  intentEquivalenceOmits: mocks.omit,
}));
vi.mock("../../src/audit/cli/auditStep.js", async (original) => ({
  ...await original<typeof import("../../src/audit/cli/auditStep.js")>(),
  runAuditStepUnlocked: mocks.apply,
}));
vi.mock("../../src/audit/orchestrator/advance.js", async (original) => ({
  ...await original<typeof import("../../src/audit/orchestrator/advance.js")>(),
  runSingleAdvanceStep: mocks.dispatch,
}));
vi.mock("../../src/audit/orchestrator/state.js", async (original) => ({
  ...await original<typeof import("../../src/audit/orchestrator/state.js")>(),
  deriveAuditState: mocks.derive,
}));

import { buildAuditObligations } from "../../src/audit/cli/nextStepHelpers.js";
import { createFoldTransaction } from "../../src/audit/cli/foldTransaction.js";
import { auditLaneReviewRequirement } from "../../src/audit/cli/reviewSubmission.js";
import { GATE_LANES, laneSubmissionPath, charterExtractionLane } from "../../src/audit/cli/laneSubmissions.js";
import { PRIORITY } from "../../src/audit/orchestrator/nextStep.js";

type Context = Parameters<ReturnType<typeof buildAuditObligations>[number]["execute"]>[1];
const state: AuditState = { status: "active", obligations: [] };
let dir: string;
let input: ArtifactBundle;
let updated: ArtifactBundle;
let ctx: Context;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.omit.mockReturnValue(false);
  mocks.derive.mockReturnValue(state);
  dir = await mkdtemp(join(tmpdir(), "omittable-outcomes-"));
  input = {};
  updated = { audit_report: "distinguishable carried output" };
  ctx = {
    params: { root: dir, sourceRoot: dir, artifactsDir: dir, selfCliPath: "unused", timeoutMs: 1000, scopeIndexMemo: {} },
    analyzersRef: { value: undefined }, lastSummaryRef: { value: "" },
    foldAdvisoriesRef: { value: { ingestIssues: [], validationWarnings: [] } }, dispatchOrdinalRef: { value: 0 },
    dispatchedSignatures: new Set(), seenStateSignatures: new Set(), obligationTrail: [],
    tx: createFoldTransaction(), currentBundleRef: { value: input }, failureRef: { value: null },
    manifestIndexCache: new WeakMap(),
  };
  mocks.apply.mockResolvedValue({ updated_bundle: updated });
  mocks.dispatch.mockResolvedValue({ updated_bundle: updated, audit_state: state, progress_made: true, progress_summary: "progress" });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function execute(id = "intent_equivalence_current") {
  const registry = buildAuditObligations();
  // Exercise the live PRIORITY-derived definitions, not a second descriptor registry.
  expect(registry.map((entry) => entry.id)).toEqual(PRIORITY);
  const entry = registry.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Missing executable obligation ${id}`);
  return entry.execute(input, ctx);
}
async function submit(text: string, lane: string = GATE_LANES.intent_equivalence) {
  const path = laneSubmissionPath(dir, lane);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
  return path;
}
const valid = JSON.stringify({ verdict: "equivalent", judged_pair: { prior_hash: "prior", new_hash: "next" } });

test("ordinary intent review emits its derived state and original bundle without deterministic dispatch", async () => {
  expect(auditLaneReviewRequirement(GATE_LANES.intent_equivalence)).toBe("ordinary");
  const result = await execute();
  expect(result.kind).toBe("emit");
  if (result.kind !== "emit") throw new Error("expected emit");
  expect(result.state).toBe(input);
  expect(result.step).toEqual({ kind: "intent_equivalence", state, bundle: input });
  expect(mocks.derive).toHaveBeenCalledWith(input, { emitStaleness: false });
  expect(mocks.dispatch).not.toHaveBeenCalled();
  expect(mocks.apply).not.toHaveBeenCalled();
});

test("valid intent is applied before omission, carrying the exact result and transaction staging", async () => {
  mocks.omit.mockReturnValue(true);
  await submit(valid);
  const result = await execute();
  expect(result).toEqual({ kind: "transition", state: updated });
  expect(result.state).toBe(updated);
  expect(mocks.apply).toHaveBeenCalledTimes(1);
  const [options, carried] = mocks.apply.mock.calls[0];
  expect(carried).toBe(input);
  expect(options).toEqual({ root: dir, sourceRoot: dir, artifactsDir: dir, preferredExecutor: "intent_equivalence_executor", intentEquivalenceVerdictPath: ctx.tx.staged[0].stagingPath, scopeIndexMemo: ctx.params.scopeIndexMemo });
  expect(options.scopeIndexMemo).toBe(ctx.params.scopeIndexMemo);
  expect(ctx.tx.staged[0].applied).toBe(true);
  expect(await readFile(ctx.tx.staged[0].stagingPath, "utf8")).toBe(valid);
  expect(mocks.omit).not.toHaveBeenCalled();
  expect(mocks.dispatch).not.toHaveBeenCalled();
});

for (const malformed of ["{broken", JSON.stringify({ verdict: "not-a-verdict" })]) {
  for (const omit of [false, true]) {
    test(`invalid intent ${malformed} quarantines before ${omit ? "omit" : "host re-emission"}`, async () => {
      mocks.omit.mockReturnValue(omit);
      await submit(malformed);
      const result = await execute();
      expect(result.kind).toBe(omit ? "transition" : "emit");
      expect(mocks.apply).not.toHaveBeenCalled();
      expect(mocks.dispatch).toHaveBeenCalledTimes(omit ? 1 : 0);
      const quarantine = await readdir(join(dir, "quarantine"));
      expect(quarantine).toHaveLength(1);
      expect(await readFile(join(dir, "quarantine", quarantine[0]), "utf8")).toBe(malformed);
      expect(ctx.tx.staged.every((entry) => !entry.applied)).toBe(true);
    });
  }
}

for (const progress of [true, false]) {
  test(`omit dispatches once and preserves the executor's ${progress ? "transition" : "emit"} outcome`, async () => {
    mocks.omit.mockReturnValue(true);
    mocks.dispatch.mockResolvedValue({ updated_bundle: updated, audit_state: state, progress_made: progress, progress_summary: "executor result" });
    const result = await execute();
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    expect(mocks.dispatch.mock.calls[0][0]).toBe(input);
    expect(result.state).toBe(updated);
    expect(result.kind).toBe(progress ? "transition" : "emit");
    if (result.kind === "emit") expect(result.step).toEqual({ kind: "blocked", state, bundle: updated, reason: "executor result" });
  });
}

test("apply errors propagate unchanged without marking staged intent applied", async () => {
  await submit(valid);
  const error = new Error("apply failed");
  mocks.apply.mockRejectedValueOnce(error);
  await expect(execute()).rejects.toBe(error);
  expect(ctx.tx.staged).toHaveLength(1);
  expect(ctx.tx.staged[0].applied).toBe(false);
  expect(await readFile(ctx.tx.staged[0].stagingPath, "utf8")).toBe(valid);
  expect(mocks.omit).not.toHaveBeenCalled();
  expect(mocks.dispatch).not.toHaveBeenCalled();
});

test("shallow charter extraction omits without consuming stray lanes or materializing packets", async () => {
  const path = await submit("stray", charterExtractionLane("stated"));
  await execute("charter_extraction_current");
  expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  expect(ctx.tx.staged).toHaveLength(0);
  expect(await readFile(path, "utf8")).toBe("stray");
  expect(await readdir(dir)).not.toContain("lanes");
});

// These cases execute the real registered policy bodies, including the custom
// charter handler. The table supplies inputs, not an alternative gate registry.
for (const id of [
  "intent_equivalence_current", "charter_extraction_current",
  "charter_comparison_current", "charter_fidelity_current",
  "charter_clarification_current", "systemic_challenge_current",
  "synthesis_narrative_current",
]) {
  test(`${id} passes through deterministic emit and carried bundle`, async () => {
    mocks.omit.mockReturnValue(true);
    mocks.dispatch.mockResolvedValue({ updated_bundle: updated, audit_state: state, progress_made: false, progress_summary: "blocked once" });
    const result = await execute(id);
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe("emit");
    expect(result.state).toBe(updated);
    if (result.kind === "emit") {
      expect(result.step).toEqual({ kind: "blocked", state, bundle: updated, reason: "blocked once" });
    }
  });
}

test("critical-flow fallback emits host work without an autonomous omit", async () => {
  const result = await execute("critical_flow_fallback_current");
  expect(result.kind).toBe("emit");
  expect(result.state).toBe(input);
  if (result.kind === "emit") expect(result.step).toEqual({ kind: "critical_flow_fallback", state, bundle: input });
  expect(mocks.dispatch).not.toHaveBeenCalled();
});
