import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Finding,
} from "../../src/audit/types.js";
import type { AuditReportModel } from "../../src/audit/reporting/synthesis.js";
import { loadSessionIntent } from "../../src/shared/sessionConfig.js";

const { validateAuditResults }: typeof import(
  "../../src/audit/validation/auditResults.js"
) = await import("../../src/audit/validation/auditResults.js");
const { buildAuditReportModel: buildAuditReportModelRaw }: typeof import(
  "../../src/audit/reporting/synthesis.js"
) = await import("../../src/audit/reporting/synthesis.js");
const buildAuditReportModel = (
  params: Parameters<typeof buildAuditReportModelRaw>[0],
) => buildAuditReportModelRaw(params);
const { buildRequeuePayload }: typeof import(
  "../../src/audit/orchestrator/requeueCommand.js"
) = await import("../../src/audit/orchestrator/requeueCommand.js");
function requireFirstFinding(
  report: AuditReportModel,
  message: string,
): asserts report is AuditReportModel & {
  findings: [Finding, ...Finding[]];
} {
  if (report.findings.length === 0) {
    throw new Error(message);
  }
}

test("validateAuditResults reports field-level evidence type errors instead of crashing", () => {
  const issues = validateAuditResults(
    [
      {
        task_id: "task-1",
        unit_id: "unit-1",
        pass_id: "pass:security",
        lens: "security",
        file_coverage: [{ path: "src/api/auth.ts", total_lines: 10 }],
        findings: [
          {
            id: "finding-1",
            title: "Object evidence",
            category: "security",
            severity: "high",
            confidence: "high",
            lens: "security",
            summary: "Evidence payload shape is wrong.",
            affected_files: [{ path: "src/api/auth.ts", line_start: 1 }],
            evidence: [{ excerpt: "bad", line_reference: "src/api/auth.ts:1" }],
          },
        ],
      },
    ],
    [
      {
        task_id: "task-1",
        unit_id: "unit-1",
        pass_id: "pass:security",
        lens: "security",
        file_paths: ["src/api/auth.ts"],
        rationale: "fixture",
      },
    ],
  );

  expect(issues.some(
      (issue) =>
        issue.field === "findings[0].evidence[0]" &&
        /must be a string, got object/i.test(issue.message),
    )).toBeTruthy();
});

test("validateAuditResults treats total_lines as advisory (S7) but still flags spans outside declared coverage", () => {
  const issues = validateAuditResults(
    [
      {
        task_id: "task-1",
        unit_id: "unit-1",
        pass_id: "pass:security",
        lens: "security",
        file_coverage: [{ path: "src/api/auth.ts", total_lines: 10 }],
        findings: [
          {
            id: "finding-1",
            title: "Out of range evidence",
            category: "security",
            severity: "medium",
            confidence: "high",
            lens: "security",
            summary: "The finding points at lines the worker did not claim to read.",
            affected_files: [{ path: "src/api/auth.ts", line_start: 12 }],
            evidence: ["src/api/auth.ts:12 - cited outside file coverage"],
          },
        ],
      },
    ],
    [
      {
        task_id: "task-1",
        unit_id: "unit-1",
        pass_id: "pass:security",
        lens: "security",
        file_paths: ["src/api/auth.ts"],
        rationale: "fixture",
      },
    ],
    {
      lineIndex: { "src/api/auth.ts": 12 },
    },
  );

  // S7: a total_lines mismatch is now an advisory WARNING, not a gating error —
  // findings are grounded by quote-and-verify, not by attesting a line count.
  expect(issues.some(
      (issue) =>
        issue.field === "file_coverage[0].total_lines" &&
        issue.severity === "warning" &&
        /does not match the current line count/i.test(issue.message),
    )).toBeTruthy();
  // The cited-span-within-declared-coverage check is unchanged (still an error);
  // the message is the REGISTRY statement (the same sentence the dispatch prompt
  // carries), not a per-site paraphrase.
  expect(issues.some(
      (issue) =>
        issue.field === "findings[0].affected_files[0]" &&
        /must fall inside the declared file_coverage/i.test(issue.message),
    )).toBeTruthy();
});

test("validateAuditResults rejects task metadata drift and out-of-scope coverage", () => {
  const issues = validateAuditResults(
    [
      {
        task_id: "task-1",
        unit_id: "wrong-unit",
        pass_id: "pass:correctness",
        lens: "correctness",
        file_coverage: [
          { path: "src/api/auth.ts", total_lines: 10 },
          { path: "src/other.ts", total_lines: 5 },
        ],
        findings: [
          {
            id: "finding-1",
            title: "Boundary drift",
            category: "security",
            severity: "high",
            confidence: "high",
            lens: "performance",
            summary: "The finding tries to escape the assigned task boundary.",
            affected_files: [{ path: "src/other.ts" }],
            evidence: ["src/other.ts:1 - outside the assigned review packet"],
          },
        ],
      },
    ],
    [
      {
        task_id: "task-1",
        unit_id: "unit-1",
        pass_id: "pass:security",
        lens: "security",
        file_paths: ["src/api/auth.ts"],
        rationale: "fixture",
      },
    ],
    {
      lineIndex: {
        "src/api/auth.ts": 10,
        "src/other.ts": 5,
      },
    },
  );

  expect(issues.some(
      (issue) =>
        issue.field === "unit_id" &&
        /must match the assigned task metadata/i.test(issue.message),
    )).toBeTruthy();
  expect(issues.some(
      (issue) =>
        issue.field === "pass_id" &&
        /must match the assigned task metadata/i.test(issue.message),
    )).toBeTruthy();
  expect(issues.some(
      (issue) =>
        issue.field === "lens" &&
        /must match the assigned task metadata/i.test(issue.message),
    )).toBeTruthy();
  expect(issues.some(
      (issue) =>
        issue.field === "file_coverage[1].path" &&
        issue.severity === "error" &&
        /not listed in the task file_paths/i.test(issue.message),
    )).toBeTruthy();
  expect(issues.some(
      (issue) =>
        issue.field === "findings[0].lens" &&
        /must match the assigned task lens/i.test(issue.message),
    )).toBeTruthy();
  expect(issues.some(
      (issue) =>
        issue.field === "findings[0].affected_files[0].path" &&
        /not in the declared assigned file_coverage/i.test(issue.message),
    )).toBeTruthy();
});

test("validateAuditResults accepts zero-line file coverage for empty files", () => {
  const issues = validateAuditResults(
    [
      {
        task_id: "task-empty",
        unit_id: "unit-empty",
        pass_id: "pass:reliability",
        lens: "reliability",
        file_coverage: [{ path: "src/empty.ts", total_lines: 0 }],
        findings: [],
        reviewed_clean: true,
      },
    ],
    [
      {
        task_id: "task-empty",
        unit_id: "unit-empty",
        pass_id: "pass:reliability",
        lens: "reliability",
        file_paths: ["src/empty.ts"],
        rationale: "fixture",
      },
    ],
    {
      lineIndex: { "src/empty.ts": 0 },
    },
  );

  expect(issues).toEqual([]);
});

test("buildAuditReportModel omits pending runtime placeholder noise and builds deterministic work blocks", () => {
  const report = buildAuditReportModel({
    results: [
      {
        task_id: "task-1",
        unit_id: "src-api-auth",
        pass_id: "pass:security",
        lens: "security",
        file_coverage: [{ path: "src/api/auth.ts", total_lines: 10 }],
        findings: [
          {
            id: "finding-1",
            title: "Missing audit trail",
            category: "security",
            severity: "medium",
            confidence: "medium",
            lens: "security",
            summary: "Authentication events are not captured consistently.",
            affected_files: [
              { path: "src/api/auth.ts", line_start: 2, line_end: 8 },
            ],
            evidence: ["src/api/auth.ts:2 - no log emitted"],
          },
        ],
      },
    ],
    unitManifest: {
      units: [
        {
          unit_id: "src-api-auth",
          name: "src-api-auth",
          files: ["src/api/auth.ts"],
          required_lenses: ["security"],
        },
      ],
    },
    runtimeValidationReport: {
      results: [
        {
          task_id: "runtime:unit:src-api-auth",
          status: "pending",
          summary: "Deterministic runtime validation has not executed yet.",
        },
      ],
    },
  });

  expect(report.findings.length).toBe(1);
  expect(report.work_blocks.length).toBe(1);
  requireFirstFinding(report, "expected one report finding");
  if (!report.findings[0].evidence) {
    throw new Error("expected report finding evidence");
  }
  expect(report.findings[0].evidence.some((entry) =>
      /has not executed yet/i.test(entry),
    )).toBe(false);
});

test("buildRequeuePayload skips flow requeue duplicates when file coverage is already complete", () => {
  const payload = buildRequeuePayload(
    {
      files: [
        {
          path: "src/api/auth.ts",
          unit_ids: ["src-api-auth"],
          classification_status: "classified",
          audit_status: "partial",
          required_lenses: ["security", "reliability"],
          completed_lenses: ["security"],
        },
      ],
    },
    {
      flows: [
        {
          id: "auth-session",
          name: "Auth session",
          paths: ["src/api/auth.ts"],
          entrypoints: ["src/api/auth.ts"],
          concerns: ["security"],
        },
      ],
    },
    {
      flows: [
        {
          flow_id: "auth-session",
          status: "pending",
          paths: ["src/api/auth.ts"],
          required_lenses: ["security"],
          completed_lenses: [],
        },
      ],
    },
  );

  expect(payload.tasks.length).toBe(1);
  if (!payload.tasks[0]) {
    throw new Error("expected one requeue task");
  }
  expect(payload.tasks[0].task_id).toBe("requeue:reliability:src/api/auth.ts");
});

test("buildRequeuePayload dedupeByScope merges a file task and flow task sharing a lens+file signature", () => {
  // The file still needs `security`, and the same file in a critical flow also
  // still needs `security`. The file requeue task and the flow requeue task
  // therefore resolve to the identical `lens:sorted(file_paths)` signature
  // (security:src/api/auth.ts) and dedupeByScope must collapse them to one
  // task — while file_task_count / flow_task_count still report the per-source
  // counts before the cross-source merge.
  const payload = buildRequeuePayload(
    {
      files: [
        {
          path: "src/api/auth.ts",
          unit_ids: ["src-api-auth"],
          classification_status: "classified",
          audit_status: "pending",
          required_lenses: ["security"],
          completed_lenses: [],
        },
      ],
    },
    {
      flows: [
        {
          id: "auth-session",
          name: "Auth session",
          paths: ["src/api/auth.ts"],
          entrypoints: ["src/api/auth.ts"],
          concerns: ["security"],
        },
      ],
    },
    {
      flows: [
        {
          flow_id: "auth-session",
          status: "pending",
          paths: ["src/api/auth.ts"],
          required_lenses: ["security"],
          completed_lenses: [],
        },
      ],
    },
  );

  // Cross-source signatures collide -> exactly one merged task.
  expect(payload.tasks.length).toBe(1);
  // Per-source counts reflect the pre-merge totals (one file task, one flow task).
  expect(payload.file_task_count).toBe(1);
  expect(payload.flow_task_count).toBe(1);
});

test("loadSessionIntent defaults a missing canonical intent without writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "audit-code-session-config-"));
  try {
    const artifactsDir = join(root, ".audit-tools", "audit");
    await mkdir(artifactsDir, { recursive: true });
    const config = await loadSessionIntent(root);
    expect(config).toEqual({
      status: "not_configured",
      intent: { review_mode: "attended", observability: "standard" },
    });
    await assert.rejects(readFile(join(artifactsDir, "session-config.json"), "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadSessionIntent reads and returns a pre-existing intent config without clobbering it", async () => {
  const root = await mkdtemp(join(tmpdir(), "audit-code-session-config-"));
  try {
    const artifactsDir = join(root, ".audit-tools", "audit");
    await mkdir(artifactsDir, { recursive: true });
    const original = JSON.stringify({ review_mode: "autonomous" });
    await writeFile(
      join(artifactsDir, "session-config.json"),
      original,
      "utf8",
    );
    const config = await loadSessionIntent(root);
    expect(config).toEqual({
      status: "configured",
      intent: { review_mode: "autonomous", observability: "standard" },
    });
    expect(await readFile(join(artifactsDir, "session-config.json"), "utf8")).toBe(original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadSessionIntent expands defaults for a partial canonical intent", async () => {
  const root = await mkdtemp(join(tmpdir(), "audit-code-session-config-"));
  try {
    const artifactsDir = join(root, ".audit-tools", "audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(artifactsDir, "session-config.json"),
      JSON.stringify({ observability: "verbose" }),
      "utf8",
    );
    const config = await loadSessionIntent(root);
    expect(config).toEqual({
      status: "configured",
      intent: { review_mode: "attended", observability: "verbose" },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadSessionIntent handles malformed JSON in the config file", async () => {
  const root = await mkdtemp(join(tmpdir(), "audit-code-session-config-"));
  try {
    const artifactsDir = join(root, ".audit-tools", "audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(artifactsDir, "session-config.json"),
      "{not json}",
      "utf8",
    );
    // loadSessionIntent must throw — it must not silently swallow a parse error.
    await assert.rejects(
      loadSessionIntent(root),
      (err) => {
        if (!(err instanceof Error)) {
          return false;
        }
        expect(err instanceof Error, "expected an Error to be thrown for malformed JSON").toBeTruthy();
        // The io layer wraps JSON.parse errors with the path in the message.
        expect(err.message.toLowerCase().includes("json") ||
            err.message.includes("session-config.json"), `expected error message to reference JSON or the config file, got: ${err.message}`).toBeTruthy();
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
