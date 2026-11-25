import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSyncHidden as spawnSync } from "../helpers/spawn.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  WORKER_SCHEMA_SOURCES,
  WorkerAuditResultsSchema,
  WorkerAuditResultSchema,
  WorkerFindingSchema,
  WorkerAuditTaskSchema,
} from "../../src/audit/contracts/workerSchemas.js";
import { LensSchema } from "audit-tools/shared";

const schemasDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "schemas",
);

// Invoke the actual writer once so skipping a registry entry or writing to
// the wrong destination fails even when the underlying renderer is unchanged.
test("schema generator writes the full registered set matching committed files", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "audit-worker-schemas-"));
  try {
    const script = join(schemasDir, "..", "scripts", "audit", "generate-schemas.mjs");
    const result = spawnSync(process.execPath, ["--import", "tsx/esm", script, "--output-dir", outputDir], {
      cwd: join(schemasDir, ".."), encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const expected = Object.keys(WORKER_SCHEMA_SOURCES).sort();
    expect((await readdir(outputDir)).sort()).toEqual(expected);
    for (const filename of expected) {
      const committed = await readFile(join(schemasDir, filename), "utf8");
      const generated = await readFile(join(outputDir, filename), "utf8");
      expect(generated, `schemas/${filename} is stale; run node --import tsx/esm scripts/audit/generate-schemas.mjs`)
        .toBe(committed.replaceAll("\r\n", "\n"));
    }
  } finally {
    await rm(outputDir, { recursive: true, force: true });
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
        affected_files: [
          { path: "src/api/auth.ts", quoted_text: "verifyToken()" },
        ],
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

test("portable finding locations enforce the same nonblank evidence XOR as worker ingestion", async () => {
  const validator = new AjvJsonSchemaValidator();
  const load = async (filename: string) => validator.getValidator(
    JSON.parse(await readFile(join(schemasDir, filename), "utf8")),
  );
  const [findingJson, resultJson, resultsJson] = await Promise.all([
    load("finding.schema.json"), load("audit_result.schema.json"), load("audit_results.schema.json"),
  ]);
  const result = {
    task_id: "task-1", unit_id: "unit-1", pass_id: "pass:behavior",
    lens: "architecture", file_coverage: [{ path: "src/a.ts", total_lines: 1 }],
  };
  const finding = {
    id: "f", title: "title", category: "category", severity: "medium", confidence: "high",
    lens: "architecture", summary: "summary",
  };
  const whitespace = " \t\n\u00a0\u2028\ufeff";
  for (const [quote, declaration, valid] of [
    [undefined, undefined, false], [whitespace, undefined, false],
    [undefined, whitespace, false], ["", "", false], ["excerpt", "explanation", false],
    ["excerpt", undefined, true], [undefined, "explanation", true],
    ["excerpt", whitespace, true], [whitespace, "explanation", true],
    ["excerpt", "", false], ["\u0085", undefined, true],
  ] as const) {
    const candidate = { ...finding, affected_files: [{
      path: "src/a.ts",
      ...(quote === undefined ? {} : { quoted_text: quote }),
      ...(declaration === undefined ? {} : { no_quotable_span: declaration }),
    }], evidence: ["src/a.ts"] };
    const entry = { ...result, findings: [candidate] };
    expect(WorkerFindingSchema.safeParse(candidate).success).toBe(valid);
    expect(findingJson(candidate).valid).toBe(valid);
    expect(resultJson(entry).valid).toBe(valid);
    expect(resultsJson([entry]).valid).toBe(valid);
  }
});
