/**
 * account-identity.test.mjs
 *
 * The N× over-admission's IDENTITY half. Step-3/4's first attempt derived the account
 * from the pool-key STRING, which silently split every explicitly-`id`'d source — the
 * motivating nim-nano/nim-super config — while the ledger half looked correct. These
 * tests start from a SOURCE DECLARATION, never a hand-injected account key.
 */
import { test, expect } from "vitest";

const { deriveAccountKey, deriveCredentialIdentity } = await import(
  "../../src/shared/quota/accountId.ts"
);
const { windowResourceKey } = await import("../../src/shared/quota/windowConstraints.ts");
const { dispatchableSourceId } = await import("../../src/shared/quota/apiPool.ts");

const NIM = "https://integrate.api.nvidia.com/v1";

test("explicitly-id'd siblings on ONE api_key_env share an account key", () => {
  // The real sources-declared.json shape: named ids, one credential. `dispatchableSourceId`
  // returns these ids VERBATIM, so nothing about the account is recoverable from the key.
  const nano = { id: "nim-nano", transport: "openai-compatible", endpoint: NIM, api_key_env: "NVIDIA_API_KEY", model: "nano" };
  const superb = { id: "nim-super", transport: "openai-compatible", endpoint: NIM, api_key_env: "NVIDIA_API_KEY", model: "super" };
  expect(deriveAccountKey(nano)).toBe(deriveAccountKey(superb));
  expect(deriveAccountKey(nano)).not.toBeNull();
});

test("explicitly-id'd siblings on ONE inline api_key share an account key", () => {
  // The shape claimed fixed three consecutive rounds while still broken.
  const nano = { id: "nim-nano", transport: "openai-compatible", endpoint: NIM, api_key: "sk-secret", model: "nano" };
  const superb = { id: "nim-super", transport: "openai-compatible", endpoint: NIM, api_key: "sk-secret", model: "super" };
  expect(deriveAccountKey(nano)).toBe(deriveAccountKey(superb));
});

test("the account key never contains a secret", () => {
  const key = deriveAccountKey({ id: "x", transport: "openai-compatible", endpoint: NIM, api_key: "sk-super-secret-value" });
  // This string is persisted into the reservation-ledger file and appears in artifacts.
  expect(key).not.toContain("sk-super-secret-value");
  expect(key).toMatch(/::inline:[0-9a-f]{16}$/);
});

test("DIFFERENT credentials on one endpoint stay distinct", () => {
  const a = { transport: "openai-compatible", endpoint: NIM, api_key_env: "NVIDIA_API_KEY" };
  const b = { transport: "openai-compatible", endpoint: NIM, api_key_env: "OTHER_KEY" };
  expect(deriveAccountKey(a)).not.toBe(deriveAccountKey(b));
});

test("different endpoints stay distinct even on the same env var name", () => {
  const a = { transport: "openai-compatible", endpoint: NIM, api_key_env: "K" };
  const b = { transport: "openai-compatible", endpoint: "http://localhost:8000/v1", api_key_env: "K" };
  expect(deriveAccountKey(a)).not.toBe(deriveAccountKey(b));
});

test("an explicit operator account declaration wins and is never re-merged", () => {
  // Two declared accounts on one endpoint+credential must stay separate.
  const a = { transport: "openai-compatible", endpoint: NIM, api_key_env: "K", account: "team-a" };
  const b = { transport: "openai-compatible", endpoint: NIM, api_key_env: "K", account: "team-b" };
  expect(deriveAccountKey(a)).not.toBe(deriveAccountKey(b));
  expect(deriveAccountKey(a)).toBe("openai-compatible#team-a");
});

test("an unattributable source yields null so the caller meters it ALONE", () => {
  // No endpoint and no credential ⇒ we cannot prove it shares anyone's allowance.
  // Merging on a guess would over-throttle; the caller falls back to the pool key.
  expect(deriveAccountKey({ transport: "openai-compatible", model: "m" })).toBeNull();
  expect(deriveCredentialIdentity({ endpoint: NIM })).toBeNull();
});

test("endpoint normalization: trailing slash and case do not split an account", () => {
  const a = { transport: "openai-compatible", endpoint: NIM, api_key_env: "K" };
  const b = { transport: "openai-compatible", endpoint: `${NIM.toUpperCase()}/`, api_key_env: "K" };
  expect(deriveAccountKey(a)).toBe(deriveAccountKey(b));
});

test("account and model window keys never collide, even when accountKey === poolId", () => {
  // The unattributable fallback sets accountKey = poolId. Un-namespaced, an
  // account-scoped and a model-scoped window sharing a label would silently meter as
  // ONE allowance — destroying the partition on exactly the pool class that needs it.
  const acct = windowResourceKey("account", "session", "nim-nano", "nim-nano");
  const model = windowResourceKey("model", "session", "nim-nano", "nim-nano");
  expect(acct).not.toBe(model);
});

test("the JOIN: siblings get DIFFERENT pool ids but the SAME account key", () => {
  // This is the pairing the whole defect lived in.  returns an
  // explicit id verbatim, so the two pool keys share no substring — any attempt to
  // recover the account from them splits the credential. Only the source declaration
  // knows they are one account.
  const nano = { id: "nim-nano", transport: "openai-compatible", endpoint: NIM, api_key_env: "NVIDIA_API_KEY", model: "nano" };
  const superb = { id: "nim-super", transport: "openai-compatible", endpoint: NIM, api_key_env: "NVIDIA_API_KEY", model: "super" };

  const nanoId = dispatchableSourceId(nano, null);
  const superId = dispatchableSourceId(superb, null);
  expect(nanoId).toBe("nim-nano");
  expect(superId).toBe("nim-super");
  expect(nanoId).not.toBe(superId);
  // ...yet ONE metered account, so ONE shared ledger key.
  expect(deriveAccountKey(nano)).toBe(deriveAccountKey(superb));
  expect(windowResourceKey("account", "session", nanoId, deriveAccountKey(nano))).toBe(
    windowResourceKey("account", "session", superId, deriveAccountKey(superb)),
  );
});
