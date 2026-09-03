// S7 surfacing: the grounding verdict (set at ingest by the quote-and-verify +
// anchor pass) must survive synthesis and be visibly separated in the report — a
// per-status summary breakdown, an inline mark on each ungrounded finding, a
// dedicated "Ungrounded Findings (not confirmed)" section, and (B4) a "Refuted
// Findings (quarantined — excluded)" section for anchor-DISPROVED findings that
// are dropped from the admitted set. So a hallucinated/stale finding is surfaced,
// a disproven one is excluded, and neither is silently confirmed. Also guards the
// grounded > refuted > ungrounded merge precedence and the schema drift fix.
import { test, expect } from "vitest";
import {
  AuditFindingsReportSchema,
  type AuditFindingsReport,
  type Finding,
} from "audit-tools/shared";
import type { AuditResult } from "../../src/audit/types.js";

const { buildAuditReportModel: buildAuditReportModelRaw, buildAuditFindingsReport, renderAuditReportMarkdown } =
  await import("../../src/audit/reporting/synthesis.js");
const buildAuditReportModel = (
  params: Parameters<typeof buildAuditReportModelRaw>[0],
) => buildAuditReportModelRaw(params);

function assertMatchesAuditFindings(value: unknown, label: string): void {
  const result = AuditFindingsReportSchema.safeParse(value);
  expect(result.success, `${label} should satisfy AuditFindingsReportSchema: ${
      result.success ? "" : JSON.stringify(result.error.issues)
    }`).toBeTruthy();
}

function resultWith(findings: Finding[]): AuditResult[] {
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

function finding(overrides: Partial<Finding> = {}): Finding {
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

function report(findings: Finding[]): AuditFindingsReport {
  return buildAuditFindingsReport(buildAuditReportModel({ results: resultWith(findings) }));
}

type FindingWithGrounding = Finding & {
  grounding: NonNullable<Finding["grounding"]>;
};

function requireAdmittedGrounding(
  value: AuditFindingsReport,
): asserts value is AuditFindingsReport & {
  findings: [FindingWithGrounding, ...FindingWithGrounding[]];
} {
  if (value.findings.length === 0 || value.findings.some((item) => !item.grounding)) {
    throw new Error("expected admitted findings with grounding verdicts");
  }
}

function requireQuarantinedGrounding(
  value: AuditFindingsReport,
): asserts value is AuditFindingsReport & {
  quarantined_findings: [FindingWithGrounding, ...FindingWithGrounding[]];
} {
  const quarantined = value.quarantined_findings;
  if (!quarantined || quarantined.length === 0 || quarantined.some((item) => !item.grounding)) {
    throw new Error("expected quarantined findings with grounding verdicts");
  }
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

// ── verification_status_breakdown (NO-REJECTION-OUTCOME) ─────────────────────
//
// The FINDING-scoped population. It deliberately does NOT reconcile with the
// adjudication's candidate-scoped counts — a merged candidate's final finding
// can still be quarantined ungrounded downstream — so each is labelled by its
// population rather than folded into one number that would hide the quarantine.
//
// Three build sites, and a breakdown missing from any one of them is silently
// dropped by the next stage, which is why all three are asserted here.

test("verification_status_breakdown is omitted with no status and counted otherwise", () => {
  const plain = report([finding({ title: "Plain" })]);
  expect(plain.summary.verification_status_breakdown).toBe(undefined);
  assertMatchesAuditFindings(plain, "plain");

  const mixed = report([
    finding({
      title: "Confirmed one",
      category: "a",
      verification_status: "judge_confirmed",
    }),
    finding({
      title: "Asserted one",
      category: "b",
      affected_files: [{ path: "src/b.ts" }],
      verification_status: "asserted",
    }),
  ]);
  expect(mixed.summary.verification_status_breakdown).toEqual({
    judge_confirmed: 1,
    asserted: 1,
  });
  assertMatchesAuditFindings(mixed, "mixed");
});

test("normalizeExistingFindingsReport re-derives verification_status_breakdown", async () => {
  const { normalizeExistingFindingsReport } = await import(
    "../../src/audit/reporting/synthesis.js"
  );
  const built = report([
    finding({ title: "Confirmed one", verification_status: "judge_confirmed" }),
  ]);
  // Drop the field, then normalize: a promoted audit-findings.json re-read from
  // disk must come back carrying the count, not silently without it.
  const stripped = {
    ...built,
    summary: { ...built.summary, verification_status_breakdown: undefined },
  } as AuditFindingsReport;
  const normalized = normalizeExistingFindingsReport(stripped);
  expect(normalized.summary.verification_status_breakdown).toEqual({
    judge_confirmed: 1,
  });
});

test("the approved-findings projection re-counts verification over the PROJECTED set", async () => {
  const { projectAuditFindingsReportSubset } = await import(
    "../../src/shared/validation/findingsReport.js"
  );
  const built = report([
    finding({
      title: "Confirmed one",
      category: "a",
      verification_status: "judge_confirmed",
    }),
    finding({
      title: "Asserted one",
      category: "b",
      affected_files: [{ path: "src/b.ts" }],
      verification_status: "asserted",
    }),
  ]);
  expect(built.summary.verification_status_breakdown).toEqual({
    judge_confirmed: 1,
    asserted: 1,
  });

  const kept = built.findings.find((entry) => entry.title === "Confirmed one");
  expect(kept).toBeDefined();
  const projected = projectAuditFindingsReportSubset(built, [kept!]);

  // The count must describe the PROJECTED set, not the input set — an approved
  // subset that still reported the full run's counts would overstate itself.
  // `asserted: 0` rather than an absent key is `projectedBreakdown`'s own
  // convention, shared with every other breakdown: the key set stays stable so a
  // status that dropped to zero is VISIBLE instead of silently disappearing.
  expect(projected.summary.verification_status_breakdown).toEqual({
    judge_confirmed: 1,
    asserted: 0,
  });
});

test("grounded-wins: a grounded re-emission keeps the merged finding out of quarantine", () => {
  // Same lens|category|title => one merged finding. One emission grounded, the
  // other ungrounded; grounded must win so a verified finding is not quarantined.
  const merged = report([
    finding({ title: "Same logical finding", category: "dup", grounding: { status: "ungrounded", reason: "no quote" } }),
    finding({ title: "Same logical finding", category: "dup", grounding: { status: "grounded" } }),
  ]);
  requireAdmittedGrounding(merged);
  expect(merged.findings.length).toBe(1);
  expect(merged.findings[0].grounding.status).toBe("grounded");
  expect(merged.summary.grounding_status_breakdown).toEqual({ grounded: 1 });

  // Order-independent: ungrounded second must not downgrade a grounded survivor.
  const reversed = report([
    finding({ title: "Same logical finding", category: "dup", grounding: { status: "grounded" } }),
    finding({ title: "Same logical finding", category: "dup", grounding: { status: "ungrounded", reason: "no quote" } }),
  ]);
  requireAdmittedGrounding(reversed);
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
  requireAdmittedGrounding(rep);
  requireQuarantinedGrounding(rep);
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
  requireAdmittedGrounding(merged);
  expect(merged.findings.length).toBe(1);
  expect(merged.findings[0].grounding.status).toBe("grounded");
  expect(merged.quarantined_findings).toBe(undefined);
});

test("B4: refuted-wins over ungrounded across passes — a disproof outranks a missing quote", () => {
  const merged = report([
    finding({ title: "Same logical finding", category: "dup", grounding: { status: "ungrounded", reason: "no quote" } }),
    finding({ title: "Same logical finding", category: "dup", grounding: { status: "refuted", reason: "anchor refuted" } }),
  ]);
  requireQuarantinedGrounding(merged);
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

// ── the report publishes both populations, and says what `grounded` certifies ─

test("the Summary carries a verification line beside the grounding line", () => {
  const md = renderAuditReportMarkdown(
    report([
      finding({
        title: "Confirmed",
        category: "a",
        verification_status: "judge_confirmed",
      }),
      finding({
        title: "Asserted",
        category: "b",
        affected_files: [{ path: "src/b.ts" }],
        verification_status: "asserted",
      }),
    ]),
  );
  expect(md).toMatch(/- Verification: .*judge_confirmed: 1/);
  expect(md).toMatch(/asserted: 1/);
  // The badge body carries it per finding too, so a reader of one finding does
  // not have to infer its status from an aggregate.
  expect(md).toMatch(/- Verification: judge-confirmed against HEAD/);
  expect(md).toMatch(/- Verification: asserted/);
});

test("the conceptual attribution section publishes candidate counts and narrows what `grounded` certifies", async () => {
  const { buildConceptualReviewAdjudication } = await import(
    "../../src/audit/types/conceptualAdjudication.js"
  );
  const manifest = {
    schema_version: 1 as const,
    mode: "deep" as const,
    round_id: "round-1",
    perspectives: [
      {
        contributor_id: "p1",
        perspective: "Minimalist",
        lane_id: "p1",
        prompt_path: "/x/p1-prompt.md",
        result_path: "/x/p1.json",
      },
    ],
    judge: {
      contributor_id: "design_review_conceptual",
      lane_id: "design_review_conceptual",
      prompt_path: "/x/judge-prompt.md",
      result_path: "/x/judge.json",
    },
  };
  const candidate = finding({ id: "DR-1", title: "Candidate" });
  const final = finding({ id: "FINAL-1", title: "Final" });
  const adjudication = buildConceptualReviewAdjudication({
    manifest,
    perspectiveFindings: new Map([["p1", [candidate]]]),
    submission: {
      round_id: "round-1",
      findings: [final],
      candidate_dispositions: [
        {
          candidate_id: "p1::DR-1",
          contributor_id: "p1",
          source_finding_id: "DR-1",
          disposition: "merged" as const,
          target_final_finding_ids: ["FINAL-1"],
          modification_percent: 20,
          rationale: "Merged into the final framing.",
          verification_status: "judge_confirmed" as const,
          verification_note: "Re-read the cited module at HEAD.",
        },
      ],
      final_finding_shares: [
        {
          final_finding_id: "FINAL-1",
          contributors: [
            {
              contributor_id: "p1",
              source_candidate_ids: ["p1::DR-1"],
              contribution_percent: 70,
              rationale: "Supplied the reduction.",
            },
            {
              contributor_id: "design_review_conceptual",
              source_candidate_ids: [],
              contribution_percent: 30,
              rationale: "Judge reconciled it.",
            },
          ],
        },
      ],
    },
    generatedAt: "now",
  });

  const md = renderAuditReportMarkdown(
    {
      summary: {
        finding_count: 1,
        work_block_count: 0,
        severity_breakdown: {},
        audited_file_count: 0,
        excluded_file_count: 0,
        runtime_validation_status_breakdown: {},
      },
      findings: [final],
      work_blocks: [],
      work_block_seams: [],
    },
    { conceptual_adjudication: adjudication },
  );

  // The aggregate the live run had to be counted BY HAND to obtain.
  expect(md).toMatch(/Candidate dispositions: .*merged: 1/);
  expect(md).toMatch(/Candidate verification: .*judge_confirmed: 1/);
  // Each disposition bullet states its own verification claim.
  expect(md).toMatch(/judge_confirmed/);
  // And the section-scoped caveat says what `grounded` does NOT certify here —
  // a conceptual finding's grounded verdict is component-path existence only.
  expect(md).toMatch(/component[- ]path existence/i);
  expect(md).toMatch(/verification_status/);
});
