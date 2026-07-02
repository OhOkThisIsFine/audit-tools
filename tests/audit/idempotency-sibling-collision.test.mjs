import { test, expect } from "vitest";

const {
  buildResultContentDiscriminator,
  canonicalSplitDiscriminator,
  splitDiscriminatorFromTaskId,
  idempotencyKey,
} = await import("../../src/shared/contentKey.ts");

const { stampLedgerKeys, appendResultsToLedger } = await import(
  "../../src/audit/orchestrator/ledger.ts"
);

// A file-split sibling pair of one unit+lens+pass: same {unit_id, lens, pass_id}
// grouping coordinate, DISTINCT task_ids (the `:part-N` budget-split form).
function siblingResult(task_id, findingId) {
  return {
    task_id,
    unit_id: "u1",
    pass_id: "p1",
    lens: "security",
    file_coverage: [{ path: "a.ts", total_lines: 10 }],
    findings: [{ id: findingId, title: findingId, severity: "low", lens: "security" }],
  };
}

test("split siblings derive DISTINCT idempotency_keys (no INV-2 collision)", () => {
  const a = stampLedgerKeys(siblingResult("scope:security:part-1", "F-A"));
  const b = stampLedgerKeys(siblingResult("scope:security:part-2", "F-B"));
  // Same grouping identity (one-to-many), but distinct logical identity.
  expect(a.identity_key).toBe(b.identity_key);
  expect(a.idempotency_key).not.toBe(b.idempotency_key);
});

test("both split siblings are RETAINED through the append-only INV-2 gate", () => {
  const incoming = [
    siblingResult("scope:security:part-1", "F-A"),
    siblingResult("scope:security:part-2", "F-B"),
  ];
  const ledger = appendResultsToLedger([], incoming);
  expect(ledger.length, "both siblings must persist, not no-op the 2nd").toBe(2);
  const ids = new Set(ledger.map((r) => r.idempotency_key));
  expect(ids.size).toBe(2);
});

test("lone (non-split) base task: discriminator + key are BYTE-IDENTICAL to legacy lone-base", () => {
  // Legacy lone-base discriminator (no split component).
  const legacyDisc = "base";
  const lone = buildResultContentDiscriminator({ source: "base" });
  expect(lone).toBe(legacyDisc);
  // A lone task_id has no `:part`/path suffix ⇒ empty split component.
  expect(splitDiscriminatorFromTaskId("scope:security", "security")).toBe("");
  const withTaskId = buildResultContentDiscriminator({
    source: "base",
    split_discriminator: splitDiscriminatorFromTaskId("scope:security", "security"),
  });
  expect(withTaskId).toBe(legacyDisc);
  // And the resulting idempotency_key is unchanged vs. the legacy keying.
  const coordinate = { unit_id: "u1", lens: "security", pass_id: "p1" };
  expect(idempotencyKey({ ...coordinate, result_content_discriminator: withTaskId })).toBe(idempotencyKey({ ...coordinate, result_content_discriminator: legacyDisc }));
});

test("large_file split: cross-platform task_id canonicalizes to the SAME key (no win32/POSIX collision)", () => {
  // Same logical large-file split, host-dependent path separator in the task_id.
  const posix = "scope:security:dir/big.ts";
  const win32 = "scope:security:dir\\big.ts";
  const discPosix = buildResultContentDiscriminator({
    source: "base",
    split_discriminator: splitDiscriminatorFromTaskId(posix, "security"),
  });
  const discWin32 = buildResultContentDiscriminator({
    source: "base",
    split_discriminator: splitDiscriminatorFromTaskId(win32, "security"),
  });
  expect(discPosix, "win32 and POSIX splits must not diverge").toBe(discWin32);
  // canonicalization is the single point of OS-agnosticism.
  expect(canonicalSplitDiscriminator("dir\\big.ts")).toBe(canonicalSplitDiscriminator("dir/big.ts"));
  // But a DIFFERENT large-file split of the same unit+lens stays distinct.
  const other = buildResultContentDiscriminator({
    source: "base",
    split_discriminator: splitDiscriminatorFromTaskId("scope:security:dir/small.ts", "security"),
  });
  expect(discPosix).not.toBe(other);
});

test("replay of an already-ingested split sibling is a NO-OP (INV-2 idempotent)", () => {
  const first = appendResultsToLedger([], [siblingResult("scope:security:part-1", "F-A")]);
  // Re-ingest the SAME logical sibling (stamped keys carried forward).
  const replay = appendResultsToLedger(first, [siblingResult("scope:security:part-1", "F-A")]);
  expect(replay.length, "replay of same split sibling must not duplicate").toBe(1);
});
