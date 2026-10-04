import { afterEach, describe, expect, it } from "vitest";
import { cleanupHostHandoffFixtures, git, fixture, boundState, persistBoundState, resultFor, decisionFor, expectWriteScopeRefusal, writeResult, landA } from "./helpers/hostHandoffCorroborationFixture.js";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { ingestRemediationHostResults } from "../../src/remediate/steps/dispatch/hostHandoff.js";

import { RemediationHostHandoffRecordSchema } from "../../src/remediate/state/types.js";

afterEach(cleanupHostHandoffFixtures);

describe("remediation host handoff record scope semantics versions", () => {
  const binding = {
    run_id: "scope-version-test",
    baseline_commit: "a".repeat(40),
    workload_sha256: "b".repeat(64),
    work_item_ids: ["B1"],
  };

  it("rejects retired implicit scope and requires explicit semantics", () => {
    expect(
      RemediationHostHandoffRecordSchema.safeParse({
        contract_version: "remediation-host-handoff-record/v1alpha1",
        ...binding,
      }).success,
    ).toBe(false);
    expect(
      RemediationHostHandoffRecordSchema.safeParse({
        contract_version: "remediation-host-handoff-record/v1alpha1",
        scope_semantics: "explicit-directory-markers/v1",
        ...binding,
      }).success,
    ).toBe(false);
    expect(
      RemediationHostHandoffRecordSchema.safeParse({
        contract_version: "remediation-host-handoff-record/v1alpha2",
        ...binding,
      }).success,
    ).toBe(false);
    expect(
      RemediationHostHandoffRecordSchema.safeParse({
        contract_version: "remediation-host-handoff-record/v1alpha2",
        scope_semantics: "explicit-directory-markers/v1",
        ...binding,
      }).success,
    ).toBe(true);
    expect(
      RemediationHostHandoffRecordSchema.safeParse({
        contract_version: "remediation-host-handoff-record/v1alpha2",
        scope_semantics: "exact-paths-mean-directories",
        ...binding,
      }).success,
    ).toBe(false);
    expect(
      RemediationHostHandoffRecordSchema.safeParse({
        contract_version: "remediation-host-handoff-record/v1alpha3",
        scope_semantics: "explicit-directory-markers/v1",
        ...binding,
      }).success,
    ).toBe(false);
  });
});

describe("remediation host handoff repository corroboration", () => {
  it("refuses a retired implicit-scope handoff without accepting a result", async () => {
    const value = await fixture();
    const before = JSON.stringify(value.state);
    const retired = { ...boundState(value), host_handoff: { ...value.handoff.handoff_record, contract_version: "remediation-host-handoff-record/v1alpha1" } };
    const result = await ingestRemediationHostResults({ root: value.root, artifactsDir: value.artifactsDir, runId: value.runId, state: retired });
    expect(result).toBe("unsupported_retired_state");
    expect(JSON.stringify(value.state)).toBe(before);
  });
  it("accepts one leading byte-order mark only after reading the bound result, while keeping invalid results refused", async () => {
    const accepted = await fixture();
    const acceptedAfter = await landA(accepted);
    const acceptedPath = resolve(accepted.root, accepted.item.result_path);
    await mkdir(dirname(acceptedPath), { recursive: true });
    await writeFile(
      acceptedPath,
      `\uFEFF${JSON.stringify(resultFor(accepted, acceptedAfter))}`,
      "utf8",
    );
    const acceptedIngest = await ingestRemediationHostResults({
      root: accepted.root,
      artifactsDir: accepted.artifactsDir,
      runId: accepted.runId,
      state: boundState(accepted),
    });
    expect(acceptedIngest).not.toBe("unsupported_retired_state");
    if (acceptedIngest === "unsupported_retired_state") return;
    expect(acceptedIngest.accepted_count).toBe(1);
    expect(acceptedIngest.issues).toEqual([]);

    const invalid = await fixture();
    const invalidAfter = await landA(invalid);
    const invalidPath = resolve(invalid.root, invalid.item.result_path);
    await mkdir(dirname(invalidPath), { recursive: true });
    await writeFile(invalidPath, `\uFEFF${JSON.stringify({
      ...resultFor(invalid, invalidAfter),
      prompt_sha256: "0".repeat(64),
    })}`, "utf8");
    const invalidIngest = await ingestRemediationHostResults({
      root: invalid.root,
      artifactsDir: invalid.artifactsDir,
      runId: invalid.runId,
      state: boundState(invalid),
    });
    expect(invalidIngest).not.toBe("unsupported_retired_state");
    if (invalidIngest === "unsupported_retired_state") return;
    expect(invalidIngest.accepted_count).toBe(0);
    expect(invalidIngest.issues.map((issue) => issue.code)).toContain(
      "submission_contract_invalid",
    );

    const malformed = await fixture();
    const malformedPath = resolve(malformed.root, malformed.item.result_path);
    await mkdir(dirname(malformedPath), { recursive: true });
    await writeFile(malformedPath, "\uFEFF{not-json", "utf8");
    const malformedIngest = await ingestRemediationHostResults({
      root: malformed.root,
      artifactsDir: malformed.artifactsDir,
      runId: malformed.runId,
      state: boundState(malformed),
    });
    expect(malformedIngest).not.toBe("unsupported_retired_state");
    if (malformedIngest === "unsupported_retired_state") return;
    expect(malformedIngest.accepted_count).toBe(0);
    expect(malformedIngest.issues.map((issue) => issue.code)).toContain(
      "submission_malformed",
    );
  });

  it("binds complete finding, clarification, and retry instructions into the prompt", async () => {
    const value = await fixture();
    expect(value.item.prompt.text).toContain("Correct the returned value");
    expect(value.item.prompt.text).toContain(
      "Change the exported value from one to two.",
    );
    expect(value.item.prompt.text).toContain(
      "Keep the public export name unchanged.",
    );
    expect(value.item.prompt.text).toContain(
      "A prior attempt changed the API name.",
    );
  });

  it("accepts a real reachable commit with an exact diff and mechanically green required test", async () => {
    const value = await fixture();
    const after = await landA(value);
    await writeResult(value, resultFor(value, after));

    const ingested = await ingestRemediationHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
      state: boundState(value),
    });
    expect(ingested).not.toBe("unsupported_retired_state");
    if (ingested === "unsupported_retired_state") return;
    expect(ingested.accepted_count).toBe(1);
    expect(ingested.issues).toEqual([]);
    expect(ingested.state.items.B1!.status).toBe("resolved");
    expect(ingested.state.applied_edit_surface).toEqual(["src/a.ts"]);
    expect(ingested.state.host_handoff).toBeUndefined();
    // The CORROBORATED landing, persisted per item. `applied_edit_surface` is
    // the run-wide union and cannot attribute a file to an item;
    // `host_result_evidence` is deleted on the resolved path. Without this the
    // only way to recover "what landed for this item" was to re-run the git
    // probes — which a rewrite-orphaned baseline makes unanswerable.
    expect(ingested.state.items.B1!.host_landed_commit).toBe(after);
    expect(ingested.state.items.B1!.host_landed_files).toEqual(["src/a.ts"]);
  });

  it("records no landed commit for a decision outcome — only a real landing claims one", async () => {
    // The negative half. `resolved_no_change` settles the item without landing
    // anything, and writing a commit there would attribute work the host
    // explicitly said it did not do.
    const value = await fixture();
    // Deliberately NO landing: a resolved_no_change claims the tree is
    // unchanged, so landing a commit and then claiming that would be refused
    // (correctly) by the no-change corroboration — a different test.
    await writeResult(
      value,
      decisionFor(value, {
        status: "resolved_no_change",
        evidence: ["The existing code already satisfies the contract."],
      }),
    );
    const ingested = await ingestRemediationHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
      state: boundState(value),
    });
    if (ingested === "unsupported_retired_state") throw new Error("state rejected");
    expect(ingested.state.items.B1!.status).toBe("resolved_no_change");
    expect(ingested.state.items.B1!.host_landed_commit).toBeUndefined();
    expect(ingested.state.items.B1!.host_landed_files).toBeUndefined();
  });

  it("accepts a real commit beneath a prompt-bound directory write scope", async () => {
    const value = await fixture({ allowedFiles: ["src/"] });
    expect(value.item.allowed_files).toEqual(["src/"]);
    const after = await landA(value);
    await writeResult(value, resultFor(value, after));

    const ingested = await ingestRemediationHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
      state: boundState(value),
    });
    expect(ingested).not.toBe("unsupported_retired_state");
    if (ingested === "unsupported_retired_state") return;
    expect(ingested.accepted_count).toBe(1);
    expect(ingested.issues).toEqual([]);
    expect(ingested.state.applied_edit_surface).toEqual(["src/a.ts"]);
  });


  it("marks new scope semantics and never reinterprets a future exact scope", async () => {
    const value = await fixture({
      allowedFiles: ["src"],
      affectedFiles: [
        { path: "src/", hash_at_plan_time: "f".repeat(64) },
      ],
    });
    expect(value.handoff.handoff_record).toMatchObject({
      contract_version: "remediation-host-handoff-record/v1alpha2",
      scope_semantics: "explicit-directory-markers/v1",
    });
    const state = boundState(value);
    await persistBoundState(value, state);
    const after = await landA(value);
    // Judged at corroboration on the git-derived file set: under v1alpha2
    // semantics the exact `src` is a FILE, never reinterpreted as a directory.
    await writeResult(value, resultFor(value, after));
    const ingested = await ingestRemediationHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
      state,
    });
    expect(ingested).not.toBe("unsupported_retired_state");
    if (ingested === "unsupported_retired_state") return;
    expect(ingested.accepted_count).toBe(0);
    expectWriteScopeRefusal(ingested.issues, "src/a.ts");
  });

  it("keeps directory write scopes component-aware", async () => {
    // v1alpha3: the landed files are git's, so they are always normalized
    // repo-relative paths; what remains to pin is that `src/` authorizes the
    // `src` COMPONENT, not every path that merely starts with those letters.
    const directory = await fixture({ allowedFiles: ["src/"] });
    await mkdir(join(directory.root, "src2"), { recursive: true });
    await writeFile(join(directory.root, "src2", "a.ts"), "export const sibling = 1;\n");
    git(directory.root, ["add", "src2/a.ts"]);
    git(directory.root, ["commit", "-m", "land outside the src component"]);
    await writeResult(
      directory,
      resultFor(directory, git(directory.root, ["rev-parse", "HEAD"])),
    );
    const directoryIngest = await ingestRemediationHostResults({
      root: directory.root,
      artifactsDir: directory.artifactsDir,
      runId: directory.runId,
      state: boundState(directory),
    });
    expect(directoryIngest).not.toBe("unsupported_retired_state");
    if (directoryIngest === "unsupported_retired_state") return;
    expect(directoryIngest.accepted_count).toBe(0);
    expectWriteScopeRefusal(directoryIngest.issues, "src2/a.ts");

    // An exact entry with no trailing "/" authorizes that one path only.
    const exact = await fixture({ allowedFiles: ["src"] });
    await writeResult(exact, resultFor(exact, await landA(exact)));
    const exactIngest = await ingestRemediationHostResults({
      root: exact.root,
      artifactsDir: exact.artifactsDir,
      runId: exact.runId,
      state: boundState(exact),
    });
    expect(exactIngest).not.toBe("unsupported_retired_state");
    if (exactIngest === "unsupported_retired_state") return;
    expect(exactIngest.accepted_count).toBe(0);
    expectWriteScopeRefusal(exactIngest.issues, "src/a.ts");
  });

  it("rejects fabricated and unlanded commit evidence", async () => {
    const fabricated = await fixture();
    await writeResult(fabricated, resultFor(fabricated, "2".repeat(40)));
    const missing = await ingestRemediationHostResults({
      root: fabricated.root,
      artifactsDir: fabricated.artifactsDir,
      runId: fabricated.runId,
      state: boundState(fabricated),
    });
    expect(missing).not.toBe("unsupported_retired_state");
    if (missing === "unsupported_retired_state") return;
    expect(missing.issues.map((issue) => issue.code)).toContain("commit_missing");
    expect(
      missing.issues.find((issue) => issue.code === "commit_missing")!.check,
    ).toBe("landed_commit");

    const unlanded = await fixture();
    git(unlanded.root, ["checkout", "-b", "side"]);
    const sideCommit = await landA(unlanded);
    git(unlanded.root, ["checkout", "-"]);
    await writeResult(unlanded, resultFor(unlanded, sideCommit));
    const rejected = await ingestRemediationHostResults({
      root: unlanded.root,
      artifactsDir: unlanded.artifactsDir,
      runId: unlanded.runId,
      state: boundState(unlanded),
    });
    expect(rejected).not.toBe("unsupported_retired_state");
    if (rejected === "unsupported_retired_state") return;
    expect(rejected.issues.map((issue) => issue.code)).toContain(
      "commit_not_landed",
    );
  });

  it("rejects a self-consistent host rewrite of the workload", async () => {
    const value = await fixture();
    const workload = JSON.parse(
      await readFile(value.handoff.workload_path, "utf8"),
    ) as { work_items: Array<{ token_estimate: number }> };
    workload.work_items[0]!.token_estimate += 1;
    await writeFile(
      value.handoff.workload_path,
      JSON.stringify(workload),
      "utf8",
    );
    const ingested = await ingestRemediationHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
      state: boundState(value),
    });
    expect(ingested).not.toBe("unsupported_retired_state");
    if (ingested === "unsupported_retired_state") return;
    expect(ingested.issues.map((issue) => issue.code)).toEqual([
      "workload_invalid",
    ]);
  });

  it("names a MISSING workload file and keeps the bound items pending", async () => {
    // The first of the three whole-ingest early exits, and the only issue code
    // in this boundary that no test asserted. Each exit returns a DIFFERENT
    // pending list — this one and the parse failure return the binding's own
    // item ids, while the trusted-binding refusal returns the empty list — so
    // the pending list is asserted here, not just the code. Confusing the three
    // is a silent behaviour change, which is what makes this a characterization
    // test rather than a coverage nicety.
    const value = await fixture();
    await rm(value.handoff.workload_path, { force: true });
    const ingested = await ingestRemediationHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
      state: boundState(value),
    });
    expect(ingested).not.toBe("unsupported_retired_state");
    if (ingested === "unsupported_retired_state") return;
    expect(ingested.issues.map((issue) => issue.code)).toEqual([
      "workload_missing",
    ]);
    expect(ingested.issues[0]!.check).toBe("workload_binding");
    expect(ingested.pending_work_item_ids).toEqual(
      value.handoff.handoff_record.work_item_ids,
    );
    expect(ingested.accepted_count).toBe(0);
    expect(ingested.state_changed).toBe(false);
    expect(ingested.state.items.B1!.status).toBe("pending");
  });

  it("names an UNPARSEABLE workload file distinctly from a digest mismatch", async () => {
    // The second early exit. It shares the `workload_invalid` code with the
    // canonical re-derivation failure above, so only the MESSAGE tells the two
    // apart — and an extract that folded one arm into the other would keep
    // every code assertion green. The message is therefore the assertion.
    const value = await fixture();
    await writeFile(value.handoff.workload_path, "{ this is not json", "utf8");
    const ingested = await ingestRemediationHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
      state: boundState(value),
    });
    expect(ingested).not.toBe("unsupported_retired_state");
    if (ingested === "unsupported_retired_state") return;
    expect(ingested.issues.map((issue) => issue.code)).toEqual([
      "workload_invalid",
    ]);
    expect(ingested.issues[0]!.message).toContain("not valid JSON");
    expect(ingested.issues[0]!.message).not.toContain("canonical state shape");
    expect(ingested.pending_work_item_ids).toEqual(
      value.handoff.handoff_record.work_item_ids,
    );
    expect(ingested.accepted_count).toBe(0);
    expect(ingested.state_changed).toBe(false);
  });
});
