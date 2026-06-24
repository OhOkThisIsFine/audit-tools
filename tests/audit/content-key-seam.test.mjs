import test from "node:test";
import assert from "node:assert/strict";

const { buildTaskContentSignature, identityKey, contentKey } = await import(
  "../../src/shared/contentKey.ts"
);

const baseIdentity = { unit_id: "u1", lens: "security", pass_id: "p1" };
const sig = buildTaskContentSignature({ goal: "audit auth", scope: ["a.ts"] });

function makeContentKeyInput(overrides = {}) {
  return {
    ...baseIdentity,
    task_content_signature: sig,
    result_content_discriminator: "base",
    ...overrides,
  };
}

test("(a) varying only task_content_signature: identityKey fixed, contentKey bumps", () => {
  const sigA = buildTaskContentSignature({ goal: "audit auth" });
  const sigB = buildTaskContentSignature({ goal: "audit billing" });
  assert.notEqual(sigA, sigB);

  const idA = identityKey(baseIdentity);
  const idB = identityKey(baseIdentity);
  assert.equal(idA, idB);

  const ckA = contentKey(makeContentKeyInput({ task_content_signature: sigA }));
  const ckB = contentKey(makeContentKeyInput({ task_content_signature: sigB }));
  assert.notEqual(ckA, ckB);
});

test("(b) varying any of unit_id/lens/pass_id bumps BOTH keys", () => {
  const baseId = identityKey(baseIdentity);
  const baseCk = contentKey(makeContentKeyInput());

  for (const field of ["unit_id", "lens", "pass_id"]) {
    const mutated = { ...baseIdentity, [field]: baseIdentity[field] + "X" };
    assert.notEqual(identityKey(mutated), baseId, `${field} → identityKey bumps`);
    assert.notEqual(
      contentKey(makeContentKeyInput(mutated)),
      baseCk,
      `${field} → contentKey bumps`,
    );
  }
});

test("(c) same coordinate, different discriminator: same identityKey, different contentKey", () => {
  const inputBase = makeContentKeyInput({ result_content_discriminator: "base" });
  const inputDeepen = makeContentKeyInput({
    result_content_discriminator: "deepening",
  });

  assert.equal(identityKey(inputBase), identityKey(inputDeepen));
  assert.notEqual(contentKey(inputBase), contentKey(inputDeepen));
});

test("(d) renumbering task_id alone changes neither key", () => {
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

  const ck1 = contentKey(makeContentKeyInput({ task_content_signature: sigT1 }));
  const ck2 = contentKey(makeContentKeyInput({ task_content_signature: sigT2 }));
  assert.equal(ck1, ck2);
});

test("(e) reordered object keys in signature input give identical contentKey", () => {
  const sig1 = buildTaskContentSignature({ goal: "g", scope: ["a"], depth: 2 });
  const sig2 = buildTaskContentSignature({ depth: 2, scope: ["a"], goal: "g" });
  assert.equal(sig1, sig2, "stableStringify, not naive JSON.stringify");

  const ck1 = contentKey(makeContentKeyInput({ task_content_signature: sig1 }));
  const ck2 = contentKey(makeContentKeyInput({ task_content_signature: sig2 }));
  assert.equal(ck1, ck2);
});

test("(f) missing pass_id or lens throws", () => {
  assert.throws(() => identityKey({ unit_id: "u1", lens: "security" }));
  assert.throws(() => identityKey({ unit_id: "u1", pass_id: "p1" }));
  assert.throws(() =>
    identityKey({ unit_id: "u1", lens: "", pass_id: "p1" }),
  );
});

test("relating invariant: equal contentKey ⟹ equal identityKey", () => {
  const a = makeContentKeyInput();
  const b = makeContentKeyInput();
  assert.equal(contentKey(a), contentKey(b));
  assert.equal(identityKey(a), identityKey(b));
});
