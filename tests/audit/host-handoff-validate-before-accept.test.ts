/**
 * A result that passes the ingest contract but FAILS audit-results validation
 * must not wedge the run.
 *
 * The defect (docs/backlog/open-bugs.md, 2026-08-21): ingestion recorded the
 * result in host-accepted-results.json + -ledger.json BEFORE the per-result
 * audit-results validation ran in auditStep.ts. When that validation failed,
 * next-step exited 1 — and because the already-accepted binding is skipped on
 * re-ingest, the corrected file was never re-read. The run stayed wedged and no
 * verb removed the accepted entry.
 *
 * The contract under test: validation happens INSIDE the host-handoff ingest,
 * per result, BEFORE anything is written to the accepted pair. An error-severity
 * issue rejects that one result (classified, file left in place), and the next
 * ingest re-reads the SAME bound path and accepts the corrected bytes.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ingestAuditHostResults,
  prepareAuditHostHandoff,
} from "../../src/audit/cli/dispatch/hostHandoff.js";
import { runAuditStep } from "../../src/audit/cli/auditStep.js";
import { recordHostResultOutcomes } from "../../src/audit/cli/laneSubmissions.js";
import { readSubmissionLedger } from "audit-tools/shared";
import type { AuditTask } from "../../src/audit/types.js";

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const RUN_ID = "host-run-validate-first";

const AUDIT_TASK: AuditTask = {
  task_id: "audit-task-a",
  unit_id: "unit-audit-task-a",
  pass_id: "pass:correctness",
  lens: "correctness",
  file_paths: ["src/a.ts"],
  rationale: "Review src/a.ts",
};

/**
 * Passes the worker finding contract at ingest (every schema-expressed rule
 * holds: evidence present, vocabularies valid, span ordered) yet fails the
 * audit-results validator on a rule only IT enforces — the affected_files span
 * (1-9) falls outside the declared file_coverage (total_lines 2). Exactly the
 * live-lap shape: a worker obeying the tool's own prompt can still produce a
 * result that the content gate must refuse.
 */
const FINDING_OUT_OF_COVERAGE = {
  id: "F-1",
  title: "Variable overwritten before use",
  category: "correctness",
  severity: "medium",
  confidence: "medium",
  lens: "correctness",
  summary: "x is reassigned before the prior value is read.",
  evidence: ["src/a.ts:1 - x overwritten"],
  affected_files: [{ path: "src/a.ts", line_start: 1, line_end: 9 }],
};

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "audit-validate-first-"));
  cleanupRoots.push(root);
  const artifactsDir = join(root, ".audit-tools", "audit");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "one\ntwo\n", "utf8");
  const prepared = await prepareAuditHostHandoff({
    root,
    artifactsDir,
    runId: RUN_ID,
    tasks: [
      {
        ...AUDIT_TASK,
        priority: "medium",
        complexity: "standard",
        risk: "medium",
        token_estimate: 1200,
        file_line_counts: { "src/a.ts": 2 },
      },
    ],
  });
  const item = prepared.workload.work_items.find(
    (entry) => entry.id === AUDIT_TASK.task_id,
  );
  if (!item) throw new Error("prepare did not publish the work item");
  const resultPath = join(root, item.result_path);
  await mkdir(join(resultPath, ".."), { recursive: true });

  const writeResult = async (finding: Record<string, unknown>) => {
    await writeFile(
      resultPath,
      JSON.stringify({
        contract_version: "audit-host-result/v1alpha1",
        // Deliberately the SAME result_id across both ingests: a rejected item
        // never entered the ledger, so re-landing the corrected bytes under the
        // same identity must be accepted, not refused as a duplicate.
        result_id: `result-${item.id}`,
        run_id: RUN_ID,
        work_item_id: item.id,
        prompt_sha256: item.prompt.sha256,
        file_coverage: [
          { path: "src/a.ts", reviewed_lines: 2, total_lines: 2 },
        ],
        findings: [finding],
      }),
      "utf8",
    );
  };

  const acceptedPair = async () => {
    const runDir = join(artifactsDir, "runs", RUN_ID);
    const results = JSON.parse(
      await readFile(join(runDir, "host-accepted-results.json"), "utf8"),
    ) as unknown[];
    const ledger = JSON.parse(
      await readFile(join(runDir, "host-accepted-results-ledger.json"), "utf8"),
    ) as { entries: unknown[] };
    return { results, ledgerEntries: ledger.entries };
  };

  return {
    root,
    artifactsDir,
    item,
    writeResult,
    acceptedPair,
    ingest: (lineIndex: Record<string, number> = { "src/a.ts": 2 }) =>
      ingestAuditHostResults({
        root,
        artifactsDir,
        runId: RUN_ID,
        auditTasks: [AUDIT_TASK],
        lineIndex,
      }),
  };
}

describe("contract:host-handoff-validates-before-it-accepts", () => {
  it("a content-invalid result (span outside declared coverage) is classified-rejected, not accepted-and-wedged", async () => {
    const ctx = await setup();
    await ctx.writeResult(FINDING_OUT_OF_COVERAGE);

    const first = await ctx.ingest();
    expect(first.accepted_count).toBe(0);
    const issue = first.issues.find(
      (entry) => entry.work_item_id === AUDIT_TASK.task_id,
    );
    expect(issue, `the rejection must be classified: ${JSON.stringify(first.issues)}`).toBeDefined();
    expect(issue?.code).toBe("result_validation_failed");
    expect(issue?.message).toMatch(/inside the declared file_coverage/u);

    // Nothing poisoned: the accepted pair holds no entry for the work item.
    const pairAfterReject = await ctx.acceptedPair();
    expect(pairAfterReject.results).toEqual([]);
    expect(pairAfterReject.ledgerEntries).toEqual([]);

    // The operator fixes the SAME bound file; the next fold re-reads it.
    await ctx.writeResult({ ...FINDING_OUT_OF_COVERAGE, affected_files: [{ path: "src/a.ts", line_start: 1, line_end: 2 }] });
    const second = await ctx.ingest();
    expect(second.accepted_count).toBe(1);
    expect(second.completed_work_item_ids).toEqual([AUDIT_TASK.task_id]);
    const pairAfterRepair = await ctx.acceptedPair();
    expect(pairAfterRepair.results).toHaveLength(1);

    // The downstream auditStep gate (kept as defense in depth) now has nothing
    // to reject: feeding the accepted result to the ordinary result-ingestion
    // executor completes without throwing formatAuditResultValidationError.
    await writeFile(
      join(ctx.artifactsDir, "coverage_matrix.json"),
      JSON.stringify({ files: [] }),
      "utf8",
    );
    await writeFile(
      join(ctx.artifactsDir, "audit_tasks.json"),
      JSON.stringify([AUDIT_TASK]),
      "utf8",
    );
    await expect(
      runAuditStep({
        root: ctx.root,
        artifactsDir: ctx.artifactsDir,
        preferredExecutor: "result_ingestion_executor",
        auditResultsData: [...second.accepted_results],
      }),
    ).resolves.toBeDefined();
  });

  it("a warning-only result is accepted and NEVER recorded as rejected", async () => {
    const ctx = await setup();

    // Declared total_lines 2 against a disk index of 3 is a ONE-line counting
    // delta — inside the ±2 advisory floor (`significant ? "error" : "warning"`),
    // so the whole result carries only warning-severity validation issues and
    // passes every error rule including the envelope's bound-count check.
    await ctx.writeResult({
      ...FINDING_OUT_OF_COVERAGE,
      // A span-free location: every error rule holds, so only the ±1-line
      // coverage delta below can surface — as a warning.
      affected_files: [{ path: "src/a.ts" }],
    });

    const ingested = await ctx.ingest({ "src/a.ts": 3 });
    expect(ingested.accepted_count).toBe(1);
    expect(ingested.completed_work_item_ids).toEqual([AUDIT_TASK.task_id]);
    expect(ingested.issues).toEqual([]);

    // The warning must ride a SEPARATE summary channel, never the rejection-
    // classified issue list.
    expect(ingested.validation_warnings).toHaveLength(1);
    expect(ingested.validation_warnings[0]?.work_item_id).toBe(AUDIT_TASK.task_id);

    // The ONE recorder fed these very outcomes must write NO 'rejected' event:
    // an accepted-with-warning result never refused anything, so the ledger
    // must not manufacture a rejected→accepted repair story for it.
    await recordHostResultOutcomes(ctx.artifactsDir, RUN_ID, {
      issues: ingested.issues,
      acceptedIds: ingested.completed_work_item_ids,
    });
    const events = await readSubmissionLedger(ctx.artifactsDir);
    expect(events.filter((event) => event.kind === "rejected")).toEqual([]);
  });

  it("a task-unknown (orphan) result passes through UNVALIDATED with the stderr notice", async () => {
    const ctx = await setup();

    // Span outside the declared coverage: would be REJECTED if the orphan were
    // validated. It is a content-invalid shape on purpose — the passthrough must
    // hold even for the worst-shaped result, because refusing an orphan strands
    // it outside the append-only ledger entirely.
    await ctx.writeResult(FINDING_OUT_OF_COVERAGE);

    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let ingested: Awaited<ReturnType<typeof ctx.ingest>>;
    try {
      ingested = await ingestAuditHostResults({
        root: ctx.root,
        artifactsDir: ctx.artifactsDir,
        runId: RUN_ID,
        auditTasks: [], // manifest WITHOUT the submitted work item → orphan
        lineIndex: { "src/a.ts": 2 },
      });
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(stderrChunks.join("")).toMatch(
      /not in the[\s\S]*active task manifest/u,
    );
    expect(ingested.accepted_count).toBe(1);
    expect(ingested.completed_work_item_ids).toEqual([AUDIT_TASK.task_id]);
    expect(ingested.issues).toEqual([]);
  });
});
