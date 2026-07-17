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
