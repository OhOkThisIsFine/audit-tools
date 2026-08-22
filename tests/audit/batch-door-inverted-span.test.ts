// N6 (A1 re-review F2-1, observation): the shared line-span rule is checked at
// BOTH ingestion doors; the host-handoff door already had a test. This drives
// the BATCH door end-to-end — `ingestBatchAuditResults` (the
// `audit-code ingest-results --batch-results <dir>` CLI path) — with a raw
// payload carrying an inverted span and asserts the error-severity issue WITH
// the shared rule wording surfaces through that door (its validation failure is
// thrown as the batch step's error).
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

describe("contract:batch-door-surfaces-the-shared-line-span-rule", () => {
  it("ingestBatchAuditResults refuses an inverted span with the shared rule wording", async () => {
    const { ingestBatchAuditResults } = await import(
      "../../src/audit/cli/auditStep.js"
    );
    const {
      FINDING_LINE_ORDER_RULE,
    } = await import("../../src/shared/types/finding.js");

    const root = await mkdtemp(join(tmpdir(), "audit-batch-span-"));
    cleanupRoots.push(root);
    const artifactsDir = join(root, ".audit-tools", "audit");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "one\ntwo\n", "utf8");
    await mkdir(artifactsDir, { recursive: true });

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
              summary: "The span runs backwards and must be refused.",
              affected_files: [{ path: "src/a.ts", line_start: 3, line_end: 1 }],
              evidence: ["src/a.ts:3 - boundary"],
            },
          ],
        },
      ]),
      "utf8",
    );

    // The batch lane validates BEFORE ingestion, so the inverted span aborts
    // the whole batch with the formatted error-severity issues.
    await expect(
      ingestBatchAuditResults({ root, artifactsDir, batchDir }),
    ).rejects.toThrow();

    // And the message carries the SHARED statement verbatim (imported, never
    // retyped) — not just any refusal.
    let message = "";
    try {
      await ingestBatchAuditResults({ root, artifactsDir, batchDir });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("affected_files[0].line_start");
    expect(message).toContain(FINDING_LINE_ORDER_RULE);
  });
});
