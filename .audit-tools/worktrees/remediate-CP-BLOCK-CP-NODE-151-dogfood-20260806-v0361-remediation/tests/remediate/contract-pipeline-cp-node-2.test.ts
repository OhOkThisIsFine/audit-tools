/**
 * CP-NODE-2 — contract-incremental-reconvergence (B1 invariants 1 & 2).
 *
 * Red-before-green pinning coverage for INV-IR-1..4 and the module's failure
 * modes. The module owns the DECISION of which downstream items re-validate vs.
 * carry forward, and the guarantee that an empty semantic delta dispatches zero
 * workers — single-sourced on the SAME `payloadSemanticHash` the DEPENDENCY_MAP
 * staleness walk uses, with load-bearing statement prose retained (CE-006).
 *
 *  - INV-IR-1: item-scoped, fail-closed re-validation (provenance key =
 *    ObligationEntry.module for obligations, obligation_id for test specs; an
 *    unestablishable / wrong / absent-from-prior key falls into FULL re-validation).
 *  - INV-IR-2: empty-delta copy-forward is deterministic, ZERO dispatch, and a
 *    meaning-changing statement reword is dispatched (never collapsed to a carry).
 *  - INV-IR-3: the scoping/copy-forward decision agrees with detectStaleArtifacts.
 *  - INV-IR-4: a carried item keeps its id/module/change_classification, and a
 *    corrupt classification reads fail-closed as a CHANGE.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveObligationLedger,
  diffFinalizedModules,
  scopeObligationRevalidation,
  scopeTestSpecRevalidation,
} from "../../src/remediate/contractPipeline/derive.js";
import {
  writeContractArtifact,
  readContractArtifact,
  reconvergeContractArtifact,
  detectStaleArtifacts,
  payloadSemanticHash,
  envelopePayload,
  type ContractPipelineArtifactName,
} from "../../src/remediate/contractPipeline/artifactStore.js";
import { readObligationChangeClassification } from "../../src/remediate/contractPipeline/changeClassification.js";
import { CP_FINALIZED_MODULE_CONTRACTS_VERSION } from "../../src/remediate/validation/contractPipeline.js";
import type { ObligationLedger } from "audit-tools/shared";

const GOAL = "GOAL-IR";
const T1 = "2026-01-01T00:00:00.000Z";
const T2 = "2099-12-31T23:59:59.000Z";

let tmpDir: string;
let artifactsDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "cp-node-2-"));
  artifactsDir = join(tmpDir, ".audit-tools", "remediation");
});
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

interface ModSpec {
  name: string;
  invariant: string;
  failure: string;
}

/** A finalized_module_contracts payload with one invariant + one failure per module. */
function makeFinalized(modules: ModSpec[], created_at = T1): Record<string, unknown> {
  return {
    contract_version: CP_FINALIZED_MODULE_CONTRACTS_VERSION,
    goal_id: GOAL,
    module_contracts: modules.map((m) => ({
      name: m.name,
      inputs: [`${m.name}Input`],
      outputs: [`${m.name}Output`],
      invariants: [m.invariant],
      side_effects: [],
      validation_boundary: `validates ${m.name}`,
      failure_modes: [m.failure],
      seam_adjustments: [],
    })),
    created_at,
  };
}

const TWO_MODULES: ModSpec[] = [
  { name: "mod-a", invariant: "modA keeps writeRecord consistent", failure: "modA drops flushBuffer" },
  { name: "mod-b", invariant: "modB keeps loadIndex consistent", failure: "modB drops parseHeader" },
];

/** Obligations belonging to one module, by ObligationEntry.module. */
function forModule(ledger: ObligationLedger, module: string) {
  return ledger.obligations.filter((o) => o.module === module);
}

/** Seed finalized's full transitive ancestor chain so it is not spuriously stale. */
async function seedFinalizedDeps(): Promise<void> {
  for (const name of [
    "goal_spec",
    "context_bundle",
    "module_decomposition",
    "module_contracts",
    "seam_reconciliation_report",
  ] as const) {
    await writeContractArtifact(artifactsDir, name, { goal_id: GOAL, artifact: name });
  }
}

// ── INV-IR-1 — item-scoped, fail-closed re-validation ──────────────────────────

describe("INV-IR-1: item-scoped, fail-closed re-validation", () => {
  it("POSITIVE: mutating one module changes ONLY that module's obligations; scoping revalidates just it", () => {
    const priorFinalized = makeFinalized(TWO_MODULES);
    const mutatedFinalized = makeFinalized([
      TWO_MODULES[0],
      { ...TWO_MODULES[1], invariant: "modB now enforces a DIFFERENT loadIndex rule" },
    ]);

    const priorLedger = deriveObligationLedger(priorFinalized, { created_at: T1 });
    const reDerivedLedger = deriveObligationLedger(mutatedFinalized, { created_at: T1 });

    // Sibling module (mod-a) obligations are byte-identical across the re-derive.
    expect(forModule(reDerivedLedger, "mod-a")).toEqual(forModule(priorLedger, "mod-a"));
    // The mutated module's invariant obligation description changed.
    const priorInvB = forModule(priorLedger, "mod-b").find((o) => o.kind === "invariant");
    const nextInvB = forModule(reDerivedLedger, "mod-b").find((o) => o.kind === "invariant");
    expect(nextInvB!.description).not.toBe(priorInvB!.description);

    // The scoping keyed on ObligationEntry.module re-validates only mod-b.
    const delta = diffFinalizedModules(priorFinalized, mutatedFinalized);
    expect([...delta.changed]).toEqual(["mod-b"]);
    const scope = scopeObligationRevalidation(reDerivedLedger, delta);
    const modBIds = forModule(reDerivedLedger, "mod-b").map((o) => o.id);
    const modAIds = forModule(reDerivedLedger, "mod-a").map((o) => o.id);
    expect(scope.revalidate.sort()).toEqual(modBIds.sort());
    expect(scope.carried_forward.sort()).toEqual(modAIds.sort());
  });

  it("NEGATIVE: an obligation whose `module` is cleared falls into FULL re-validation (never skipped)", () => {
    const finalized = makeFinalized(TWO_MODULES);
    const ledger = deriveObligationLedger(finalized, { created_at: T1 });
    // Clear the provenance key on one obligation (module unestablishable).
    const orphanId = ledger.obligations[1].id;
    ledger.obligations[1] = { ...ledger.obligations[1], module: undefined };

    // No module changed at all — every provenance-keyed item would carry forward…
    const delta = diffFinalizedModules(finalized, finalized);
    expect([...delta.changed]).toEqual([]);
    const scope = scopeObligationRevalidation(ledger, delta);
    // …EXCEPT the provenance-missing orphan, which fails closed into re-validation.
    expect(scope.revalidate).toContain(orphanId);
    expect(scope.carried_forward).not.toContain(orphanId);
  });

  it("NEGATIVE: a `module` absent from the current upstream (re-slug/id reuse) is fail-closed as a change", () => {
    const finalized = makeFinalized(TWO_MODULES);
    const ledger = deriveObligationLedger(finalized, { created_at: T1 });
    const reslugId = ledger.obligations[0].id;
    ledger.obligations[0] = { ...ledger.obligations[0], module: "mod-ghost" };

    const delta = diffFinalizedModules(finalized, finalized); // nothing changed
    const scope = scopeObligationRevalidation(ledger, delta);
    expect(scope.revalidate).toContain(reslugId); // module resolves to a nonexistent upstream
  });

  it("NEGATIVE: a test spec whose obligation_id is absent from the prior plan lands in full re-validation", () => {
    const priorPlan = { test_specs: [{ obligation_id: "OBL-mod-a-inv-1", assertions: ["x"] }] };
    const reDerivedPlan = {
      test_specs: [
        { obligation_id: "OBL-mod-a-inv-1", assertions: ["x"] },
        { obligation_id: "OBL-mod-b-inv-1", assertions: ["y"] }, // new item, absent from prior
        { assertions: ["z"] }, // no obligation_id → provenance unestablishable
      ],
    };
    const scope = scopeTestSpecRevalidation(reDerivedPlan, priorPlan, new Set<string>());
    expect(scope.revalidate).toContain("OBL-mod-b-inv-1"); // new id → revalidate
    expect(scope.revalidate).toContain(""); // unkeyed spec → revalidate (surfaced, never carried)
    expect(scope.carried_forward).toEqual(["OBL-mod-a-inv-1"]); // known + unchanged → carry
  });
});

// ── INV-IR-2 — empty-delta copy-forward, zero dispatch ─────────────────────────

/** Re-emit and dispatch ONLY on a genuine re-emit (a carry-forward is dispatch-free). */
async function reEmitWithDispatch(
  name: ContractPipelineArtifactName,
  reDerived: unknown,
  dispatch: (payload: unknown) => void,
) {
  const result = await reconvergeContractArtifact(artifactsDir, name, reDerived);
  if (result.decision === "reemitted") dispatch(result.envelope.payload);
  return result;
}

describe("INV-IR-2: empty-delta copy-forward is deterministic, zero dispatch", () => {
  it("POSITIVE: a stamp-only re-derive copy-forwards the prior payload verbatim with zero dispatch", async () => {
    const finalized = makeFinalized(TWO_MODULES);
    const priorLedger = deriveObligationLedger(finalized, { created_at: T1 });
    await writeContractArtifact(artifactsDir, "obligation_ledger", priorLedger);

    // A stamp-only edit: same obligations, fresh created_at (the exact re-derive churn).
    const reDerived = deriveObligationLedger(finalized, { created_at: T2 });
    expect(payloadSemanticHash("obligation_ledger", priorLedger)).toBe(
      payloadSemanticHash("obligation_ledger", reDerived),
    );

    const dispatch = vi.fn();
    const result = await reEmitWithDispatch("obligation_ledger", reDerived, dispatch);

    expect(result.decision).toBe("carried_forward");
    expect(dispatch).not.toHaveBeenCalled(); // ZERO worker/LLM round-trips
    // The PRIOR payload (created_at T1) is carried forward verbatim, not the T2 re-derive.
    const stored = envelopePayload(await readContractArtifact(artifactsDir, "obligation_ledger"));
    expect(stored).toEqual(priorLedger);
    expect((stored as { created_at: string }).created_at).toBe(T1);
  });

  it("NEGATIVE: a load-bearing STATEMENT reword changes the hash and IS dispatched (CE-006)", async () => {
    const finalized = makeFinalized(TWO_MODULES);
    const priorLedger = deriveObligationLedger(finalized, { created_at: T1 });
    await writeContractArtifact(artifactsDir, "obligation_ledger", priorLedger);

    // Meaning-changing reword of one obligation statement; structural fields intact.
    const reworded = makeFinalized([
      TWO_MODULES[0],
      { ...TWO_MODULES[1], invariant: "modB must NEVER allow a stale loadIndex read" },
    ]);
    const reDerived = deriveObligationLedger(reworded, { created_at: T1 });
    expect(payloadSemanticHash("obligation_ledger", priorLedger)).not.toBe(
      payloadSemanticHash("obligation_ledger", reDerived),
    );

    const dispatch = vi.fn();
    const result = await reEmitWithDispatch("obligation_ledger", reDerived, dispatch);

    expect(result.decision).toBe("reemitted");
    expect(dispatch).toHaveBeenCalledTimes(1); // meaning changed → re-dispatch, never carried
    const stored = envelopePayload(await readContractArtifact(artifactsDir, "obligation_ledger"));
    expect(stored).toEqual(reDerived);
    expect(stored).not.toEqual(priorLedger);
  });
});

// ── INV-IR-3 — scoping consistency with the staleness DAG ──────────────────────

describe("INV-IR-3: item-scoping/copy-forward agrees with detectStaleArtifacts", () => {
  it("POSITIVE: a stamp-only upstream edit leaves the DAG non-stale AND triggers copy-forward", async () => {
    await seedFinalizedDeps();
    const finalized = makeFinalized(TWO_MODULES, T1);
    await writeContractArtifact(artifactsDir, "finalized_module_contracts", finalized);
    const ledger = deriveObligationLedger(finalized, { created_at: T1 });
    await writeContractArtifact(artifactsDir, "obligation_ledger", ledger);
    expect((await detectStaleArtifacts(artifactsDir)).stale).not.toContain("obligation_ledger");

    // Cosmetic upstream edit: created_at only.
    const cosmetic = makeFinalized(TWO_MODULES, T2);
    await writeContractArtifact(artifactsDir, "finalized_module_contracts", cosmetic);

    // DAG signal: obligation_ledger stays non-stale.
    expect((await detectStaleArtifacts(artifactsDir)).stale).not.toContain("obligation_ledger");
    // Scoping signal: re-deriving from the cosmetic upstream copy-forwards (agree).
    const reDerived = deriveObligationLedger(cosmetic, { created_at: T2 });
    const result = await reconvergeContractArtifact(artifactsDir, "obligation_ledger", reDerived);
    expect(result.decision).toBe("carried_forward");
  });

  it("NEGATIVE: a load-bearing reword flips the DAG STALE AND re-dispatches (both move together)", async () => {
    await seedFinalizedDeps();
    const finalized = makeFinalized(TWO_MODULES, T1);
    await writeContractArtifact(artifactsDir, "finalized_module_contracts", finalized);
    const ledger = deriveObligationLedger(finalized, { created_at: T1 });
    await writeContractArtifact(artifactsDir, "obligation_ledger", ledger);
    expect((await detectStaleArtifacts(artifactsDir)).stale).not.toContain("obligation_ledger");

    // Load-bearing upstream edit: reword an invariant statement.
    const reworded = makeFinalized(
      [TWO_MODULES[0], { ...TWO_MODULES[1], invariant: "modB now forbids a partial loadIndex" }],
      T1,
    );
    await writeContractArtifact(artifactsDir, "finalized_module_contracts", reworded);

    // DAG signal: obligation_ledger IS stale.
    expect((await detectStaleArtifacts(artifactsDir)).stale).toContain("obligation_ledger");
    // Scoping signal: re-deriving re-emits (dispatches), never a stale carry.
    const reDerived = deriveObligationLedger(reworded, { created_at: T1 });
    const result = await reconvergeContractArtifact(artifactsDir, "obligation_ledger", reDerived);
    expect(result.decision).toBe("reemitted");
  });
});

// ── INV-IR-4 — verbatim carry preserves item identity + provenance ─────────────

describe("INV-IR-4: verbatim carry preserves identity; corrupt classification fails closed", () => {
  it("POSITIVE: copy-forward preserves each carried obligation's id/module/change_classification", async () => {
    const finalized = makeFinalized(TWO_MODULES);
    const priorLedger = deriveObligationLedger(finalized, { created_at: T1 });
    await writeContractArtifact(artifactsDir, "obligation_ledger", priorLedger);

    const reDerived = deriveObligationLedger(finalized, { created_at: T2 }); // stamp-only
    const result = await reconvergeContractArtifact(artifactsDir, "obligation_ledger", reDerived);
    expect(result.decision).toBe("carried_forward");

    const stored = envelopePayload(
      await readContractArtifact(artifactsDir, "obligation_ledger"),
    ) as ObligationLedger;
    for (let i = 0; i < priorLedger.obligations.length; i++) {
      const before = priorLedger.obligations[i];
      const after = stored.obligations[i];
      expect(after.id).toBe(before.id);
      expect(after.module).toBe(before.module);
      expect(after.change_classification).toEqual(before.change_classification);
    }
    // A testable obligation carries a real classification verdict, unchanged.
    const testable = stored.obligations.find((o) => o.kind === "invariant");
    expect(testable!.change_classification).toBeDefined();
  });

  it("NEGATIVE: readObligationChangeClassification reads a corrupt classification as a fail-closed CHANGE", () => {
    // Present-but-corrupt change_kind → CHANGE, never undefined / never relaxed.
    expect(
      readObligationChangeClassification({
        change_classification: { change_kind: "bogus", touched_symbols: ["writerecord"] },
      })?.change_kind,
    ).toBe("change");
    // A non-record classification is also fail-closed to CHANGE.
    expect(
      readObligationChangeClassification({ change_classification: "garbage" })?.change_kind,
    ).toBe("change");
    // A genuinely absent classification stays undefined (consumers stay fail-closed).
    expect(readObligationChangeClassification({})).toBeUndefined();
    // A valid addition is NOT coerced to change.
    expect(
      readObligationChangeClassification({
        change_classification: { change_kind: "addition", touched_symbols: [], determined_by: "no_existing_symbol" },
      })?.change_kind,
    ).toBe("addition");
  });
});

// ── Failure-mode obligations (fail-1..fail-6) ──────────────────────────────────

describe("CP-NODE-2 failure modes", () => {
  it("fail-1/under-invalidation: an unresolvable provenance key is never dropped from re-validation", () => {
    const finalized = makeFinalized(TWO_MODULES);
    const ledger = deriveObligationLedger(finalized, { created_at: T1 });
    ledger.obligations[2] = { ...ledger.obligations[2], module: undefined };
    const scope = scopeObligationRevalidation(ledger, diffFinalizedModules(finalized, finalized));
    expect(scope.revalidate).toContain(ledger.obligations[2].id);
  });

  it("fail-2: an empty-delta re-derive dispatches ZERO worker/LLM round-trips", async () => {
    const finalized = makeFinalized(TWO_MODULES);
    await writeContractArtifact(
      artifactsDir,
      "obligation_ledger",
      deriveObligationLedger(finalized, { created_at: T1 }),
    );
    const dispatch = vi.fn();
    await reEmitWithDispatch(
      "obligation_ledger",
      deriveObligationLedger(finalized, { created_at: T2 }),
      dispatch,
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("fail-3/churn: re-deriving an unchanged upstream yields an identical semantic hash (no order churn)", () => {
    const finalized = makeFinalized(TWO_MODULES);
    const a = deriveObligationLedger(finalized, { created_at: T1 });
    const b = deriveObligationLedger(finalized, { created_at: T2 }); // different stamp only
    expect(payloadSemanticHash("obligation_ledger", a)).toBe(
      payloadSemanticHash("obligation_ledger", b),
    );
    // Obligation order is stable module/first-appearance order across re-derives.
    expect(a.obligations.map((o) => o.id)).toEqual(b.obligations.map((o) => o.id));
  });

  it("fail-4/identity drift: a carried obligation retains id/module/change_classification", async () => {
    const finalized = makeFinalized(TWO_MODULES);
    const prior = deriveObligationLedger(finalized, { created_at: T1 });
    await writeContractArtifact(artifactsDir, "obligation_ledger", prior);
    await reconvergeContractArtifact(
      artifactsDir,
      "obligation_ledger",
      deriveObligationLedger(finalized, { created_at: T2 }),
    );
    const stored = envelopePayload(
      await readContractArtifact(artifactsDir, "obligation_ledger"),
    ) as ObligationLedger;
    expect(stored.obligations).toEqual(prior.obligations);
  });

  it("fail-5/agreement: every carried item is one the DAG judges non-stale", async () => {
    await seedFinalizedDeps();
    const finalized = makeFinalized(TWO_MODULES, T1);
    await writeContractArtifact(artifactsDir, "finalized_module_contracts", finalized);
    const ledger = deriveObligationLedger(finalized, { created_at: T1 });
    await writeContractArtifact(artifactsDir, "obligation_ledger", ledger);

    // Cosmetic upstream edit → every obligation carries forward AND the DAG is non-stale.
    const cosmetic = makeFinalized(TWO_MODULES, T2);
    await writeContractArtifact(artifactsDir, "finalized_module_contracts", cosmetic);
    const delta = diffFinalizedModules(finalized, cosmetic);
    const scope = scopeObligationRevalidation(ledger, delta);
    expect(scope.revalidate).toEqual([]); // nothing to re-validate
    expect(scope.carried_forward.length).toBe(ledger.obligations.length);
    expect((await detectStaleArtifacts(artifactsDir)).stale).not.toContain("obligation_ledger");
  });

  it("fail-6/prose-collision: a load-bearing statement reword is NOT carried (payload changes + re-dispatch)", async () => {
    const finalized = makeFinalized(TWO_MODULES);
    const prior = deriveObligationLedger(finalized, { created_at: T1 });
    await writeContractArtifact(artifactsDir, "obligation_ledger", prior);

    const reworded = deriveObligationLedger(
      makeFinalized([TWO_MODULES[0], { ...TWO_MODULES[1], invariant: "modB must reject a stale parseHeader" }]),
      { created_at: T1 },
    );
    const result = await reconvergeContractArtifact(artifactsDir, "obligation_ledger", reworded);
    expect(result.decision).toBe("reemitted");
    const stored = envelopePayload(await readContractArtifact(artifactsDir, "obligation_ledger"));
    expect(stored).not.toEqual(prior); // stale payload never carried forward
    expect(stored).toEqual(reworded);
  });
});
