import { canonicalStateFromLegacyFixture, writeApprovedPlanFixture } from "./helpers/canonicalPlanFixture.js";
import { recoverIngestHostResults } from "../../src/remediate/steps/recoverIngest.js";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupHostHandoffFixtures, cleanupRoots, git, fixture, boundState, persistBoundState, resultFor, writeResult, landA, landB, isAncestor, COUNTER_SCRIPT, COUNTER_TEST, COUNTER_SCRIPT_SOURCE, counterRuns, recoveryOptions, orphanBaselineAndLand, reopenGate } from "./helpers/hostHandoffCorroborationFixture.js";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { ingestRemediationHostResults, prepareRemediationHostHandoff } from "../../src/remediate/steps/dispatch/hostHandoff.js";
import { type CurrentRemediationHostState } from "../../src/remediate/steps/dispatch/hostContracts.js";

import { REMEDIATION_STATE_CONTRACT_VERSION } from "../../src/remediate/state/store.js";
import { readSubmissionLedger } from "audit-tools/shared";

afterEach(cleanupHostHandoffFixtures);

describe("remediation host handoff repository corroboration", () => {
  it("aborts when the WORKLOAD BINDING moves between the phases, though HEAD does not", async () => {
    // The sibling of the HEAD guard, and the window HEAD cannot see: a
    // concurrent state writer settles items and re-mints the binding without
    // touching a single commit. The phase-1 verdict table then describes a
    // frontier that no longer exists, and the mismatch would surface as a
    // spurious `required_test_failed` — a bookkeeping race reported as the
    // host's work being wrong.
    const value = await fixture({ requiredTest: COUNTER_TEST });
    const landed = await orphanBaselineAndLand(value);
    await writeResult(value, resultFor(value, landed));
    await persistBoundState(value);

    // The required test a host authored SETTLES THE ITEM — the real residual,
    // and the one no digest in the state tracks. The phase-1 verdict table was
    // keyed on B1 being pending; by the time the lock is taken it is not, so the
    // table describes a frontier that no longer exists. (`tree_moved_between_phases`
    // is asserted separately above; this run's HEAD is untouched, so only the
    // frontier half of the guard can catch it.)
    const settled = COUNTER_SCRIPT_SOURCE.replace(
      'appendFileSync(new URL("./.counter", import.meta.url), "x");',
      [
        'appendFileSync(new URL("./.counter", import.meta.url), "x");',
        'import { readFileSync, writeFileSync } from "node:fs";',
        "const p = new URL(",
        '  "./.audit-tools/remediation/state.json",',
        "  import.meta.url,",
        ");",
        'const s = JSON.parse(readFileSync(p, "utf8"));',
        's.items.B1.status = "resolved";',
        'writeFileSync(p, JSON.stringify(s, null, 2));',
      ].join("\n"),
    );
    await writeFile(join(value.root, COUNTER_SCRIPT), settled, "utf8");
    const headBefore = git(value.root, ["rev-parse", "HEAD"]);

    const summary = await recoverIngestHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
    });
    // HEAD is untouched, so this is not the tree guard firing.
    expect(git(value.root, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(summary.accepted_count).toBe(0);
    expect(summary.issues.map((issue) => issue.code)).toEqual([
      "state_moved_between_phases",
    ]);
    // The abort left the concurrent writer's own state alone.
    expect(summary.state_changed).toBe(false);
  });

  it("runs every required test before the lock and none inside it", async () => {
    // Two work items binding the same non-idempotent command: phase 1 runs it
    // once, phase 2 accepts both while spawning nothing.
    const value = await fixture({ twoBlocks: true, requiredTest: COUNTER_TEST });
    const landedA = await orphanBaselineAndLand(value);
    const landedB = await landB(value);
    await writeResult(value, resultFor(value, landedA));
    await writeResult(
      value,
      resultFor(value, landedB, value.workItems[1]!),
      value.workItems[1]!,
    );
    await persistBoundState(value);

    const summary = await recoverIngestHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
    });
    expect(summary.issues).toEqual([]);
    expect(summary.accepted_count).toBe(2);
    expect(await counterRuns(value.root)).toBe(1);
  });

  it("aborts when HEAD moves between the unlocked test phase and the locked write", async () => {
    // The required test itself moves HEAD, which is exactly the mixed-provenance
    // case the guard exists for: the verdict describes a tree that is already
    // gone by the time the lock is taken.
    const value = await fixture({
      requiredTest: 'git commit --allow-empty -m "moved by the required test"',
    });
    const landed = await orphanBaselineAndLand(value);
    await writeResult(value, resultFor(value, landed));
    await persistBoundState(value);

    const summary = await recoverIngestHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
    });
    expect(summary.accepted_count).toBe(0);
    expect(summary.state_changed).toBe(false);
    expect(summary.issues.map((issue) => issue.code)).toEqual([
      "tree_moved_between_phases",
    ]);
    expect(summary.state.items.B1!.status).toBe("pending");
    expect(await readSubmissionLedger(value.artifactsDir)).toEqual([]);
  });

  it("marks a re-accepted item again when the landed commit differs", async () => {
    const value = await fixture();
    const first = await orphanBaselineAndLand(value);
    await writeResult(value, resultFor(value, first));
    const accepted = await ingestRemediationHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
      state: boundState(value),
      recovery: await recoveryOptions(value),
    });
    expect(accepted).not.toBe("unsupported_retired_state");
    if (accepted === "unsupported_retired_state") return;
    expect(accepted.accepted_count).toBe(1);
    expect(await readSubmissionLedger(value.artifactsDir)).toHaveLength(1);

    // The item is re-opened and re-accepted from a DIFFERENT landing: a
    // different relaxed acceptance, so it earns its own record.
    await writeFile(join(value.root, "src", "a.ts"), "export const value = 3;\n");
    git(value.root, ["add", "src/a.ts"]);
    git(value.root, ["commit", "-m", "fix a again"]);
    const second = git(value.root, ["rev-parse", "HEAD"]);
    await writeResult(value, resultFor(value, second));
    const reaccepted = await ingestRemediationHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
      state: boundState(value),
      recovery: await recoveryOptions(value),
    });
    expect(reaccepted).not.toBe("unsupported_retired_state");
    if (reaccepted === "unsupported_retired_state") return;
    expect(reaccepted.accepted_count).toBe(1);
    const events = await readSubmissionLedger(value.artifactsDir);
    expect(events).toHaveLength(2);
    expect(events[0]!.message).toContain(first);
    expect(events[1]!.message).toContain(second);
  });

  it("keeps dependency eligibility enforced under recovery", async () => {
    const value = await fixture({ gateBlock: true });
    const landed = await orphanBaselineAndLand(value);
    await writeResult(value, resultFor(value, landed));

    const refused = await ingestRemediationHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
      state: reopenGate(value),
      recovery: await recoveryOptions(value, reopenGate(value)),
    });
    expect(refused).not.toBe("unsupported_retired_state");
    if (refused === "unsupported_retired_state") return;
    expect(refused.accepted_count).toBe(0);
    expect(refused.state.items.B1!.status).toBe("pending");
    expect(refused.issues.map((issue) => issue.code)).toEqual([
      "work_item_not_eligible",
    ]);
    expect(refused.issues[0]!.message).toContain(
      "no longer dependency/phase eligible",
    );
    const events = await readSubmissionLedger(value.artifactsDir);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      run_id: value.runId,
      submission_id: value.item.id,
      lane: value.item.id,
      kind: "rejected",
      issue_code: "work_item_not_eligible",
    });
  });

  // ── CORROBORATION FAILS CLOSED — both branches, so the skip cannot widen ──

  it("refuses attestation-only acceptance when neither a trusted binding nor a git repo exists", async () => {
    // The documented, bounded refusal: nothing to corroborate against, and no
    // trusted record claiming there was. This branch MUST refuse and is pinned
    // so it can never widen into accepting attestation-only evidence.
    const root = await mkdtemp(join(tmpdir(), "remediation-no-git-"));
    cleanupRoots.push(root);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "export const value = 1;\n");
    const artifactsDir = join(root, ".audit-tools", "remediation");
    const runId = "no-git-corroboration";
    const state = canonicalStateFromLegacyFixture({
      contract_version: REMEDIATION_STATE_CONTRACT_VERSION,
      status: "implementing",
      plan: {
        plan_id: runId,
        findings: [
          {
            id: "F1",
            title: "Correct the exported value",
            category: "correctness",
            severity: "high" as const,
            confidence: "high" as const,
            lens: "correctness",
            summary: "Change the exported value.",
            affected_files: [{ path: "src/a.ts" }],
            evidence: ["src/a.ts:1 returns the stale value"],
          },
        ],
        blocks: [
          {
            block_id: "B1",
            items: ["F1"],
            parallel_safe: true,
            dependencies: [],
            targeted_commands: ['node -e "process.exit(0)"'],
            touched_files: ["src/a.ts"],
            phase_ordinal: 0,
            token_estimate: 1_200,
          },
        ],
        project_type: "typescript",
        candidate_closing_actions: ["none"],
      },
      items: { F1: { finding_id: "F1", block_id: "B1", status: "pending" } },
    }) as CurrentRemediationHostState;
    await writeApprovedPlanFixture(artifactsDir, state, root);
    const prepared = await prepareRemediationHostHandoff({
      root,
      artifactsDir,
      runId,
      baselineCommit: "1".repeat(40),
      state,
    });
    if (prepared === "unsupported_retired_state") throw new Error("state rejected");
    const item = prepared.workload.work_items[0]!;
    const resultPath = resolve(root, item.result_path);
    await mkdir(dirname(resultPath), { recursive: true });
    await writeFile(
      resultPath,
      JSON.stringify(resultFor({ runId, item }, "2".repeat(40))),
      "utf8",
    );

    const ingested = await ingestRemediationHostResults({
      root,
      artifactsDir,
      runId,
      state,
    });
    if (ingested === "unsupported_retired_state") throw new Error("state rejected");
    // Must be refused: no git repo and no host_handoff binding means no corroboration possible
    expect(ingested.accepted_count).toBe(0);
    expect(ingested.issues.map((i) => i.code)).toContain("trusted_binding_missing");
    expect(ingested.state.items.B1!.status).toBe("pending");
  });

  it("refuses a git-backed workload with no trusted binding rather than accepting the claim", async () => {
    const value = await fixture();
    const after = await landA(value);
    await writeResult(value, resultFor(value, after));

    // Same fixture, same byte-correct submission — but the state carries no
    // host_handoff record. `isGitRepo(root)` is true, so the skip must NOT
    // apply and the ingest must refuse outright.
    const refused = await ingestRemediationHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
      state: value.state,
    });
    if (refused === "unsupported_retired_state") throw new Error("state rejected");
    expect(refused.accepted_count).toBe(0);
    expect(refused.issues.map((issue) => issue.code)).toEqual([
      "trusted_binding_missing",
    ]);
    expect(refused.state.items.B1!.status).toBe("pending");
  });

  it("keeps corroborating when a binding is present — 'unavailable' never means 'corroborated'", async () => {
    const value = await fixture();
    const after = await landA(value);
    // A real landing, then the object database is made unreadable to git by
    // claiming a commit that cannot resolve. Corroboration must still refuse
    // rather than fall through to the host's word.
    await writeResult(value, resultFor(value, "3".repeat(40)));
    const refused = await ingestRemediationHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
      state: boundState(value),
    });
    if (refused === "unsupported_retired_state") throw new Error("state rejected");
    expect(refused.accepted_count).toBe(0);
    // An UNRESOLVABLE commit is classified as commit_missing — the same code an
    // absent git binary produces, which is exactly why the failure mode warns a
    // caller to read a run-wide commit_missing as an environment signal.
    expect(refused.issues.map((issue) => issue.code)).toEqual(["commit_missing"]);
    expect(refused.state.items.B1!.status).toBe("pending");
    // The genuinely landed commit is still there; nothing about it was accepted.
    expect(isAncestor(value.root, after, "HEAD")).toBe(true);
  });
});
