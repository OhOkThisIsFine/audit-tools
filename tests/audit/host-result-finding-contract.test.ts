import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { validateAuditResults } from "../../src/audit/validation/auditResults.js";
import type { AuditTask } from "../../src/audit/types.js";

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
  readonly accepted_results?: readonly Record<string, unknown>[];
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
            title: "Off-vocabulary lens",
            category: "correctness",
            severity: "medium",
            confidence: "medium",
            evidence: ["src/a.ts:1 - boundary"],
            summary: "The finding cites a lens outside the closed vocabulary.",
            // An OMITTED lens is legal under the worker projection (it defaults
            // from the enclosing AuditResult); a WRONG lens — outside the
            // closed LensSchema vocabulary — is what the schema refuses here,
            // and the refusal must name findings[0].lens.
            lens: "vibes",
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

  it("states every finding-level rule the downstream validator enforces", async () => {
    const published = await publishOneWorkItem();
    const prompt = published.item.prompt.text;

    // Scoped to the finding-contract lines, so a field name that merely occurs
    // elsewhere in the prompt (`task_id`, `result_id`) cannot satisfy this.
    const contractBlock = prompt
      .split("\n")
      .filter((line) => /finding/iu.test(line) && !line.startsWith("Assignment:"))
      .join("\n");

    // Derived from the schema INGESTION enforces, so this list cannot drift
    // from it. The base FindingSchema is the shared core (remediate draws on it
    // too); the audit draw's strictness lives in the worker projection.
    const { WorkerFindingSchema } = await import(
      "../../src/audit/contracts/workerSchemas.js"
    );
    const required = Object.entries(WorkerFindingSchema.shape)
      .filter(([, field]) => !field.isOptional())
      .map(([name]) => name);
    expect(required.length, "WorkerFindingSchema must have required fields").toBeGreaterThan(0);
    expect(required, "evidence is required of the audit draw").toContain("evidence");
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

    // Every min(1) constraint the projection enforces — required or optional,
    // array or string — is stated in the prompt, detected FROM the schema node
    // (zodToJsonSchema emits minItems/minLength) rather than a hand list.
    const { zodToJsonSchema } = await import("zod-to-json-schema");
    const schema = (zodToJsonSchema as (s: unknown, o: object) => { properties: Record<string, { type?: string; minItems?: number; minLength?: number }> })(
      WorkerFindingSchema,
      { $refStrategy: "none", target: "jsonSchema7" },
    );
    const constrained = Object.entries(schema.properties)
      .filter(([, node]) => (node.minItems ?? 0) >= 1 || (node.minLength ?? 0) >= 1)
      .map(([name]) => name);
    expect(constrained, "the schema must constrain some fields to non-empty").toContain("evidence");
    expect(constrained).toContain("reproduction");
    expect(constrained).toContain("related_findings");
    expect(constrained).toContain("category");
    for (const field of constrained) {
      expect(
        contractBlock,
        `the prompt must state that '${field}' is non-empty — it carries a min(1) constraint`,
      ).toMatch(new RegExp(`${field}[^\\n]*non-empty`, "u"));
    }

    // The line-span rules are enforced by the shared location refinement; the
    // exported rule constants ARE their statements, so each must appear in the
    // rendered contract block read from those constants (no hand-typed text).
    const {
      FINDING_LINE_START_INTEGER_RULE,
      FINDING_LINE_END_INTEGER_RULE,
      FINDING_LINE_ORDER_RULE,
    } = await import("../../src/shared/types/finding.js");
    for (const rule of [
      FINDING_LINE_START_INTEGER_RULE,
      FINDING_LINE_END_INTEGER_RULE,
      FINDING_LINE_ORDER_RULE,
    ]) {
      expect(prompt, `the dispatch prompt must state the line-span rule: ${rule}`).toContain(rule);
    }

    // The non-schema rules live in ONE registry; the prompt carries each
    // statement verbatim and the validator emits it verbatim.
    const { AUDIT_RESULT_RULES } = await import(
      "../../src/audit/validation/auditResults.js"
    );
    expect(AUDIT_RESULT_RULES.length, "the rule registry must be non-empty").toBeGreaterThan(0);
    for (const rule of AUDIT_RESULT_RULES as readonly { id: string; statement: string }[]) {
      expect(
        prompt,
        `the dispatch prompt must carry rule '${rule.id}' verbatim`,
      ).toContain(rule.statement);
    }
  });

  it("refuses a submission carrying exactly what today's prompt demanded (no evidence)", async () => {
    const published = await publishOneWorkItem();
    // Schema-required fields only — no `evidence`. This is what a worker that
    // OBEYS the old prompt produces: accepted by ingestion, then failed by
    // validateEvidence downstream. Ingestion parses the same projection the
    // prompt renders, so an evidence-less finding must be refused HERE.
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
            title: "Obeys the old prompt",
            category: "correctness",
            severity: "medium",
            confidence: "medium",
            lens: "correctness",
            summary: "A finding with every base-required field but no evidence.",
            affected_files: [{ path: "src/a.ts", line_start: 1, line_end: 2 }],
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
    expect(ingest.accepted_count).toBe(0);
    const issue = (ingest.issues ?? []).find(
      (entry) => entry.work_item_id === "audit-task-a",
    );
    expect(issue, `an evidence-less finding must be refused: ${JSON.stringify(ingest.issues)}`)
      .toBeDefined();
    expect((issue as IngestIssue).message).toMatch(/findings\[0\][^\s]*evidence/u);

    // A corrected submission that carries evidence IS accepted, and the
    // downstream audit-results validation over it yields zero errors.
    await writeFile(
      published.resultPath,
      JSON.stringify({
        contract_version: "audit-host-result/v1alpha1",
        result_id: "result-audit-task-a-2",
        run_id: published.runId,
        work_item_id: published.item.id,
        prompt_sha256: published.item.prompt.sha256,
        file_coverage: [{ path: "src/a.ts", reviewed_lines: 2, total_lines: 2 }],
        findings: [
          {
            id: "F-2",
            title: "Carries its evidence",
            category: "correctness",
            severity: "medium",
            confidence: "medium",
            lens: "correctness",
            summary: "A complete finding under the one-source contract.",
            affected_files: [{ path: "src/a.ts", line_start: 1, line_end: 2 }],
            evidence: ["src/a.ts:1 - variable overwritten before use"],
          },
        ],
      }),
      "utf8",
    );
    const accepted = await published.boundary.ingestAuditHostResults({
      root: published.root,
      artifactsDir: published.artifactsDir,
      runId: published.runId,
      auditTasks: [task("audit-task-a", "correctness", "src/a.ts")],
    });
    expect(accepted.accepted_count).toBe(1);
    expect(accepted.completed_work_item_ids).toEqual(["audit-task-a"]);
    const auditTask: AuditTask = {
      task_id: "audit-task-a",
      unit_id: "unit-audit-task-a",
      pass_id: "pass:correctness",
      lens: "correctness",
      file_paths: ["src/a.ts"],
      rationale: "Review src/a.ts",
    };
    const issues = validateAuditResults(accepted.accepted_results, [auditTask], {});
    const errors = issues.filter((entry) => entry.severity === "error");
    expect(errors, `a prompt-obedient submission must validate clean: ${JSON.stringify(issues)}`).toEqual([]);
  });

  it("refuses an inverted or non-integer line span with the one rule wording", async () => {
    const published = await publishOneWorkItem();
    for (const affectedFiles of [
      [{ path: "src/a.ts", line_start: 3, line_end: 1 }],
      [{ path: "src/a.ts", line_start: 1.5 }],
    ]) {
      await writeFile(
        published.resultPath,
        JSON.stringify({
          contract_version: "audit-host-result/v1alpha1",
          result_id: `result-audit-task-a-${JSON.stringify(affectedFiles)}`,
          run_id: published.runId,
          work_item_id: published.item.id,
          prompt_sha256: published.item.prompt.sha256,
          file_coverage: [{ path: "src/a.ts", reviewed_lines: 2, total_lines: 2 }],
          findings: [
            {
              id: "F-span",
              title: "Bad span",
              category: "correctness",
              severity: "medium",
              confidence: "medium",
              lens: "correctness",
              summary: "The cited line span violates a stated rule.",
              affected_files: affectedFiles,
              evidence: ["src/a.ts:1 - boundary"],
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
      expect(
        ingest.completed_work_item_ids,
        `an invalid span must be refused: ${JSON.stringify(affectedFiles)}`,
      ).toEqual([]);
      const issue = (ingest.issues ?? []).find(
        (entry) => entry.work_item_id === "audit-task-a",
      );
      expect(issue, `the rejection must be classified: ${JSON.stringify(ingest.issues)}`).toBeDefined();
      const message = (issue as IngestIssue).message;
      expect(message).toMatch(/findings\[0\]\.affected_files\.0/u);
      expect(message, `one wording per rule: ${message}`).toMatch(/line_start/u);
    }
  });

  it("refuses an inverted span through the BATCH door with the same rule wording", async () => {
    // The batch lane (`ingest-results`) feeds raw payloads to
    // `validateAuditResults` WITHOUT a worker-projection parse, so deleting the
    // validator's span checks left that door weaker than the host door. The
    // validator must enforce the line rules itself via the ONE shared predicate.
    const task: AuditTask = {
      task_id: "audit-task-a",
      unit_id: "unit-audit-task-a",
      pass_id: "pass:correctness",
      lens: "correctness",
      file_paths: ["src/a.ts"],
      rationale: "Review src/a.ts",
    };
    for (const affectedFiles of [
      [{ path: "src/a.ts", line_start: 3, line_end: 1 }],
      [{ path: "src/a.ts", line_start: 1.5 }],
    ]) {
      const issues = validateAuditResults(
        [
          {
            task_id: "audit-task-a",
            unit_id: "unit-audit-task-a",
            pass_id: "pass:correctness",
            lens: "correctness",
            file_coverage: [{ path: "src/a.ts", total_lines: 2 }],
            findings: [
              {
                id: "F-batch",
                title: "Bad span through batch",
                category: "correctness",
                severity: "medium",
                confidence: "medium",
                lens: "correctness",
                summary: "An inverted span must error on the batch lane too.",
                affected_files: affectedFiles,
                evidence: ["src/a.ts:1 - boundary"],
              },
            ],
          },
        ],
        [task],
        {},
      );
      const spanIssues = issues.filter((entry) =>
        /affected_files\[0\]\.line_(start|end)$/.test(entry.field),
      );
      expect(
        spanIssues,
        `an invalid span must yield a location-line issue through the batch door: ${JSON.stringify(affectedFiles)}`,
      ).not.toEqual([]);
      expect(spanIssues.every((entry) => entry.severity === "error")).toBe(true);
      const {
        FINDING_LINE_START_INTEGER_RULE,
        FINDING_LINE_END_INTEGER_RULE,
        FINDING_LINE_ORDER_RULE,
      } = await import("../../src/shared/types/finding.js");
      const statements = [FINDING_LINE_START_INTEGER_RULE, FINDING_LINE_END_INTEGER_RULE, FINDING_LINE_ORDER_RULE];
      for (const issue of spanIssues) {
        expect(
          statements.some((statement) => issue.message.includes(statement)),
          `the issue message must carry the shared rule wording verbatim: ${issue.message}`,
        ).toBe(true);
      }
    }
  });
});
