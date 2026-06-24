import test from "node:test";
import assert from "node:assert/strict";

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
  assert.notEqual(sigC1, sigC2, "benign edit moves the live task_content_signature");

  // --- First ingest: establish the ledger record + the baseline (C1). ---
  const ledger1 = appendResultsToLedger([], [ledgerResult()]);
  assert.equal(ledger1.length, 1);

  const keysC1 = deriveLiveResultKeys({
    ...coordinate,
    task_content_signature: sigC1,
  });
  // No baseline yet → not stale (first ingest establishes it, never compares).
  assert.equal(
    isResultStaleAgainstBaseline(undefined, keysC1),
    false,
    "first ingest is not stale",
  );
  let baselines = recordResultBaseline(undefined, keysC1);
  assert.equal(baselines[keysC1.idempotency_key], keysC1.content_key);

  // --- Benign edit: live signature C1 → C2, then re-ingest the same result. ---
  const keysC2 = deriveLiveResultKeys({
    ...coordinate,
    task_content_signature: sigC2,
  });

  // idempotencyKey is signature-STABLE → the baseline store key is unchanged.
  assert.equal(
    keysC2.idempotency_key,
    keysC1.idempotency_key,
    "idempotencyKey fixed across a benign edit",
  );
  // contentKey is signature-SENSITIVE → it bumped (C1 → C2).
  assert.notEqual(
    keysC2.content_key,
    keysC1.content_key,
    "contentKey bumped on the benign edit",
  );

  // (1) Idempotent re-ingest is a NO-OP — no duplicate ledger record appended.
  const ledger2 = appendResultsToLedger(ledger1, [ledgerResult()]);
  assert.equal(ledger2.length, 1, "re-ingest did not append a duplicate");
  assert.equal(
    ledger2[0].instance_id,
    ledger1[0].instance_id,
    "existing ledger record untouched (append-only)",
  );

  // (2) Staleness FIRES — live C2 != baseline C1, compared OUTSIDE the ledger.
  assert.equal(
    isResultStaleAgainstBaseline(baselines, keysC2),
    true,
    "staleness fires on the benign edit",
  );

  // Refreshing the baseline to C2 clears staleness (advance recorded the move).
  baselines = recordResultBaseline(baselines, keysC2);
  assert.equal(
    isResultStaleAgainstBaseline(baselines, keysC2),
    false,
    "baseline refresh clears staleness",
  );
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
  assert.equal(a.idempotency_key, b.idempotency_key);
  assert.notEqual(a.content_key, b.content_key);
});

test("no recorded baseline → not stale (never-compared, not a false positive)", () => {
  const keys = deriveLiveResultKeys({
    ...coordinate,
    task_content_signature: buildTaskContentSignature({ x: 1 }),
  });
  assert.equal(isResultStaleAgainstBaseline({}, keys), false);
  assert.equal(isResultStaleAgainstBaseline(undefined, keys), false);
});

test("recordResultBaseline is pure (no input mutation) and idempotent", () => {
  const keys = deriveLiveResultKeys({
    ...coordinate,
    task_content_signature: buildTaskContentSignature({ x: 1 }),
  });
  const before = {};
  const after = recordResultBaseline(before, keys);
  assert.deepEqual(before, {}, "input not mutated");
  assert.equal(after[keys.idempotency_key], keys.content_key);
  // Recording the same content_key again yields an equal store.
  assert.deepEqual(recordResultBaseline(after, keys), after);
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
  assert.notEqual(a1.idempotency_key, a2.idempotency_key);
  const baselines = recordResultBaseline(
    recordResultBaseline(undefined, a1),
    a2,
  );
  assert.equal(Object.keys(baselines).length, 2);
});
