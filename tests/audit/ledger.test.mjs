import test from "node:test";
import assert from "node:assert/strict";

const { appendResultsToLedger, stampLedgerKeys, groupLedgerByIdentity } =
  await import("../../src/audit/orchestrator/ledger.ts");

function baseResult(over = {}) {
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

test("stampLedgerKeys — mints instance_id + seam keys, idempotent on replay", () => {
  const r = baseResult();
  const a = stampLedgerKeys(r);
  assert.ok(a.instance_id, "instance_id minted");
  assert.ok(a.identity_key, "identity_key derived");
  assert.ok(a.idempotency_key, "idempotency_key derived");

  // Re-stamping an already-stamped record keeps its logical keys (so a replay
  // hashes identically) — only instance_id is per-record.
  const b = stampLedgerKeys(a);
  assert.equal(b.identity_key, a.identity_key);
  assert.equal(b.idempotency_key, a.idempotency_key);
  assert.equal(b.instance_id, a.instance_id);
});

test("appendResultsToLedger — append-only, distinct records get distinct instance_ids", () => {
  const ledger = appendResultsToLedger([], [baseResult(), baseResult({ unit_id: "u2" })]);
  assert.equal(ledger.length, 2);
  assert.notEqual(ledger[0].instance_id, ledger[1].instance_id);
});

test("appendResultsToLedger — replay of the same logical result is a no-op (idempotent)", () => {
  const first = appendResultsToLedger([], [baseResult()]);
  assert.equal(first.length, 1);
  // Same coordinate + same emit source → same idempotency_key → no-op.
  const replayed = appendResultsToLedger(first, [baseResult()]);
  assert.equal(replayed.length, 1, "replay did not append a duplicate");
  // Existing record untouched (append-only).
  assert.equal(replayed[0].instance_id, first[0].instance_id);
});

test("appendResultsToLedger — base vs deepening share a coordinate but both persist", () => {
  // Same {unit_id, lens, pass_id} coordinate; different emit source (task_id
  // prefix) → distinct idempotency_keys → BOTH persist, never merged.
  const ledger = appendResultsToLedger(
    [],
    [baseResult({ task_id: "t1" }), baseResult({ task_id: "deepening:x:abc" })],
  );
  assert.equal(ledger.length, 2);
  assert.equal(ledger[0].identity_key, ledger[1].identity_key, "same identity coordinate");
  assert.notEqual(
    ledger[0].idempotency_key,
    ledger[1].idempotency_key,
    "distinct logical identity",
  );
});

test("appendResultsToLedger — dedupes replays within a single batch", () => {
  const ledger = appendResultsToLedger([], [baseResult(), baseResult()]);
  assert.equal(ledger.length, 1);
});

test("groupLedgerByIdentity — one-to-many grouping by identity_key; retains every record", () => {
  const ledger = appendResultsToLedger(
    [],
    [
      baseResult({ task_id: "t1" }),
      baseResult({ task_id: "deepening:x:abc" }),
      baseResult({ task_id: "t2", unit_id: "u2" }),
    ],
  );
  const groups = groupLedgerByIdentity(ledger);
  // u1 coordinate has two records (base + deepening); u2 has one.
  const sizes = [...groups.values()].map((g) => g.length).sort();
  assert.deepEqual(sizes, [1, 2]);
  // RETAIN-UNASSIGNED: no record dropped — total across groups equals ledger size.
  const total = [...groups.values()].reduce((n, g) => n + g.length, 0);
  assert.equal(total, ledger.length);
});
