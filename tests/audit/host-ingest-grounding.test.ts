// C1 (docs-16): grounding is TOOL-COMPUTED at ingest, never worker-self-reported.
//
// `verifyFindingGrounding` existed with zero production callers while the shared
// `FindingSchema` happily carried a worker-supplied `grounding` verdict straight
// through ingestion into synthesis — so the "confirmed by the tool's re-check"
// bit was, on the audit path, the model's own word. Two halves of one contract:
// the host boundary must COMPUTE the verdict for every accepted finding, and it
// must REFUSE a submission that supplies one.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const FAILURE_SIGNATURE =
  "contract:audit-host-ingest-computes-grounding:not-yet-satisfied";

interface HostTask {
  readonly task_id: string;
  readonly unit_id: string;
  readonly pass_id: string;
  readonly lens: string;
  readonly file_paths: readonly string[];
  readonly file_line_counts: Readonly<Record<string, number>>;
  readonly rationale: string;
  readonly priority: string;
  readonly complexity: string;
  readonly risk: string;
  readonly token_estimate: number;
}

interface HostWorkItem {
  readonly id: string;
  readonly lens: string;
  readonly prompt: { readonly sha256: string; readonly text: string };
  readonly scope: {
    readonly files: readonly string[];
    readonly unit_ids: readonly string[];
  };
  readonly result_path: string;
}

interface PreparedHandoff {
  readonly workload: {
    readonly run_id: string;
    readonly work_items: readonly HostWorkItem[];
  };
}

interface IngestIssue {
  readonly code: string;
  readonly message: string;
  readonly work_item_id?: string;
  readonly result_path?: string;
}

interface IngestedFinding {
  readonly id: string;
  readonly grounding?: { readonly status: string; readonly reason?: string };
}

interface IngestedResult {
  readonly findings: readonly IngestedFinding[];
}

interface IngestSummary {
  readonly accepted_count: number;
  readonly accepted_results: readonly IngestedResult[];
  readonly completed_work_item_ids: readonly string[];
  readonly issues?: readonly IngestIssue[];
}

interface HostBoundary {
  readonly prepareAuditHostHandoff: (input: {
    readonly root: string;
    readonly artifactsDir: string;
    readonly runId: string;
    readonly tasks: readonly HostTask[];
  }) => Promise<PreparedHandoff>;
  readonly ingestAuditHostResults: (input: {
    readonly root: string;
    readonly artifactsDir: string;
    readonly runId: string;
  }) => Promise<IngestSummary>;
}

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function loadBoundary(): Promise<HostBoundary> {
  const loaded = (await import(
    "../../src/audit/cli/dispatch.js"
  )) as unknown as Partial<HostBoundary>;
  if (
    typeof loaded.prepareAuditHostHandoff !== "function" ||
    typeof loaded.ingestAuditHostResults !== "function"
  ) {
    throw new Error(
      `${FAILURE_SIGNATURE}: prepareAuditHostHandoff/ingestAuditHostResults exports are absent`,
    );
  }
  return loaded as HostBoundary;
}

function task(id: string, lens: string, path: string): HostTask {
  return {
    task_id: id,
    unit_id: `unit-${id}`,
    pass_id: `pass:${lens}`,
    lens,
    file_paths: [path],
    file_line_counts: { [path]: 2 },
    rationale: `Review ${path}`,
    priority: "medium",
    complexity: "standard",
    risk: "medium",
    token_estimate: 1200,
  };
}

/** A repo with one file (`src/a.ts` = "one\ntwo\n") and one published work item. */
async function publishOneWorkItem(): Promise<{
  boundary: HostBoundary;
  root: string;
  artifactsDir: string;
  runId: string;
  item: HostWorkItem;
  resultPath: string;
}> {
  const boundary = await loadBoundary();
  const root = await mkdtemp(join(tmpdir(), "audit-ingest-grounding-"));
  cleanupRoots.push(root);
  const artifactsDir = join(root, ".audit-tools", "audit");
  const runId = "host-run-ingest-grounding";

  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "one\ntwo\n", "utf8");

  const prepared = await boundary.prepareAuditHostHandoff({
    root,
    artifactsDir,
    runId,
    tasks: [task("audit-task-a", "correctness", "src/a.ts")],
  });
  const item = prepared.workload.work_items.find((entry) => entry.id === "audit-task-a");
  expect(item, "prepare must publish the single pending work item").toBeDefined();
  const resolved = item as HostWorkItem;
  const resultPath = isAbsolute(resolved.result_path)
    ? resolve(resolved.result_path)
    : resolve(root, resolved.result_path);
  await mkdir(join(resultPath, ".."), { recursive: true });
  return { boundary, root, artifactsDir, runId, item: resolved, resultPath };
}

async function submitFinding(
  published: Awaited<ReturnType<typeof publishOneWorkItem>>,
  finding: Record<string, unknown>,
): Promise<IngestSummary> {
  await writeFile(
    published.resultPath,
    JSON.stringify({
      contract_version: "audit-host-result/v1alpha1",
      result_id: "result-audit-task-a",
      run_id: published.runId,
      work_item_id: published.item.id,
      prompt_sha256: published.item.prompt.sha256,
      file_coverage: [{ path: "src/a.ts", reviewed_lines: 2, total_lines: 2 }],
      findings: [finding],
    }),
    "utf8",
  );
  return await published.boundary.ingestAuditHostResults({
    root: published.root,
    artifactsDir: published.artifactsDir,
    runId: published.runId,
  });
}

function baseFinding(
  affectedFiles: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return {
    id: "F-1",
    title: "A finding",
    category: "correctness",
    severity: "medium",
    confidence: "medium",
    lens: "correctness",
    summary: "A summary long enough to be realistic.",
    affected_files: affectedFiles,
    evidence: ["src/a.ts:1 - boundary"],
  };
}

describe(FAILURE_SIGNATURE, () => {
  it("T1: stamps `ungrounded` when the cited quote is absent from disk", async () => {
    const published = await publishOneWorkItem();
    const ingest = await submitFinding(
      published,
      baseFinding([{ path: "src/a.ts", quoted_text: "text absent from disk" }]),
    );

    expect(
      ingest.issues ?? [],
      "a failed quote must NOT reject the submission — it is surfaced, not refused",
    ).toEqual([]);
    expect(ingest.accepted_count).toBe(1);
    const grounding = ingest.accepted_results[0]?.findings[0]?.grounding;
    expect(
      grounding,
      "ingest must COMPUTE a grounding verdict for every accepted finding",
    ).toBeDefined();
    expect(grounding?.status).toBe("ungrounded");
    expect(grounding?.reason).toMatch(/quoted_text not found on disk/u);
  });

  it("T2: stamps `grounded` when the cited quote content-matches disk", async () => {
    const published = await publishOneWorkItem();
    const ingest = await submitFinding(
      published,
      baseFinding([{ path: "src/a.ts", quoted_text: "one\ntwo" }]),
    );

    expect(ingest.accepted_count).toBe(1);
    expect(ingest.accepted_results[0]?.findings[0]?.grounding).toEqual({
      status: "grounded",
    });
  });

  it("T3: refuses a submission that SUPPLIES its own grounding verdict", async () => {
    const published = await publishOneWorkItem();
    const ingest = await submitFinding(published, {
      ...baseFinding([{ path: "src/a.ts", quoted_text: "one\ntwo" }]),
      grounding: { status: "grounded" },
    });

    expect(
      ingest.completed_work_item_ids,
      "a self-reported grounding verdict must not be accepted",
    ).toEqual([]);
    const issue = (ingest.issues ?? [])[0];
    expect(issue, `the rejection must be classified: ${JSON.stringify(ingest.issues)}`)
      .toBeDefined();
    expect(issue?.code).toBe("submission_contract_invalid");
    expect(issue?.message).toMatch(/findings\[0\]\.grounding/u);
    expect(issue?.message).toMatch(/tool-computed/u);
  });

  it("T4: stamps `ungrounded` when no affected_files entry carries a quote", async () => {
    const published = await publishOneWorkItem();
    const ingest = await submitFinding(published, baseFinding([{ path: "src/a.ts" }]));

    expect(ingest.accepted_count).toBe(1);
    const grounding = ingest.accepted_results[0]?.findings[0]?.grounding;
    expect(grounding?.status).toBe("ungrounded");
    expect(grounding?.reason).toMatch(
      /no affected_files entry carries a verbatim quoted_text/u,
    );
  });

  it("T5: the worker-facing finding schema does not advertise `grounding`", async () => {
    const { renderWorkerJsonSchema } = await import(
      "../../src/audit/contracts/workerSchemas.js"
    );
    const schema = renderWorkerJsonSchema("finding.schema.json");
    const properties = schema.properties as Record<string, unknown>;
    expect(
      Object.keys(properties),
      "a worker must not be told it may supply a grounding verdict",
    ).not.toContain("grounding");
  });

  it("T6: the dispatch prompt states that grounding must not be supplied", async () => {
    const published = await publishOneWorkItem();
    expect(published.item.prompt.text).toMatch(/grounding/u);
    expect(published.item.prompt.text).toMatch(
      /Do not supply a `grounding` field/u,
    );
  });
});

// The CLI batch lane (`audit-code ingest-results --batch-results <dir>`) is the
// SECOND worker door into the same ledger: it bypasses `ingestAuditHostResults`
// entirely, so a self-reported verdict entered there untouched. It closes by
// RECOMPUTE-OVERWRITE rather than refusal — the same directory also carries
// results a previous ingest already grounded, and refusing those would reject a
// legitimate re-import. `stampToolComputedGrounding` is the mechanism
// `ingestBatchAuditResults` applies to every payload before validation.
describe("contract:audit-batch-lane-recomputes-grounding:not-yet-satisfied", () => {
  it("overwrites a worker's self-reported verdict with the tool's own re-check", async () => {
    const { stampToolComputedGrounding } = await import(
      "../../src/audit/cli/auditStep.js"
    );
    const root = await mkdtemp(join(tmpdir(), "audit-batch-grounding-"));
    cleanupRoots.push(root);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "one\ntwo\n", "utf8");

    const results = [
      {
        task_id: "u1:correctness",
        findings: [
          {
            id: "F-lie",
            // A worker CLAIMS grounded while citing a span that is not on disk.
            grounding: { status: "grounded" },
            affected_files: [{ path: "src/a.ts", quoted_text: "absent span" }],
          },
          {
            id: "F-true",
            grounding: { status: "ungrounded", reason: "self-reported" },
            affected_files: [{ path: "src/a.ts", quoted_text: "one\ntwo" }],
          },
        ],
      },
    ];

    await stampToolComputedGrounding(root, results);

    expect(results[0].findings[0].grounding).toEqual({
      status: "ungrounded",
      reason: "src/a.ts: quoted_text not found on disk",
    });
    expect(results[0].findings[1].grounding).toEqual({ status: "grounded" });
  });

  it("tolerates a malformed payload so it still fails at the validation gate", async () => {
    const { stampToolComputedGrounding } = await import(
      "../../src/audit/cli/auditStep.js"
    );
    const root = await mkdtemp(join(tmpdir(), "audit-batch-grounding-bad-"));
    cleanupRoots.push(root);

    await expect(
      stampToolComputedGrounding(root, [
        null,
        "not an object",
        { findings: "not an array" },
        { findings: [null, 7] },
        {},
      ]),
    ).resolves.toBeUndefined();
  });
});
