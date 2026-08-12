import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// P25-d / R6 — the audit host-result ingest must CLASSIFY a failed read, not
// collapse it to `null`. At HEAD `readSubmittedResult`
// (src/audit/cli/dispatch/hostHandoff.ts) returns `null` for a missing file, an
// unparseable file, a contract-invalid body and a failed `toAuditResult`
// alike, and `AuditHostIngestSummary` carries no `issues` field at all — so a
// host that never wrote its result and a host that wrote garbage are
// indistinguishable to every caller.
//
// Vocabulary is the shared submission_* union (BRIEF D5), NOT remediate's
// legacy `result_missing` / `result_malformed`.
const FAILURE_SIGNATURE = "contract:audit-ingest-classifies-submissions:not-yet-satisfied";

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

// Declared locally (structurally narrower than the real, `readonly`-typed
// summary) so the test tree keeps typechecking at HEAD and the red is the
// runtime property, not a compile error.
interface IngestIssue {
  readonly code: string;
  readonly message: string;
  readonly work_item_id?: string;
  readonly result_path?: string;
}

interface IngestSummary {
  readonly accepted_count: number;
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

/** Resolve a work item's tool-owned result path against the repo root. */
function absoluteResultPath(root: string, item: HostWorkItem): string {
  return isAbsolute(item.result_path)
    ? resolve(item.result_path)
    : resolve(root, item.result_path);
}

function issueCodes(summary: IngestSummary): readonly string[] {
  expect(
    Array.isArray(summary.issues),
    "AuditHostIngestSummary must carry a classified `issues` array — a failed " +
      "read may not collapse into silence",
  ).toBe(true);
  return (summary.issues ?? []).map((issue) => issue.code);
}

function issueFor(summary: IngestSummary, code: string): IngestIssue {
  const found = (summary.issues ?? []).find((issue) => issue.code === code);
  expect(found, `no issue with code '${code}' in ${JSON.stringify(summary.issues)}`).toBeDefined();
  return found as IngestIssue;
}

describe(FAILURE_SIGNATURE, () => {
  it("classifies a malformed bound submission and, separately, an absent one", async () => {
    const boundary = await loadBoundary();
    const root = await mkdtemp(join(tmpdir(), "audit-ingest-issue-codes-"));
    cleanupRoots.push(root);
    const artifactsDir = join(root, ".audit-tools", "audit");
    const runId = "host-run-issue-codes";

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
    const resultPath = absoluteResultPath(root, item as HostWorkItem);
    await mkdir(join(resultPath, ".."), { recursive: true });

    // (a) Malformed bytes at the bound path.
    await writeFile(resultPath, "{ malformed", "utf8");
    const malformed = await boundary.ingestAuditHostResults({ root, artifactsDir, runId });
    expect(malformed.completed_work_item_ids).toEqual([]);
    expect(issueCodes(malformed)).toContain("submission_malformed");
    const malformedIssue = issueFor(malformed, "submission_malformed");
    expect(malformedIssue.work_item_id).toBe("audit-task-a");
    expect(
      (malformedIssue.result_path ?? "").replaceAll("\\", "/"),
      "the malformed issue must name the bound result path",
    ).toContain(
      relative(root, resultPath).replaceAll("\\", "/"),
    );

    // (b) Nothing at the bound path at all — a distinct code, not the same silence.
    await rm(resultPath, { force: true });
    const missing = await boundary.ingestAuditHostResults({ root, artifactsDir, runId });
    expect(missing.completed_work_item_ids).toEqual([]);
    expect(issueCodes(missing)).toContain("submission_missing");
    const missingIssue = issueFor(missing, "submission_missing");
    expect(missingIssue.work_item_id).toBe("audit-task-a");
    expect(missingIssue.result_path, "the missing issue must name the path it looked at")
      .toBeTruthy();

    // The two failures must never share a code — that collapse is the defect.
    expect(issueCodes(missing)).not.toContain("submission_malformed");
  });
});
