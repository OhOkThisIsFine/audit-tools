import { afterEach, describe, expect, it } from "vitest";
import { cleanupHostHandoffFixtures, git, fixture, boundState, resultFor, decisionFor, expectWriteScopeRefusal, writeResult, landA, landB } from "./helpers/hostHandoffCorroborationFixture.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { ingestRemediationHostResults } from "../../src/remediate/steps/dispatch/hostHandoff.js";
import { type RemediationHostWorkItem } from "../../src/remediate/steps/dispatch/hostContracts.js";


afterEach(cleanupHostHandoffFixtures);

describe("remediation host handoff repository corroboration", () => {
  it("rejects a landed commit that changes files outside allowed_files, and files dirty at run start", async () => {
    // v1alpha3: no host-reported file list exists to disagree with git, so the
    // mismatch property is the git-derived change set against the bound scope.
    const mismatch = await fixture({ allowedFiles: ["src/b.ts"] });
    const after = await landA(mismatch);
    await writeResult(mismatch, resultFor(mismatch, after));
    const mismatched = await ingestRemediationHostResults({
      root: mismatch.root,
      artifactsDir: mismatch.artifactsDir,
      runId: mismatch.runId,
      state: boundState(mismatch),
    });
    expect(mismatched).not.toBe("unsupported_retired_state");
    if (mismatched === "unsupported_retired_state") return;
    expect(mismatched.accepted_count).toBe(0);
    expectWriteScopeRefusal(mismatched.issues, "src/a.ts");

    const dirty = await fixture({ runStartDirty: ["src/a.ts"] });
    const dirtyAfter = await landA(dirty);
    await writeResult(dirty, resultFor(dirty, dirtyAfter));
    const dirtyRejected = await ingestRemediationHostResults({
      root: dirty.root,
      artifactsDir: dirty.artifactsDir,
      runId: dirty.runId,
      state: boundState(dirty),
    });
    expect(dirtyRejected).not.toBe("unsupported_retired_state");
    if (dirtyRejected === "unsupported_retired_state") return;
    expect(dirtyRejected.issues.map((issue) => issue.code)).toContain(
      "run_start_dirty_overlap",
    );
    expect(
      dirtyRejected.issues.find((issue) => issue.code === "run_start_dirty_overlap")!.check,
    ).toBe("run_start_dirt");
  });

  it("reruns required tests and reports malformed result JSON explicitly", async () => {
    const failing = await fixture({
      requiredTest: 'node -e "process.exit(1)"',
    });
    const after = await landA(failing);
    await writeResult(failing, resultFor(failing, after));
    const failed = await ingestRemediationHostResults({
      root: failing.root,
      artifactsDir: failing.artifactsDir,
      runId: failing.runId,
      state: boundState(failing),
    });
    expect(failed).not.toBe("unsupported_retired_state");
    if (failed === "unsupported_retired_state") return;
    expect(failed.issues.map((issue) => issue.code)).toContain(
      "required_test_failed",
    );
    expect(
      failed.issues.find((issue) => issue.code === "required_test_failed")!.check,
    ).toBe("required_tests");
    expect(failed.state.items.B1!.status).toBe("pending");

    const malformed = await fixture();
    const path = resolve(malformed.root, malformed.item.result_path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{not json", "utf8");
    const diagnosed = await ingestRemediationHostResults({
      root: malformed.root,
      artifactsDir: malformed.artifactsDir,
      runId: malformed.runId,
      state: boundState(malformed),
    });
    expect(diagnosed).not.toBe("unsupported_retired_state");
    if (diagnosed === "unsupported_retired_state") return;
    expect(diagnosed.issues.map((issue) => issue.code)).toContain(
      "submission_malformed",
    );
  });

  it("refuses a resolved_no_change whose write scope the tree shows as CHANGED", async () => {
    // A no-change decision used to be accepted on its evidence STRINGS alone,
    // with only the required tests re-run. So a host that edited inside its own
    // write scope and then declared "nothing to do" was recorded as
    // verified-no-change and the edit rode in unattributed. The claim is
    // mechanically falsifiable against the tree, so it must be FALSIFIED.
    const contradicted = await fixture({ allowedFiles: ["src/"] });
    // The host really did land a change to its own allowed file, then claimed
    // it had changed nothing.
    await landA(contradicted);
    await writeResult(
      contradicted,
      decisionFor(contradicted, {
        status: "resolved_no_change",
        evidence: ["Claimed the existing code already satisfied the contract."],
      }),
    );
    const refused = await ingestRemediationHostResults({
      root: contradicted.root,
      artifactsDir: contradicted.artifactsDir,
      runId: contradicted.runId,
      state: boundState(contradicted),
    });
    expect(refused).not.toBe("unsupported_retired_state");
    if (refused === "unsupported_retired_state") return;
    expect(refused.accepted_count).toBe(0);
    expect(refused.issues.map((issue) => issue.code)).toContain(
      "changed_files_mismatch",
    );
    expect(refused.issues.map((issue) => issue.message).join("\n")).not.toContain(
      "outside prompt-bound allowed_files",
    );
    // The item stays PENDING: an unaccepted claim must not settle the finding.
    expect(refused.state.items.B1!.status).toBe("pending");
  });

  it("refuses a resolved_no_change contradicted by an UNCOMMITTED edit", async () => {
    // The second half of the enumeration. A host that edits and commits is
    // caught by baseline→HEAD; a host that edits and leaves the change in the
    // working tree is caught by HEAD→worktree. Without the second probe the
    // cheapest way to smuggle an edit past the claim is simply not to commit it.
    const uncommitted = await fixture();
    await writeFile(
      join(uncommitted.root, "src", "a.ts"),
      "export const value = 2;\n",
    );
    await writeResult(
      uncommitted,
      decisionFor(uncommitted, {
        status: "resolved_no_change",
        evidence: ["Claimed the existing code already satisfied the contract."],
      }),
    );
    const refused = await ingestRemediationHostResults({
      root: uncommitted.root,
      artifactsDir: uncommitted.artifactsDir,
      runId: uncommitted.runId,
      state: boundState(uncommitted),
    });
    expect(refused).not.toBe("unsupported_retired_state");
    if (refused === "unsupported_retired_state") return;
    expect(refused.accepted_count).toBe(0);
    expect(refused.issues.map((issue) => issue.code)).toContain(
      "changed_files_mismatch",
    );
    expect(refused.state.items.B1!.status).toBe("pending");
  });

  it("refuses a resolved_no_change contradicted by a NEW UNTRACKED file", async () => {
    // The third way a host can have edited, and the one the tracked-only probe
    // could not see: CREATING a file. A new `src/new.ts` is a real edit — and
    // the most natural shape a remediation takes — so a claim of "nothing to
    // do" beside one is false. Without the `ls-files --others` leg the cheapest
    // way to smuggle an edit past the claim was simply never to `git add` it.
    //
    // The old justification for omitting untracked files was that the tool's
    // own `.audit-tools` documents would refuse every claim ever made. They do
    // not: the tool writes a managed `.gitignore` block covering that tree, so
    // `--exclude-standard` never reports it, and the probe subtracts the
    // directory explicitly besides. Pre-existing strays are excused by
    // `run_start_dirty`, which is captured from `stagedAndUntracked` and so
    // already enumerates untracked files. What is left is exactly this: a file
    // that appeared DURING the run.
    const created = await fixture();
    await writeFile(
      join(created.root, "src", "new.ts"),
      "export const added = 1;\n",
    );
    await writeResult(
      created,
      decisionFor(created, {
        status: "resolved_no_change",
        evidence: ["Claimed the existing code already satisfied the contract."],
      }),
    );
    const refused = await ingestRemediationHostResults({
      root: created.root,
      artifactsDir: created.artifactsDir,
      runId: created.runId,
      state: boundState(created),
    });
    expect(refused).not.toBe("unsupported_retired_state");
    if (refused === "unsupported_retired_state") return;
    expect(refused.accepted_count).toBe(0);
    expect(refused.issues.map((issue) => issue.code)).toContain(
      "changed_files_mismatch",
    );
    // The created file is NAMED, and named as out-of-scope: `src/new.ts` is in
    // nobody's `allowed_files`.
    expect(refused.issues.map((issue) => issue.message).join("\n")).toContain(
      "src/new.ts",
    );
    expect(refused.state.items.B1!.status).toBe("pending");
  });

  it("accepts a resolved_no_change whose only untracked files are the tool's own artifacts", async () => {
    // The other half, and the one that keeps the leg from becoming a check that
    // always fires: an honest no-change claim in a repo where the ONLY
    // untracked paths are this tool's own workload/prompt/result documents
    // under `.audit-tools/` must still be accepted. The fixture root carries no
    // `.gitignore` at all, so this pins the explicit subtraction rather than
    // git's ignore rules doing the work.
    const honest = await fixture();
    expect(
      git(honest.root, ["ls-files", "--others", "--exclude-standard"]),
    ).toContain(".audit-tools/");
    await writeResult(
      honest,
      decisionFor(honest, {
        status: "resolved_no_change",
        evidence: ["The existing code already satisfies the contract."],
      }),
    );
    const accepted = await ingestRemediationHostResults({
      root: honest.root,
      artifactsDir: honest.artifactsDir,
      runId: honest.runId,
      state: boundState(honest),
    });
    expect(accepted).not.toBe("unsupported_retired_state");
    if (accepted === "unsupported_retired_state") return;
    expect(accepted.issues).toEqual([]);
    expect(accepted.accepted_count).toBe(1);
  });

  it("refuses a resolved_no_change whose tree shows changes OUTSIDE allowed_files", async () => {
    // The out-of-scope half, and the one a narrowed check inverts. For a LANDED
    // result `corroborateHostResult` refuses a commit that touched anything
    // outside the prompt-bound `allowed_files` — that is the more serious
    // violation, not the lesser one. A no-change corroboration that only asked
    // about files INSIDE `allowed_files` would therefore be the exact INVERSE
    // of the rule it claims to share: the in-scope edit refused, the
    // out-of-scope edit waved through. Both halves refuse.
    const outOfScope = await fixture();
    // `src/b.ts` is nobody's write scope in this workload — the item is bound
    // to `src/a.ts` alone.
    expect(outOfScope.item.allowed_files).toEqual(["src/a.ts"]);
    const landed = await landB(outOfScope);
    expect(landed).toBeTruthy();
    await writeResult(
      outOfScope,
      decisionFor(outOfScope, {
        status: "resolved_no_change",
        evidence: ["Claimed the existing code already satisfied the contract."],
      }),
    );
    const refused = await ingestRemediationHostResults({
      root: outOfScope.root,
      artifactsDir: outOfScope.artifactsDir,
      runId: outOfScope.runId,
      state: boundState(outOfScope),
    });
    expect(refused).not.toBe("unsupported_retired_state");
    if (refused === "unsupported_retired_state") return;
    expect(refused.accepted_count).toBe(0);
    expect(refused.issues.map((issue) => issue.code)).toContain(
      "changed_files_mismatch",
    );
    // Named in the refusal as out-of-scope, so the operator is not left to
    // guess which half of the rule fired.
    expect(
      refused.issues.map((issue) => issue.message).join("\n"),
    ).toContain("src/b.ts");
    expect(refused.state.items.B1!.status).toBe("pending");
  });

  it("excuses a SIBLING's landing accepted earlier in the SAME ingest from a no-change claim", async () => {
    // The intra-ingest half of the excuse, and the one the code comment at the
    // `excusedPaths` site promises: `landedFiles` starts from
    // `applied_edit_surface` and GROWS as this same ingest accepts. Without the
    // growth half, an honest no-change item is falsified by a sibling item's
    // legitimately landed commit — the tree really has moved since the
    // baseline, and the mover was this same run.
    //
    // This is a CHARACTERIZATION test for the hostHandoff decomposition: the
    // set of accepted files is created before the per-item loop, READ by the
    // no-change branch, and WRITTEN by the landed branch, so it is an
    // accumulator with intra-loop feedback. Any split that defers the accepted
    // set to a post-loop phase flips this case from accepted to refused, and
    // every other test in this file stays green while it does.
    const shared = await fixture({ twoBlocks: true });
    // Iteration order is the guarantee under test: the landing must be accepted
    // BEFORE the no-change claim is corroborated, or there is nothing to excuse.
    expect(shared.workItems.map((entry) => entry.id)).toEqual(["B1", "B2"]);
    const [landing, noChange] = shared.workItems as [
      RemediationHostWorkItem,
      RemediationHostWorkItem,
    ];
    // The two write scopes are disjoint, so the landed file is OUT of the
    // no-change item's scope — the strictest half of the falsification rule.
    expect(landing.allowed_files).toEqual(["src/a.ts"]);
    expect(noChange.allowed_files).toEqual(["src/b.ts"]);

    const after = await landA(shared);
    await writeResult(shared, resultFor(shared, after, landing), landing);
    await writeResult(
      shared,
      decisionFor(
        shared,
        {
          status: "resolved_no_change",
          evidence: ["src/b.ts already exports the requested value."],
        },
        noChange,
      ),
      noChange,
    );

    const ingested = await ingestRemediationHostResults({
      root: shared.root,
      artifactsDir: shared.artifactsDir,
      runId: shared.runId,
      state: boundState(shared),
    });
    expect(ingested).not.toBe("unsupported_retired_state");
    if (ingested === "unsupported_retired_state") return;
    // BOTH are accepted. The sibling's landed `src/a.ts` is ground truth this
    // run already corroborated, so it does not falsify the other item's claim.
    expect(ingested.issues).toEqual([]);
    expect(ingested.accepted_count).toBe(2);
    expect(ingested.state.items.B1!.status).toBe("resolved");
    expect(ingested.state.items.B2!.status).toBe("resolved_no_change");
    // The accepted surface carries the landed file, which is what the excuse
    // was drawn from.
    expect(ingested.state.applied_edit_surface).toEqual(["src/a.ts"]);
  });

  it("converges explicit no-change, blocked, and clarification outcomes without fabricated merge evidence", async () => {
    const noChange = await fixture();
    await writeResult(
      noChange,
      decisionFor(noChange, {
        status: "resolved_no_change",
        evidence: ["The current export already satisfies the requested contract."],
      }),
    );
    const noChangeResult = await ingestRemediationHostResults({
      root: noChange.root,
      artifactsDir: noChange.artifactsDir,
      runId: noChange.runId,
      state: boundState(noChange),
    });
    expect(noChangeResult).not.toBe("unsupported_retired_state");
    if (noChangeResult === "unsupported_retired_state") return;
    expect(noChangeResult.state.items.B1!.status).toBe("resolved_no_change");
    expect(noChangeResult.state.items.B1!.host_result_evidence).toHaveLength(1);

    const blocked = await fixture();
    await writeResult(
      blocked,
      decisionFor(blocked, {
        status: "blocked",
        failure_reason: "The required upstream API is absent.",
      }),
    );
    const blockedResult = await ingestRemediationHostResults({
      root: blocked.root,
      artifactsDir: blocked.artifactsDir,
      runId: blocked.runId,
      state: boundState(blocked),
    });
    expect(blockedResult).not.toBe("unsupported_retired_state");
    if (blockedResult === "unsupported_retired_state") return;
    expect(blockedResult.state.items.B1).toMatchObject({
      status: "blocked",
      failure_reason: "The required upstream API is absent.",
    });

    const clarification = await fixture();
    await writeResult(
      clarification,
      decisionFor(clarification, {
        status: "needs_clarification",
        question: "Should the legacy export remain as an alias?",
        category: "compatibility_policy",
      }),
    );
    const clarificationResult = await ingestRemediationHostResults({
      root: clarification.root,
      artifactsDir: clarification.artifactsDir,
      runId: clarification.runId,
      state: boundState(clarification),
    });
    expect(clarificationResult).not.toBe("unsupported_retired_state");
    if (clarificationResult === "unsupported_retired_state") return;
    expect(clarificationResult.state.items.B1!.status).toBe(
      "needs_clarification",
    );
    // The question lives on the item it pauses — its one home.
    expect(clarificationResult.state.items.B1!.clarification_question).toEqual({
      category: "compatibility_policy",
      description: "Should the legacy export remain as an alias?",
    });
    expect(clarificationResult.state).not.toHaveProperty("clarifications");
  });
});
