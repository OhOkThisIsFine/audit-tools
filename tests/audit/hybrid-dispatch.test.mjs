/**
 * A-8 hybrid dispatch split — audit driver (FINDING-020 capstone).
 *
 * The audit split bounds the in-process backend (NIM) partition to its capacity and
 * claims each task through the SAME shared coordinator + ClaimRegistry remediate
 * drives — so the spill topology cannot drift between the two tools. Everything the
 * coordinator does not claim is left pending for the batch host review (coverage
 * folds the in-process results in by task_id). Asserts:
 *
 *  - the NIM partition is claimed (exactly-one-claimant) and capacity-bounded;
 *  - a quotaSignalDegraded NIM pool still gets a floored slot (safe degrade);
 *  - the in-process provider classification (host / IDE backends are NOT in-process).
 */

import { test, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { ClaimRegistry } = await import("../../src/shared/quota/claimRegistry.ts");
const { isInProcessAuditPool } = await import("../../src/audit/cli/hybridDispatch.ts");
const { planHybridDispatch } = await import("../../src/shared/dispatch/hybridDispatch.ts");

const SESSION = { quota: { unknown_hosted_concurrency: 8 } };

function tasks(count, tokens = 1000) {
  return Array.from({ length: count }, (_, i) => ({ id: `task-${i}`, estimatedTokens: tokens }));
}

function snapshot(pct) {
  return {
    remaining_pct: pct,
    reset_at: null,
    requests_remaining: null,
    tokens_remaining: null,
    captured_at: new Date(0).toISOString(),
    source: "test",
  };
}

function nimPool(over = {}) {
  return {
    id: "pool/nim",
    providerName: "openai-compatible",
    hostModel: null,
    hostConcurrencyLimit: null,
    quotaSourceSnapshot: snapshot(0.95),
    ...over,
  };
}

function settledStore() {
  const set = new Set();
  return { readSettled: () => set, onSettle: (p) => set.add(p), set };
}

test("audit hybrid: a claude-worker pool is an in-process pool and receives partition work", async () => {
  // Live dogfood 2026-07-16: the claude-worker lane shipped confirmable (Gate-0 fold,
  // backend-keyed pools, launch transport) but UNDRIVABLE — isInProcessAuditPool did
  // not classify `claude-worker`, so the hybrid split assigned the free lanes nothing
  // and all 313 packets fell to the walled host pool (zero dispatched).
  expect(isInProcessAuditPool({ providerName: "claude-worker" })).toBe(true);
  const dir = mkdtempSync(join(tmpdir(), "audit-hyb-cw-"));
  try {
    const registry = new ClaimRegistry(join(dir, "claims.json"));
    const store = settledStore();
    const part = await planHybridDispatch({
      isInProcess: isInProcessAuditPool,
      frontier: tasks(6),
      pools: [nimPool({ id: "nim/z-ai/glm-5.2", providerName: "claude-worker" })],
      sessionConfig: SESSION,
      claimRegistry: registry,
      readSettled: store.readSettled,
      onSettle: store.onSettle,
    });
    expect(part.inProcess.length > 0).toBeTruthy();
    expect(part.inProcess.every((a) => a.providerName === "claude-worker")).toBeTruthy();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("audit hybrid: the NIM partition is claimed + capacity-bounded; all on the NIM pool", async () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-hyb-"));
  try {
    const registry = new ClaimRegistry(join(dir, "claims.json"));
    const store = settledStore();
    const part = await planHybridDispatch({
      isInProcess: isInProcessAuditPool,
      frontier: tasks(12),
      pools: [nimPool()],
      sessionConfig: SESSION,
      claimRegistry: registry,
      readSettled: store.readSettled,
      onSettle: store.onSettle,
    });
    expect(part.inProcess.length > 0).toBeTruthy();
    // Bounded to the pool's capacity (NOT the whole 12-task frontier).
    expect(part.inProcess.length < 12).toBeTruthy();
    expect(part.inProcess.every((a) => a.providerName === "openai-compatible")).toBeTruthy();
    expect(part.inProcess.every((a) => typeof a.ownerToken === "string" && a.ownerToken.length > 0)).toBeTruthy();
    // Every returned task is actually claimed in the shared registry.
    const claims = await registry.listClaims();
    expect(Object.keys(claims).length).toBe(part.inProcess.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("audit hybrid: a quotaSignalDegraded NIM pool still gets a floored slot (safe degrade)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-hyb2-"));
  try {
    const registry = new ClaimRegistry(join(dir, "claims.json"));
    const store = settledStore();
    const part = await planHybridDispatch({
      isInProcess: isInProcessAuditPool,
      frontier: tasks(3, 500),
      pools: [nimPool({ quotaSignalDegraded: true, quotaSourceSnapshot: null })],
      sessionConfig: SESSION,
      claimRegistry: registry,
      readSettled: store.readSettled,
      onSettle: store.onSettle,
    });
    expect(part.inProcess.length >= 1).toBeTruthy();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("audit hybrid: in-process provider classification (host / IDE / worker-command are NOT in-process)", () => {
  expect(isInProcessAuditPool({ providerName: "openai-compatible" })).toBe(true);
  expect(isInProcessAuditPool({ providerName: "codex" })).toBe(true);
  expect(isInProcessAuditPool({ providerName: "opencode" })).toBe(true);
  expect(isInProcessAuditPool({ providerName: "claude-code" })).toBe(false);
  expect(isInProcessAuditPool({ providerName: "vscode-task" })).toBe(false);
  // Excluded for audit (it IS audit's conventional host-dispatch default).
  expect(isInProcessAuditPool({ providerName: "worker-command" })).toBe(false);
});

// Per-pool packet-fit gate (U2, 2026-07-17 gap-fix lap): fit is enforced inside the
// coordinator's claim walk — a node is never CLAIMED to a pool whose declared
// contextCapTokens (plus agentic-harness overhead) it exceeds. RED on pre-fix HEAD:
// the old linear-cursor walk claimed largest-first onto whichever pool had slots,
// so the oversized node landed on the capped pool and 413'd at dispatch.
test("audit hybrid: an oversized node is never claimed to a capped pool — it lands on the cap-less pool", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hybrid-fit-"));
  try {
    const registry = new ClaimRegistry(join(dir, "claims.json"));
    const store = settledStore();
    const capped = nimPool({
      id: "pool/groq",
      contextCapTokens: 30_000,
      quotaSourceSnapshot: snapshot(0.95),
    });
    const capless = nimPool({ id: "pool/host", providerName: "claude-code" });
    // 20k tokens + 15k harness overhead = 35k > groq's 30k cap → must not claim to groq.
    const big = [{ id: "task-big", estimatedTokens: 20_000 }];
    const { inProcess, host, coordinator } = await planHybridDispatch({
      frontier: big,
      pools: [capped, capless],
      sessionConfig: SESSION,
      claimRegistry: registry,
      readSettled: store.readSettled,
      onSettle: store.onSettle,
      isInProcess: isInProcessAuditPool,
    });
    const all = [...inProcess, ...host];
    expect(all.length).toBe(1);
    expect(all[0].poolId).toBe("pool/host");
    for (const a of all) await coordinator.release(a);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("audit hybrid: a small node still claims to the capped pool (fit gate does not over-filter)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hybrid-fit-small-"));
  try {
    const registry = new ClaimRegistry(join(dir, "claims.json"));
    const store = settledStore();
    const capped = nimPool({ id: "pool/groq", contextCapTokens: 30_000 });
    const small = [{ id: "task-small", estimatedTokens: 1_000 }];
    const { inProcess, host, coordinator } = await planHybridDispatch({
      frontier: small,
      pools: [capped],
      sessionConfig: SESSION,
      claimRegistry: registry,
      readSettled: store.readSettled,
      onSettle: store.onSettle,
      isInProcess: isInProcessAuditPool,
    });
    const all = [...inProcess, ...host];
    expect(all.length).toBe(1);
    expect(all[0].poolId).toBe("pool/groq");
    for (const a of all) await coordinator.release(a);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("audit hybrid: a node that fits NO active pool is left unclaimed (re-offered), never mis-claimed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hybrid-fit-none-"));
  try {
    const registry = new ClaimRegistry(join(dir, "claims.json"));
    const store = settledStore();
    const cappedA = nimPool({ id: "pool/groq", contextCapTokens: 20_000 });
    const cappedB = nimPool({ id: "pool/nim-small", contextCapTokens: 25_000 });
    const big = [{ id: "task-huge", estimatedTokens: 50_000 }];
    const { inProcess, host } = await planHybridDispatch({
      frontier: big,
      pools: [cappedA, cappedB],
      sessionConfig: SESSION,
      claimRegistry: registry,
      readSettled: store.readSettled,
      onSettle: store.onSettle,
      isInProcess: isInProcessAuditPool,
    });
    expect(inProcess.length).toBe(0);
    expect(host.length).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── H2+H4 collapse: the unconditional primary fold + D1 dedup on the audit draw ──

const { buildAuditSourcePools } = await import("../../src/audit/cli/hybridDispatch.ts");

test("audit pool assembly: an agy primary ALWAYS folds in as a source pool (D4 — red on HEAD twice over)", async () => {
  // HEAD: agy was absent from the demotable set AND primaryInProcessSource had no
  // agy arm — an attended agy run had no pool at all. Now the fold is unconditional.
  const { pools } = await buildAuditSourcePools({
    provider: "agy",
    agy: { command: "agy", model: "gemini-3-pro" },
  });
  const agyPool = pools.find((p) => p.providerName === "agy");
  expect(agyPool).toBeTruthy();
  expect(agyPool.source?.transport).toBe("agy");
  expect(isInProcessAuditPool(agyPool)).toBe(true);
});

test("audit pool assembly: a codex primary folds with NO demote flag; the option is gone", async () => {
  const { pools } = await buildAuditSourcePools({
    provider: "codex",
    codex: { command: "codex", model: "gpt-5" },
  });
  expect(pools.filter((p) => p.providerName === "codex").length).toBe(1);
});

test("audit pool assembly (D1/D6): an attended host identity colliding with the in-process primary keeps the SOURCE pool", async () => {
  // Audit's host is never a member pool (D6) — same-agent collision degenerates to
  // "the engine/source pool survives" so the engine drives that single account.
  const { pools } = await buildAuditSourcePools(
    { provider: "codex", codex: { command: "codex", model: "gpt-5" } },
    { attendedHostProviderName: "codex" },
  );
  expect(pools.filter((p) => p.providerName === "codex").length).toBe(1);
});

test("audit pool assembly: audit's policy excludes a command-shaped primary (no fold, no pool)", async () => {
  const { pools } = await buildAuditSourcePools({
    provider: "worker-command",
  });
  expect(pools).toEqual([]);
});
