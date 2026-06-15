// Integration test for the ingest grounding pass (groundPassingFindings) — the
// bounded-concurrency S7 pass that grounds every finding across all passing
// results. Exercises the flatten -> parallel map -> in-place mutation -> ordered
// ungrounded-list wiring (not just the per-finding verifiers, which are unit
// tested elsewhere). Uses real temp files for the grounded case and no-quote /
// quote-not-on-disk for the ungrounded cases — deterministic, no process spawns.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { groundPassingFindings } = await import("../src/cli/mergeAndIngestCommand.ts");

function finding(id, overrides) {
  return {
    id,
    title: "t",
    category: "c",
    severity: "high",
    confidence: "high",
    lens: "security",
    summary: "s",
    affected_files: [{ path: "src/real.ts" }],
    evidence: ["e"],
    ...overrides,
  };
}

test("groundPassingFindings grounds every finding and returns the ungrounded ones in input order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ground-ingest-"));
  try {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "real.ts"), "const realToken = 1;\n", "utf8");

    const passing = [
      {
        task_id: "u1:security",
        unit_id: "u1",
        pass_id: "p",
        lens: "security",
        file_coverage: [{ path: "src/real.ts", total_lines: 1 }],
        findings: [
          // quoted_text matches the file on disk -> grounded
          finding("F-grounded", {
            affected_files: [{ path: "src/real.ts", quoted_text: "const realToken = 1;" }],
          }),
          // no quoted_text at all -> ungrounded
          finding("F-noquote", { affected_files: [{ path: "src/real.ts" }] }),
        ],
      },
      {
        task_id: "u2:correctness",
        unit_id: "u2",
        pass_id: "p",
        lens: "correctness",
        file_coverage: [{ path: "src/ghost.ts", total_lines: 1 }],
        findings: [
          // quoted_text not present on disk -> ungrounded
          finding("F-badquote", {
            lens: "correctness",
            affected_files: [{ path: "src/ghost.ts", quoted_text: "this text exists nowhere on disk" }],
          }),
        ],
      },
    ];

    const ungrounded = await groundPassingFindings(dir, passing);

    // Every finding was annotated in place (the parallel pass mutated each).
    for (const r of passing) {
      for (const f of r.findings) assert.ok(f.grounding, `${f.id} should carry a grounding verdict`);
    }
    assert.equal(passing[0].findings[0].grounding.status, "grounded");
    assert.equal(passing[0].findings[1].grounding.status, "ungrounded");
    assert.equal(passing[1].findings[0].grounding.status, "ungrounded");

    // Ungrounded list: exactly the two ungrounded findings, in input order, with
    // their owning task_id (proves the flatten/filter/order wiring under the pool).
    assert.deepEqual(
      ungrounded.map((u) => u.finding_id),
      ["F-noquote", "F-badquote"],
    );
    assert.equal(ungrounded[0].task_id, "u1:security");
    assert.equal(ungrounded[1].task_id, "u2:correctness");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
