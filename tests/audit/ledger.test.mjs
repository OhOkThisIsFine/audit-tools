import { test, expect } from "vitest";

const { appendResultsToLedger, stampLedgerKeys } =
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
  expect(a.instance_id, "instance_id minted").toBeTruthy();
  expect(a.identity_key, "identity_key derived").toBeTruthy();
  expect(a.idempotency_key, "idempotency_key derived").toBeTruthy();

  // Re-stamping an already-stamped record keeps its logical keys (so a replay
  // hashes identically) — only instance_id is per-record.
  const b = stampLedgerKeys(a);
  expect(b.identity_key).toBe(a.identity_key);
  expect(b.idempotency_key).toBe(a.idempotency_key);
  expect(b.instance_id).toBe(a.instance_id);
});

test("appendResultsToLedger — append-only, distinct records get distinct instance_ids", () => {
  const ledger = appendResultsToLedger([], [baseResult(), baseResult({ unit_id: "u2" })]);
  expect(ledger.length).toBe(2);
  expect(ledger[0].instance_id).not.toBe(ledger[1].instance_id);
});

test("appendResultsToLedger — replay of the same logical result is a no-op (idempotent)", () => {
  const first = appendResultsToLedger([], [baseResult()]);
  expect(first.length).toBe(1);
  // Same coordinate + same emit source → same idempotency_key → no-op.
  const replayed = appendResultsToLedger(first, [baseResult()]);
  expect(replayed.length, "replay did not append a duplicate").toBe(1);
  // Existing record untouched (append-only).
  expect(replayed[0].instance_id).toBe(first[0].instance_id);
});

test("appendResultsToLedger — base vs deepening share a coordinate but both persist", () => {
  // Same {unit_id, lens, pass_id} coordinate; different emit source (task_id
  // prefix) → distinct idempotency_keys → BOTH persist, never merged.
  const ledger = appendResultsToLedger(
    [],
    [baseResult({ task_id: "t1" }), baseResult({ task_id: "deepening:x:abc" })],
  );
  expect(ledger.length).toBe(2);
  expect(ledger[0].identity_key, "same identity coordinate").toBe(ledger[1].identity_key);
  expect(ledger[0].idempotency_key, "distinct logical identity").not.toBe(ledger[1].idempotency_key);
});

test("appendResultsToLedger — dedupes replays within a single batch", () => {
  const ledger = appendResultsToLedger([], [baseResult(), baseResult()]);
  expect(ledger.length).toBe(1);
});

test("appendResultsToLedger — two deepening rounds at the same coordinate under DISTINCT task_ids both persist (confirmed live 2026-06-30 collision)", () => {
  // Selective-deepening re-mints the steward task under a fresh task_id each
  // round (taskIdFor hashes the growing source-result set), but every round
  // shares the same {unit_id, lens, pass_id}. Before folding task_id into the
  // discriminator, both rounds' clean results collapsed to the bare
  // 'deepening' discriminator and round 2 was silently dropped as a replay.
  const round1 = baseResult({ task_id: "deepening:steward:round1hash" });
  const round2 = baseResult({ task_id: "deepening:steward:round2hash" });
  const ledger = appendResultsToLedger([], [round1, round2]);
  expect(ledger.length, "round 2 is not dropped as a replay of round 1").toBe(2);
  expect(ledger[0].identity_key, "same identity coordinate").toBe(ledger[1].identity_key);
  expect(ledger[0].idempotency_key).not.toBe(ledger[1].idempotency_key);
});

test("appendResultsToLedger — a genuine replay of the SAME deepening task_id still no-ops (INV-2 preserved)", () => {
  const first = appendResultsToLedger(
    [],
    [baseResult({ task_id: "deepening:steward:round1hash" })],
  );
  expect(first.length).toBe(1);
  const replayed = appendResultsToLedger(
    first,
    [baseResult({ task_id: "deepening:steward:round1hash" })],
  );
  expect(replayed.length, "same-task_id replay did not append a duplicate").toBe(1);
  expect(replayed[0].instance_id).toBe(first[0].instance_id);
});
