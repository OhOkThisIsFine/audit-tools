// CE-201 — inv-8 sidecar-vs-git accept-outcome reconciliation (kill windows).
//
// The prescribed retry-window kill-variant, run on a REAL temp git repo:
//   1. attempt 1 verify-FAILS → acceptNodeWorktree persists (via
//      recordNodeAcceptOutcome) a merged:false sidecar carrying attempt-1's
//      quarantined committed_oid;
//   2. triage-retry → attempt 2 lands the cherry-pick, and the process "dies"
//      BETWEEN the pick and recordNodeAcceptOutcome (the record call is simply
//      skipped) — the sidecar on disk is now STALE (merged:false, but the
//      block's commit is base-reachable);
//   3. resume + force-close → the landed block's findings must NOT report
//      blocked, applied_edit_surface must include the landed commit's files,
//      and the stale sidecar is repaired to merged:true.
//
// Detection is DISAGREEMENT-keyed (all THREE durable records: base-reachable
// tool-owned commits, the sidecar's merged/committed_oid, and in-progress item
// statuses) — never keyed on sidecar absence alone: the window-1 sidecar here
// is PRESENT and stale. Invariant 9's force-close blocked mapping stays
// conditional on the reconciliation having run and found NO landed evidence —
// pinned by the sibling no-evidence negative control.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSyncHidden } from "../helpers/spawn.mjs";

import {
  acceptNodeWorktree,
  recordNodeAcceptOutcome,
  loadNodeAcceptOutcome,
} from "../../src/remediate/steps/dispatch/acceptNode.js";
import {
  createWorktree,
  resetNodeWorktreeAndBranch,
  worktreePath,
} from "../../src/remediate/steps/dispatch/worktreeLifecycle.js";
import { worktreeBranchForBlock } from "../../src/remediate/steps/dispatch/common.js";
import { runClosePhase } from "../../src/remediate/phases/close.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
import type { Finding } from "../../src/remediate/state/types.js";

const BASE = join(tmpdir(), "audit-tools-tests", ".cp-node-1-kill-window");
const ROOT = join(BASE, "repo");
const ARTIFACTS = join(ROOT, ".audit-tools", "remediation");
const RUN_ID = "RUN-KILL";

function git(cwd: string, ...args: string[]): string {
  const r = spawnSyncHidden("git", args, { cwd, encoding: "utf8", shell: false });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr ?? r.error?.message}`);
  }
  return (r.stdout ?? "").toString().trim();
}

function mkFinding(id: string, path: string): Finding {
  return {
    id,
    title: `Finding ${id}`,
    category: "correctness",
    severity: "high",
    confidence: "high",
    lens: "correctness",
    summary: `Fix ${id}.`,
    affected_files: [{ path }],
    evidence: [`${path}:1 evidence`],
  } as Finding;
}

/** Drive one worker attempt for a block: edit the file in the node's worktree,
 * then run the shared accept lifecycle with an injected pass/fail verify. */
async function runAttempt(args: {
  blockId: string;
  fileRel: string;
  content: string;
  verifyPasses: boolean;
}): Promise<Awaited<ReturnType<typeof acceptNodeWorktree>>> {
  const branch = worktreeBranchForBlock(args.blockId, RUN_ID);
  const wt = worktreePath(ROOT, args.blockId, RUN_ID);
  resetNodeWorktreeAndBranch(ROOT, wt, branch);
  createWorktree(ROOT, wt, branch);
  await writeFile(join(wt, args.fileRel), args.content, "utf8");
  return acceptNodeWorktree({
    root: ROOT,
    runId: RUN_ID,
    blockId: args.blockId,
    worktreeRoot: wt,
    branch,
    workerOutcome: "success",
    targetedCommands: args.verifyPasses ? [] : ['node -e "process.exit(1)"'],
    scope: { allBlockScopes: [] },
    writePaths: [args.fileRel],
    mergedBaseCheckCommand: null,
    mergedGuardCommand: null,
  });
}

function killWindowState(): RemediationState {
  return {
    status: "closing",
    plan: {
      plan_id: RUN_ID,
      findings: [mkFinding("KF-1", "target.txt"), mkFinding("KF-2", "other.txt")],
      blocks: [
        {
          block_id: "KB-1",
          items: ["KF-1"],
          parallel_safe: true,
          touched_files: ["target.txt"],
        },
        {
          block_id: "KB-2",
          items: ["KF-2"],
          parallel_safe: true,
          touched_files: ["other.txt"],
        },
      ],
      project_type: "unknown",
      candidate_closing_actions: ["none"],
    },
    items: {
      // The landed block's item was killed mid-flight (in-progress at resume).
      "KF-1": { finding_id: "KF-1", status: "pending", block_id: "KB-1" },
      // Sibling negative control: NO landed evidence, genuinely blocked.
      "KF-2": {
        finding_id: "KF-2",
        status: "blocked",
        block_id: "KB-2",
        failure_reason: "worker failed",
      },
    },
    closing_plan: { action: "none" },
  } as RemediationState;
}

beforeAll(async () => {
  await rm(BASE, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });
  git(ROOT, "init", "-b", "main");
  git(ROOT, "config", "user.email", "test@example.com");
  git(ROOT, "config", "user.name", "test");
  await writeFile(join(ROOT, ".gitignore"), ".audit-tools/\n", "utf8");
  await writeFile(join(ROOT, "target.txt"), "base\n", "utf8");
  await writeFile(join(ROOT, "other.txt"), "base\n", "utf8");
  git(ROOT, "add", "-A");
  git(ROOT, "commit", "-m", "base");
  await mkdir(ARTIFACTS, { recursive: true });
});

afterAll(async () => {
  await rm(BASE, { recursive: true, force: true });
});

describe("CE-201 retry-window kill-variant (window 1: killed between cherry-pick and record)", () => {
  it("NEGATIVE→POSITIVE: a landed block with a stale merged:false sidecar force-closes resolved, never blocked", async () => {
    // ── Attempt 1: verify fails; the tool records a merged:false sidecar. ────
    const a1 = await runAttempt({
      blockId: "KB-1",
      fileRel: "target.txt",
      content: "attempt-1 fix\n",
      verifyPasses: false,
    });
    expect(a1.merged).toBe(false);
    expect(a1.verifyPassed).toBe(false);
    // INV-WTS-7: the node DID commit — the failure return must carry its
    // committed branch-tip OID so the sidecar records it (CE-201's
    // merged:false-sidecar-with-committed_oid premise).
    expect(a1.committedOid).toBeTruthy();
    await recordNodeAcceptOutcome(ARTIFACTS, RUN_ID, "KB-1", a1);
    const sidecar1 = await loadNodeAcceptOutcome(ARTIFACTS, RUN_ID, "KB-1");
    expect(sidecar1?.merged).toBe(false);
    expect(sidecar1?.committedOid).toBeTruthy();

    // ── Attempt 2 (triage retry): lands, then the process dies BEFORE the
    //    record call — the stale merged:false sidecar stays on disk. ─────────
    const a2 = await runAttempt({
      blockId: "KB-1",
      fileRel: "target.txt",
      content: "attempt-2 fix\n",
      verifyPasses: true,
    });
    expect(a2.merged).toBe(true);
    // (recordNodeAcceptOutcome deliberately NOT called — the kill window.)
    const staleSidecar = await loadNodeAcceptOutcome(ARTIFACTS, RUN_ID, "KB-1");
    expect(staleSidecar?.merged).toBe(false); // present AND stale — not absent

    // ── Resume + force-close. ───────────────────────────────────────────────
    const closed = await runClosePhase(killWindowState(), {
      root: ROOT,
      artifactsDir: ARTIFACTS,
    });

    // F-KILL: the landed block's finding must NOT report blocked.
    const outcomesRaw = await readFile(
      join(ROOT, ".audit-tools", "remediation-outcomes.json"),
      "utf8",
    );
    const outcomes = JSON.parse(outcomesRaw) as {
      outcomes: Array<{ finding_id: string; outcome: string }>;
    };
    const kf1 = outcomes.outcomes.find((o) => o.finding_id === "KF-1");
    expect(kf1?.outcome).toBe("resolved");
    expect(closed.items?.["KF-1"]?.status).toBe("resolved");

    // applied_edit_surface includes the landed commit's files.
    expect(closed.applied_edit_surface ?? []).toContain("target.txt");

    // The stale sidecar was repaired to merged:true (artifacts preserved
    // because the sibling KF-2 is blocked — the CE-003 not-fully-green path).
    const repaired = await loadNodeAcceptOutcome(ARTIFACTS, RUN_ID, "KB-1");
    expect(repaired?.merged).toBe(true);

    // Invariant-9 precondition (negative control): the sibling block with NO
    // landed evidence still force-closes blocked.
    const kf2 = outcomes.outcomes.find((o) => o.finding_id === "KF-2");
    expect(kf2?.outcome).toBe("blocked");
    expect(closed.items?.["KF-2"]?.status).toBe("blocked");

    // And the landed fix is really in the main tree (ground truth). Normalize
    // line endings — git autocrlf may rewrite LF→CRLF on the checkout.
    expect(
      (await readFile(join(ROOT, "target.txt"), "utf8")).replace(/\r\n/g, "\n"),
    ).toBe("attempt-2 fix\n");
  });
});

describe("CE-201 window 2 (killed between record and state merge) + no-evidence control", () => {
  it("NEGATIVE→POSITIVE: reconcileAcceptOutcomes resolves in-progress items of a merged:true sidecar", async () => {
    const rec = (await import(
      "../../src/remediate/steps/dispatch/acceptReconcile.js"
    )) as Record<string, unknown>;
    expect(typeof rec.reconcileAcceptOutcomes).toBe("function");
    const reconcile = rec.reconcileAcceptOutcomes as (args: {
      root: string;
      artifactsDir: string;
      state: RemediationState;
    }) => Promise<{ changed: boolean }>;

    // Land KB-3 fully and record its merged:true sidecar (the record ran)…
    const a = await runAttempt({
      blockId: "KB-3",
      fileRel: "other.txt",
      content: "window-2 fix\n",
      verifyPasses: true,
    });
    expect(a.merged).toBe(true);
    await recordNodeAcceptOutcome(ARTIFACTS, RUN_ID, "KB-3", a);

    // …but the process died before the state merge: the item is in-progress.
    const state: RemediationState = {
      status: "closing",
      plan: {
        plan_id: RUN_ID,
        findings: [mkFinding("KF-3", "other.txt"), mkFinding("KF-4", "nowhere.txt")],
        blocks: [
          {
            block_id: "KB-3",
            items: ["KF-3"],
            parallel_safe: true,
            touched_files: ["other.txt"],
          },
          {
            block_id: "KB-4",
            items: ["KF-4"],
            parallel_safe: true,
            touched_files: ["nowhere.txt"],
          },
        ],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
      },
      items: {
        "KF-3": { finding_id: "KF-3", status: "pending", block_id: "KB-3" },
        // No-evidence control: never dispatched, no sidecar, no commit.
        "KF-4": { finding_id: "KF-4", status: "pending", block_id: "KB-4" },
      },
      closing_plan: { action: "none" },
    } as RemediationState;

    const result = await reconcile({ root: ROOT, artifactsDir: ARTIFACTS, state });
    expect(result.changed).toBe(true);
    // Window 2: sidecar merged:true + in-progress item ⇒ reconciled resolved.
    expect(state.items?.["KF-3"]?.status).toBe("resolved");
    expect(state.applied_edit_surface ?? []).toContain("other.txt");
    // No landed evidence ⇒ untouched (invariant 9's blocked mapping may apply).
    expect(state.items?.["KF-4"]?.status).toBe("pending");
  });
});
