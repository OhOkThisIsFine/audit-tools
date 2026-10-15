import { test, expect, afterEach, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunLogger, advance } from "audit-tools/shared";
import { StateStore } from "../../src/remediate/state/store.js";
import {
  buildPreIntakeObligations,
  buildMainObligations,
  decideNextStep,
  type RemediateCtx,
  type PreIntakeSnapshot,
} from "../../src/remediate/steps/nextStep.js";

import { createNextStepHarness, makePlanningState } from "./helpers/nextStepHarness.js";

vi.mock("audit-tools/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("audit-tools/shared")>();
  return { ...actual, advance: vi.fn(actual.advance) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.mocked(advance).mockReset();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

/**
 * A real ctx over a real temp dir. The builders close over these paths but never
 * touch the filesystem at BUILD time — only the `derive`/`execute` closures do,
 * and this contract reads ids only. Nothing here is cast, so a shape change in
 * `RemediateCtx` reds this file rather than passing vacuously.
 */
async function buildCtx(): Promise<RemediateCtx> {
  const root = await mkdtemp(join(tmpdir(), "obl-coverage-"));
  roots.push(root);
  const artifactsDir = join(root, ".audit-tools", "remediation");
  return {
    root,
    artifactsDir,
    options: {},
    runLogger: RunLogger.disabled(),
    store: new StateStore(artifactsDir),
    // `RemediateCtx.inputResolution` is the ONE `InputResolution` declared in
    // `src/remediate/steps/types.ts` and imported by both the resolver and the
    // decide loop. It used to be declared twice under this name (a private copy
    // here and a wider exported one in intakeResolver.ts) with no cross-
    // reference; the shape below is written out rather than cast, so a shape
    // change reds this file.
    inputResolution: {
      supplied: false,
      existing: [],
      allExisting: [],
      missing: [],
      checked: [],
    },
    countStep: async () => {},
  };
}

const EMPTY_SNAPSHOT: PreIntakeSnapshot = {
  existingCheckpoint: undefined,
  rejectedCheckpointFields: [],
  resumeAck: undefined,
  entryState: null,
  suppliedInputUnchanged: false,
  guidanceFileSupplied: false,
};

// Written independently of production registration: order itself is the contract.
const PRE_ORDER = ["input_conflict", "confirm_resume", "confirm_intent", "interpret_intent", "complete_redelivery", "complete", "pending_intake"];
const MAIN_ORDER = ["operator_plan_only", "waiting_for_clarification", "waiting_for_triage", "planning_documentable", "deferred_clarification", "implementing", "triage", "planning_zero", "all_terminal", "closing", "unhandled"];

test("builders own exact unique order and construction does not mutate state or disk", async () => {
  const ctx = await buildCtx();
  const state = makePlanningState();
  const before = structuredClone(state);
  const pre = buildPreIntakeObligations(ctx, { ...EMPTY_SNAPSHOT, entryState: state });
  const main = buildMainObligations(ctx);
  expect(pre.map(def => def.id)).toEqual(PRE_ORDER);
  expect(main.map(def => def.id)).toEqual(MAIN_ORDER);
  for (const defs of [pre, main]) expect(new Set(defs.map(def => def.id)).size).toBe(defs.length);
  expect(state).toEqual(before);
  expect(await readdir(ctx.root)).toEqual([]);
});

// Real derives and the real shared advance selector; replace only execution to
// expose the selected ID without running an unrelated phase handler.
async function selected(
  defs: ReturnType<typeof buildMainObligations>,
  state: Parameters<(typeof defs)[number]["derive"]>[0],
  ctx: RemediateCtx,
): Promise<string | null> {
  const obligations = defs.map(def => ({ ...def, execute: async () => ({ kind: "emit" as const, step: def.id }) }));
  return (await advance({ priority: obligations.map(def => def.id), obligations }, state, ctx)).step;
}

test("input conflict wins over simultaneously actionable resume and intent gates", async () => {
  const ctx = await buildCtx();
  const state = makePlanningState();
  const defs = buildPreIntakeObligations(ctx, { ...EMPTY_SNAPSHOT, entryState: state, guidanceFileSupplied: true });
  for (const id of ["input_conflict", "confirm_resume", "confirm_intent"]) {
    expect(defs.find(def => def.id === id)?.derive(state)).toBe("missing");
  }
  expect(await selected(defs, state, ctx)).toBe("input_conflict");
});

test("plan-only wins over implementation and catch-all", async () => {
  const ctx = await buildCtx();
  ctx.options.planOnly = true;
  const state = makePlanningState({ status: "implementing" });
  const defs = buildMainObligations(ctx);
  for (const id of ["operator_plan_only", "implementing", "unhandled"]) expect(defs.find(def => def.id === id)?.derive(state)).toBe("missing");
  expect(await selected(defs, state, ctx)).toBe("operator_plan_only");
});

test("deferred questions wait for the frontier and precede implementation or triage", async () => {
  const ctx = await buildCtx();
  const state = makePlanningState({ status: "implementing" });
  state.items!["B-001"] = { unit_id: "B-001", status: "needs_clarification", clarification_question: { category: "scope_of_fix", description: "Which scope?" } };
  const defs = buildMainObligations(ctx);
  expect(await selected(defs, state, ctx)).toBe("implementing");
  state.items!["B-002"] = { unit_id: "B-002", status: "resolved" };
  expect(await selected(defs, state, ctx)).toBe("deferred_clarification");
  state.status = "triage";
  expect(defs.find(def => def.id === "triage")?.derive(state)).toBe("missing");
  expect(await selected(defs, state, ctx)).toBe("deferred_clarification");
});

test("planning-zero and all-terminal retain mutually exclusive eligibility before catch-all", async () => {
  const ctx = await buildCtx();
  const state = makePlanningState();
  for (const item of Object.values(state.items!)) {
    item.status = "needs_clarification";
    item.clarification_question = { category: "scope_of_fix", description: "Which scope?" };
  }
  const defs = buildMainObligations(ctx);
  expect(defs.find(def => def.id === "all_terminal")?.derive(state)).toBe("satisfied");
  expect(await selected(defs, state, ctx)).toBe("planning_zero");
  for (const item of Object.values(state.items!)) {
    item.status = "resolved";
    delete item.clarification_question;
  }
  expect(defs.find(def => def.id === "planning_zero")?.derive(state)).toBe("satisfied");
  expect(await selected(defs, state, ctx)).toBe("all_terminal");
  expect(await selected(defs, { status: "pending" }, ctx)).toBe("unhandled");
  expect(await selected(defs, null, ctx)).toBeNull();
});

const harness = createNextStepHarness(".test-priority-fold-boundaries");

test("pre-intake emit counts once and never enters the main fold", async () => {
  await harness.resetTestRepo();
  try {
    await harness.saveState(makePlanningState({ step_count: 4 }));
    vi.mocked(advance).mockClear();
    const step = await decideNextStep({ root: harness.REPO_DIR, guidanceFileSupplied: true });
    expect(step.step_kind).toBe("input_conflict");
    expect(advance).toHaveBeenCalledTimes(1);
    expect(vi.mocked(advance).mock.calls[0]![0].priority).toEqual(PRE_ORDER);
    expect((await new StateStore(harness.ARTIFACTS_DIR).loadState())?.step_count).toBe(5);
  } finally { await harness.cleanupTestRepo(); }
});

test("a stopped pre-intake fold does not fall through", async () => {
  await harness.resetTestRepo();
  try {
    await harness.saveState(makePlanningState());
    vi.mocked(advance).mockClear().mockImplementationOnce(async (_engine, state) => ({ state, step: null, executions: 100, stopped: "bound", stoppedBound: 100, lastObligationId: "pending_intake" }));
    const step = await decideNextStep({ root: harness.REPO_DIR });
    expect(step.status).toBe("blocked");
    expect(step.step_kind).toBe("fold_did_not_converge");
    expect(advance).toHaveBeenCalledTimes(1);
  } finally { await harness.cleanupTestRepo(); }
});

test("main fold reloads a newer persisted pre-intake state and countStep remains once", async () => {
  await harness.resetTestRepo();
  try {
    await harness.saveState(makePlanningState({ step_count: 4 }));
    const newer = makePlanningState({ status: "triage", step_count: 5 });
    const stop = new Error("observed main fold");
    vi.mocked(advance).mockClear()
      .mockImplementationOnce(async (_engine, state, context) => {
        // Exercise an actual transition through the real engine: its executor
        // persists a newer value while returning the old in-memory state.
        const actual = await vi.importActual<typeof import("audit-tools/shared")>("audit-tools/shared");
        const ctx = context as RemediateCtx;
        let transitioned = false;
        return actual.advance({
          priority: ["persist_newer"],
          obligations: [{
            id: "persist_newer",
            derive: () => transitioned ? "satisfied" : "missing",
            execute: async () => {
              await ctx.countStep(state as Parameters<RemediateCtx["countStep"]>[0]);
              await ctx.store.saveState(newer);
              transitioned = true;
              return { kind: "transition", state };
            },
          }],
        }, state, context);
      })
      .mockImplementationOnce(async () => { throw stop; });
    await expect(decideNextStep({ root: harness.REPO_DIR })).rejects.toThrow(stop);
    expect(advance).toHaveBeenCalledTimes(2);
    const [engine, state] = vi.mocked(advance).mock.calls[1]!;
    expect(engine.priority).toEqual(MAIN_ORDER);
    expect(engine.obligations.map(def => def.id)).toEqual(MAIN_ORDER);
    expect(state).toMatchObject(newer);
    expect(state).toEqual(await new StateStore(harness.ARTIFACTS_DIR).loadState());
    expect((await new StateStore(harness.ARTIFACTS_DIR).loadState())?.step_count).toBe(5);
  } finally { await harness.cleanupTestRepo(); }
});
