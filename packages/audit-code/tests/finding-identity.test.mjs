import test from "node:test";
import assert from "node:assert/strict";

const { assignStableFindingIds } = await import(
  "../src/reporting/findingIdentity.ts"
);
const { buildAuditReportModel } = await import("../src/reporting/synthesis.ts");

function finding(overrides = {}) {
  return {
    id: "MNT-001",
    title: "A finding",
    category: "smell",
    severity: "medium",
    confidence: "high",
    lens: "maintainability",
    summary: "summary",
    affected_files: [{ path: "src/a.ts", line_start: 1, line_end: 10 }],
    evidence: ["e"],
    ...overrides,
  };
}

test("assignStableFindingIds gives every finding a globally-unique, lens-prefixed id", () => {
  const out = assignStableFindingIds([
    finding({ id: "MNT-001", title: "first", affected_files: [{ path: "src/a.ts" }] }),
    finding({ id: "MNT-001", title: "second", affected_files: [{ path: "src/b.ts" }] }),
    finding({ id: "COR-001", lens: "correctness", title: "third", affected_files: [{ path: "src/c.ts" }] }),
  ]);

  const ids = out.map((f) => f.id);
  assert.equal(new Set(ids).size, 3, "ids must be unique");
  assert.ok(ids[0].startsWith("MNT-"), `expected MNT- prefix, got ${ids[0]}`);
  assert.ok(ids[1].startsWith("MNT-"), `expected MNT- prefix, got ${ids[1]}`);
  assert.ok(ids[2].startsWith("COR-"), `expected COR- prefix, got ${ids[2]}`);
});

test("assignStableFindingIds is deterministic and content-derived (stable across runs)", () => {
  const input = [finding({ title: "stable" }), finding({ title: "other", affected_files: [{ path: "src/z.ts" }] })];
  const a = assignStableFindingIds(input).map((f) => f.id);
  const b = assignStableFindingIds(input).map((f) => f.id);
  assert.deepEqual(a, b, "same findings must re-key to the same ids");
});

test("assignStableFindingIds deterministically disambiguates a content/hash collision", () => {
  // Two findings with an identical content signature collide on the base hash;
  // the guard must still hand back distinct ids.
  const f = finding({ title: "dup", affected_files: [{ path: "src/dup.ts" }] });
  const out = assignStableFindingIds([f, { ...f }]);
  assert.notEqual(out[0].id, out[1].id);
  const stem = out[0].id;
  assert.equal(out[1].id, `${stem}-2`);
});

test("assignStableFindingIds drops related_findings (it referenced collision-prone ids)", () => {
  const out = assignStableFindingIds([
    finding({ related_findings: ["MNT-001", "COR-001"] }),
  ]);
  assert.equal(out[0].related_findings, undefined);
});

test("buildAuditReportModel: colliding per-packet ids become unique and work_blocks round-trip", () => {
  // Two packets both emit id "MNT-001" for unrelated files — the exact T-004
  // collision. After synthesis every finding id must be unique, and every
  // work_blocks.finding_ids entry must resolve to exactly one finding.
  const report = buildAuditReportModel({
    results: [
      {
        task_id: "t1",
        unit_id: "u1",
        pass_id: "pass:maintainability",
        lens: "maintainability",
        file_coverage: [{ path: "src/a.ts", total_lines: 20 }],
        findings: [
          {
            id: "MNT-001",
            title: "god module a",
            category: "length",
            severity: "high",
            confidence: "high",
            lens: "maintainability",
            summary: "a is too long",
            affected_files: [{ path: "src/a.ts", line_start: 1, line_end: 20 }],
            evidence: ["x"],
          },
        ],
      },
      {
        task_id: "t2",
        unit_id: "u2",
        pass_id: "pass:maintainability",
        lens: "maintainability",
        file_coverage: [{ path: "src/b.ts", total_lines: 20 }],
        findings: [
          {
            id: "MNT-001",
            title: "god module b",
            category: "length",
            severity: "high",
            confidence: "high",
            lens: "maintainability",
            summary: "b is too long",
            affected_files: [{ path: "src/b.ts", line_start: 1, line_end: 20 }],
            evidence: ["y"],
          },
        ],
      },
    ],
  });

  const ids = report.findings.map((f) => f.id);
  assert.equal(report.findings.length, 2);
  assert.equal(new Set(ids).size, 2, "synthesized finding ids must be unique");

  const findingIds = new Set(ids);
  const referenced = report.work_blocks.flatMap((b) => b.finding_ids);
  assert.equal(
    new Set(referenced).size,
    referenced.length,
    "no finding id is referenced by more than one work-block slot",
  );
  for (const ref of referenced) {
    assert.ok(findingIds.has(ref), `work block references unknown finding id ${ref}`);
  }
  // The two findings own different units, so they must NOT fuse into one block
  // (the union-find-on-id collapse that non-unique ids used to cause).
  assert.equal(referenced.length, 2);
});
