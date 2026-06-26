import test from "node:test";
import assert from "node:assert/strict";

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
  assert.equal(a.identity_key, b.identity_key);
  assert.notEqual(a.idempotency_key, b.idempotency_key);
});

test("both split siblings are RETAINED through the append-only INV-2 gate", () => {
  const incoming = [
    siblingResult("scope:security:part-1", "F-A"),
    siblingResult("scope:security:part-2", "F-B"),
  ];
  const ledger = appendResultsToLedger([], incoming);
  assert.equal(ledger.length, 2, "both siblings must persist, not no-op the 2nd");
  const ids = new Set(ledger.map((r) => r.idempotency_key));
  assert.equal(ids.size, 2);
});

test("lone (non-split) base task: discriminator + key are BYTE-IDENTICAL to legacy lone-base", () => {
  // Legacy lone-base discriminator (no split component).
  const legacyDisc = "base";
  const lone = buildResultContentDiscriminator({ source: "base" });
  assert.equal(lone, legacyDisc);
  // A lone task_id has no `:part`/path suffix ⇒ empty split component.
  assert.equal(splitDiscriminatorFromTaskId("scope:security", "security"), "");
  const withTaskId = buildResultContentDiscriminator({
    source: "base",
    split_discriminator: splitDiscriminatorFromTaskId("scope:security", "security"),
  });
  assert.equal(withTaskId, legacyDisc);
  // And the resulting idempotency_key is unchanged vs. the legacy keying.
  const coordinate = { unit_id: "u1", lens: "security", pass_id: "p1" };
  assert.equal(
    idempotencyKey({ ...coordinate, result_content_discriminator: withTaskId }),
    idempotencyKey({ ...coordinate, result_content_discriminator: legacyDisc }),
  );
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
  assert.equal(discPosix, discWin32, "win32 and POSIX splits must not diverge");
  // canonicalization is the single point of OS-agnosticism.
  assert.equal(
    canonicalSplitDiscriminator("dir\\big.ts"),
    canonicalSplitDiscriminator("dir/big.ts"),
  );
  // But a DIFFERENT large-file split of the same unit+lens stays distinct.
  const other = buildResultContentDiscriminator({
    source: "base",
    split_discriminator: splitDiscriminatorFromTaskId("scope:security:dir/small.ts", "security"),
  });
  assert.notEqual(discPosix, other);
});

test("replay of an already-ingested split sibling is a NO-OP (INV-2 idempotent)", () => {
  const first = appendResultsToLedger([], [siblingResult("scope:security:part-1", "F-A")]);
  // Re-ingest the SAME logical sibling (stamped keys carried forward).
  const replay = appendResultsToLedger(first, [siblingResult("scope:security:part-1", "F-A")]);
  assert.equal(replay.length, 1, "replay of same split sibling must not duplicate");
});
