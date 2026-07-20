/**
 * Cross-class host-vs-source pool dedup (H2+H4 collapse, plan D1) —
 * `dedupHostAndSourcePools` is the ONE shared collision rule both draws apply when
 * assembling the eligible pool set. Red on HEAD: the function did not exist (the
 * retired B1 same-agent guard suppressed the fold instead; with the fold now
 * unconditional, the collision must be resolved at pool-assembly time).
 *
 * D1 survivor rule: on a provider+account identity collision the SOURCE/engine pool
 * survives when its provider is an in-process worker (the engine drives that single
 * account — self-drive for attended provider=codex=host, no double-booking); the
 * HOST pool survives otherwise.
 */

import { test, expect } from "vitest";

const { dedupHostAndSourcePools } = await import("../../src/shared/quota/apiPool.ts");

/** Minimal CapacityPool shape for the dedup (id + providerName are the identity). */
function pool(id, providerName, source) {
  return {
    id,
    providerName,
    hostModel: null,
    hostConcurrencyLimit: null,
    ...(source ? { source } : {}),
  };
}

test("D1 collision (host IS the primary backend): the SOURCE/engine pool survives, ONE pool total", () => {
  const host = pool("codex#acctA/gpt-5", "codex");
  const source = pool("codex#acctA/gpt-5", "codex", { transport: "codex" });
  const out = dedupHostAndSourcePools({ hostPools: [host], sourcePools: [source] });
  // Self-drive preserved: the surviving pool is the SOURCE pool (engine-launchable —
  // it carries its `source`), and the host pool is gone (nothing to double-book).
  expect(out.hostPools).toEqual([]);
  expect(out.sourcePools.length).toBe(1);
  expect(out.sourcePools[0].source).toBeTruthy();
});

test("D1 collision is provider+account, not model-granular (roster model vs source model)", () => {
  // The host roster spells a model the folded source does not — same provider, same
  // account ⇒ still ONE meter ⇒ still a collision.
  const host = pool("codex#acctA/gpt-5-codex", "codex");
  const source = pool("codex#acctA/*", "codex", { transport: "codex" });
  const out = dedupHostAndSourcePools({ hostPools: [host], sourcePools: [source] });
  expect(out.hostPools).toEqual([]);
  expect(out.sourcePools.length).toBe(1);
});

test("no collision across DIFFERENT accounts: both pools survive (a second-account source is a real extra pool)", () => {
  const host = pool("codex#acctA/gpt-5", "codex");
  const source = pool("codex#acctB/gpt-5", "codex", { transport: "codex", account: "acctB" });
  const out = dedupHostAndSourcePools({ hostPools: [host], sourcePools: [source] });
  expect(out.hostPools.length).toBe(1);
  expect(out.sourcePools.length).toBe(1);
});

test("an UNRESOLVED account degrades to provider-name collision (the retired guard's compare)", () => {
  const host = pool("codex/gpt-5", "codex");
  const source = pool("codex/*", "codex", { transport: "codex" });
  const out = dedupHostAndSourcePools({ hostPools: [host], sourcePools: [source] });
  expect(out.hostPools).toEqual([]);
  expect(out.sourcePools.length).toBe(1);
});

test("no collision at all: different providers pass through untouched (host + backend + NIM fan-out)", () => {
  const host = pool("claude-code#orgA/opus", "claude-code");
  const codex = pool("codex/gpt-5", "codex", { transport: "codex" });
  const nim = pool("openai-compatible/m", "openai-compatible", { transport: "openai-compatible" });
  const out = dedupHostAndSourcePools({ hostPools: [host], sourcePools: [codex, nim] });
  expect(out.hostPools.length).toBe(1);
  expect(out.sourcePools.length).toBe(2);
});

test("HOST survives against a colliding NON-in-process source (the 'otherwise' arm)", () => {
  // A source whose transport is host-shaped (not an engine-drivable worker) colliding
  // with the host identity: the host pool survives, the source drops.
  const host = pool("claude-code#orgA/opus", "claude-code");
  const weird = pool("claude-code#orgA/opus", "claude-code", { transport: "claude-code" });
  const out = dedupHostAndSourcePools({ hostPools: [host], sourcePools: [weird] });
  expect(out.hostPools.length).toBe(1);
  expect(out.sourcePools).toEqual([]);
});

test("audit shape (host is NOT a member pool): hostProviderName drops only a colliding non-in-process source", () => {
  const codex = pool("codex/gpt-5", "codex", { transport: "codex" });
  const hostShaped = pool("claude-code/opus", "claude-code", { transport: "claude-code" });
  const out = dedupHostAndSourcePools({
    hostPools: [],
    sourcePools: [codex, hostShaped],
    hostProviderName: "claude-code",
  });
  // The in-process codex source is untouched; the host-shaped collider drops.
  expect(out.sourcePools.map((p) => p.providerName)).toEqual(["codex"]);
  expect(out.hostPools).toEqual([]);
});

test("audit shape, same-agent (host==codex): the in-process source SURVIVES (engine drives that account)", () => {
  const codex = pool("codex/gpt-5", "codex", { transport: "codex" });
  const out = dedupHostAndSourcePools({
    hostPools: [],
    sourcePools: [codex],
    hostProviderName: "codex",
  });
  expect(out.sourcePools.length).toBe(1);
});

test("no host identity at all (headless): pass-through", () => {
  const codex = pool("codex/gpt-5", "codex", { transport: "codex" });
  const out = dedupHostAndSourcePools({ hostPools: [], sourcePools: [codex] });
  expect(out.sourcePools.length).toBe(1);
});

test("MIXED accounts (h2c3 F3): an unresolved HOST account is never surrendered to a source declared on a DIFFERENT account", () => {
  // Host credential is dark (account unresolved); the operator declared a source on
  // an explicit second account. Colliding here would silently drop the attended
  // host's own dispatch lane — the fail-closed-on-one-draw class.
  const host = pool("codex/gpt-5", "codex");
  const source = pool("codex#acctB/gpt-5", "codex", { transport: "codex", account: "acctB" });
  const out = dedupHostAndSourcePools({ hostPools: [host], sourcePools: [source] });
  expect(out.hostPools.length).toBe(1);
  expect(out.sourcePools.length).toBe(1);
});

test("ACCOUNTLESS source still collides on provider alone (the synthesized primary fold shares the host credential)", () => {
  const host = pool("codex#acctA/gpt-5", "codex");
  const source = pool("codex/*", "codex", { transport: "codex" });
  const out = dedupHostAndSourcePools({ hostPools: [host], sourcePools: [source] });
  expect(out.hostPools).toEqual([]);
  expect(out.sourcePools.length).toBe(1);
});

test("BACKEND identity outranks transport (h2c3 F5): a proxied lane onto the host's own backend collides", () => {
  // A claude-worker lane fronting the host's own backend+account double-books that
  // meter even though its transport providerName differs from the host's.
  const host = pool("claude-code#orgA/opus", "claude-code");
  const proxied = pool("claude-code#orgA/opus", "claude-worker", {
    transport: "claude-worker",
    service: "claude-code",
  });
  const out = dedupHostAndSourcePools({ hostPools: [host], sourcePools: [proxied] });
  // claude-worker is an in-process worker: the engine lane survives, host drops.
  expect(out.hostPools).toEqual([]);
  expect(out.sourcePools.length).toBe(1);
});

test("survivor rule follows the DRAW's worker policy (h2c3 F9): a command-shaped collider survives only under commandWorkers", () => {
  const host = pool("worker-command/x", "worker-command");
  const cmd = pool("worker-command/x", "worker-command", { transport: "worker-command" });
  const remediate = dedupHostAndSourcePools({
    hostPools: [host],
    sourcePools: [cmd],
    commandWorkers: true,
  });
  expect(remediate.hostPools).toEqual([]);
  expect(remediate.sourcePools.length).toBe(1);
  const audit = dedupHostAndSourcePools({ hostPools: [host], sourcePools: [cmd] });
  expect(audit.hostPools.length).toBe(1);
  expect(audit.sourcePools).toEqual([]);
});
