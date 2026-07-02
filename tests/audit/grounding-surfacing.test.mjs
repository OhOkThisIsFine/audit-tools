// S7 surfacing: the grounding verdict (set at ingest by the quote-and-verify +
// anchor pass) must survive synthesis and be visibly separated in the report — a
// per-status summary breakdown, an inline mark on each ungrounded finding, a
// dedicated "Ungrounded Findings (not confirmed)" section, and (B4) a "Refuted
// Findings (quarantined — excluded)" section for anchor-DISPROVED findings that
// are dropped from the admitted set. So a hallucinated/stale finding is surfaced,
// a disproven one is excluded, and neither is silently confirmed. Also guards the
// grounded > refuted > ungrounded merge precedence and the schema drift fix.
import { test, expect } from "vitest";
import { AuditFindingsReportSchema } from "audit-tools/shared";

const { buildAuditReportModel, buildAuditFindingsReport, renderAuditReportMarkdown } =
  await import("../../src/audit/reporting/synthesis.ts");

function assertMatchesAuditFindings(value, label) {
  const result = AuditFindingsReportSchema.safeParse(value);
  expect(result.success, `${label} should satisfy AuditFindingsReportSchema: ${
      result.success ? "" : JSON.stringify(result.error.issues)
    }`).toBeTruthy();
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
  expect(plain.summary.grounding_status_breakdown).toBe(undefined);
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
  expect(mixed.summary.grounding_status_breakdown).toEqual({ grounded: 1, ungrounded: 1 });
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
  expect(merged.findings.length).toBe(1);
  expect(merged.findings[0].grounding.status).toBe("grounded");
  expect(merged.summary.grounding_status_breakdown).toEqual({ grounded: 1 });

  // Order-independent: ungrounded second must not downgrade a grounded survivor.
  const reversed = report([
    finding({ title: "Same logical finding", category: "dup", grounding: { status: "grounded" } }),
    finding({ title: "Same logical finding", category: "dup", grounding: { status: "ungrounded", reason: "no quote" } }),
  ]);
  expect(reversed.findings.length).toBe(1);
  expect(reversed.findings[0].grounding.status).toBe("grounded");
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
  expect(rep.findings.length).toBe(1);
  expect(rep.findings[0].title).toBe("Real issue");
  const admittedIds = new Set(rep.findings.map((f) => f.id));
  for (const wb of rep.work_blocks) {
    for (const id of wb.finding_ids) {
      expect(admittedIds.has(id), "a work block must only reference admitted (non-refuted) findings").toBeTruthy();
    }
  }
  // …but preserved (quarantine, not delete) + counted in the breakdown.
  expect(rep.quarantined_findings.length).toBe(1);
  expect(rep.quarantined_findings[0].grounding.status).toBe("refuted");
  expect(rep.summary.finding_count).toBe(1);
  expect(rep.summary.grounding_status_breakdown).toEqual({ refuted: 1, grounded: 1 });
  assertMatchesAuditFindings(rep, "refuted-quarantine");
});

test("B4: grounded-wins over refuted across passes — a finding grounded on another pass is NOT quarantined", () => {
  const merged = report([
    finding({ title: "Same logical finding", category: "dup", grounding: { status: "refuted", reason: "anchor refuted" } }),
    finding({ title: "Same logical finding", category: "dup", grounding: { status: "grounded" } }),
  ]);
  expect(merged.findings.length).toBe(1);
  expect(merged.findings[0].grounding.status).toBe("grounded");
  expect(merged.quarantined_findings).toBe(undefined);
});

test("B4: refuted-wins over ungrounded across passes — a disproof outranks a missing quote", () => {
  const merged = report([
    finding({ title: "Same logical finding", category: "dup", grounding: { status: "ungrounded", reason: "no quote" } }),
    finding({ title: "Same logical finding", category: "dup", grounding: { status: "refuted", reason: "anchor refuted" } }),
  ]);
  // Merged identity is refuted → excluded from findings, present in quarantine.
  expect(merged.findings.length).toBe(0);
  expect(merged.quarantined_findings.length).toBe(1);
  expect(merged.quarantined_findings[0].grounding.status).toBe("refuted");
});

test("B4: renderAuditReportMarkdown lists a Refuted Findings (quarantined — excluded) section", () => {
  const md = renderAuditReportMarkdown(
    report([
      finding({ title: "Disproven cycle", category: "arch", lens: "architecture", grounding: { status: "refuted", reason: "executable anchor refuted the claim: REFUTED by `madge`" } }),
      finding({ title: "Real issue", category: "real", grounding: { status: "grounded" } }),
    ]),
  );
  expect(md).toMatch(/## Refuted Findings \(quarantined — excluded\)/);
  expect(md).toMatch(/Disproven cycle/);
  expect(md).toMatch(/Grounding: ✗ refuted — executable anchor refuted the claim/);
  // Note 2: refuted findings now use the SAME full block format, but only under
  // the Refuted section — never in the main `## Findings` section as actionable.
  const mainFindings = md.slice(
    md.indexOf("## Findings"),
    md.indexOf("## Refuted Findings"),
  );
  expect(mainFindings).not.toMatch(/Disproven cycle/);
  expect(md).toMatch(/refuted findings are quarantined-excluded below/);
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
  expect(md).toMatch(/## Ungrounded Findings \(not confirmed\)/);
  expect(md).toMatch(/Hallucinated cycle/);
  expect(md).toMatch(/Reason: src\/x\.ts: quoted_text not found on disk/);
  expect(md).toMatch(/Grounding: ⚠ ungrounded/);
  expect(md).toMatch(/- Grounding \(S7\): grounded: 1, ungrounded: 1 — ungrounded findings are surfaced-not-confirmed below/);
});

test("a fully grounded report shows the grounding line but no quarantine section", () => {
  const md = renderAuditReportMarkdown(
    report([finding({ title: "Verified", grounding: { status: "grounded" } })]),
  );
  expect(md).not.toMatch(/## Ungrounded Findings/);
  expect(md).toMatch(/- Grounding \(S7\): grounded: 1/);
  expect(md).not.toMatch(/quarantined below/);
});
