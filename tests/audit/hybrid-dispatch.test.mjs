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

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { ClaimRegistry } = await import("../../src/shared/quota/claimRegistry.ts");
const { planAuditHybridDispatch, isInProcessAuditPool } = await import(
  "../../src/audit/cli/hybridDispatch.ts"
);

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

test("audit hybrid: the NIM partition is claimed + capacity-bounded; all on the NIM pool", async () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-hyb-"));
  try {
    const registry = new ClaimRegistry(join(dir, "claims.json"));
    const store = settledStore();
    const part = await planAuditHybridDispatch({
      frontier: tasks(12),
      nimPools: [nimPool()],
      sessionConfig: SESSION,
      claimRegistry: registry,
      readSettled: store.readSettled,
      onSettle: store.onSettle,
    });
    assert.ok(part.inProcess.length > 0);
    // Bounded to the pool's capacity (NOT the whole 12-task frontier).
    assert.ok(part.inProcess.length < 12);
    assert.ok(part.inProcess.every((a) => a.providerName === "openai-compatible"));
    assert.ok(part.inProcess.every((a) => typeof a.ownerToken === "string" && a.ownerToken.length > 0));
    // Every returned task is actually claimed in the shared registry.
    const claims = await registry.listClaims();
    assert.equal(Object.keys(claims).length, part.inProcess.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("audit hybrid: a quotaSignalDegraded NIM pool still gets a floored slot (safe degrade)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-hyb2-"));
  try {
    const registry = new ClaimRegistry(join(dir, "claims.json"));
    const store = settledStore();
    const part = await planAuditHybridDispatch({
      frontier: tasks(3, 500),
      nimPools: [nimPool({ quotaSignalDegraded: true, quotaSourceSnapshot: null })],
      sessionConfig: SESSION,
      claimRegistry: registry,
      readSettled: store.readSettled,
      onSettle: store.onSettle,
    });
    assert.ok(part.inProcess.length >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("audit hybrid: in-process provider classification (host / IDE / local-subprocess are NOT in-process)", () => {
  assert.equal(isInProcessAuditPool({ providerName: "openai-compatible" }), true);
  assert.equal(isInProcessAuditPool({ providerName: "codex" }), true);
  assert.equal(isInProcessAuditPool({ providerName: "opencode" }), true);
  assert.equal(isInProcessAuditPool({ providerName: "claude-code" }), false);
  assert.equal(isInProcessAuditPool({ providerName: "vscode-task" }), false);
  // Excluded for audit (it IS audit's conventional host-dispatch default).
  assert.equal(isInProcessAuditPool({ providerName: "local-subprocess" }), false);
});
