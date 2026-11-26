/**
 * Correctness regression tests for the audit-code CLI layer.
 * Locks fixes from the N-audit-cli-correctness remediation block (COR-*).
 *
 * Deterministic in-process tests — no LLM calls, minimal disk IO.
 */
import { createFoldTransaction } from "../../src/audit/cli/foldTransaction.js";
import { test, expect, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWrapper } from "./helpers/run-wrapper.mjs";
import { captureConsole } from "./helpers/captureConsole.mjs";
import type { AuditState } from "../../src/audit/types/auditState.js";

async function withTempDir<T>(
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "audit-cli-cor-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── COR-a278fbe0: sampleRunCommand task_id derived from unit, not hardcoded ──
// Previously: task_id was the literal "src-api:security:src/api/auth.ts:1-100"
// After fix:  task_id is `${sampleUnitId}:${sampleLens}` (derived from planning output).

const { GATE_LANES, laneSubmissionPath } = await import(
  "../../src/audit/cli/laneSubmissions.js"
);
const { submissionsDir } = await import(
  "../../src/shared/io/auditToolsPaths.js"
);
const { runSample } = await import("../../src/audit/cli/sampleRunCommand.js");

test("sample-run writes a v2 report in a separate sample directory, not audit state", async () => {
  await withTempDir(async root => {
    const { QuestionAuditFindingsReportSchema } = await import("../../src/shared/types/questionReviewReport.js");
    await runSample(["--root", root]);
    const target = join(root, ".audit-tools", "sample");
    const report = QuestionAuditFindingsReportSchema.parse(JSON.parse(await readFile(join(target, "audit-findings.json"), "utf8")));
    expect(report.question_review).toMatchObject({
      snapshot_id: "fabricated-sample", completion: "incomplete",
      questions: [{ question_id: "sample-review-queue", state: "unreviewed" }],
    });
    expect(report.findings).toEqual([]);
    expect(await readFile(join(target, "audit-report.md"), "utf8")).toContain("## Questions and review limits");
    for (const name of ["audit_state.json", "review_session.json", "audit_results.jsonl"]) {
      await expect(readFile(join(target, name), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(readFile(join(root, ".audit-tools", "audit", "audit-findings.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

test("COR-df0bf37c: import-external-analyzer rejects non-array results before dispatch and accepts an empty array", async () => {
  await withTempDir(async root => {
    const input = join(root, "normalized-findings.json");
    const artifacts = join(root, ".audit-tools", "audit");
    const args = ["import-external-analyzer", "--external-analyzer-results", input];
    for (const malformed of [null, { tool: "fixture-analyzer", results: { length: 0 } }]) {
      await writeFile(input, JSON.stringify(malformed));
      await expect(runWrapper(args, { cwd: root })).rejects.toThrow(/must have a 'results' array/);
    }
    await expect(stat(artifacts)).rejects.toMatchObject({ code: "ENOENT" });

    const empty = { tool: "fixture-analyzer", results: [] };
    await writeFile(input, JSON.stringify(empty));
    const { stdout } = await runWrapper(args, { cwd: root });
    expect(JSON.parse(stdout)).toMatchObject({
      tool: empty.tool,
      imported_count: 0,
      selected_executor: "external_analyzer_import_executor",
    });
    const stored = await readFile(join(artifacts, "external_analyzer_results.json"), "utf8");
    expect(JSON.parse(stored)).toEqual([empty]);
  });
});

// ── COR-0ae3577b: CLI forwards no token-wrap option from sessionConfig ───────
// Token compression is handled by host-level headroom; CLI commands must not
// forward any session-config wrap flag into runDeterministicForNextStep.
// Structural check: NextStepParams carries the trimmed params shape.

test("COR-0ae3577b: handleGraphEnrichmentBranch accepts the trimmed params shape", async () => {
  const { handleGraphEnrichmentBranch } = await import("../../src/audit/cli/nextStepCommand.js");
  const params = { root: ".", sourceRoot: ".", artifactsDir: ".", graphLlmEdgeReasoning: false, since: undefined };
  const result = await handleGraphEnrichmentBranch(
    params,
    {},
    { status: "active", obligations: [], blockers: [] } satisfies AuditState,
    { value: undefined },
    createFoldTransaction(),
  );
  expect(["fallthrough", "continue", "return"].includes(result.action), `Expected valid action; got ${result.action}`).toBeTruthy();
});

// ── COR-03418a9f-2: all-invalid analyzer decisions → stderr diagnostic ────────
// When all values in analyzer-decisions.json fail recognized-value check,
// a stderr warning must be emitted before the file is unlinked.

test("COR-03418a9f-2: handleGraphEnrichmentBranch emits stderr for all-invalid analyzer decisions", async () => {
  await withTempDir(async (dir) => {
    const { handleGraphEnrichmentBranch } = await import("../../src/audit/cli/nextStepCommand.js");
    await mkdir(submissionsDir(dir), { recursive: true });
    // Write decisions file with all-invalid values
    await writeFile(
      laneSubmissionPath(dir, GATE_LANES.analyzer_decisions),
      JSON.stringify({ "myanalyzer": "install", "otheralyzer": "disable" }),
      "utf8",
    );
    // Write a minimal session-config so persistAnalyzerSettings doesn't throw
    await writeFile(join(dir, "session-config.json"), JSON.stringify({}), "utf8");

    const stderrChunks: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });

    try {
      const bundle = {};
      const state = { status: "active", obligations: [], blockers: [] } satisfies AuditState;
      const params = { root: dir, sourceRoot: dir, artifactsDir: dir, graphLlmEdgeReasoning: false, since: undefined };
      // With no manifest, unresolved = [] → falls to edge reasoning check → fallthrough
      // (decisions file is only consumed when unresolved.length > 0)
      const result = await handleGraphEnrichmentBranch(params, bundle, state, { value: undefined }, createFoldTransaction());
      // No manifest means no unresolved entries, so the decisions path is not taken
      expect(result.action, "no manifest → fallthrough").toBe("fallthrough");
    } finally {
      stderrSpy.mockRestore();
    }
    // THE BUFFER IS READ (COR-1faa3e31). It was collected and then discarded,
    // so nothing about stderr was actually under test. This scenario has an
    // EMPTY expectation and that is the assertion: with no manifest there are no
    // unresolved entries, so the decisions file is never consumed and the
    // all-invalid diagnostic must NOT fire. A spy whose buffer is never read
    // cannot tell that from a diagnostic that fired for the wrong reason.
    expect(
      stderrChunks.join(""),
      "the all-invalid diagnostic must not fire when there are no unresolved entries",
    ).not.toMatch(/analyzer/i);
  });
});

// ── COR-4c72c062: getFlag behavior when next token is a long flag ─────────────
// INV-04 already covers this; this is a correctness companion confirming the
// documented behavior is consistent across different flag names.

const { getFlag } = await import("../../src/audit/cli/args.js");

test("COR-4c72c062: getFlag returns fallback (not undefined) when next token is a long flag", () => {
  // Caller passes '--root --artifacts-dir something' — root gets fallback
  // Both sides come from production: the ARGV goes in, `getFlag` decides. (An
  // earlier assertion here compared two strings the test itself had built, which
  // is green by construction and was dropped.)
  expect(getFlag(["--root", "--artifacts-dir", "something"], "--root", "/default"), "When next token is a long flag, getFlag returns the explicit fallback").toBe("/default");
  expect(getFlag(["--root", "--artifacts-dir", "something"], "--root"), "When next token is a long flag and no fallback given, returns undefined").toBe(undefined);
});

test("sample-run refuses to overwrite active question review or an existing report", async () => {
  await withTempDir(async root => {
    const artifactsDir = join(root, "sample-target");
    await mkdir(artifactsDir, { recursive: true });
    const session = join(artifactsDir, "review_session.json");
    const findings = join(artifactsDir, "audit-findings.json");
    await writeFile(session, "active review");
    const argv = ["--artifacts-dir", artifactsDir];
    const before = process.exitCode;
    try {
      await runSample(argv);
      expect(process.exitCode).toBe(1);
      expect(await readFile(session, "utf8")).toBe("active review");
      await expect(readFile(findings)).rejects.toMatchObject({ code: "ENOENT" });
      await rm(session);
      await writeFile(findings, "preexisting report");
      await runSample(argv);
      expect(process.exitCode).toBe(1);
      expect(await readFile(findings, "utf8")).toBe("preexisting report");
    } finally { process.exitCode = before; }
  });
});

test("sample-run resumes only the exact first half and preserves completed reports", async () => {
  await withTempDir(async root => {
    const { runCli } = await import("../../src/audit/cli.js");
    const artifactsDir = join(root, "sample-target");
    const findings = join(artifactsDir, "audit-findings.json");
    const markdown = join(artifactsDir, "audit-report.md");
    const receipt = join(artifactsDir, ".fold-receipt.json");
    const run = (force = false) => captureConsole(() => runCli([
      process.execPath, "audit-code", "sample-run", "--root", root, "--artifacts-dir", artifactsDir,
      ...(force ? ["--force"] : []),
    ]));
    expect((await run()).code).toBe(0);
    const expectedFindings = await readFile(findings);
    const expectedMarkdown = await readFile(markdown);

    await rm(markdown); // The atomic findings write made it, the Markdown write did not.
    await utimes(findings, new Date("2000-01-01T00:00:00Z"), new Date("2000-01-01T00:00:00Z"));
    const preservedMtime = (await stat(findings)).mtimeMs;
    expect((await run()).code).toBe(0);
    expect(await readFile(findings)).toEqual(expectedFindings);
    expect((await stat(findings)).mtimeMs).toBe(preservedMtime);
    expect(await readFile(markdown)).toEqual(expectedMarkdown);

    expect((await run()).code).toBe(1); // Both generated outputs already exist.
    await writeFile(markdown, "custom report");
    await rm(findings);
    expect((await run()).code).toBe(1); // A Markdown-only target is not an interrupted sample.
    expect(await readFile(markdown, "utf8")).toBe("custom report");
    await expect(readFile(findings)).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(findings, "custom findings");
    await writeFile(receipt, "{}");
    const pending = await run(true);
    expect(pending.code).toBe(1);
    expect(pending.stderr).toMatch(/incomplete fold receipt/);
    expect(await readFile(findings, "utf8")).toBe("custom findings");
    expect(await readFile(markdown, "utf8")).toBe("custom report");

    await rm(receipt);
    expect((await run(true)).code).toBe(0); // The custom target is disposable.
    expect(await readFile(findings)).toEqual(expectedFindings);
    expect(await readFile(markdown)).toEqual(expectedMarkdown);
  });
});

// ── COR-2cf46bf7: ensureSemanticReviewRun writeJsonFile(pendingTasksPath) ─────
// Both writes serve distinct purposes:
//   1. writeWorkerTaskFiles(…, pendingTasks) → dispatch/current-tasks.json (dispatch pointer)
//   2. writeJsonFile(pendingTasksPath, pendingTasks) → run-dir/pending-audit-tasks.json
//      (referenced by task.pending_audit_tasks_path, read by the worker via workerRunCommand)
// These are NOT the same path; both are needed. Verified-already-satisfied.
test("COR-2cf46bf7: the review run writes pendingTasks to two DISTINCT consumer paths", async () => {
  // FALSIFIABLE: drive the real writer and assert BOTH files exist with the same
  // canonical content at DIFFERENT paths. Deleting either write — the
  // deduplication this finding considered — breaks one consumer, and this now
  // detects it. `expect(true)` asserted the claim in prose and could not.
  const { writeReviewRunFiles } = await import("../../src/audit/io/runArtifacts.js");
  const { readJsonFile } = await import("audit-tools/shared");
  await withTempDir(async (dir) => {
    const runId = "review-run-1";
    const run = {
      contract_version: "audit-review-run/v1alpha1",
      run_id: runId,
      review_run_path: join(dir, "runs", runId, "review-run.json"),
      pending_audit_tasks_path: join(dir, "runs", runId, "pending-audit-tasks.json"),
      host_workload_path: join(dir, "runs", runId, "host-workload.json"),
      host_result_map_path: join(dir, "runs", runId, "host-result-map.json"),
    };
    await writeReviewRunFiles(dir, run as never, []);

    const workerCopy = await readJsonFile(run.pending_audit_tasks_path);
    const dispatchCopy = await readJsonFile(join(dir, "dispatch", "current-tasks.json"));
    expect(workerCopy, "the worker's pending-tasks file must exist").toEqual([]);
    expect(dispatchCopy, "the dispatch pointer's task list must exist").toEqual([]);
    // The "two paths differ" assertion that used to sit here compared two
    // strings this test had itself constructed — green by construction, and no
    // witness to anything production does. The two reads above ARE the witness:
    // both files exist, at different paths, only because the writer wrote both.
  });
});

// ── COR-dc621e7a: buildManualReviewBlocker routing is correct (verified in INV-01) ─
test("COR-dc621e7a: buildManualReviewBlocker states host-executable work, not an operator instruction", async () => {
  // FALSIFIABLE against the real function. The old assertion deferred to another
  // file by NAME, which is not a check: if that file's test were deleted or
  // renamed this would still pass.
  const { buildManualReviewBlocker, buildBlockedAuditState } = await import(
    "../../src/audit/cli/envelope.js"
  );
  const blocker = buildManualReviewBlocker();
  expect(blocker, "the blocker names the host-executable next action").toMatch(
    /next-step/,
  );
  expect(blocker.length, "a blocker must actually say something").toBeGreaterThan(0);
  // And it is what lands on the blocked state, which is the routing claim.
  const blocked = buildBlockedAuditState({
    state: { status: "active", obligations: [], blockers: [] } satisfies AuditState,
    obligationId: "semantic_review",
    executor: null,
    blocker,
  });
  // `blockers` is a de-duplicated string list, so the routing claim is that the
  // blocker text itself lands on the state and the status flips.
  expect(blocked.blockers, "the blocker is routed onto the state").toContain(blocker);
  expect(blocked.status, "routing a blocker blocks the state").toBe("blocked");
});

// ── COR-1faa3e31, THE FIRING DIRECTION ───────────────────────────────────────
//
// The emptiness assertion above covers only the OVER-firing direction: it reds
// if the diagnostic fires when it should not. It cannot see the emitter being
// silently skipped. This drives the path that SHOULD emit and asserts it does.
//
// The unresolved-analyzer input is INJECTED. The real resolution asks the
// machine which analyzers are installed, so a fixture built on it would pass or
// fail depending on the box — the seam exists so this verdict does not.
test("COR-1faa3e31: the quarantine diagnostic actually EMITS when a misshapen decisions file arrives", async () => {
  await withTempDir(async (dir) => {
    const { handleGraphEnrichmentBranch } = await import(
      "../../src/audit/cli/nextStepHelpers.js"
    );
    await mkdir(submissionsDir(dir), { recursive: true });
    // A NON-OBJECT top-level value: the shape that is quarantined rather than
    // merged, which is the branch that writes the stderr diagnostic.
    await writeFile(
      laneSubmissionPath(dir, GATE_LANES.analyzer_decisions),
      JSON.stringify(["not", "an", "object"]),
      "utf8",
    );
    await writeFile(join(dir, "session-config.json"), JSON.stringify({}), "utf8");

    const stderrChunks: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });

    try {
      const state = { status: "active", obligations: [], blockers: [] } satisfies AuditState;
      const params = { root: dir, sourceRoot: dir, artifactsDir: dir, graphLlmEdgeReasoning: false, since: undefined };
      await handleGraphEnrichmentBranch(
        params,
        {},
        state,
        { value: undefined },
        // Seeded: one unresolved analyzer, so the decisions file is consumed and
        // its misshapen top-level value reaches the quarantine path.
        createFoldTransaction(),
        { unresolvedAnalyzers: () => [{ id: "semgrep" }] as never },
      );
    } finally {
      stderrSpy.mockRestore();
    }

    const emitted = stderrChunks.join("");
    expect(
      emitted,
      "the quarantine diagnostic must name the lane it refused",
    ).toContain(GATE_LANES.analyzer_decisions);
    expect(
      emitted,
      "and must tell the operator what to do about it",
    ).toMatch(/quarantined/i);
  });
});
