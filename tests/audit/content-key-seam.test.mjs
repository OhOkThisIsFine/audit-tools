import { test, expect } from "vitest";
import assert from "node:assert/strict";

const {
  buildTaskContentSignature,
  buildResultContentDiscriminator,
  identityKey,
  idempotencyKey,
  contentKey,
  newInstanceId,
} = await import("../../src/shared/contentKey.ts");

const baseIdentity = { unit_id: "u1", lens: "security", pass_id: "p1" };
const sig = buildTaskContentSignature({ goal: "audit auth", scope: ["a.ts"] });
const disc = buildResultContentDiscriminator({ source: "base" });

function makeInput(overrides = {}) {
  return {
    ...baseIdentity,
    task_content_signature: sig,
    result_content_discriminator: disc,
    ...overrides,
  };
}

test("(a) varying only task_content_signature: identityKey + idempotencyKey fixed, contentKey bumps", () => {
  const sigA = buildTaskContentSignature({ goal: "audit auth" });
  const sigB = buildTaskContentSignature({ goal: "audit billing" });
  expect(sigA).not.toBe(sigB);

  // identityKey and idempotencyKey are signature-STABLE.
  expect(identityKey(baseIdentity)).toBe(identityKey(baseIdentity));
  expect(idempotencyKey(makeInput({ task_content_signature: sigA }))).toBe(idempotencyKey(makeInput({ task_content_signature: sigB })));

  // contentKey is signature-SENSITIVE.
  const ckA = contentKey(makeInput({ task_content_signature: sigA }));
  const ckB = contentKey(makeInput({ task_content_signature: sigB }));
  expect(ckA).not.toBe(ckB);
});

test("(b) varying any of unit_id/lens/pass_id bumps ALL THREE keys", () => {
  const baseId = identityKey(baseIdentity);
  const baseIk = idempotencyKey(makeInput());
  const baseCk = contentKey(makeInput());

  for (const field of ["unit_id", "lens", "pass_id"]) {
    const mutated = { ...baseIdentity, [field]: baseIdentity[field] + "X" };
    expect(identityKey(mutated), `${field} → identityKey bumps`).not.toBe(baseId);
    expect(idempotencyKey(makeInput(mutated)), `${field} → idempotencyKey bumps`).not.toBe(baseIk);
    expect(contentKey(makeInput(mutated)), `${field} → contentKey bumps`).not.toBe(baseCk);
  }
});

test("(c) same coordinate, different discriminator: same identityKey, different idempotencyKey + contentKey", () => {
  const inputBase = makeInput({
    result_content_discriminator: buildResultContentDiscriminator({ source: "base" }),
  });
  const inputDeepen = makeInput({
    result_content_discriminator: buildResultContentDiscriminator({
      source: "deepening",
      task_id: "deepening:steward:abc123",
    }),
  });

  expect(identityKey(inputBase)).toBe(identityKey(inputDeepen));
  expect(idempotencyKey(inputBase)).not.toBe(idempotencyKey(inputDeepen));
  expect(contentKey(inputBase)).not.toBe(contentKey(inputDeepen));
});

test("(d) renumbering task_id alone changes no key", () => {
  const sigT1 = buildTaskContentSignature({
    task_id: "T-001",
    goal: "audit auth",
    scope: ["a.ts"],
  });
  const sigT2 = buildTaskContentSignature({
    task_id: "T-999",
    goal: "audit auth",
    scope: ["a.ts"],
  });
  expect(sigT1, "task_id excluded from task_content_signature").toBe(sigT2);

  expect(contentKey(makeInput({ task_content_signature: sigT1 }))).toBe(contentKey(makeInput({ task_content_signature: sigT2 })));
});

test("(e) reordered object keys in signature input give identical signature + contentKey", () => {
  const sig1 = buildTaskContentSignature({ goal: "g", scope: ["a"], depth: 2 });
  const sig2 = buildTaskContentSignature({ depth: 2, scope: ["a"], goal: "g" });
  expect(sig1, "stableStringify, not naive JSON.stringify").toBe(sig2);

  expect(contentKey(makeInput({ task_content_signature: sig1 }))).toBe(contentKey(makeInput({ task_content_signature: sig2 })));
});

test("(f) missing pass_id or lens throws (fail-3)", () => {
  assert.throws(() => identityKey({ unit_id: "u1", lens: "security" }));
  assert.throws(() => identityKey({ unit_id: "u1", pass_id: "p1" }));
  assert.throws(() => identityKey({ unit_id: "u1", lens: "", pass_id: "p1" }));
  // Propagates through the dependent keys.
  assert.throws(() =>
    idempotencyKey({ unit_id: "u1", lens: "", pass_id: "p1", result_content_discriminator: "base" }),
  );
  assert.throws(() =>
    contentKey({ ...baseIdentity, lens: "", task_content_signature: sig, result_content_discriminator: "base" }),
  );
});

test("(g) missing discriminator / signature throws", () => {
  assert.throws(() => idempotencyKey({ ...baseIdentity, result_content_discriminator: "" }));
  assert.throws(() => contentKey(makeInput({ task_content_signature: "" })));
});

test("INV-CK-7 / inv-7: idempotencyKey is signature-STABLE, contentKey is signature-SENSITIVE", () => {
  const sigC1 = buildTaskContentSignature({ goal: "g", note: "v1" });
  const sigC2 = buildTaskContentSignature({ goal: "g", note: "v2" });
  expect(sigC1).not.toBe(sigC2);

  const ikC1 = idempotencyKey(makeInput({ task_content_signature: sigC1 }));
  const ikC2 = idempotencyKey(makeInput({ task_content_signature: sigC2 }));
  expect(ikC1, "idempotencyKey invariant under task_content_signature change").toBe(ikC2);

  const ckC1 = contentKey(makeInput({ task_content_signature: sigC1 }));
  const ckC2 = contentKey(makeInput({ task_content_signature: sigC2 }));
  expect(ckC1, "contentKey bumps on signature change").not.toBe(ckC2);
});

test("inv-8 (replay idempotent): re-deriving the same logical result yields identical keys", () => {
  const a = makeInput();
  const b = makeInput();
  expect(identityKey(a)).toBe(identityKey(b));
  expect(idempotencyKey(a)).toBe(idempotencyKey(b));
  expect(contentKey(a)).toBe(contentKey(b));
});

test("inv-8 (benign edit bumps ONLY contentKey): replay stays idempotent, staleness still fires", () => {
  const before = makeInput({ task_content_signature: buildTaskContentSignature({ goal: "g", body: "x" }) });
  const after = makeInput({ task_content_signature: buildTaskContentSignature({ goal: "g", body: "x edited" }) });

  // idempotencyKey unchanged → idempotent re-ingest is a no-op (no duplicate).
  expect(idempotencyKey(before)).toBe(idempotencyKey(after));
  // contentKey changed → staleness fires.
  expect(contentKey(before)).not.toBe(contentKey(after));
});

test("relating invariant (inv-7): equal contentKey ⟹ equal idempotencyKey ⟹ equal identityKey", () => {
  const a = makeInput();
  const b = makeInput();
  expect(contentKey(a)).toBe(contentKey(b));
  expect(idempotencyKey(a)).toBe(idempotencyKey(b));
  expect(identityKey(a)).toBe(identityKey(b));
});

test("buildResultContentDiscriminator is tool-owned: enum sources + attempt-keyed redispatch (fail-3)", () => {
  expect(buildResultContentDiscriminator({ source: "base" })).toBe("base");
  expect(buildResultContentDiscriminator({ source: "deepening", task_id: "deepening:clean:aaa" })).toBe("deepening:deepening:clean:aaa");
  expect(buildResultContentDiscriminator({ source: "steward", task_id: "deepening:steward:bbb" })).toBe("steward:deepening:steward:bbb");

  const r1 = buildResultContentDiscriminator({ source: "redispatch", attempt: 1 });
  const r2 = buildResultContentDiscriminator({ source: "redispatch", attempt: 2 });
  expect(r1, "distinct attempts → distinct discriminators (no collision)").not.toBe(r2);

  assert.throws(() => buildResultContentDiscriminator({ source: "redispatch" }));
  assert.throws(() => buildResultContentDiscriminator({ source: "redispatch", attempt: 0 }));
  assert.throws(() => buildResultContentDiscriminator({ source: "bogus" }));
  // Deepening/steward without a task_id would collide across rounds — refuse (fail-3).
  assert.throws(() => buildResultContentDiscriminator({ source: "deepening" }));
  assert.throws(() => buildResultContentDiscriminator({ source: "steward", task_id: "" }));

  // Two redispatch attempts at one coordinate get distinct idempotencyKeys.
  const ikA1 = idempotencyKey(makeInput({ result_content_discriminator: r1 }));
  const ikA2 = idempotencyKey(makeInput({ result_content_discriminator: r2 }));
  expect(ikA1).not.toBe(ikA2);
});

test("deepening/steward: distinct task_id per round → distinct idempotencyKey; same task_id replays idempotent (confirmed live 2026-06-30)", () => {
  const round1 = buildResultContentDiscriminator({
    source: "deepening",
    task_id: "deepening:steward:round1hash",
  });
  const round2 = buildResultContentDiscriminator({
    source: "deepening",
    task_id: "deepening:steward:round2hash",
  });
  expect(round1, "each regenerated deepening round gets a distinct discriminator").not.toBe(round2);

  const ikRound1 = idempotencyKey(makeInput({ result_content_discriminator: round1 }));
  const ikRound2 = idempotencyKey(makeInput({ result_content_discriminator: round2 }));
  expect(ikRound1, "round 2's clean result no longer no-ops against round 1's ledger slot").not.toBe(ikRound2);

  const replay = buildResultContentDiscriminator({
    source: "deepening",
    task_id: "deepening:steward:round1hash",
  });
  expect(round1, "a genuine replay of the SAME task_id reproduces the same discriminator").toBe(replay);
  expect(idempotencyKey(makeInput({ result_content_discriminator: round1 })), "INV-2 replay-no-op preserved for same-task_id replays").toBe(idempotencyKey(makeInput({ result_content_discriminator: replay })));
});

test("newInstanceId mints a distinct id per record (fail-2: ledger keyed by instance, not identity)", () => {
  const a = newInstanceId();
  const b = newInstanceId();
  expect(typeof a).toBe("string");
  expect(a).not.toBe(b);
});

test("INV-CK-2: contentKey is pure/deterministic (no second serializer; stable across calls)", () => {
  const input = makeInput();
  expect(contentKey(input)).toBe(contentKey({ ...input }));
});
