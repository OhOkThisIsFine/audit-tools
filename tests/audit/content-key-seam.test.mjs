import test from "node:test";
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
  assert.notEqual(sigA, sigB);

  // identityKey and idempotencyKey are signature-STABLE.
  assert.equal(identityKey(baseIdentity), identityKey(baseIdentity));
  assert.equal(
    idempotencyKey(makeInput({ task_content_signature: sigA })),
    idempotencyKey(makeInput({ task_content_signature: sigB })),
  );

  // contentKey is signature-SENSITIVE.
  const ckA = contentKey(makeInput({ task_content_signature: sigA }));
  const ckB = contentKey(makeInput({ task_content_signature: sigB }));
  assert.notEqual(ckA, ckB);
});

test("(b) varying any of unit_id/lens/pass_id bumps ALL THREE keys", () => {
  const baseId = identityKey(baseIdentity);
  const baseIk = idempotencyKey(makeInput());
  const baseCk = contentKey(makeInput());

  for (const field of ["unit_id", "lens", "pass_id"]) {
    const mutated = { ...baseIdentity, [field]: baseIdentity[field] + "X" };
    assert.notEqual(identityKey(mutated), baseId, `${field} → identityKey bumps`);
    assert.notEqual(
      idempotencyKey(makeInput(mutated)),
      baseIk,
      `${field} → idempotencyKey bumps`,
    );
    assert.notEqual(
      contentKey(makeInput(mutated)),
      baseCk,
      `${field} → contentKey bumps`,
    );
  }
});

test("(c) same coordinate, different discriminator: same identityKey, different idempotencyKey + contentKey", () => {
  const inputBase = makeInput({
    result_content_discriminator: buildResultContentDiscriminator({ source: "base" }),
  });
  const inputDeepen = makeInput({
    result_content_discriminator: buildResultContentDiscriminator({ source: "deepening" }),
  });

  assert.equal(identityKey(inputBase), identityKey(inputDeepen));
  assert.notEqual(idempotencyKey(inputBase), idempotencyKey(inputDeepen));
  assert.notEqual(contentKey(inputBase), contentKey(inputDeepen));
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
  assert.equal(sigT1, sigT2, "task_id excluded from task_content_signature");

  assert.equal(
    contentKey(makeInput({ task_content_signature: sigT1 })),
    contentKey(makeInput({ task_content_signature: sigT2 })),
  );
});

test("(e) reordered object keys in signature input give identical signature + contentKey", () => {
  const sig1 = buildTaskContentSignature({ goal: "g", scope: ["a"], depth: 2 });
  const sig2 = buildTaskContentSignature({ depth: 2, scope: ["a"], goal: "g" });
  assert.equal(sig1, sig2, "stableStringify, not naive JSON.stringify");

  assert.equal(
    contentKey(makeInput({ task_content_signature: sig1 })),
    contentKey(makeInput({ task_content_signature: sig2 })),
  );
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
  assert.notEqual(sigC1, sigC2);

  const ikC1 = idempotencyKey(makeInput({ task_content_signature: sigC1 }));
  const ikC2 = idempotencyKey(makeInput({ task_content_signature: sigC2 }));
  assert.equal(ikC1, ikC2, "idempotencyKey invariant under task_content_signature change");

  const ckC1 = contentKey(makeInput({ task_content_signature: sigC1 }));
  const ckC2 = contentKey(makeInput({ task_content_signature: sigC2 }));
  assert.notEqual(ckC1, ckC2, "contentKey bumps on signature change");
});

test("inv-8 (replay idempotent): re-deriving the same logical result yields identical keys", () => {
  const a = makeInput();
  const b = makeInput();
  assert.equal(identityKey(a), identityKey(b));
  assert.equal(idempotencyKey(a), idempotencyKey(b));
  assert.equal(contentKey(a), contentKey(b));
});

test("inv-8 (benign edit bumps ONLY contentKey): replay stays idempotent, staleness still fires", () => {
  const before = makeInput({ task_content_signature: buildTaskContentSignature({ goal: "g", body: "x" }) });
  const after = makeInput({ task_content_signature: buildTaskContentSignature({ goal: "g", body: "x edited" }) });

  // idempotencyKey unchanged → idempotent re-ingest is a no-op (no duplicate).
  assert.equal(idempotencyKey(before), idempotencyKey(after));
  // contentKey changed → staleness fires.
  assert.notEqual(contentKey(before), contentKey(after));
});

test("relating invariant (inv-7): equal contentKey ⟹ equal idempotencyKey ⟹ equal identityKey", () => {
  const a = makeInput();
  const b = makeInput();
  assert.equal(contentKey(a), contentKey(b));
  assert.equal(idempotencyKey(a), idempotencyKey(b));
  assert.equal(identityKey(a), identityKey(b));
});

test("buildResultContentDiscriminator is tool-owned: enum sources + attempt-keyed redispatch (fail-3)", () => {
  assert.equal(buildResultContentDiscriminator({ source: "base" }), "base");
  assert.equal(buildResultContentDiscriminator({ source: "deepening" }), "deepening");
  assert.equal(buildResultContentDiscriminator({ source: "steward" }), "steward");

  const r1 = buildResultContentDiscriminator({ source: "redispatch", attempt: 1 });
  const r2 = buildResultContentDiscriminator({ source: "redispatch", attempt: 2 });
  assert.notEqual(r1, r2, "distinct attempts → distinct discriminators (no collision)");

  assert.throws(() => buildResultContentDiscriminator({ source: "redispatch" }));
  assert.throws(() => buildResultContentDiscriminator({ source: "redispatch", attempt: 0 }));
  assert.throws(() => buildResultContentDiscriminator({ source: "bogus" }));

  // Two redispatch attempts at one coordinate get distinct idempotencyKeys.
  const ikA1 = idempotencyKey(makeInput({ result_content_discriminator: r1 }));
  const ikA2 = idempotencyKey(makeInput({ result_content_discriminator: r2 }));
  assert.notEqual(ikA1, ikA2);
});

test("newInstanceId mints a distinct id per record (fail-2: ledger keyed by instance, not identity)", () => {
  const a = newInstanceId();
  const b = newInstanceId();
  assert.equal(typeof a, "string");
  assert.notEqual(a, b);
});

test("INV-CK-2: contentKey is pure/deterministic (no second serializer; stable across calls)", () => {
  const input = makeInput();
  assert.equal(contentKey(input), contentKey({ ...input }));
});
