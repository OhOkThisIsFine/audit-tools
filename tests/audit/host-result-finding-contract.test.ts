import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// The dogfood lap's four `submission_contract_invalid` rejections were ALL
// finding-schema failures (a missing per-finding `lens`, an `evidence` string
// where an array is required) — yet the issue message named "identity, prompt
// binding, or file coverage", three categories that had passed, and the work
// item's prompt never stated the finding contract it was being judged against.
// Two halves of one auditor-agnostic-robustness defect: the tool must NAME the
// category that failed, and must CARRY the contract it enforces.
const FAILURE_SIGNATURE =
  "contract:audit-host-result-states-and-names-the-finding-contract:not-yet-satisfied";

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
    /** The same manifest prepareAuditHostHandoff published. */
    readonly auditTasks: readonly HostTask[];
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

/** A repo with one file and one published work item, ready to submit against. */
async function publishOneWorkItem(): Promise<{
  boundary: HostBoundary;
  root: string;
  artifactsDir: string;
  runId: string;
  item: HostWorkItem;
  resultPath: string;
}> {
  const boundary = await loadBoundary();
  const root = await mkdtemp(join(tmpdir(), "audit-finding-contract-"));
  cleanupRoots.push(root);
  const artifactsDir = join(root, ".audit-tools", "audit");
  const runId = "host-run-finding-contract";

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

describe(FAILURE_SIGNATURE, () => {
  it("names the FINDINGS contract and the failing field when a finding fails the schema", async () => {
    const published = await publishOneWorkItem();
    // Identity, prompt binding and file coverage are all exactly right; only the
    // finding is short a required field. This is the live-lap shape.
    await writeFile(
      published.resultPath,
      JSON.stringify({
        contract_version: "audit-host-result/v1alpha1",
        result_id: "result-audit-task-a",
        run_id: published.runId,
        work_item_id: published.item.id,
        prompt_sha256: published.item.prompt.sha256,
        file_coverage: [{ path: "src/a.ts", reviewed_lines: 2, total_lines: 2 }],
        findings: [
          {
            id: "F-1",
            title: "Missing lens",
            category: "correctness",
            severity: "medium",
            confidence: "medium",
            summary: "The finding omits the required per-finding lens.",
            affected_files: [{ path: "src/a.ts" }],
          },
        ],
      }),
      "utf8",
    );

    const ingest = await published.boundary.ingestAuditHostResults({
      root: published.root,
      artifactsDir: published.artifactsDir,
      runId: published.runId,
      auditTasks: [task("audit-task-a", "correctness", "src/a.ts")],
    });
    expect(ingest.completed_work_item_ids).toEqual([]);
    const issue = (ingest.issues ?? []).find(
      (entry) => entry.work_item_id === "audit-task-a",
    );
    expect(issue, `the rejection must be classified: ${JSON.stringify(ingest.issues)}`)
      .toBeDefined();
    const message = (issue as IngestIssue).message;

    expect(
      message,
      "the message must say the FINDINGS failed the finding contract",
    ).toMatch(/finding contract/iu);
    expect(
      message,
      "the message must name the failing finding index and field (the zod issue path)",
    ).toMatch(/findings\[0\][^\s]*lens/u);
    expect(
      message,
      "the three categories that PASSED must not be offered as the cause",
    ).not.toMatch(/identity, prompt binding, or file coverage/u);
  });

  it("states the finding contract inline in the work item's dispatch prompt", async () => {
    const published = await publishOneWorkItem();
    const prompt = published.item.prompt.text;

    // Scoped to the finding-contract lines, so a field name that merely occurs
    // elsewhere in the prompt (`task_id`, `result_id`) cannot satisfy this.
    const contractBlock = prompt
      .split("\n")
      .filter((line) => /finding/iu.test(line) && !line.startsWith("Assignment:"))
      .join("\n");

    // Derived from the enforced schema, so this list cannot drift from it.
    const { FindingSchema } = await import("../../src/shared/types/finding.js");
    const required = Object.entries(FindingSchema.shape)
      .filter(([, field]) => !field.isOptional())
      .map(([name]) => name);
    expect(required.length, "FindingSchema must have required fields").toBeGreaterThan(0);
    for (const field of required) {
      expect(
        contractBlock,
        `the dispatch prompt must state required finding field '${field}' — a host cannot ` +
          `comply with a contract the prompt never carries`,
      ).toContain(field);
    }
    // The array-shaped fields are the other measured failure (a string where an
    // array is required), so the prompt must say they are arrays.
    for (const field of ["affected_files", "evidence", "reproduction"]) {
      expect(contractBlock, `the prompt must state the array shape of '${field}'`).toContain(
        field,
      );
    }
    expect(contractBlock, "the prompt must name the array shape explicitly").toMatch(
      /array/iu,
    );
  });
});
