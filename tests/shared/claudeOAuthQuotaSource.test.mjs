import { test, afterEach, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";

const { ClaudeOAuthQuotaSource, parseProviderModelKey, mapUsageToSnapshot } = await import("../../src/shared/quota/claudeOAuthQuotaSource.ts");

const NOW = Date.parse("2026-06-16T12:00:00.000Z");

// The real /usage body captured live 2026-06-16 (trimmed to mapped fields).
const LIVE_USAGE = {
  five_hour: { utilization: 10, resets_at: "2026-06-17T04:30:00.038674+00:00" },
  seven_day: { utilization: 5, resets_at: "2026-06-23T17:00:00.038699+00:00" },
  seven_day_opus: null,
  seven_day_sonnet: { utilization: 0, resets_at: null },
  limits: [
    { kind: "session", percent: 10, resets_at: "2026-06-17T04:30:00.038674+00:00", scope: null, is_active: true },
    { kind: "weekly_all", percent: 5, resets_at: "2026-06-23T17:00:00.038699+00:00", scope: null, is_active: false },
    { kind: "weekly_scoped", percent: 0, resets_at: null, scope: { model: { id: null, display_name: "Sonnet" } }, is_active: false },
  ],
};

const tmpDirs = [];
afterEach(() => {
  while (tmpDirs.length) {
    try { rmSync(tmpDirs.pop(), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function writeCreds(creds) {
  const dir = mkdtempSync(join(tmpdir(), "claude-oauth-"));
  tmpDirs.push(dir);
  const p = join(dir, ".credentials.json");
  writeFileSync(p, JSON.stringify(creds));
  return p;
}

function validCreds(overrides = {}) {
  return { claudeAiOauth: { accessToken: "tok-abc", expiresAt: NOW + 600_000, ...overrides } };
}

function recordingFetch(response) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (typeof response === "function") return response(url, init);
    return response;
  };
  fn.calls = calls;
  return fn;
}

function okResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

// ---- parseProviderModelKey ----

test("parseProviderModelKey splits provider/model and normalizes wildcard/empty", () => {
  expect(parseProviderModelKey("claude-code/*")).toEqual({ provider: "claude-code", account: null, model: null });
  expect(parseProviderModelKey("claude-code/")).toEqual({ provider: "claude-code", account: null, model: null });
  expect(parseProviderModelKey("claude-code/claude-opus-4-8")).toEqual({
    provider: "claude-code",
    account: null,
    model: "claude-opus-4-8",
  });
  expect(parseProviderModelKey("codex")).toEqual({ provider: "codex", account: null, model: null });
});

test("parseProviderModelKey extracts the account segment (provider#account/model)", () => {
  expect(parseProviderModelKey("claude-code#org-abc/claude-opus-4-8")).toEqual({
    provider: "claude-code",
    account: "org-abc",
    model: "claude-opus-4-8",
  });
  expect(parseProviderModelKey("claude-code#org-abc/*")).toEqual({
    provider: "claude-code",
    account: "org-abc",
    model: null,
  });
  // Model tail may itself contain '/': only provider+account live before the first '/'.
  expect(parseProviderModelKey("openrouter#acctB/anthropic/claude-x")).toEqual({
    provider: "openrouter",
    account: "acctB",
    model: "anthropic/claude-x",
  });
});

// ---- mapUsageToSnapshot ----

test("mapUsageToSnapshot picks the least-remaining window as a 0-1 fraction", () => {
  const snap = mapUsageToSnapshot(LIVE_USAGE, null, NOW);
  expect(snap.remaining_pct).toBe(0.9); // five_hour util 10 → 90% remaining
  expect(snap.reset_at).toBe("2026-06-17T04:30:00.038674+00:00");
  expect(snap.source).toBe("claude-oauth");
  expect(snap.requests_remaining).toBe(null);
  expect(snap.captured_at).toBe(new Date(NOW).toISOString());
});

test("mapUsageToSnapshot returns null when no window has a numeric utilization", () => {
  expect(mapUsageToSnapshot({ five_hour: null, seven_day: null, limits: [] }, null, NOW)).toBe(null);
  expect(mapUsageToSnapshot({}, null, NOW)).toBe(null);
});

test("mapUsageToSnapshot honors a per-model scoped limits[] entry when the model is known", () => {
  // Per-model constraint is data-driven via limits[].scope.model (no hardcoded
  // model-family names in the source — INV-QD-04).
  const body = {
    five_hour: { utilization: 10, resets_at: "r5h" },
    seven_day: { utilization: 5, resets_at: "r7d" },
    limits: [
      { percent: 80, resets_at: "r-sonnet", scope: { model: { display_name: "Sonnet" } } },
    ],
  };
  const known = mapUsageToSnapshot(body, "claude-sonnet-4-6", NOW);
  expect(known.remaining_pct).toBe(0.2); // scoped window binds at 80% util
  // Unknown model → the scoped 80% window is skipped, five_hour(10) binds.
  const unknown = mapUsageToSnapshot(body, null, NOW);
  expect(unknown.remaining_pct).toBe(0.9);
});

test("mapUsageToSnapshot lets a high limits[] entry bind over top-level windows", () => {
  const body = {
    five_hour: { utilization: 10, resets_at: "r5h" },
    limits: [{ percent: 95, resets_at: "r-crit", scope: null }],
  };
  const snap = mapUsageToSnapshot(body, null, NOW);
  expect(snap.remaining_pct).toBe(0.05);
  expect(snap.reset_at).toBe("r-crit");
});

test("mapUsageToSnapshot clamps over-cap utilization to 0 remaining", () => {
  const snap = mapUsageToSnapshot({ five_hour: { utilization: 130, resets_at: "r" } }, null, NOW);
  expect(snap.remaining_pct).toBe(0);
});

// ---- queryCurrentUsage ----

test("queryCurrentUsage returns null for a non-Claude provider without fetching", async () => {
  const fetchImpl = recordingFetch(okResponse(LIVE_USAGE));
  const src = new ClaudeOAuthQuotaSource({
    credentialsPath: writeCreds(validCreds()),
    fetchImpl,
    now: () => NOW,
  });
  expect(await src.queryCurrentUsage("codex/*")).toBe(null);
  expect(fetchImpl.calls.length).toBe(0);
});

test("queryCurrentUsage maps a live 200 response and sends auth + beta headers", async () => {
  const fetchImpl = recordingFetch(okResponse(LIVE_USAGE));
  const src = new ClaudeOAuthQuotaSource({
    credentialsPath: writeCreds(validCreds()),
    fetchImpl,
    now: () => NOW,
  });
  const snap = await src.queryCurrentUsage("claude-code/*");
  expect(snap.remaining_pct).toBe(0.9);
  expect(snap.source).toBe("claude-oauth");
  expect(fetchImpl.calls.length).toBe(1);
  const headers = fetchImpl.calls[0].init.headers;
  expect(headers.Authorization).toBe("Bearer tok-abc");
  expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20");
});

test("queryCurrentUsage returns null when the credentials file is missing", async () => {
  const fetchImpl = recordingFetch(okResponse(LIVE_USAGE));
  const src = new ClaudeOAuthQuotaSource({
    credentialsPath: join(tmpdir(), "does-not-exist-claude", ".credentials.json"),
    fetchImpl,
    now: () => NOW,
  });
  expect(await src.queryCurrentUsage("claude-code/*")).toBe(null);
  expect(fetchImpl.calls.length).toBe(0);
});

test("queryCurrentUsage returns null for an expired token without fetching", async () => {
  const fetchImpl = recordingFetch(okResponse(LIVE_USAGE));
  const src = new ClaudeOAuthQuotaSource({
    credentialsPath: writeCreds(validCreds({ expiresAt: NOW - 1 })),
    fetchImpl,
    now: () => NOW,
  });
  expect(await src.queryCurrentUsage("claude-code/*")).toBe(null);
  expect(fetchImpl.calls.length).toBe(0);
});

test("queryCurrentUsage degrades to null on a 401 response", async () => {
  const fetchImpl = recordingFetch({ ok: false, status: 401, json: async () => ({}) });
  const src = new ClaudeOAuthQuotaSource({
    credentialsPath: writeCreds(validCreds()),
    fetchImpl,
    now: () => NOW,
  });
  expect(await src.queryCurrentUsage("claude-code/*")).toBe(null);
  expect(fetchImpl.calls.length).toBe(1);
});

test("queryCurrentUsage degrades to null when fetch throws", async () => {
  const fetchImpl = recordingFetch(() => Promise.reject(new Error("ECONNREFUSED")));
  const src = new ClaudeOAuthQuotaSource({
    credentialsPath: writeCreds(validCreds()),
    fetchImpl,
    now: () => NOW,
  });
  expect(await src.queryCurrentUsage("claude-code/*")).toBe(null);
});

test("queryCurrentUsage caches within the TTL and refetches after it elapses", async () => {
  let clock = NOW;
  const fetchImpl = recordingFetch(okResponse(LIVE_USAGE));
  const src = new ClaudeOAuthQuotaSource({
    credentialsPath: writeCreds(validCreds({ expiresAt: NOW + 3_600_000 })),
    fetchImpl,
    now: () => clock,
    cacheTtlMs: 45_000,
  });
  await src.queryCurrentUsage("claude-code/*");
  clock += 10_000; // within TTL
  await src.queryCurrentUsage("claude-code/*");
  expect(fetchImpl.calls.length).toBe(1);
  clock += 60_000; // past TTL
  await src.queryCurrentUsage("claude-code/*");
  expect(fetchImpl.calls.length).toBe(2);
});

test("queryCurrentUsage with the DEFAULT fetch makes no network call under a test runner", async () => {
  // No fetchImpl injected → usingDefaultFetch; this test process sets
  // NODE_TEST_CONTEXT → the live endpoint must be skipped (hermeticity).
  const src = new ClaudeOAuthQuotaSource({
    credentialsPath: writeCreds(validCreds()),
    now: () => NOW,
  });
  expect(await src.queryCurrentUsage("claude-code/*")).toBe(null);
});

// ---- resolveAccountId (account discriminator for pool keys) ----

test("resolveAccountId reads organizationUuid from the credential, gated by provider", async () => {
  const src = new ClaudeOAuthQuotaSource({
    credentialsPath: writeCreds({ ...validCreds(), organizationUuid: "org-xyz" }),
    readEnvToken: () => null,
  });
  expect(await src.resolveAccountId("claude-code/*")).toBe("org-xyz");
  expect(await src.resolveAccountId("claude-code/some-model")).toBe("org-xyz");
  // Not this source's provider → null (no cross-provider account leakage).
  expect(await src.resolveAccountId("codex/*")).toBe(null);
});

test("resolveAccountId is null when the credential file has no organizationUuid / is absent", async () => {
  const noOrg = new ClaudeOAuthQuotaSource({
    credentialsPath: writeCreds(validCreds()),
    readEnvToken: () => null,
  });
  expect(await noOrg.resolveAccountId("claude-code/*")).toBe(null);
  const absent = new ClaudeOAuthQuotaSource({
    credentialsPath: join(tmpdir(), "no-such-claude", ".credentials.json"),
    readEnvToken: () => "env-only",
  });
  expect(await absent.resolveAccountId("claude-code/*")).toBe(null);
});

test("resolveAccountId skips the DEFAULT credential path under a test runner (hermeticity)", async () => {
  // No credentialsPath → default (~/.claude/.credentials.json). Under the test
  // runner this must NOT read the real machine credential, or pool ids would be
  // machine-dependent. An explicitly-injected path (above) is still honored.
  const def = new ClaudeOAuthQuotaSource({ readEnvToken: () => null });
  expect(await def.resolveAccountId("claude-code/*")).toBe(null);
});

// ---- credential resolution: env handoff + refresh-on-expiry ----

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";

/** Fetch double that routes the usage GET and the refresh POST independently. */
function routedFetch({ onUsage, onToken }) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (url === TOKEN_URL) return onToken(JSON.parse(init.body));
    if (url === USAGE_URL) return onUsage(init);
    throw new Error(`unexpected url ${url}`);
  };
  fn.calls = calls;
  return fn;
}

function readCreds(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

test("CLAUDE_CODE_OAUTH_TOKEN short-circuits the file and probes with the env token", async () => {
  const fetchImpl = recordingFetch(okResponse(LIVE_USAGE));
  const src = new ClaudeOAuthQuotaSource({
    // Point at a non-existent file: the env token must make the file irrelevant.
    credentialsPath: join(tmpdir(), "no-such-claude", ".credentials.json"),
    readEnvToken: () => "env-handoff-token",
    fetchImpl,
    now: () => NOW,
  });
  const snap = await src.queryCurrentUsage("claude-code/*");
  expect(snap.remaining_pct).toBe(0.9);
  expect(fetchImpl.calls[0].init.headers.Authorization).toBe("Bearer env-handoff-token");
});

test("an expired token is refreshed, the rotated creds are persisted, and /usage uses the new token", async () => {
  const credsPath = writeCreds(validCreds({ expiresAt: NOW - 1, refreshToken: "rt-old" }));
  let usageAuth = null;
  const fetchImpl = routedFetch({
    onToken: (body) => {
      expect(body.grant_type).toBe("refresh_token");
      expect(body.refresh_token).toBe("rt-old");
      return okResponse({ access_token: "at-new", refresh_token: "rt-new", expires_in: 28800, scope: "user:inference" });
    },
    onUsage: (init) => {
      usageAuth = init.headers.Authorization;
      return okResponse(LIVE_USAGE);
    },
  });
  const src = new ClaudeOAuthQuotaSource({ credentialsPath: credsPath, readEnvToken: () => null, fetchImpl, now: () => NOW });
  const snap = await src.queryCurrentUsage("claude-code/*");
  expect(snap.remaining_pct).toBe(0.9);
  expect(usageAuth).toBe("Bearer at-new");
  // Rotated credential persisted atomically (refresh token replaced, expiry advanced).
  const persisted = readCreds(credsPath).claudeAiOauth;
  expect(persisted.accessToken).toBe("at-new");
  expect(persisted.refreshToken).toBe("rt-new");
  expect(persisted.expiresAt).toBe(NOW + 28800 * 1000);
});

test("a 401 on a file token forces one refresh + retry", async () => {
  const credsPath = writeCreds(validCreds({ expiresAt: NOW + 600_000, accessToken: "at-stale", refreshToken: "rt-old" }));
  let usageCalls = 0;
  const fetchImpl = routedFetch({
    onToken: () => okResponse({ access_token: "at-fresh", refresh_token: "rt-new", expires_in: 28800 }),
    onUsage: (init) => {
      usageCalls += 1;
      if (init.headers.Authorization === "Bearer at-stale") return { ok: false, status: 401, json: async () => ({}) };
      return okResponse(LIVE_USAGE);
    },
  });
  const src = new ClaudeOAuthQuotaSource({ credentialsPath: credsPath, readEnvToken: () => null, fetchImpl, now: () => NOW });
  const snap = await src.queryCurrentUsage("claude-code/*");
  expect(snap.remaining_pct).toBe(0.9);
  expect(usageCalls).toBe(2); // stale 401, then retry with refreshed token
  expect(readCreds(credsPath).claudeAiOauth.accessToken).toBe("at-fresh");
});

test("a failed refresh grant degrades to null and leaves creds untouched", async () => {
  const credsPath = writeCreds(validCreds({ expiresAt: NOW - 1, accessToken: "at-old", refreshToken: "rt-old" }));
  const fetchImpl = routedFetch({
    onToken: () => ({ ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) }),
    onUsage: () => okResponse(LIVE_USAGE),
  });
  const src = new ClaudeOAuthQuotaSource({ credentialsPath: credsPath, readEnvToken: () => null, fetchImpl, now: () => NOW });
  expect(await src.queryCurrentUsage("claude-code/*")).toBe(null);
  // Original (expired) creds are NOT clobbered by a failed refresh.
  expect(readCreds(credsPath).claudeAiOauth.refreshToken).toBe("rt-old");
});

test("an expired token with no refresh token degrades without any network call", async () => {
  const fetchImpl = recordingFetch(okResponse(LIVE_USAGE));
  const src = new ClaudeOAuthQuotaSource({
    credentialsPath: writeCreds(validCreds({ expiresAt: NOW - 1 })),
    readEnvToken: () => null,
    fetchImpl,
    now: () => NOW,
  });
  expect(await src.queryCurrentUsage("claude-code/*")).toBe(null);
  expect(fetchImpl.calls.length).toBe(0);
});

test("AUDIT_TOOLS_DISABLE_PROACTIVE_QUOTA disables the source even with an injected fetch", async () => {
  const prev = process.env.AUDIT_TOOLS_DISABLE_PROACTIVE_QUOTA;
  process.env.AUDIT_TOOLS_DISABLE_PROACTIVE_QUOTA = "1";
  try {
    const fetchImpl = recordingFetch(okResponse(LIVE_USAGE));
    const src = new ClaudeOAuthQuotaSource({
      credentialsPath: writeCreds(validCreds()),
      fetchImpl,
      now: () => NOW,
    });
    expect(await src.queryCurrentUsage("claude-code/*")).toBe(null);
    expect(fetchImpl.calls.length).toBe(0);
  } finally {
    if (prev === undefined) delete process.env.AUDIT_TOOLS_DISABLE_PROACTIVE_QUOTA;
    else process.env.AUDIT_TOOLS_DISABLE_PROACTIVE_QUOTA = prev;
  }
});

// ── window metering scope ────────────────────────────────────────────────────
// These pin the three defects an independent review found in the scope-stamping
// change. Each drives the REAL seam (mapUsageToSnapshot), not a helper, because
// a helper-level assertion proves nothing about the path that builds windows.

test("window scope: a model-scoped limit whose display_name is EMPTY still scopes to the model", () => {
  // Regression: `display_name ?? id` returns "" for an empty display_name — falsy,
  // so the limit was stamped `account` and one model's allowance was applied to
  // every sibling on the credential. Must fall through to `id`.
  const snap = mapUsageToSnapshot(
    {
      five_hour: { utilization: 10, resets_at: null },
      limits: [
        {
          kind: "fable_cap",
          percent: 40,
          resets_at: null,
          scope: { model: { id: "claude-fable-5", display_name: "" } },
          is_active: true,
        },
      ],
    },
    "claude-fable-5",
    NOW,
  );
  const scoped = snap.windows.find((w) => w.label.endsWith("fable_cap"));
  expect(scoped).toBeDefined();
  expect(scoped.scope).toBe("model");
});

test("window scope: a model-scoped limit is NOT deduped away by an account window of the same name", () => {
  // Regression: `seen` was keyed on the bare label, so a model-scoped limit whose
  // group is "session" was swallowed by the top-level five_hour "session" window
  // — silently dropping that model's own constraint.
  const snap = mapUsageToSnapshot(
    {
      five_hour: { utilization: 10, resets_at: null },
      limits: [
        {
          kind: "session",
          percent: 80,
          resets_at: null,
          scope: { model: { id: null, display_name: "Sonnet" } },
          is_active: true,
        },
      ],
    },
    "claude-sonnet-5",
    NOW,
  );
  const account = snap.windows.filter((w) => w.scope === "account");
  const model = snap.windows.filter((w) => w.scope === "model");
  expect(account.map((w) => w.label)).toContain("session");
  expect(model).toHaveLength(1);
  // The label is emitted VERBATIM and is deliberately IDENTICAL to the account
  // window's ("session"). The scope, not a mangled label, is what distinguishes the
  // two — and it is what keeps them apart in the per-pool tokens_per_pct slope map,
  // which is keyed by `windowSlopeKey(scope, label)` ("account:session" vs
  // "model:session"). Encoding scope into the label itself would be defeatable by a
  // payload whose group already contains the delimiter.
  expect(model[0].label).toBe("session");
  expect(model[0].scope).toBe("model");
});

test("window scope: every window emitted by the real payload declares a scope", () => {
  const snap = mapUsageToSnapshot(LIVE_USAGE, "claude-sonnet-5", NOW);
  expect(snap.windows.length).toBeGreaterThan(0);
  for (const w of snap.windows) {
    expect(["account", "model"]).toContain(w.scope);
  }
});

test("window scope: a limit with scope.model PRESENT but unnameable is still model-scoped", () => {
  // Regression: scope was derived by extracting a model NAME, so a blank
  // display_name AND blank id collapsed to null and the limit was classified
  // `account` — applying one model's cap to every sibling on the credential.
  // Presence of `scope.model` is the discriminator; naming is a separate concern.
  const snap = mapUsageToSnapshot(
    {
      five_hour: { utilization: 10, resets_at: null },
      limits: [
        {
          kind: "opaque_cap",
          percent: 40,
          resets_at: null,
          scope: { model: { id: "", display_name: " " } },
          is_active: true,
        },
      ],
    },
    "claude-sonnet-5",
    NOW,
  );
  const scoped = snap.windows.find((w) => w.label === "opaque_cap");
  // It may or may not APPLY to this model (naming drives matching), but if it is
  // emitted at all it must never be stamped account-wide.
  if (scoped) expect(scoped.scope).toBe("model");
  expect(snap.windows.filter((w) => w.scope === "account").map((w) => w.label)).not.toContain("opaque_cap");
});
