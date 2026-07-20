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

test("one vendor credential is ONE account partition, however the lane is reached", () => {
  // A proxied lane (transport claude-worker) and a direct lane (transport
  // openai-compatible) both routing to service `nim` under one declared account are ONE
  // real credential at one vendor and must share ONE budget partition. Namespacing the
  // explicit-account key on the TRANSPORT split them into `claude-worker#work` and
  // `openai-compatible#work` — double-booking the budget the account key exists to protect.
  // Account is only meaningful WITHIN a service (spec/backend-identity-axes.md), so the
  // namespace is service-keyed.
  const proxied = { transport: "claude-worker", service: "nim", account: "work" };
  const direct = { transport: "openai-compatible", service: "nim", account: "work" };
  expect(deriveAccountKey(proxied)).toBe(deriveAccountKey(direct));
  expect(deriveAccountKey(proxied)).toBe("nim#work");
});

test("proxied siblings on ONE service behind ONE proxy share an account key", () => {
  // Expanded claude-worker sources (proxyCatalog.expandSources) all carry the proxy's
  // endpoint + api_key_env and differ only in `service`+`model`. Two nim models behind
  // the proxy are ONE account — a 429 on one must gate the other. The old
  // deriveLocalAccountId guard (transport === "openai-compatible") returned null here,
  // so they never folded: the live under-merge bug.
  const PROXY = "http://127.0.0.1:4000/v1";
  const a = { transport: "claude-worker", service: "nim", endpoint: PROXY, api_key_env: "PROXY_KEY", model: "nano" };
  const b = { transport: "claude-worker", service: "nim", endpoint: PROXY, api_key_env: "PROXY_KEY", model: "super" };
  expect(deriveAccountKey(a)).toBe(deriveAccountKey(b));
  expect(deriveAccountKey(a)).not.toBeNull();
});

test("different services behind ONE proxy stay DISTINCT (no cooldown over-merge)", () => {
  // The over-merge the backlog forbids: every backend behind one proxy shares the proxy's
  // (endpoint, api_key_env), so a service-less credential identity would collapse them and
  // let a free nim 429 stall a paid anthropic lane. Service-namespacing keeps them apart.
  const PROXY = "http://127.0.0.1:4000/v1";
  const nim = { transport: "claude-worker", service: "nim", endpoint: PROXY, api_key_env: "PROXY_KEY", model: "m" };
  const anthropic = { transport: "claude-worker", service: "anthropic", endpoint: PROXY, api_key_env: "PROXY_KEY", model: "m" };
  expect(deriveAccountKey(nim)).not.toBe(deriveAccountKey(anthropic));
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
