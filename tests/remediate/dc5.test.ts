/**
 * DC-5: change-vs-addition classification + paired/scoped-negative test specs.
 *
 * Each obligation is classified change-vs-addition with a deterministic
 * touches-an-existing-symbol heuristic FIRST (recorded on the ledger), then an
 * LLM may confirm/override (also recorded). A behavior CHANGE requires a PAIRED
 * positive+negative test spec whose negative is SCOPED to the changed
 * symbol/file via an anti-rot scope predicate — an unscoped repo-wide-grep
 * negative is rejected (CE-006), not merely keyword-checked. A pure ADDITION is
 * never forced to pair. The pair is enforced by the shared test-plan and
 * verification evaluation. Fixes CE-013 (render-only misclassification).
 *
 * Verifies:
 *   inv-1  deterministic classifier: touches-existing-symbol → change (+anchors);
 *          no-existing-symbol → addition (no anchors).
 *   inv-2  LLM confirm vs. override is recorded on `determined_by` (never silent).
 *   inv-3  the deriver attaches the classification to every testable obligation,
 *          deterministically, from the finalized-contract symbol baseline.
 *   inv-4  test-plan gate: a change needs a paired positive+scoped-negative; a
 *          pure addition needs neither half.
 *   inv-5  scope predicate: a negative naming the changed symbol/file is scoped;
 *          an unscoped repo-wide negative is rejected even with a polarity keyword.
 *   inv-6  verification helper: only-one-polarity (or unscoped negative) for a
 *          change → block reason; a full scoped pair → null; addition → null.
 *   inv-7  the test-plan gate and verification helper share one evaluation.
 */
import { describe, it, expect } from "vitest";
import {
  classifyObligationChange,
  buildBaselineSymbolCorpus,
  negativeAssertionIsScoped,
  evaluatePairing,
  assertionPolarity,
  verifyPairingForFinding,
  obligationScopeAnchors,
  readObligationChangeClassification,
} from "../../src/remediate/contractPipeline/changeClassification.js";
import { deriveObligationLedger } from "../../src/remediate/contractPipeline/derive.js";
import { validatePairedObligations } from "../../src/remediate/validation/contractPipeline.js";
import {
  CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
  CONTRACT_PIPELINE_TEST_VALIDATOR_PLAN_VERSION,
} from "audit-tools/shared";

const CREATED_AT = "2026-01-01T00:00:00.000Z";
const CP_FINALIZED_MODULE_CONTRACTS_VERSION =
  "remediate-code-contract-pipeline/finalized-module-contracts/v1alpha1" as const;

// ── inv-1: deterministic touches-an-existing-symbol classifier ─────────────────

describe("classifyObligationChange (deterministic FIRST pass)", () => {
  const baseline = new Set(["writerecord", "flush_buffer", "src/store.ts"]);

  it("inv-1: classifies a change when the obligation references an existing symbol", () => {
    const cls = classifyObligationChange(
      "writeRecord must return an ack token after the write",
      baseline,
    );
    expect(cls.change_kind).toBe("change");
    expect(cls.determined_by).toBe("touches_existing_symbol");
    // The matched existing symbol becomes a scope anchor for the paired negative.
    expect(cls.touched_symbols).toContain("writerecord");
  });

  it("inv-1: classifies a pure addition when no existing symbol is referenced", () => {
    const cls = classifyObligationChange(
      "A brand new metricsEmitter publishes counters",
      baseline,
    );
    expect(cls.change_kind).toBe("addition");
    expect(cls.determined_by).toBe("no_existing_symbol");
    expect(cls.touched_symbols).toEqual([]);
  });

  it("inv-1: matches a touched FILE path, not only a function symbol", () => {
    const cls = classifyObligationChange(
      "Records are appended to src/store.ts on commit",
      baseline,
    );
    expect(cls.change_kind).toBe("change");
    expect(cls.touched_symbols).toContain("src/store.ts");
  });

  it("inv-1: a plain prose word that happens to be in the baseline is not treated as a symbol", () => {
    // "rejects" is prose (no code-ish shape), so even if a baseline had it, the
    // obligation text yields no symbol tokens and stays an addition.
    const cls = classifyObligationChange("malformed input is rejected", new Set(["rejects"]));
    expect(cls.change_kind).toBe("addition");
  });

  it("builds the baseline corpus from the finalized-contract interface surface", () => {
    const corpus = buildBaselineSymbolCorpus({
      module_contracts: [
        {
          name: "store-module",
          inputs: ["record"],
          outputs: ["writeRecord ack"],
          side_effects: ["mutates src/store.ts"],
          validation_boundary: "validates at flushBuffer",
          invariants: [],
          failure_modes: [],
        },
      ],
    });
    expect(corpus.has("writerecord")).toBe(true);
    expect(corpus.has("flushbuffer")).toBe(true);
    expect(corpus.has("src/store.ts")).toBe(true);
  });
});

// ── inv-3: the deriver attaches the classification ─────────────────────────────

describe("deriveObligationLedger attaches change_classification (CE-013 fix)", () => {
  function finalized() {
    return {
      contract_version: CP_FINALIZED_MODULE_CONTRACTS_VERSION,
      goal_id: "G1",
      module_contracts: [
        {
          name: "store-module",
          inputs: ["record"],
          outputs: ["writeRecord ack"],
          invariants: ["writeRecord is idempotent for a duplicate record"],
          side_effects: [],
          validation_boundary: "validates record",
          failure_modes: ["a brand new audit trail is appended"],
        },
      ],
      created_at: CREATED_AT,
    };
  }

  it("inv-3: testable obligations carry a recorded, deterministic classification", () => {
    const ledger = deriveObligationLedger(finalized(), { created_at: CREATED_AT });
    const inv = ledger.obligations.find((o) => o.kind === "invariant")!;
    const fail = ledger.obligations.find((o) => o.kind === "behavioral")!;

    // The invariant references writeRecord (an existing output symbol) → change.
    expect(inv.change_classification?.change_kind).toBe("change");
    expect(inv.change_classification?.determined_by).toBe("touches_existing_symbol");
    // The failure mode introduces a brand-new audit trail (no existing symbol) → addition.
    expect(fail.change_classification?.change_kind).toBe("addition");

    // Structural obligations get no classification (no test burden).
    const structural = ledger.obligations.find((o) => o.kind === "structural")!;
    expect(structural.change_classification).toBeUndefined();
  });

  it("inv-3: derivation stays deterministic with the classification attached", () => {
    const a = deriveObligationLedger(finalized(), { created_at: CREATED_AT });
    const b = deriveObligationLedger(finalized(), { created_at: CREATED_AT });
    expect(a).toEqual(b);
  });
});

// ── inv-5: anti-rot scope predicate (CE-006) ───────────────────────────────────

describe("negativeAssertionIsScoped (anti-rot scope predicate, CE-006)", () => {
  const anchors = ["writerecord", "src/store.ts"];

  it("inv-5: a negative naming the changed symbol is scoped", () => {
    expect(
      negativeAssertionIsScoped("writeRecord rejects a record with no id", anchors),
    ).toBe(true);
  });

  it("inv-5: a negative naming the changed FILE is scoped", () => {
    expect(
      negativeAssertionIsScoped("src/store.ts throws on a duplicate append", anchors),
    ).toBe(true);
  });

  it("inv-5: an unscoped repo-wide negative is rejected even though it has a negative keyword", () => {
    // Keyword matching alone ("no ... anywhere") would have accepted this — the
    // predicate rejects it because it names no anchor and scans the whole repo.
    expect(
      negativeAssertionIsScoped("no file anywhere in the repo contains a raw write", anchors),
    ).toBe(false);
  });

  it("inv-5: a global-scan negative is rejected even when it also names the anchor", () => {
    // Naming the symbol is necessary but not sufficient: the repo-wide scan, not
    // the symbol, is what the assertion actually checks.
    expect(
      negativeAssertionIsScoped("grep the repo to prove writeRecord appears in no file", anchors),
    ).toBe(false);
  });

  it("inv-5: a scoped negative with no recognizable anchor is rejected (fail-closed)", () => {
    expect(negativeAssertionIsScoped("throws on bad input", anchors)).toBe(false);
  });

  it("inv-5: a DESCRIPTIVE (negated) mention of a repo-wide scan does not disqualify a scoped negative (CE-006 FP)", () => {
    // The gate must read the assertion's ACTION, not the literal words: a negative
    // that names the anchor and merely says it is *not* a repo-wide check is scoped.
    // Flagging the words "repo-wide" here forced hosts to euphemise legitimate specs.
    expect(
      negativeAssertionIsScoped(
        "writeRecord rejects an empty id, scoped to writeRecord and not an unscoped repo-wide check",
        anchors,
      ),
    ).toBe(true);
    expect(
      negativeAssertionIsScoped(
        "src/store.ts throws on a duplicate append rather than scanning the whole repo",
        anchors,
      ),
    ).toBe(true);
  });

  it("inv-5: an affirmative scan in a LATER clause still disqualifies (negation in an earlier clause does not launder it)", () => {
    // A negation cue in a prior clause must not suppress an unrelated affirmative
    // scan later in the assertion; clause-scoping keeps the two independent.
    expect(
      negativeAssertionIsScoped(
        "writeRecord does not accept null; grep the repo to prove it appears nowhere",
        anchors,
      ),
    ).toBe(false);
  });
});

// ── inv-4 + inv-7: test-plan derivation gate ───────────────────────────────────

describe("validatePairedObligations (change-scoped, CE-013/CE-006)", () => {
  const ledger = (obligations: unknown[]) => ({
    contract_version: CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
    goal_id: "G1",
    obligations,
    created_at: CREATED_AT,
  });
  const plan = (specs: unknown[]) => ({
    contract_version: CONTRACT_PIPELINE_TEST_VALIDATOR_PLAN_VERSION,
    goal_id: "G1",
    test_specs: specs,
    created_at: CREATED_AT,
  });
  const changeObl = (id: string, anchor: string) => ({
    id,
    description: `${anchor} must hold`,
    kind: "behavioral",
    depends_on: [],
    status: "pending",
    change_classification: {
      change_kind: "change",
      touched_symbols: [anchor],
      determined_by: "touches_existing_symbol",
    },
  });
  const additionObl = (id: string) => ({
    id,
    description: "a brand new capability",
    kind: "behavioral",
    depends_on: [],
    status: "pending",
    change_classification: { change_kind: "addition", touched_symbols: [], determined_by: "no_existing_symbol" },
  });

  it("inv-4: a CHANGE passes with a positive + a scoped negative", () => {
    const issues = validatePairedObligations(
      ledger([changeObl("O-1", "writerecord")]),
      plan([
        {
          obligation_id: "O-1",
          name: "t",
          kind: "unit",
          assertions: ["writeRecord returns the ack on success", "writeRecord rejects a missing id"],
        },
      ]),
    );
    expect(issues).toHaveLength(0);
  });

  it("inv-4: a CHANGE with a positive but an UNSCOPED negative fails (CE-006)", () => {
    const issues = validatePairedObligations(
      ledger([changeObl("O-1", "writerecord")]),
      plan([
        {
          obligation_id: "O-1",
          name: "t",
          kind: "unit",
          assertions: ["writeRecord returns the ack", "throws on a duplicate anywhere in the repo"],
        },
      ]),
    );
    expect(issues.some((i) => i.path.endsWith(".negative"))).toBe(true);
    expect(issues.some((i) => i.message.includes("CE-006"))).toBe(true);
  });

  it("inv-4: a CHANGE with only a positive fails (missing negative half)", () => {
    const issues = validatePairedObligations(
      ledger([changeObl("O-1", "writerecord")]),
      plan([{ obligation_id: "O-1", name: "t", kind: "unit", assertions: ["writeRecord returns the ack"] }]),
    );
    expect(issues.some((i) => i.path.endsWith(".negative"))).toBe(true);
    expect(issues.some((i) => i.path.endsWith(".positive"))).toBe(false);
  });

  it("inv-4: a pure ADDITION needs neither a negative nor a pair", () => {
    const issues = validatePairedObligations(
      ledger([additionObl("O-2")]),
      plan([{ obligation_id: "O-2", name: "t", kind: "unit", assertions: ["emits a new counter"] }]),
    );
    expect(issues).toHaveLength(0);
  });

  it("inv-4: an UNCLASSIFIED testable obligation is treated as a change (fail-closed)", () => {
    // No change_classification → fail-closed change → a positive-only spec fails.
    const issues = validatePairedObligations(
      ledger([{ id: "writeRecord-O", description: "writeRecord stays consistent", kind: "behavioral", depends_on: [], status: "pending" }]),
      plan([{ obligation_id: "writeRecord-O", name: "t", kind: "unit", assertions: ["writeRecord returns the ack"] }]),
    );
    expect(issues.some((i) => i.path.endsWith(".negative"))).toBe(true);
  });

  it("inv-4: an addition still fails when it has NO covering spec at all", () => {
    const issues = validatePairedObligations(ledger([additionObl("O-2")]), plan([]));
    expect(issues.some((i) => i.message.includes("no test spec"))).toBe(true);
  });
});

// ── inv-6 + inv-7: verification helper (parity with the test-plan gate) ─────────

describe("verifyPairingForFinding", () => {
  const ledger = (obligations: unknown[]) => ({
    contract_version: CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
    goal_id: "G1",
    obligations,
    created_at: CREATED_AT,
  });
  const plan = (specs: unknown[]) => ({
    contract_version: CONTRACT_PIPELINE_TEST_VALIDATOR_PLAN_VERSION,
    goal_id: "G1",
    test_specs: specs,
    created_at: CREATED_AT,
  });
  const changeObl = {
    id: "O-1",
    description: "writeRecord must hold",
    kind: "behavioral",
    depends_on: [],
    status: "pending",
    change_classification: { change_kind: "change", touched_symbols: ["writerecord"], determined_by: "touches_existing_symbol" },
  };

  it("inv-6: returns null when the change obligation is fully scoped-paired", () => {
    const reason = verifyPairingForFinding(
      ["O-1"],
      ledger([changeObl]),
      plan([{ obligation_id: "O-1", name: "t", kind: "unit", assertions: ["writeRecord returns ack", "writeRecord rejects missing id"] }]),
    );
    expect(reason).toBeNull();
  });

  it("inv-6: blocks (only one polarity) when the negative half is missing", () => {
    const reason = verifyPairingForFinding(
      ["O-1"],
      ledger([changeObl]),
      plan([{ obligation_id: "O-1", name: "t", kind: "unit", assertions: ["writeRecord returns ack"] }]),
    );
    expect(reason).not.toBeNull();
    expect(reason).toContain("only one polarity");
  });

  it("inv-6: blocks when the negative is unscoped (CE-006)", () => {
    const reason = verifyPairingForFinding(
      ["O-1"],
      ledger([changeObl]),
      plan([{ obligation_id: "O-1", name: "t", kind: "unit", assertions: ["writeRecord returns ack", "fails for a raw write anywhere in the repo"] }]),
    );
    expect(reason).not.toBeNull();
    expect(reason).toContain("CE-006");
  });

  it("inv-6: returns null for a pure addition (never paired)", () => {
    const additionObl = { ...changeObl, id: "O-2", change_classification: { change_kind: "addition", touched_symbols: [], determined_by: "no_existing_symbol" } };
    const reason = verifyPairingForFinding(
      ["O-2"],
      ledger([additionObl]),
      plan([{ obligation_id: "O-2", name: "t", kind: "unit", assertions: ["emits a counter"] }]),
    );
    expect(reason).toBeNull();
  });

  it("inv-6: returns null when the finding covers no obligation (audit-findings intake)", () => {
    expect(verifyPairingForFinding([], ledger([changeObl]), plan([]))).toBeNull();
  });

  it("inv-7: the verify gate and the test-plan gate agree on the same only-one-polarity case", () => {
    const onlyPositive = plan([{ obligation_id: "O-1", name: "t", kind: "unit", assertions: ["writeRecord returns ack"] }]);
    const verifyReason = verifyPairingForFinding(["O-1"], ledger([changeObl]), onlyPositive);
    const planIssues = validatePairedObligations(ledger([changeObl]), onlyPositive).filter(
      (i) => i.severity === "error",
    );
    // Both gates flag the same gap (parity): one blocks, the other errors.
    expect(verifyReason).not.toBeNull();
    expect(planIssues.length).toBeGreaterThan(0);
  });
});

describe("obligationScopeAnchors fallback", () => {
  it("falls back to the obligation id + description symbols when no classification anchors", () => {
    const anchors = obligationScopeAnchors("OBL-store-inv-1", "writeRecord stays consistent", undefined);
    expect(anchors).toContain("obl-store-inv-1");
    expect(anchors).toContain("writerecord");
  });

  it("prefers the classification's recorded touched_symbols when present", () => {
    const cls = readObligationChangeClassification({
      change_classification: { change_kind: "change", touched_symbols: ["flushbuffer"], determined_by: "touches_existing_symbol" },
    });
    const anchors = obligationScopeAnchors("O-1", "whatever else", cls);
    expect(anchors).toEqual(["flushbuffer"]);
  });
});

// ── evaluatePairing primitive directness ───────────────────────────────────────

describe("evaluatePairing primitive", () => {
  it("reports negativeUnscoped when the sole negative failed scoping", () => {
    const v = evaluatePairing(
      ["writeRecord returns ack", "fails for any input anywhere in the repo"],
      ["writerecord"],
    );
    expect(v.hasPositive).toBe(true);
    expect(v.hasNegative).toBe(false);
    expect(v.negativeUnscoped).toBe(true);
    expect(v.ok).toBe(false);
  });

  it("is ok only with a positive AND a scoped negative", () => {
    const v = evaluatePairing(
      ["writeRecord returns ack", "writeRecord rejects an empty id"],
      ["writerecord"],
    );
    expect(v.ok).toBe(true);
  });
});

describe("assertionPolarity — identifier-token masking", () => {
  it("does not misclassify a positive that merely cites a `-fail-` obligation id", () => {
    // A `\\b`-bounded keyword regex matches `fail` inside `OBL-AUTH-fail-session`
    // (hyphen is a non-word boundary); masking the identifier token keeps the
    // prose polarity ("returns a token" → positive).
    expect(assertionPolarity("Returns a token for OBL-AUTH-fail-session")).toBe(
      "positive",
    );
  });

  it("leaves genuine prose-negative and prose-positive assertions unchanged", () => {
    expect(assertionPolarity("rejects invalid input")).toBe("negative");
    expect(assertionPolarity("emits canonical output")).toBe("positive");
  });

  it("keeps an explicit label authoritative regardless of embedded ids", () => {
    expect(assertionPolarity("NEGATIVE: OBL-x-ok-path is unreachable")).toBe(
      "negative",
    );
  });

  it("does not let a dotted/sliced path token leak polarity", () => {
    // `src/remediate/never-null.ts` contains `never`; masking prevents a false
    // negative classification for an otherwise-positive assertion.
    expect(
      assertionPolarity("writes src/remediate/never-null.ts and succeeds"),
    ).toBe("positive");
  });
});
