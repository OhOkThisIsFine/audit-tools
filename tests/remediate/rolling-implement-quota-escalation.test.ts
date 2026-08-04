// Remediate-side parity for the M-QUOTA bounded-escalation chain:
//   recordLimit → escalate → strand → `quota_escalation` friction.
//
// The shared engine half (recordLimit → escalate → early strand) is pinned in
// tests/shared/rollingDispatch.test.mjs with NO friction assertion, and the
// AUDIT driver's full chain through to the written `friction/<runId>.json`
// record is pinned in tests/audit/rolling-audit-dispatch.test.mjs §5. Nothing
// under tests/remediate asserted the remediate driver's half, so a deletion of
// `driveRollingImplementDispatch`'s `onEscalation` block was green here.
//
// This pins the REMEDIATE glue: the retained `HostSessionQuotaSource` built for
// the drive is fed by each node dispatch's `rate_limited` evidence via
// `recordRateLimit`, `isPacketEscalated` strands the node once the bound is
// crossed, and the driver's `onEscalation` routes a `quota_escalation` fact to
// the single step-boundary friction chokepoint.

import { afterAll, describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawnSyncHidden } from "../helpers/spawn.mjs";
import { driveRollingImplementDispatch } from "../../src/remediate/steps/nextStep.js";
import { StateStore } from "../../src/remediate/state/store.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
import { frictionCapturePath } from "audit-tools/shared";
import type { CapacityPool, ProviderSlot } from "audit-tools/shared";
import type { RemediationBlock } from "../../src/remediate/state/types.js";

const RM_DIRS: string[] = [];
afterAll(() => {
  for (const dir of RM_DIRS) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows file-lock stragglers are harmless temp litter. */
    }
  }
});

const git = (repo: string, ...a: string[]) =>
  spawnSyncHidden("git", a, { cwd: repo, encoding: "utf8", shell: false, windowsHide: true });

function initRepo(prefix: string): string {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  RM_DIRS.push(repo);
  git(repo, "init");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "fx", private: true, scripts: { check: "node --version" } }, null, 2) + "\n",
  );
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n.audit-tools/\n");
  git(repo, "add", "package.json", ".gitignore");
  git(repo, "commit", "-m", "base");
  return repo;
}

/**
 * A SINGLE pending node. The host-session re-limit tracker is per-packet, so an
 * interleaved sibling would reset the consecutive count before the bound is
 * reached and nothing would ever escalate.
 */
function buildSingleNodeState(): RemediationState {
  const block: RemediationBlock = {
    block_id: "B-001",
    items: ["F-001"],
    parallel_safe: true,
    dependencies: [],
    touched_files: [],
  };
  return {
    status: "implementing",
    plan: {
      plan_id: "PLAN-QESC",
      findings: [
        {
          id: "F-001",
          title: "Create alpha.mjs",
          category: "correctness",
          severity: "low",
          confidence: "high",
          lens: "correctness",
          summary: "Create alpha.mjs.",
          affected_files: [{ path: "alpha.mjs" }],
          evidence: ["alpha.mjs:1"],
        },
      ],
      blocks: [block],
      project_type: "unknown",
      candidate_closing_actions: ["none"],
    },
    items: {
      "F-001": {
        finding_id: "F-001",
        status: "pending",
        block_id: "B-001",
        item_spec: {
          finding_id: "F-001",
          concrete_change: "Create alpha.mjs containing exactly: export const alpha = 1;",
          no_change: false,
          touched_files: ["alpha.mjs"],
          tests_to_write: [],
          not_applicable_steps: [],
        },
      },
    },
    closing_plan: { action: "none" },
  } as unknown as RemediationState;
}

const backendPool = (id: string): CapacityPool =>
  ({
    id,
    accountKey: id,
    providerName: "openai-compatible",
    hostModel: null,
    hostConcurrencyLimit: null,
    contextCapTokens: 200_000,
  }) as unknown as CapacityPool;

/**
 * The friction capture is fire-and-forget (`void captureStepBoundaryFriction`),
 * so the record can land a tick after the drive resolves. Poll for it rather
 * than reading once — bounded, so an absent capture still fails fast.
 */
async function readEscalationFriction(
  artifactsDir: string,
  runId: string,
): Promise<{ id: string; severity?: string; area?: string } | undefined> {
  const path = frictionCapturePath(artifactsDir, runId);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const record = JSON.parse(await readFile(path, "utf8")) as {
        frictions?: Array<{ id: string; severity?: string; area?: string }>;
      };
      const hit = record.frictions?.find((f) => f.id.startsWith("quota_escalation:"));
      if (hit) return hit;
    } catch {
      /* Not written yet. */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return undefined;
}

describe("driveRollingImplementDispatch — M-QUOTA bounded escalation (parity with audit §5)", () => {
  it(
    "a same-packet account wall escalates across pools and captures a quota_escalation friction",
    async () => {
      const repo = initRepo("rm-quota-esc-");
      const artifactsDir = join(repo, ".audit-tools", "remediation");
      const runId = "RUN-QUOTA-ESC";
      await new StateStore(artifactsDir).saveState(buildSingleNodeState());

      // Four pools that ALL rate-limit the node with a parseable host-session
      // limit string. The default bound is 3 consecutive same-packet re-limits,
      // so the 4th pool's re-limit (count 4 > 3) escalates — before pool
      // exhaustion would have stranded it anyway.
      const pools = ["nim/pa", "nim/pb", "nim/pc", "nim/pd"].map(backendPool);
      const LIMIT_TEXT = "session limit reached. Resets in 1h";
      const attemptedPools = new Set<string>();

      const driven = await driveRollingImplementDispatch({
        root: repo,
        artifactsDir,
        runId,
        sessionConfig: null,
        dispatchNode: async (args: { block: RemediationBlock; slot: ProviderSlot }) => {
          attemptedPools.add(args.slot.poolId);
          return {
            packet: {
              id: args.block.block_id,
              payload: { block_id: args.block.block_id },
              estimatedTokens: 1,
              complexity: 0.5,
            },
            outcome: "rate_limited" as const,
            rateLimit: { channel: "error" as const, text: LIMIT_TEXT },
          };
        },
        rebuildSharedBetweenLevels: async () => {},
        blocksOverride: ["B-001"],
        poolsOverride: pools,
      });

      // Early strand on the escalation guard: the same node re-limited on every
      // pool, and the 4th crossed the bound.
      // The SAME node re-limited on every pool, so the bound accrued rather than
      // being reset by an interleaved sibling.
      expect(attemptedPools.size).toBe(4);
      expect(driven?.nodes.every((n) => n.block_id === "B-001" && n.outcome === "rate_limited")).toBe(true);
      // It stranded (never completed) and the run surfaces the retryable wall.
      expect(driven?.terminal?.stranded_ids).toContain("B-001");
      expect(driven?.terminal?.reason).toBe("quota_paused");

      // The remediate driver routed the escalation to the friction chokepoint.
      const escalation = await readEscalationFriction(artifactsDir, runId);
      expect(escalation, "a quota_escalation friction is captured for the remediate run").toBeTruthy();
      expect(escalation?.severity).toBe("high");
      expect(escalation?.area).toBe("dispatch/quota");
    },
    180_000,
  );
});
