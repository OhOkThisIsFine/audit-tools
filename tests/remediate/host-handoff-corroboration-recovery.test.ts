import { recoverIngestHostResults } from "../../src/remediate/steps/recoverIngest.js";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupHostHandoffFixtures, cleanupRoots, git, fixture, boundState, persistBoundState, resultFor, writeResult, landA, landB, refsContaining, isAncestor, COUNTER_TEST, counterRuns, recoveryOptions, orphanBaselineAndLand } from "./helpers/hostHandoffCorroborationFixture.js";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ingestRemediationHostResults } from "../../src/remediate/steps/dispatch/hostHandoff.js";
import { type CurrentRemediationHostState } from "../../src/remediate/steps/dispatch/hostContracts.js";

import { REMEDIATION_STATE_CONTRACT_VERSION } from "../../src/remediate/state/store.js";
import { readSubmissionLedger } from "audit-tools/shared";

afterEach(cleanupHostHandoffFixtures);

describe("remediation host handoff repository corroboration", () => {
  it("refuses an orphaned trusted baseline on the normal lane and accepts it only under the explicit recovery verb", async () => {
    const value = await fixture();
    const landed = await orphanBaselineAndLand(value);
    await writeResult(value, resultFor(value, landed));

    const normal = await ingestRemediationHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
      state: boundState(value),
    });
    expect(normal).not.toBe("unsupported_retired_state");
    if (normal === "unsupported_retired_state") return;
    // A TRULY orphaned baseline is a fault in the run, not the work: its own
    // code, naming the recovery verb as the repair.
    expect(normal.issues.map((issue) => issue.code)).toEqual([
      "baseline_orphaned",
    ]);
    expect(normal.issues[0]!.check).toBe("landed_commit");
    expect(normal.issues[0]!.message).toContain("recover-ingest");
    expect(normal.accepted_count).toBe(0);
    expect(normal.state.items.B1!.status).toBe("pending");

    const recovered = await ingestRemediationHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
      state: boundState(value),
      recovery: await recoveryOptions(value),
    });
    expect(recovered).not.toBe("unsupported_retired_state");
    if (recovered === "unsupported_retired_state") return;
    expect(recovered.issues).toEqual([]);
    expect(recovered.accepted_count).toBe(1);
    expect(recovered.state.items.B1!.status).toBe("resolved");
    expect(recovered.state.applied_edit_surface).toEqual(["src/a.ts"]);

    // No acceptance without a record: the relaxation is marked on the ledger,
    // so a run repaired this way stays distinguishable from a clean one.
    const events = await readSubmissionLedger(value.artifactsDir);
    expect(events.map((event) => event.kind)).toEqual([
      "rejected",
      "accepted_via_recovery",
    ]);
    expect(events[1]).toMatchObject({
      run_id: value.runId,
      submission_id: value.item.id,
      kind: "accepted_via_recovery",
    });
    expect(events[1]!.message).toContain(value.baseline);
    expect(events[1]!.message).toContain(landed);
  });

  it("refuses recovery when the trusted baseline is still reachable from HEAD", async () => {
    const value = await fixture({
      beforePrepare: async (root) => {
        // Branch the future sibling off the root commit, then advance the
        // baseline, so the trusted baseline is a healthy non-root ancestor.
        git(root, ["branch", "sibling"]);
        await writeFile(join(root, "src", "b.ts"), "export const other = 2;\n");
        git(root, ["add", "src/b.ts"]);
        git(root, ["commit", "-m", "advance the baseline"]);
      },
    });
    const trunk = git(value.root, ["rev-parse", "--abbrev-ref", "HEAD"]);
    git(value.root, ["checkout", "sibling"]);
    const sibling = await landA(value);
    git(value.root, ["checkout", trunk]);
    git(value.root, ["merge", "--no-ff", "-m", "merge sibling", "sibling"]);
    await writeResult(value, resultFor(value, sibling));

    // The baseline IS an ancestor of HEAD, so the stale-worker protection is
    // live and recovery must refuse exactly like the normal lane.
    const refused = await ingestRemediationHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
      state: boundState(value),
      recovery: await recoveryOptions(value),
    });
    expect(refused).not.toBe("unsupported_retired_state");
    if (refused === "unsupported_retired_state") return;
    expect(refused.accepted_count).toBe(0);
    expect(refused.state.items.B1!.status).toBe("pending");
    expect(refused.issues.map((issue) => issue.code)).toEqual([
      "baseline_not_ancestor",
    ]);
    expect(refused.issues[0]!.message).toContain("NOT orphaned");
    const events = await readSubmissionLedger(value.artifactsDir);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      run_id: value.runId,
      submission_id: value.item.id,
      lane: value.item.id,
      kind: "rejected",
      issue_code: "baseline_not_ancestor",
    });
  });

  it("refuses recovery when the orphaned-looking baseline is a linked worktree's HEAD", async () => {
    // The THIRD source of reachability, and the one git does not enumerate as a
    // ref: a linked worktree parked (detached) exactly on the trusted baseline.
    // `git worktree add --detach` writes no branch, and this repository's own
    // HEAD has moved on, so `for-each-ref --contains` and the HEAD-ancestry
    // probe BOTH read "orphaned" — while the repository is in fact keeping that
    // commit alive as another worktree's checkout, which is exactly the state a
    // parallel remediation lane sits in. Without the worktree probe the
    // relaxation is handed out and the stale-worker protection is waived for a
    // commit the repository never let go of.
    const value = await fixture();
    const sibling = await mkdtemp(join(tmpdir(), "remediation-linked-worktree-"));
    cleanupRoots.push(sibling);
    git(value.root, ["worktree", "add", "--detach", sibling, value.baseline]);

    const landed = await orphanBaselineAndLand(value);
    // Precondition, so the refusal below can only be the worktree arm firing:
    // the baseline really is invisible to BOTH of the original probes, and the
    // sibling worktree is the only thing left holding it.
    expect(refsContaining(value.root, value.baseline)).toBe("");
    expect(isAncestor(value.root, value.baseline, "HEAD")).toBe(false);
    expect(git(sibling, ["rev-parse", "HEAD"])).toBe(value.baseline);
    await writeResult(value, resultFor(value, landed));

    const refused = await ingestRemediationHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
      state: boundState(value),
      recovery: await recoveryOptions(value),
    });
    expect(refused).not.toBe("unsupported_retired_state");
    if (refused === "unsupported_retired_state") return;
    expect(refused.accepted_count).toBe(0);
    expect(refused.state.items.B1!.status).toBe("pending");
    expect(refused.issues.map((issue) => issue.code)).toEqual([
      "baseline_not_ancestor",
    ]);
    expect(refused.issues[0]!.message).toContain("NOT orphaned");

    // CONTROL: the identical fixture with the sibling worktree GONE is genuinely
    // orphaned, and recovery accepts it. The two runs differ only in whether a
    // worktree HEAD kept the commit — so the refusal above is that arm, not this
    // fixture being unacceptable for some unrelated reason.
    const control = await fixture();
    const controlSibling = await mkdtemp(
      join(tmpdir(), "remediation-linked-worktree-"),
    );
    cleanupRoots.push(controlSibling);
    git(control.root, [
      "worktree",
      "add",
      "--detach",
      controlSibling,
      control.baseline,
    ]);
    git(control.root, ["worktree", "remove", "--force", controlSibling]);
    const controlLanded = await orphanBaselineAndLand(control);
    expect(refsContaining(control.root, control.baseline)).toBe("");
    await writeResult(control, resultFor(control, controlLanded));

    const accepted = await ingestRemediationHostResults({
      root: control.root,
      artifactsDir: control.artifactsDir,
      runId: control.runId,
      state: boundState(control),
      recovery: await recoveryOptions(control),
    });
    expect(accepted).not.toBe("unsupported_retired_state");
    if (accepted === "unsupported_retired_state") return;
    expect(accepted.issues).toEqual([]);
    expect(accepted.accepted_count).toBe(1);
  });

  it("refuses a recovery acceptance whose ledger mark cannot be recorded", async () => {
    const value = await fixture();
    const landed = await orphanBaselineAndLand(value);
    await writeResult(value, resultFor(value, landed));
    // Occupy the ledger's own directory with a FILE, so the append cannot land.
    await mkdir(value.artifactsDir, { recursive: true });
    await writeFile(
      join(value.artifactsDir, "submissions"),
      "not a directory",
      "utf8",
    );

    const unrecorded = await ingestRemediationHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
      state: boundState(value),
      recovery: await recoveryOptions(value),
    });
    expect(unrecorded).not.toBe("unsupported_retired_state");
    if (unrecorded === "unsupported_retired_state") return;
    expect(unrecorded.accepted_count).toBe(0);
    expect(unrecorded.state.items.B1!.status).toBe("pending");
    expect(unrecorded.issues.map((issue) => issue.code)).toEqual([
      "recovery_unrecorded",
    ]);
  });

  it("refuses recovery when a live ref still contains the baseline, though HEAD does not", async () => {
    // The baseline sits on an unmerged `feature` branch and the work landed on
    // trunk. Ancestry fails exactly as it does for a rewritten-away baseline —
    // but the repository still KEEPS this one, so it is the ordinary
    // stale-worker case, not an orphan, and recovery must refuse it.
    const value = await fixture({
      beforePrepare: async (root) => {
        git(root, ["checkout", "-b", "feature"]);
        await writeFile(join(root, "src", "b.ts"), "export const other = 2;\n");
        git(root, ["add", "src/b.ts"]);
        git(root, ["commit", "-m", "advance the feature branch"]);
      },
    });
    git(value.root, ["checkout", "-"]);
    const landed = await landA(value);
    await writeResult(value, resultFor(value, landed));

    // The precondition the guard must detect: unreachable from HEAD, yet held
    // by a live ref.
    expect(isAncestor(value.root, value.baseline, "HEAD")).toBe(false);
    expect(refsContaining(value.root, value.baseline)).toContain(
      "refs/heads/feature",
    );

    const refused = await ingestRemediationHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
      state: boundState(value),
      recovery: await recoveryOptions(value),
    });
    expect(refused).not.toBe("unsupported_retired_state");
    if (refused === "unsupported_retired_state") return;
    expect(refused.accepted_count).toBe(0);
    expect(refused.state.items.B1!.status).toBe("pending");
    expect(refused.issues.map((issue) => issue.code)).toEqual([
      "baseline_not_ancestor",
    ]);
    expect(refused.issues[0]!.message).toContain("NOT orphaned");
    const events = await readSubmissionLedger(value.artifactsDir);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      run_id: value.runId,
      submission_id: value.item.id,
      lane: value.item.id,
      kind: "rejected",
      issue_code: "baseline_not_ancestor",
    });
  });

  it("reruns a shared required test per work item on the normal lane, and once per call under recovery", async () => {
    // A targeted_command need not be idempotent, so collapsing spawns is
    // observable. The normal lane must keep spawning per work item; only
    // recovery — where one operator call may corroborate a dozen items binding
    // the same command — memoizes.
    const normal = await fixture({ twoBlocks: true, requiredTest: COUNTER_TEST });
    const normalA = await landA(normal);
    const normalB = await landB(normal);
    await writeResult(normal, resultFor(normal, normalA));
    await writeResult(
      normal,
      resultFor(normal, normalB, normal.workItems[1]!),
      normal.workItems[1]!,
    );
    const ingested = await ingestRemediationHostResults({
      root: normal.root,
      artifactsDir: normal.artifactsDir,
      runId: normal.runId,
      state: boundState(normal),
    });
    expect(ingested).not.toBe("unsupported_retired_state");
    if (ingested === "unsupported_retired_state") return;
    expect(ingested.issues).toEqual([]);
    expect(ingested.accepted_count).toBe(2);
    expect(await counterRuns(normal.root)).toBe(2);

    const recovery = await fixture({
      twoBlocks: true,
      requiredTest: COUNTER_TEST,
    });
    const recoveryA = await orphanBaselineAndLand(recovery);
    const recoveryB = await landB(recovery);
    await writeResult(recovery, resultFor(recovery, recoveryA));
    await writeResult(
      recovery,
      resultFor(recovery, recoveryB, recovery.workItems[1]!),
      recovery.workItems[1]!,
    );
    const recovered = await ingestRemediationHostResults({
      root: recovery.root,
      artifactsDir: recovery.artifactsDir,
      runId: recovery.runId,
      state: boundState(recovery),
      recovery: await recoveryOptions(recovery),
    });
    expect(recovered).not.toBe("unsupported_retired_state");
    if (recovered === "unsupported_retired_state") return;
    expect(recovered.issues).toEqual([]);
    expect(recovered.accepted_count).toBe(2);
    expect(await counterRuns(recovery.root)).toBe(1);
    // Both acceptances are marked, once each.
    expect(
      (await readSubmissionLedger(recovery.artifactsDir)).map(
        (event) => event.submission_id,
      ),
    ).toEqual(["B1", "B2"]);
  });

  it("does not append a second ledger mark when a recovery acceptance is retried", async () => {
    const value = await fixture();
    const landed = await orphanBaselineAndLand(value);
    await writeResult(value, resultFor(value, landed));
    const ingest = async () =>
      ingestRemediationHostResults({
        root: value.root,
        artifactsDir: value.artifactsDir,
        runId: value.runId,
        state: boundState(value),
        recovery: await recoveryOptions(value),
      });

    const first = await ingest();
    expect(first).not.toBe("unsupported_retired_state");
    if (first === "unsupported_retired_state") return;
    expect(first.accepted_count).toBe(1);
    // The retry a crash between the append and the state write would force:
    // the item is still pending, the mark is already on the ledger.
    const retried = await ingest();
    expect(retried).not.toBe("unsupported_retired_state");
    if (retried === "unsupported_retired_state") return;
    expect(retried.accepted_count).toBe(1);
    expect(await readSubmissionLedger(value.artifactsDir)).toHaveLength(1);
  });

  it("recovers through the exported entry point the CLI wraps", async () => {
    const value = await fixture();
    const landed = await orphanBaselineAndLand(value);
    await writeResult(value, resultFor(value, landed));
    const statePath = join(value.artifactsDir, "state.json");
    await persistBoundState(value);

    const summary = await recoverIngestHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
    });
    expect(summary.accepted_count).toBe(1);
    expect(summary.state_changed).toBe(true);
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as Record<
      string,
      unknown
    > & { items: Record<string, { status: string }> };
    // The version DOES reach the persisted state — the store stamps it on every
    // write, and the version it stamps is the store's own declaration rather
    // than the boundary view's. (It used to be peeled off here because
    // `currentHostBoundaryState` supplied it and nothing on disk carried it; the
    // store now owns the field, so peeling would persist a state whose identity
    // the next read has to re-invent.)
    expect(persisted.contract_version).toBe(REMEDIATION_STATE_CONTRACT_VERSION);
    expect(persisted.items.B1!.status).toBe("resolved");

    const afterFirst = await readFile(statePath, "utf8");
    const again = await recoverIngestHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
    });
    expect(again.accepted_count).toBe(0);
    expect(again.state_changed).toBe(false);
    expect(await readFile(statePath, "utf8")).toBe(afterFirst);
  });

  it("refuses a hand-built verdict table that no runner produced", async () => {
    // The table's TYPE says "verdicts"; it cannot say "verdicts from actually
    // running the tests". A caller that constructs `new Map()` — or any plain
    // object cast to the type — can assert green for everything without
    // spawning anything, and the ingest would read that as evidence. The guard
    // is a runtime brand only `precomputeRecoveryTestVerdicts` can mint, and it
    // fires before any ledger append, git probe, or acceptance.
    //
    // A green table is asserted here on purpose: the fail-closed property is not
    // "the fabricated table is refused because it is empty", it is "a fabricated
    // table is refused whatever it says".
    const value = await fixture();
    const landed = await orphanBaselineAndLand(value);
    await writeResult(value, resultFor(value, landed));
    const command = value.item.required_tests[0]!;
    const fabricated = new Map([[`${String(value.root.length)}:${value.root}:${command}`, null]]);

    await expect(
      ingestRemediationHostResults({
        root: value.root,
        artifactsDir: value.artifactsDir,
        runId: value.runId,
        state: boundState(value),
        recovery: { requiredTestVerdicts: fabricated },
      }),
    ).rejects.toThrow(/precomputeRecoveryTestVerdicts/u);

    // Nothing was accepted and nothing was recorded on the ledger.
    expect(await readSubmissionLedger(value.artifactsDir)).toEqual([]);
  });

  it("accepts the table the minter produces — the brand does not refuse the real thing", async () => {
    // CONTROL for the guard above: the same shape, minted by the real
    // precompute, must still pass. Without this the brand check could be
    // vacuously green by refusing every recovery ingest.
    const value = await fixture({ requiredTest: COUNTER_TEST });
    const landed = await orphanBaselineAndLand(value);
    await writeResult(value, resultFor(value, landed));

    const recovery = await recoveryOptions(value);
    const accepted = await ingestRemediationHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
      state: boundState(value),
      recovery,
    });
    if (accepted === "unsupported_retired_state") throw new Error("state rejected");
    expect(accepted.issues).toEqual([]);
    expect(accepted.accepted_count).toBe(1);
  });

  it("refuses a caller-supplied verdict table before it can spawn anything", async () => {
    // The locked phase must not spawn: it reads the phase-1 verdict table and
    // nothing else. An EMPTY table therefore refuses every item WITHOUT running
    // the (deliberately observable) command.
    const value = await fixture({ requiredTest: COUNTER_TEST });
    const landed = await orphanBaselineAndLand(value);
    await writeResult(value, resultFor(value, landed));

    // A real, MINTED table that happens to be empty: the item's finding is not
    // pending in the state the minter scoped to, so no command entered it. Every
    // command is therefore absent, and the ingest fails closed rather than
    // spawning. (A bare `new Map()` would be refused up front instead — it is
    // not the minter's brand — which is a DIFFERENT refusal; this test is about
    // the fail-closed READ path, not the brand guard.)
    //
    // The minter is scoped by a state in which F1 is already settled, while the
    // INGEST reads the ordinary pending state — so the table is legitimately
    // empty for the item the ingest then corroborates.
    const scoped = {
      ...boundState(value),
      items: {
        ...boundState(value).items,
        B1: { ...boundState(value).items.B1!, status: "resolved" },
      },
    } as CurrentRemediationHostState;
    const refused = await ingestRemediationHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
      state: boundState(value),
      recovery: await recoveryOptions(value, scoped),
    });
    expect(refused).not.toBe("unsupported_retired_state");
    if (refused === "unsupported_retired_state") return;
    expect(refused.accepted_count).toBe(0);
    expect(refused.issues.map((issue) => issue.code)).toEqual([
      "required_test_failed",
    ]);
    expect(refused.issues[0]!.message).toContain("refusing to spawn");
    expect(await counterRuns(value.root)).toBe(0);
    const events = await readSubmissionLedger(value.artifactsDir);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      run_id: value.runId,
      submission_id: value.item.id,
      lane: value.item.id,
      kind: "rejected",
      issue_code: "required_test_failed",
    });
  });
});
