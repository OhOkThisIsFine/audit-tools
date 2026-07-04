import { test, expect, describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  WORKER_SCHEMA_SOURCES,
  renderWorkerJsonSchema,
  WorkerAuditResultsSchema,
  WorkerAuditResultSchema,
  WorkerFindingSchema,
  WorkerAuditTaskSchema,
} from "../../src/audit/contracts/workerSchemas.ts";
import { LensSchema } from "audit-tools/shared";

const schemasDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "schemas",
);

// A6 drift guard: the committed worker-facing JSON schemas are generated from
// their zod sources. If a contract changes and `generate-schemas.mjs` was not
// rerun, the committed file diverges from what the source would render — this
// test catches it so the JSON schema can never drift from the TypeScript type.
describe("committed worker schemas match their zod sources (run generate-schemas.mjs)", () => {
  for (const filename of Object.keys(WORKER_SCHEMA_SOURCES)) {
    it(filename, async () => {
      const committed = JSON.parse(
        await readFile(join(schemasDir, filename), "utf8"),
      );
      const regenerated = renderWorkerJsonSchema(filename);
      expect(committed, `schemas/${filename} is stale — run \`node --import tsx/esm scripts/audit/generate-schemas.mjs\``).toEqual(regenerated);
    });
  }
});

// The worker contract is validated against the zod SOURCE (not the JSON file):
// the JSON file is a generated projection of this schema, guarded above.
test("worker schemas accept a valid worker submission and reject invalid lens", () => {
  const validResult = {
    task_id: "task-1",
    unit_id: "unit-1",
    pass_id: "pass:security",
    lens: "security",
    file_coverage: [{ path: "src/api/auth.ts", total_lines: 12 }],
    findings: [
      {
        id: "finding-1",
        title: "Auth bypass",
        category: "command-execution",
        severity: "high",
        confidence: "high",
        lens: "security",
        summary: "Token boundary not enforced.",
        affected_files: [{ path: "src/api/auth.ts", line_start: 1 }],
        evidence: ["src/api/auth.ts:1 - missing check"],
      },
    ],
  };
  assert.doesNotThrow(() => WorkerAuditResultsSchema.parse([validResult]));

  // Bogus lens rejected (canonical enum).
  assert.throws(() =>
    WorkerAuditResultSchema.parse({
      ...validResult,
      findings: [{ ...validResult.findings[0], lens: "bogus" }],
    }),
  );

  // Empty findings array is allowed; empty file_coverage is not.
  assert.doesNotThrow(() =>
    WorkerAuditResultSchema.parse({ ...validResult, findings: [] }),
  );
  assert.throws(() =>
    WorkerAuditResultSchema.parse({ ...validResult, file_coverage: [] }),
  );

  // A finding missing evidence is rejected (worker must cite evidence).
  assert.throws(() =>
    WorkerFindingSchema.parse({
      id: "f",
      title: "t",
      category: "c",
      severity: "high",
      confidence: "high",
      lens: "security",
      summary: "s",
      affected_files: [{ path: "x" }],
    }),
  );

  // Unknown top-level key rejected (additionalProperties: false / .strict()).
  assert.throws(() =>
    WorkerAuditTaskSchema.parse({
      task_id: "t",
      unit_id: "u",
      pass_id: "p",
      lens: "security",
      file_paths: ["a"],
      rationale: "r",
      unexpected: true,
    }),
  );

  expect(LensSchema.options.length).toEqual(11);
});

// INV-SCHEMA-COMMIT-ATOMIC (C-002): a worker line_range must be ordered — end >= start.
// The refinement lives on WorkerAuditTaskSchema.line_ranges[] in workerSchemas.ts;
// this guards it so an inverted span (end < start) can never slip through validation.
test("WorkerAuditTaskSchema line_ranges enforces end >= start", () => {
  const baseTask = {
    task_id: "t",
    unit_id: "u",
    pass_id: "p",
    lens: "security",
    file_paths: ["src/a.ts"],
    rationale: "r",
  };

  // Ordered range (end >= start) accepted, including the degenerate equal case.
  assert.doesNotThrow(() =>
    WorkerAuditTaskSchema.parse({
      ...baseTask,
      line_ranges: [{ path: "src/a.ts", start: 3, end: 7 }],
    }),
  );
  assert.doesNotThrow(() =>
    WorkerAuditTaskSchema.parse({
      ...baseTask,
      line_ranges: [{ path: "src/a.ts", start: 5, end: 5 }],
    }),
  );

  // Inverted range (end < start) rejected by the refinement.
  assert.throws(
    () =>
      WorkerAuditTaskSchema.parse({
        ...baseTask,
        line_ranges: [{ path: "src/a.ts", start: 9, end: 2 }],
      }),
    /line range end must be >= start/,
  );
});
