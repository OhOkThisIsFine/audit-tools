// The BATCH door (`ingestBatchAuditResults`, the
// `audit-code ingest-results --batch-results <dir>` CLI path) end-to-end: line
// numbers are tool-owned, so a raw payload's supplied span — here an INVERTED
// one, which this door used to have to refuse — is discarded, and the finding
// lands carrying the span its quote really occupies. The direct test of
// `stampToolComputedGrounding` cannot see a door that stops calling it; this one
// can.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("contract:batch-door-derives-lines-from-the-quote", () => {
  it("ingestBatchAuditResults replaces a supplied inverted span with the quote's real span", async () => {
    const { ingestBatchAuditResults } = await import(
      "../../src/audit/cli/auditStep.js"
    );

    const root = await mkdtemp(join(tmpdir(), "audit-batch-span-"));
    cleanupRoots.push(root);
    const artifactsDir = join(root, ".audit-tools", "audit");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "one\ntwo\n", "utf8");
    await mkdir(artifactsDir, { recursive: true });
    // The minimum planned state result ingestion requires.
    await writeFile(
      join(artifactsDir, "coverage_matrix.json"),
      JSON.stringify({ files: [] }),
      "utf8",
    );
    await writeFile(
      join(artifactsDir, "audit_tasks.json"),
      JSON.stringify([
        {
          task_id: "u1:correctness",
          unit_id: "u1",
          pass_id: "pass:correctness",
          lens: "correctness",
          file_paths: ["src/a.ts"],
          rationale: "Review src/a.ts",
        },
      ]),
      "utf8",
    );

    // Canonical batch filename (<stem>_<12-hex>.json), one raw payload whose
    // finding cites an INVERTED span — every other field contract-valid.
    const batchDir = join(root, "batch");
    await mkdir(batchDir, { recursive: true });
    await writeFile(
      join(batchDir, "batch-result_0123456789ab.json"),
      JSON.stringify([
        {
          task_id: "u1:correctness",
          unit_id: "u1",
          pass_id: "pass:correctness",
          lens: "correctness",
          agent_role: "reviewer",
          file_coverage: [{ path: "src/a.ts", total_lines: 2 }],
          findings: [
            {
              id: "F-1",
              title: "Inverted span through the batch door",
              category: "correctness",
              severity: "medium",
              confidence: "medium",
              lens: "correctness",
              summary: "The supplied span runs backwards; the quote says where it is.",
              affected_files: [
                { path: "src/a.ts", line_start: 3, line_end: 1, quoted_text: "two" },
              ],
              evidence: ["src/a.ts - boundary"],
            },
          ],
        },
      ]),
      "utf8",
    );

    const ingested = await ingestBatchAuditResults({ root, artifactsDir, batchDir });
    const results = (ingested.bundle as { audit_results?: unknown }).audit_results as
      | { findings: { affected_files: { line_start?: number; line_end?: number }[] }[] }[]
      | undefined;
    expect(results?.[0]?.findings[0]?.affected_files[0]).toMatchObject({
      line_start: 2,
      line_end: 2,
    });
  });
});
