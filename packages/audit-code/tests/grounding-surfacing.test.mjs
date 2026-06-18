// S7 surfacing: the grounding verdict (set at ingest by the quote-and-verify +
// anchor pass) must survive synthesis and be visibly separated in the report — a
// per-status summary breakdown, an inline mark on each ungrounded finding, a
// dedicated "Ungrounded Findings (not confirmed)" section, and (B4) a "Refuted
// Findings (quarantined — excluded)" section for anchor-DISPROVED findings that
// are dropped from the admitted set. So a hallucinated/stale finding is surfaced,
// a disproven one is excluded, and neither is silently confirmed. Also guards the
// grounded > refuted > ungrounded merge precedence and the schema drift fix.
import test from "node:test";
import assert from "node:assert/strict";
import { AuditFindingsReportSchema } from "@audit-tools/shared";

const { buildAuditReportModel, buildAuditFindingsReport, renderAuditReportMarkdown } =
  await import("../src/reporting/synthesis.ts");

function assertMatchesAuditFindings(value, label) {
  const result = AuditFindingsReportSchema.safeParse(value);
  assert.ok(
    result.success,
    `${label} should satisfy AuditFindingsReportSchema: ${
      result.success ? "" : JSON.stringify(result.error.issues)
    }`,
  );
}

function resultWith(findings) {
  return [
    {
      task_id: "u1:security",
      unit_id: "u1",
      pass_id: "pass:security",
      lens: "security",
      file_coverage: [{ path: "src/a.ts", total_lines: 10 }],
      findings,
    },
  ];
}

function finding(overrides) {
  return {
    id: "F-x",
    title: "Title",
    category: "cat",
    severity: "high",
    confidence: "high",
    lens: "security",
    summary: "A summary long enough to be realistic.",
    affected_files: [{ path: "src/a.ts", line_start: 1, line_end: 2, quoted_text: "const x = 1;" }],
    evidence: ["src/a.ts:1 - boundary"],
    ...overrides,
  };
}

function report(findings) {
  return buildAuditFindingsReport(buildAuditReportModel({ results: resultWith(findings) }));
}

test("grounding_status_breakdown is omitted with no verdict and counted otherwise", () => {
  const plain = report([finding({ title: "Plain" })]);
  assert.equal(plain.summary.grounding_status_breakdown, undefined);
  assertMatchesAuditFindings(plain, "plain");

  const mixed = report([
    finding({ title: "Grounded one", category: "a", grounding: { status: "grounded" } }),
    finding({
      title: "Ungrounded one",
      category: "b",
      affected_files: [{ path: "src/b.ts" }],
      grounding: { status: "ungrounded", reason: "src/b.ts: quoted_text not found on disk" },
    }),
  ]);
  assert.deepEqual(mixed.summary.grounding_status_breakdown, { grounded: 1, ungrounded: 1 });
  // Grounded findings flow through the report carrying their verdict + quote —
  // this assertion is the regression guard for the audit_findings.schema.json
  // drift (grounding / quoted_text were missing under additionalProperties:false).
  assertMatchesAuditFindings(mixed, "mixed");
});

test("grounded-wins: a grounded re-emission keeps the merged finding out of quarantine", () => {
  // Same lens|category|title => one merged finding. One emission grounded, the
  // other ungrounded; grounded must win so a verified finding is not quarantined.
  const merged = report([
    finding({ title: "Same logical finding", category: "dup", grounding: { status: "ungrounded", reason: "no quote" } }),
    finding({ title: "Same logical finding", category: "dup", grounding: { status: "grounded" } }),
  ]);
  assert.equal(merged.findings.length, 1);
  assert.equal(merged.findings[0].grounding.status, "grounded");
  assert.deepEqual(merged.summary.grounding_status_breakdown, { grounded: 1 });

  // Order-independent: ungrounded second must not downgrade a grounded survivor.
  const reversed = report([
    finding({ title: "Same logical finding", category: "dup", grounding: { status: "grounded" } }),
    finding({ title: "Same logical finding", category: "dup", grounding: { status: "ungrounded", reason: "no quote" } }),
  ]);
  assert.equal(reversed.findings.length, 1);
  assert.equal(reversed.findings[0].grounding.status, "grounded");
});

// ---------------------------------------------------------------------------
// B4: tool-REFUTED findings are quarantined-EXCLUDED (not merely ungrounded)
// ---------------------------------------------------------------------------

test("B4: a refuted finding is excluded from findings + work_blocks and recorded in quarantined_findings", () => {
  const rep = report([
    finding({ title: "Disproven cycle", category: "arch", lens: "architecture", grounding: { status: "refuted", reason: "executable anchor refuted the claim: REFUTED by `madge`" } }),
    finding({ title: "Real issue", category: "real", grounding: { status: "grounded" } }),
  ]);
  // Excluded from the admitted contract + work blocks…
  assert.equal(rep.findings.length, 1);
  assert.equal(rep.findings[0].title, "Real issue");
  const admittedIds = new Set(rep.findings.map((f) => f.id));
  for (const wb of rep.work_blocks) {
    for (const id of wb.finding_ids) {
      assert.ok(admittedIds.has(id), "a work block must only reference admitted (non-refuted) findings");
    }
  }
  // …but preserved (quarantine, not delete) + counted in the breakdown.
  assert.equal(rep.quarantined_findings.length, 1);
  assert.equal(rep.quarantined_findings[0].grounding.status, "refuted");
  assert.equal(rep.summary.finding_count, 1);
  assert.deepEqual(rep.summary.grounding_status_breakdown, { refuted: 1, grounded: 1 });
  assertMatchesAuditFindings(rep, "refuted-quarantine");
});

test("B4: grounded-wins over refuted across passes — a finding grounded on another pass is NOT quarantined", () => {
  const merged = report([
    finding({ title: "Same logical finding", category: "dup", grounding: { status: "refuted", reason: "anchor refuted" } }),
    finding({ title: "Same logical finding", category: "dup", grounding: { status: "grounded" } }),
  ]);
  assert.equal(merged.findings.length, 1);
  assert.equal(merged.findings[0].grounding.status, "grounded");
  assert.equal(merged.quarantined_findings, undefined);
});

test("B4: refuted-wins over ungrounded across passes — a disproof outranks a missing quote", () => {
  const merged = report([
    finding({ title: "Same logical finding", category: "dup", grounding: { status: "ungrounded", reason: "no quote" } }),
    finding({ title: "Same logical finding", category: "dup", grounding: { status: "refuted", reason: "anchor refuted" } }),
  ]);
  // Merged identity is refuted → excluded from findings, present in quarantine.
  assert.equal(merged.findings.length, 0);
  assert.equal(merged.quarantined_findings.length, 1);
  assert.equal(merged.quarantined_findings[0].grounding.status, "refuted");
});

test("B4: renderAuditReportMarkdown lists a Refuted Findings (quarantined — excluded) section", () => {
  const md = renderAuditReportMarkdown(
    report([
      finding({ title: "Disproven cycle", category: "arch", lens: "architecture", grounding: { status: "refuted", reason: "executable anchor refuted the claim: REFUTED by `madge`" } }),
      finding({ title: "Real issue", category: "real", grounding: { status: "grounded" } }),
    ]),
  );
  assert.match(md, /## Refuted Findings \(quarantined — excluded\)/);
  assert.match(md, /Disproven cycle/);
  assert.match(md, /Refuted: executable anchor refuted the claim/);
  // The disproven finding must NOT appear in the main Findings section as actionable.
  assert.doesNotMatch(md, /### .*Disproven cycle/);
  assert.match(md, /refuted findings are quarantined-excluded below/);
});

test("renderAuditReportMarkdown quarantines ungrounded findings, inline-marks them, and lists the breakdown", () => {
  const md = renderAuditReportMarkdown(
    report([
      finding({
        title: "Hallucinated cycle",
        category: "arch",
        lens: "architecture",
        grounding: { status: "ungrounded", reason: "src/x.ts: quoted_text not found on disk" },
      }),
      finding({ title: "Real issue", category: "real", grounding: { status: "grounded" } }),
    ]),
  );
  assert.match(md, /## Ungrounded Findings \(not confirmed\)/);
  assert.match(md, /Hallucinated cycle/);
  assert.match(md, /Reason: src\/x\.ts: quoted_text not found on disk/);
  assert.match(md, /⚠ Grounding: ungrounded/);
  assert.match(
    md,
    /- Grounding \(S7\): grounded: 1, ungrounded: 1 — ungrounded findings are surfaced-not-confirmed below/,
  );
});

test("a fully grounded report shows the grounding line but no quarantine section", () => {
  const md = renderAuditReportMarkdown(
    report([finding({ title: "Verified", grounding: { status: "grounded" } })]),
  );
  assert.doesNotMatch(md, /## Ungrounded Findings/);
  assert.match(md, /- Grounding \(S7\): grounded: 1/);
  assert.doesNotMatch(md, /quarantined below/);
});
