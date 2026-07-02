import { test, expect } from "vitest";

const {
  deriveLiveResultKeys,
  isResultStaleAgainstBaseline,
  recordResultBaseline,
} = await import("../../src/audit/orchestrator/resultBaseline.ts");

const { appendResultsToLedger } = await import(
  "../../src/audit/orchestrator/ledger.ts"
);
const { buildTaskContentSignature } = await import(
  "../../src/shared/contentKey.ts"
);

const coordinate = {
  unit_id: "u1",
  lens: "security",
  pass_id: "p1",
  source: "base",
};

function ledgerResult(over = {}) {
  return {
    task_id: "t1",
    unit_id: "u1",
    pass_id: "p1",
    lens: "security",
    file_coverage: [],
    findings: [],
    ...over,
  };
}

// CE-011 residual-risk fix. The headline guarantee: an already-ingested logical
// result given a BENIGN content edit (idempotencyKey fixed, contentKey C1 → C2)
// keeps idempotent re-ingest a NO-OP **and** fires staleness, because the
// staleness gate compares a freshly-computed live contentKey against a baseline
// persisted OUTSIDE the immutable ledger record.
test("benign edit: idempotent re-ingest is a no-op AND staleness fires", () => {
  const sigC1 = buildTaskContentSignature({ goal: "audit auth", body: "v1" });
  const sigC2 = buildTaskContentSignature({ goal: "audit auth", body: "v2" });
  expect(sigC1, "benign edit moves the live task_content_signature").not.toBe(sigC2);

  // --- First ingest: establish the ledger record + the baseline (C1). ---
  const ledger1 = appendResultsToLedger([], [ledgerResult()]);
  expect(ledger1.length).toBe(1);

  const keysC1 = deriveLiveResultKeys({
    ...coordinate,
    task_content_signature: sigC1,
  });
  // No baseline yet → not stale (first ingest establishes it, never compares).
  expect(isResultStaleAgainstBaseline(undefined, keysC1), "first ingest is not stale").toBe(false);
  let baselines = recordResultBaseline(undefined, keysC1);
  expect(baselines[keysC1.idempotency_key]).toBe(keysC1.content_key);

  // --- Benign edit: live signature C1 → C2, then re-ingest the same result. ---
  const keysC2 = deriveLiveResultKeys({
    ...coordinate,
    task_content_signature: sigC2,
  });

  // idempotencyKey is signature-STABLE → the baseline store key is unchanged.
  expect(keysC2.idempotency_key, "idempotencyKey fixed across a benign edit").toBe(keysC1.idempotency_key);
  // contentKey is signature-SENSITIVE → it bumped (C1 → C2).
  expect(keysC2.content_key, "contentKey bumped on the benign edit").not.toBe(keysC1.content_key);

  // (1) Idempotent re-ingest is a NO-OP — no duplicate ledger record appended.
  const ledger2 = appendResultsToLedger(ledger1, [ledgerResult()]);
  expect(ledger2.length, "re-ingest did not append a duplicate").toBe(1);
  expect(ledger2[0].instance_id, "existing ledger record untouched (append-only)").toBe(ledger1[0].instance_id);

  // (2) Staleness FIRES — live C2 != baseline C1, compared OUTSIDE the ledger.
  expect(isResultStaleAgainstBaseline(baselines, keysC2), "staleness fires on the benign edit").toBe(true);

  // Refreshing the baseline to C2 clears staleness (advance recorded the move).
  baselines = recordResultBaseline(baselines, keysC2);
  expect(isResultStaleAgainstBaseline(baselines, keysC2), "baseline refresh clears staleness").toBe(false);
});

test("staleness reads a freshly-computed live contentKey, never one off the ledger record", () => {
  // The live contentKey is derived from the live signature passed in — the
  // ledger record carries no contentKey field to read from. Same logical result,
  // two different live signatures → two different live contentKeys.
  const a = deriveLiveResultKeys({
    ...coordinate,
    task_content_signature: buildTaskContentSignature({ x: 1 }),
  });
  const b = deriveLiveResultKeys({
    ...coordinate,
    task_content_signature: buildTaskContentSignature({ x: 2 }),
  });
  expect(a.idempotency_key).toBe(b.idempotency_key);
  expect(a.content_key).not.toBe(b.content_key);
});

test("no recorded baseline → not stale (never-compared, not a false positive)", () => {
  const keys = deriveLiveResultKeys({
    ...coordinate,
    task_content_signature: buildTaskContentSignature({ x: 1 }),
  });
  expect(isResultStaleAgainstBaseline({}, keys)).toBe(false);
  expect(isResultStaleAgainstBaseline(undefined, keys)).toBe(false);
});

test("recordResultBaseline is pure (no input mutation) and idempotent", () => {
  const keys = deriveLiveResultKeys({
    ...coordinate,
    task_content_signature: buildTaskContentSignature({ x: 1 }),
  });
  const before = {};
  const after = recordResultBaseline(before, keys);
  expect(before, "input not mutated").toEqual({});
  expect(after[keys.idempotency_key]).toBe(keys.content_key);
  // Recording the same content_key again yields an equal store.
  expect(recordResultBaseline(after, keys)).toEqual(after);
});

test("redispatch attempt feeds a distinct idempotencyKey baseline slot", () => {
  const sig = buildTaskContentSignature({ x: 1 });
  const a1 = deriveLiveResultKeys({
    unit_id: "u1",
    lens: "security",
    pass_id: "p1",
    source: "redispatch",
    attempt: 1,
    task_content_signature: sig,
  });
  const a2 = deriveLiveResultKeys({
    unit_id: "u1",
    lens: "security",
    pass_id: "p1",
    source: "redispatch",
    attempt: 2,
    task_content_signature: sig,
  });
  expect(a1.idempotency_key).not.toBe(a2.idempotency_key);
  const baselines = recordResultBaseline(
    recordResultBaseline(undefined, a1),
    a2,
  );
  expect(Object.keys(baselines).length).toBe(2);
});
