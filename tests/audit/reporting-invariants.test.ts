/**
 * Regression tests for audit-reporting module invariants:
 *   INV-audit-reporting-01 — render-equals-contract (JSON↔markdown parity)
 *   INV-audit-reporting-04 — applyNarrative sanitizes duplicate finding_ids across themes
 *   INV-audit-reporting-06 — normalizeExistingFindingsReport recomputes counts from findings+work_blocks
 *   INV-audit-reporting-07 — language-neutral render (no per-ecosystem special-casing)
 *   INV-audit-reporting-08 — truncation diagnostic uses process.stderr, not console.warn
 *   OBL-INV-APR-09 — buildAuditFindingsReport contract_version === shared constant; deferred prompt has no Command argv
 */
import { test, expect } from "vitest";
import {
  FindingSchema,
  type Finding,
} from "audit-tools/shared";
import {
  AuditResultSchema,
  type AuditResult,
} from "../../src/audit/types.js";

const {
  buildAuditReportModel: buildAuditReportModelRaw,
  buildAuditFindingsReport,
  applyNarrative,
  renderAuditReportMarkdown,
  normalizeExistingFindingsReport,
  escapeControlCharacters,
  hasSubstantiveEvidence,
  CRITICAL_EVIDENCE_BAR,
  AUDIT_FINDINGS_CONTRACT_VERSION,
} = await import("../../src/audit/reporting/synthesis.js");
const buildAuditReportModel = (
  params: Parameters<typeof buildAuditReportModelRaw>[0],
) => buildAuditReportModelRaw(params);

const { renderSynthesisNarrativePrompt } = await import("../../src/audit/reporting/synthesisNarrativePrompt.js");

// ── helpers ───────────────────────────────────────────────────────────────────
// makeFinding / wrapResult are single-sourced in tests/audit/fixtures/reporting.mjs
// (TST-1bfd0034 / MNT-1bfd0034: never drift-test two copies).

import {
  makeFinding as makeFindingFixture,
  wrapResult as wrapResultFixture,
} from "./fixtures/reporting.mjs";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return FindingSchema.parse(makeFindingFixture(overrides));
}

function wrapResult(
  findings: Finding[],
  overrides: Partial<AuditResult> = {},
): AuditResult {
  return AuditResultSchema.parse(wrapResultFixture(findings, overrides));
}

function baseReport() {
  const model = buildAuditReportModel({
    results: [
      wrapResult([
        makeFinding({
          id: "F-1",
          title: "Input not validated",
          lens: "security",
          severity: "high",
          confidence: "high",
          affected_files: [{ path: "src/auth.ts", line_start: 1 }],
        }),
        makeFinding({
          id: "F-2",
          title: "Error swallowed silently",
          lens: "correctness",
          severity: "medium",
          confidence: "medium",
          affected_files: [{ path: "src/parser.ts", line_start: 5 }],
        }),
        makeFinding({
          id: "F-3",
          title: "Missing test for edge case",
          lens: "tests",
          severity: "low",
          confidence: "low",
          affected_files: [{ path: "src/util.ts", line_start: 20 }],
        }),
      ]),
    ],
  });
  return buildAuditFindingsReport(model);
}

// ── INV-audit-reporting-01: render-equals-contract ───────────────────────────

test("INV-01: render finding count matches JSON contract finding_count", () => {
  const report = baseReport();
  const markdown = renderAuditReportMarkdown(report);

  // The markdown summary line must reflect the same count as the JSON contract.
  expect(markdown, "markdown summary finding count must equal JSON contract finding_count").toMatch(new RegExp(`- Findings: ${report.summary.finding_count}`));
});

test("INV-01: render work block count matches JSON contract work_block_count", () => {
  const report = baseReport();
  const markdown = renderAuditReportMarkdown(report);

  expect(markdown, "markdown summary work block count must equal JSON contract work_block_count").toMatch(new RegExp(`- Work blocks: ${report.summary.work_block_count}`));
});

test("INV-01: every finding id in JSON contract appears in the markdown render", () => {
  const report = baseReport();
  const markdown = renderAuditReportMarkdown(report);

  for (const finding of report.findings) {
    expect(markdown.includes(finding.id), `finding id ${finding.id} must appear in the markdown render`).toBeTruthy();
  }
});

test("INV-01: every work block id in JSON contract appears in the markdown render", () => {
  const report = baseReport();
  const markdown = renderAuditReportMarkdown(report);

  for (const block of report.work_blocks) {
    expect(markdown.includes(block.id), `work block id ${block.id} must appear in the markdown render`).toBeTruthy();
  }
});

test("INV-01: narrative-enriched render finding ids still match the JSON contract", () => {
  const report = baseReport();
  const firstFindingId = report.findings[0].id;
  const narrative = {
    themes: [
      {
        theme_id: "T-1",
        title: "Input trust violations",
        root_cause: "Inputs are not validated at trust boundaries.",
        finding_ids: [firstFindingId],
        suggested_fix_pattern: "Validate and sanitize at every entry point.",
      },
    ],
    executive_summary: "One theme identified.",
    top_risks: ["Auth bypass"],
  };
  const enriched = applyNarrative(report, narrative);
  const markdown = renderAuditReportMarkdown(enriched);

  // All finding ids from the JSON contract must appear in the enriched render.
  for (const finding of enriched.findings) {
    expect(markdown.includes(finding.id), `enriched finding id ${finding.id} must appear in the markdown render`).toBeTruthy();
  }
  // The finding count must still match.
  expect(markdown, "enriched markdown summary finding count must match JSON contract").toMatch(new RegExp(`- Findings: ${enriched.summary.finding_count}`));
});

// ── The `critical` evidence bar: DECIDED and recorded ────────────────────────

test("CRITICAL_EVIDENCE_BAR states the decision as a value, not an implication", () => {
  // The 2026-08-06 open question ("should synthesis demand mechanism-grounded,
  // not flow-existence, evidence for critical?") is answered by the bar's own
  // doc comment in synthesis.ts. This pins the ANSWER as data so a future run
  // that finds 0-of-N criticals surviving reads the decision instead of
  // re-opening it — and so a silent change to the bar is a red test.
  expect(CRITICAL_EVIDENCE_BAR).toBe("substantive-evidence");
});

test("a critical with only blank evidence is downgraded to high, never silently kept", () => {
  const model = buildAuditReportModel({
    results: [
      wrapResult([
        makeFinding({
          id: "F-BLANK",
          title: "Flow reaches untrusted input",
          lens: "security",
          severity: "critical",
          evidence: ["   "],
        }),
      ]),
    ],
  });
  const report = buildAuditFindingsReport(model);

  // Synthesis re-keys findings to content-addressed ids, so resolve by position
  // rather than the fixture's local id.
  expect(report.findings).toHaveLength(1);
  expect(
    report.findings[0]?.severity,
    "a critical whose evidence is blank makes no claim the tool can find, so it cannot stand as critical",
  ).toBe("high");
  // Downgraded, never dropped: the finding is still admitted and its breakdown
  // still counts it.
  expect(report.summary.severity_breakdown.high).toBe(1);
  expect(report.summary.severity_breakdown.critical ?? 0).toBe(0);
  // The move is RECORDED. Without this the tool-moved `high` is byte-identical
  // to a judge-authored `high` in audit-findings.json — and so is every
  // work_blocks.max_severity computed from it — which is the qualification the
  // bar exists to make visible.
  expect(
    report.findings[0]?.severity_downgraded_from,
    "the severity the judge claimed must survive the downgrade",
  ).toBe("critical");
  // The work block reads the downgraded severity, so the partition and the
  // finding agree about what this finding is.
  expect(report.work_blocks[0]?.max_severity).toBe("high");
  // A born-high finding carries no such field: absence means "not re-graded",
  // never "re-graded from nothing".
  const bornHigh = buildAuditFindingsReport(
    buildAuditReportModel({
      results: [
        wrapResult([
          makeFinding({
            id: "F-BORN-HIGH",
            title: "Born high, never re-graded",
            lens: "security",
            severity: "high",
            evidence: ["   "],
          }),
        ]),
      ],
    }),
  );
  expect(bornHigh.findings[0]?.severity_downgraded_from).toBeUndefined();
});

test("a design-review critical is NOT re-graded: its contract never carries the field the bar tests", () => {
  // The design-review lanes have no `evidence` field in their contract
  // (`findingsEnvelopeExample`) — their evidence channel is `affected_files`,
  // certified by `groundDesignFinding`. Grading them against `evidence` read
  // their silence as a failed claim, so the same critical rendered `critical`
  // through the per-file lane and `high` through this one.
  const designFinding = makeFinding({
    id: "F-DESIGN",
    title: "The charter boundary is drawn in the wrong layer",
    lens: "architecture",
    severity: "critical",
    evidence: [],
  });
  // The lane marker is what ingest stamps (`groundDesignFindings`); the fixture
  // sets it the same way so the test pins the READ, not the ingest plumbing.
  const marked: Finding = { ...designFinding, evidence_lane: "design-review-lane" };
  const model = buildAuditReportModel({
    // No per-file results at all: the design-review lane is the ONLY producer,
    // which is the configuration the bar has to leave alone.
    results: [],
    designAssessment: {
      generated_at: "2026-09-10T00:00:00.000Z",
      findings: [],
      contract_findings: [marked],
      contract_reviewed: true,
    },
  });
  const report = buildAuditFindingsReport(model);

  expect(report.findings).toHaveLength(1);
  expect(
    report.findings[0]?.severity,
    "a design-review critical was never asked for evidence, so it cannot be downgraded for lacking it",
  ).toBe("critical");
  expect(
    report.findings[0]?.severity_downgraded_from,
    "nothing was re-graded, so nothing may claim it was",
  ).toBeUndefined();
  // The marker is provenance, not a verdict — it must survive synthesis.
  expect(report.findings[0]?.evidence_lane).toBe("design-review-lane");
});

test("the explicit per-file-lane stamp is graded by the bar — a lane is not an escape hatch", () => {
  // Both ingests STAMP a lane (`toAuditResult` writes `per-file-lane`), so the
  // bar reads a stamped value in the ordinary case, not an absent one. The
  // stamp is set on the RESULT, before the model builder runs — the same order
  // ingest produces — so this pins the bar's read rather than re-stamping an
  // array it has already been applied to.
  const model = buildAuditReportModel({
    results: [
      wrapResult([
        makeFinding({
          id: "F-STAMPED-PERFILE",
          title: "Stamped, blank evidence, still critical",
          lens: "security",
          severity: "critical",
          evidence: ["  "],
          evidence_lane: "per-file-lane",
        }),
      ]),
    ],
  });
  const report = buildAuditFindingsReport(model);

  expect(report.findings[0]?.evidence_lane).toBe("per-file-lane");
  expect(
    report.findings[0]?.severity,
    "an explicit per-file-lane stamp names the lane the bar DOES grade",
  ).toBe("high");
  expect(report.findings[0]?.severity_downgraded_from).toBe("critical");
});

test("a per-file critical with blank evidence is re-graded even beside a design-review critical", () => {
  // The two lanes in ONE array is the shape that made the defect visible: a
  // lane-blind bar moved one and left the other, so two identically-severe
  // claims rendered differently for a reason neither finding stated.
  const model = buildAuditReportModel({
    results: [
      wrapResult([
        makeFinding({
          id: "F-PERFILE-BLANK",
          title: "Unbounded retry loop in the fetch helper",
          category: "reliability",
          lens: "correctness",
          severity: "critical",
          affected_files: [{ path: "src/net/fetch.ts", line_start: 12 }],
          evidence: ["  "],
        }),
      ]),
    ],
    designAssessment: {
      generated_at: "2026-09-10T00:00:00.000Z",
      findings: [],
      conceptual_reviewed: true,
      conceptual_findings: [
        {
          ...makeFinding({
            id: "F-CONCEPT",
            title: "The persistence boundary belongs one layer up the goal graph",
            category: "structural_risk",
            lens: "architecture",
            severity: "critical",
            affected_files: [{ path: "src/store/persist.ts" }],
            evidence: [],
          }),
          evidence_lane: "design-review-lane",
        },
      ],
    },
  });
  const report = buildAuditFindingsReport(model);

  expect(report.findings).toHaveLength(2);
  const byLane = report.findings.map((finding) => ({
    lane: finding.evidence_lane ?? "per-file-lane",
    severity: finding.severity,
    from: finding.severity_downgraded_from,
  }));
  expect(byLane).toContainEqual({ lane: "per-file-lane", severity: "high", from: "critical" });
  expect(byLane).toContainEqual({
    lane: "design-review-lane",
    severity: "critical",
    from: undefined,
  });
  // And the report says so, in the summary the reader actually reads.
  const markdown = renderAuditReportMarkdown(report);
  expect(markdown).toContain("Severity re-graded by the tool:");
});

test("a re-normalized report's disclosure agrees with the record it renders", () => {
  // `cmdResynthesize` reads a PROMOTED `audit-findings.json` and renders it
  // through `normalizeExistingFindingsReport` — never through the model builder.
  // The disclosure line used to be gated on "a critical exists", so a record
  // promoted before the bar existed (or written by an older contract version)
  // rendered a claim that the bar was enforced beside a critical it had never
  // been applied to. The JSON round-trip below is that record: a serialized
  // report carries no in-memory marker, exactly like the file on disk.
  const model = buildAuditReportModel({
    results: [
      wrapResult([
        makeFinding({
          id: "F-BLANK",
          title: "Blank-evidence critical reaching the promoted record",
          lens: "security",
          severity: "critical",
          evidence: ["   "],
        }),
      ]),
    ],
  });
  const recorded = JSON.parse(
    JSON.stringify(buildAuditFindingsReport(model)),
  ) as ReturnType<typeof buildAuditFindingsReport>;
  // Restore what an un-barred record would carry: the judge's claimed severity
  // and no downgrade record. This is the input the resynthesize path sees.
  delete recorded.findings[0]!.severity_downgraded_from;
  recorded.findings[0]!.severity = "critical";
  recorded.summary.severity_breakdown = { critical: 1 };

  const normalized = normalizeExistingFindingsReport(recorded);
  const markdown = renderAuditReportMarkdown(normalized);

  // The bar ran on the path that does not go through the model builder...
  expect(
    normalized.findings[0]?.severity,
    "the normalization boundary must apply the bar, not only the model builder",
  ).toBe("high");
  expect(normalized.findings[0]?.severity_downgraded_from).toBe("critical");
  expect(normalized.summary.severity_breakdown).toEqual({ high: 1 });

  // ...so the record and the render agree: whenever the report tells the reader
  // criticals are held to the bar, no un-barred critical is left in the record.
  const unbarred = normalized.findings.some(
    (finding) =>
      finding.severity === "critical" && !hasSubstantiveEvidence(finding),
  );
  if (markdown.includes("Critical severity is judge-authored")) {
    expect(
      unbarred,
      "the report claims the bar is enforced, so it must not print an un-barred critical",
    ).toBe(false);
  }
  expect(markdown).toContain("Severity re-graded by the tool:");
});

test("a re-normalized report that cleared the bar still states the bar ran", () => {
  // The other half of the same gate: the sentence is about the bar having been
  // APPLIED, not about it having changed something. A critical that carries
  // substantive evidence is exactly the critical the sentence qualifies, so a
  // report that only disclosed re-grades would go silent on the case the reader
  // most needs the qualification for.
  const model = buildAuditReportModel({
    results: [
      wrapResult([
        makeFinding({
          id: "F-REAL",
          title: "Unvalidated input reaches the query builder",
          lens: "security",
          severity: "critical",
          evidence: ["src/db/query.ts:42 interpolates req.body.id"],
        }),
      ]),
    ],
  });
  const recorded = JSON.parse(
    JSON.stringify(buildAuditFindingsReport(model)),
  ) as ReturnType<typeof buildAuditFindingsReport>;
  const normalized = normalizeExistingFindingsReport(recorded);
  const markdown = renderAuditReportMarkdown(normalized);

  expect(normalized.findings[0]?.severity).toBe("critical");
  expect(markdown).toContain("Critical severity is judge-authored");
  // ...and nothing was re-graded, so nothing claims to have been.
  expect(normalized.findings[0]?.severity_downgraded_from).toBeUndefined();
  expect(markdown).not.toContain("Severity re-graded by the tool:");
});

test("a report that never went through the bar does not claim it ran", () => {
  // A hand-assembled record — no model builder, no normalization — with a
  // critical that has no evidence at all. The render must not assert the bar was
  // enforced over it: claiming a check that did not run is worse than silence,
  // and this is the arm that makes the disclosure a statement about the artifact
  // rather than about the reader's expectations.
  const recorded = JSON.parse(
    JSON.stringify(
      buildAuditFindingsReport(
        buildAuditReportModel({
          results: [
            wrapResult([
              makeFinding({
                id: "F-RAW",
                title: "Assembled by hand, never barred",
                lens: "security",
                severity: "critical",
                evidence: ["  "],
              }),
            ]),
          ],
        }),
      ),
    ),
  ) as ReturnType<typeof buildAuditFindingsReport>;
  delete recorded.findings[0]!.severity_downgraded_from;
  recorded.findings[0]!.severity = "critical";

  const markdown = renderAuditReportMarkdown(recorded);
  expect(recorded.findings[0]?.severity).toBe("critical");
  expect(markdown).not.toContain("Critical severity is judge-authored");
});

test("re-applying the bar is idempotent: a re-graded finding is not re-graded again", () => {
  // `normalizeExistingFindingsReport` runs the bar over a record the model
  // builder may already have barred, so a non-idempotent bar would compound —
  // or, worse, treat its own output as a judge-authored critical and move it a
  // second time.
  const model = buildAuditReportModel({
    results: [
      wrapResult([
        makeFinding({
          id: "F-BLANK",
          title: "Blank-evidence critical",
          lens: "security",
          severity: "critical",
          evidence: [""],
        }),
      ]),
    ],
  });
  const once = buildAuditFindingsReport(model);
  const twice = normalizeExistingFindingsReport(once);

  expect(twice.findings[0]?.severity).toBe("high");
  expect(twice.findings[0]?.severity_downgraded_from).toBe("critical");
  expect(twice.summary.severity_breakdown).toEqual({ high: 1 });
  expect(twice).toEqual(once);
});

test("a critical with substantive evidence stands, and the render names the bar", () => {
  const model = buildAuditReportModel({
    results: [
      wrapResult([
        makeFinding({
          id: "F-REAL",
          title: "Unvalidated input reaches the query builder",
          lens: "security",
          severity: "critical",
          evidence: ["src/db/query.ts:42 interpolates req.body.id into the SQL string"],
        }),
      ]),
    ],
  });
  const report = buildAuditFindingsReport(model);
  const markdown = renderAuditReportMarkdown(report);

  expect(
    report.findings[0]?.severity,
    "substantive evidence clears the bar — the tool does not grade the mechanism claim",
  ).toBe("critical");
  // The reader must be able to tell a tool-verified claim from a judge's: the
  // bar is only honest if the report says which one a critical is.
  expect(markdown).toContain("Critical severity is judge-authored");
  expect(markdown).toContain(CRITICAL_EVIDENCE_BAR);
});

test("hasSubstantiveEvidence is a content test, not an array-length test", () => {
  // The schema already requires a non-empty evidence array, so a length check
  // would be dead code; the hole is the array that exists to satisfy it.
  expect(hasSubstantiveEvidence({ evidence: [""] })).toBe(false);
  expect(hasSubstantiveEvidence({ evidence: ["\t"] })).toBe(false);
  expect(hasSubstantiveEvidence({ evidence: [] })).toBe(false);
  expect(hasSubstantiveEvidence({})).toBe(false);
  expect(hasSubstantiveEvidence({ evidence: ["x"] })).toBe(true);
});

// ── The rendered deliverable carries no raw C0 control byte ──────────────────

// Built from code points, never typed as a literal: a raw control byte in THIS
// file would make git/grep treat the test source as binary — the same trap the
// production fix exists to close, one level up.
const BACKSPACE = String.fromCharCode(0x08);
const BELL = String.fromCharCode(0x07);
const NUL = String.fromCharCode(0x00);

test("the render re-escapes a C0 control byte instead of emitting it raw", () => {
  // The live failure: a worker summary carrying a JSON-escaped backspace (a
  // mangled regex word boundary). It parses, it stores (JSON escapes it), and
  // it used to land as a literal 0x08 in audit-report.md — where
  // check:control-bytes correctly reds the build. The finding is contract-valid
  // either way, so the render step is the only place this can be guaranteed.
  const model = buildAuditReportModel({
    results: [
      wrapResult([
        makeFinding({
          id: "F-CTRL",
          title: `Boundary check${BACKSPACE}broken`,
          lens: "correctness",
          summary: `The pattern uses ${BACKSPACE} as a word boundary.`,
          evidence: [`leading ${BACKSPACE} in the regex`],
        }),
      ]),
    ],
  });
  const markdown = renderAuditReportMarkdown(buildAuditFindingsReport(model));

  // No byte below 0x20 except tab / LF / CR — the byte gate's own permitted set.
  const offending = [...markdown]
    .map((character) => character.codePointAt(0)!)
    .filter(
      (code) => code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d,
    );
  expect(
    offending.map((code) => `0x${code.toString(16).padStart(2, "0")}`),
    "a contract-valid finding must never render a raw control byte into the tracked report",
  ).toEqual([]);

  // Re-escaped, not deleted: the escape is readable and the text is preserved,
  // so a reader can still see the worker's mangled boundary.
  expect(markdown).toContain("\\u0008");
  expect(markdown).toContain("Boundary check\\u0008broken");
});

test("escapeControlCharacters preserves tab, LF and CR — the bytes markdown legitimately uses", () => {
  expect(escapeControlCharacters("a\tb\nc\rd")).toBe("a\tb\nc\rd");
  expect(escapeControlCharacters(`bell${BELL}null${NUL}`)).toBe(
    "bell\\u0007null\\u0000",
  );
});

// ── INV-audit-reporting-04: applyNarrative sanitizes duplicate finding_ids ───

test("INV-04: a finding_id claimed by the first theme is not re-assigned by a later theme", () => {
  const report = baseReport();
  const [first, second] = report.findings;

  // Second theme tries to claim the first finding's id (already claimed by T-1).
  const narrative = {
    themes: [
      {
        theme_id: "T-1",
        title: "First theme",
        root_cause: "Root cause A.",
        finding_ids: [first.id],
        suggested_fix_pattern: "Fix A.",
      },
      {
        theme_id: "T-2",
        title: "Second theme",
        root_cause: "Root cause B.",
        finding_ids: [first.id, second.id],  // first.id is a duplicate across themes
        suggested_fix_pattern: "Fix B.",
      },
    ],
    executive_summary: "Two themes.",
    top_risks: [],
  };

  const enriched = applyNarrative(report, narrative);

  // Both themes are preserved.
  if (enriched.themes === undefined) {
    throw new Error("narrative themes missing");
  }
  expect(enriched.themes.length).toBe(2);

  const t1 = enriched.themes.find((t) => t.theme_id === "T-1");
  const t2 = enriched.themes.find((t) => t.theme_id === "T-2");
  expect(t1).toBeTruthy();
  expect(t2).toBeTruthy();
  if (t1 === undefined || t2 === undefined) {
    throw new Error("expected narrative themes missing");
  }

  // T-1 keeps first.id as first-claimer.
  expect(t1.finding_ids.includes(first.id), "T-1 must retain the first-claimed id").toBeTruthy();

  // T-2 must NOT contain first.id (already claimed by T-1).
  expect(!t2.finding_ids.includes(first.id), "T-2 must not contain a finding_id already claimed by T-1").toBeTruthy();

  // T-2 keeps second.id which was not previously claimed.
  expect(t2.finding_ids.includes(second.id), "T-2 must keep its unclaimed finding_id").toBeTruthy();
});

test("INV-04: duplicate finding_ids within one theme's list are deduplicated", () => {
  const report = baseReport();
  const [first] = report.findings;

  const narrative = {
    themes: [
      {
        theme_id: "T-1",
        title: "Single theme with dup ids",
        root_cause: "Root cause.",
        finding_ids: [first.id, first.id, first.id],  // triply-repeated
        suggested_fix_pattern: "Fix.",
      },
    ],
    executive_summary: "Test.",
    top_risks: [],
  };

  const enriched = applyNarrative(report, narrative);

  if (enriched.themes === undefined) {
    throw new Error("narrative themes missing");
  }
  expect(enriched.themes.length).toBe(1);
  const t1 = enriched.themes[0];
  expect(t1.finding_ids.length, "duplicate finding_ids within one theme must be deduplicated to one entry").toBe(1);
  expect(t1.finding_ids[0]).toBe(first.id);
});

test("INV-04: applyNarrative never drops or re-severities findings — the finding set is unchanged", () => {
  const report = baseReport();
  const originalFindings = report.findings.map((f) => ({ id: f.id, severity: f.severity }));

  const narrative = {
    themes: [
      {
        theme_id: "T-1",
        title: "A theme",
        root_cause: "Root.",
        finding_ids: [report.findings[0].id],
        suggested_fix_pattern: "Fix.",
      },
    ],
    executive_summary: "Test.",
    top_risks: [],
  };

  // Uniform id-join contract: an unknown id refuses the whole narrative.
  expect(() =>
    applyNarrative(report, {
      ...narrative,
      themes: [{ ...narrative.themes[0], finding_ids: [report.findings[0].id, "UNKNOWN-ID-XYZ"] }],
    }),
  ).toThrow(/UNKNOWN-ID-XYZ/);

  const enriched = applyNarrative(report, narrative);

  // Finding set is unchanged in count, ids, and severities.
  expect(enriched.findings.length, "applyNarrative must not drop or add findings").toBe(originalFindings.length);
  for (const orig of originalFindings) {
    const enrichedFinding = enriched.findings.find((f) => f.id === orig.id);
    expect(enrichedFinding, `finding ${orig.id} must still be present after applyNarrative`).toBeTruthy();
    if (enrichedFinding === undefined) {
      throw new Error(`finding ${orig.id} missing after applyNarrative`);
    }
    expect(enrichedFinding.severity, `applyNarrative must not change severity of finding ${orig.id}`).toBe(orig.severity);
  }
});

// ── INV-audit-reporting-06: normalizeExistingFindingsReport recomputes counts ─

test("INV-06: normalizeExistingFindingsReport recomputes finding_count and work_block_count from the findings and work_blocks arrays", () => {
  const report = baseReport();

  // Corrupt the summary counts to simulate a drifted/stale promoted file.
  const stale = {
    ...report,
    summary: {
      ...report.summary,
      finding_count: 999,
      work_block_count: 42,
      severity_breakdown: { critical: 100 },
      lens_breakdown: { fake: 99 },
    },
  };

  const normalized = normalizeExistingFindingsReport(stale);

  expect(normalized.summary.finding_count, "finding_count must be recomputed from findings.length").toBe(report.findings.length);
  expect(normalized.summary.work_block_count, "work_block_count must be recomputed from work_blocks.length").toBe(report.work_blocks.length);
});

test("INV-06: normalizeExistingFindingsReport recomputes severity_breakdown from findings", () => {
  const report = baseReport();

  const stale = {
    ...report,
    summary: { ...report.summary, severity_breakdown: { critical: 100 } },
  };

  const normalized = normalizeExistingFindingsReport(stale);

  // The real breakdown must match what we can compute from the findings.
  const expected: Record<string, number> = {};
  for (const f of report.findings) {
    expected[f.severity] = (expected[f.severity] ?? 0) + 1;
  }
  expect(normalized.summary.severity_breakdown, "severity_breakdown must be recomputed from findings").toEqual(expected);
});

test("INV-06: normalizeExistingFindingsReport preserves upstream-derived fields (audited/excluded counts, runtime breakdown)", () => {
  const report = baseReport();

  // Upstream-derived fields that cannot be reconstructed without the bundle intermediates.
  const stale = {
    ...report,
    summary: {
      ...report.summary,
      audited_file_count: 17,
      excluded_file_count: 3,
      runtime_validation_status_breakdown: { confirmed: 5, pending: 2 },
    },
  };

  const normalized = normalizeExistingFindingsReport(stale);

  expect(normalized.summary.audited_file_count, "audited_file_count must be preserved (not recomputable without bundle intermediates)").toBe(17);
  expect(normalized.summary.excluded_file_count, "excluded_file_count must be preserved").toBe(3);
  expect(normalized.summary.runtime_validation_status_breakdown, "runtime_validation_status_breakdown must be preserved").toEqual({ confirmed: 5, pending: 2 });
});

// ── INV-audit-reporting-07: language-neutral render ───────────────────────────

test("INV-07: renderAuditReportMarkdown renders findings from mixed-language results without language-specific branching", () => {
  // Findings from TypeScript, Python, Go, and Rust files in one report.
  const model = buildAuditReportModel({
    results: [
      {
        task_id: "t-ts",
        unit_id: "u-ts",
        pass_id: "pass:correctness",
        lens: "correctness",
        file_coverage: [{ path: "src/main.ts", total_lines: 100 }],
        findings: [
          makeFinding({
            id: "F-TS",
            title: "TypeScript issue",
            lens: "correctness",
            affected_files: [{ path: "src/main.ts" }],
          }),
        ],
      },
      {
        task_id: "t-py",
        unit_id: "u-py",
        pass_id: "pass:correctness",
        lens: "correctness",
        file_coverage: [{ path: "lib/helper.py", total_lines: 50 }],
        findings: [
          makeFinding({
            id: "F-PY",
            title: "Python issue",
            lens: "security",
            affected_files: [{ path: "lib/helper.py" }],
          }),
        ],
      },
      {
        task_id: "t-go",
        unit_id: "u-go",
        pass_id: "pass:correctness",
        lens: "correctness",
        file_coverage: [{ path: "cmd/server.go", total_lines: 80 }],
        findings: [
          makeFinding({
            id: "F-GO",
            title: "Go issue",
            lens: "reliability",
            affected_files: [{ path: "cmd/server.go" }],
          }),
        ],
      },
      {
        task_id: "t-rs",
        unit_id: "u-rs",
        pass_id: "pass:correctness",
        lens: "correctness",
        file_coverage: [{ path: "src/lib.rs", total_lines: 60 }],
        findings: [
          makeFinding({
            id: "F-RS",
            title: "Rust issue",
            lens: "maintainability",
            affected_files: [{ path: "src/lib.rs" }],
          }),
        ],
      },
    ],
  });

  const report = buildAuditFindingsReport(model);
  const markdown = renderAuditReportMarkdown(report);

  // All four findings appear in the render, regardless of language.
  expect(report.summary.finding_count, "all 4 mixed-language findings must be present").toBe(4);
  for (const finding of report.findings) {
    expect(markdown.includes(finding.id), `finding ${finding.id} from ${finding.affected_files[0].path} must appear in the render`).toBeTruthy();
    expect(markdown.includes(finding.affected_files[0].path), `file path ${finding.affected_files[0].path} must appear in the render`).toBeTruthy();
  }
});

test("INV-07: the report shape is identical whether findings reference .ts, .py, .go, or .rs files", () => {
  // Same finding structure but for different language file paths → same report structure.
  const makeReport = (path: string) =>
    buildAuditFindingsReport(
      buildAuditReportModel({
        results: [
          {
            task_id: "t-1",
            unit_id: "u-1",
            pass_id: "pass:correctness",
            lens: "correctness",
            file_coverage: [{ path, total_lines: 10 }],
            findings: [
              makeFinding({
                id: "F-1",
                title: "Missing validation",
                lens: "security",
                affected_files: [{ path }],
              }),
            ],
          },
        ],
      }),
    );

  const tsReport = makeReport("src/auth.ts");
  const pyReport = makeReport("auth/views.py");
  const goReport = makeReport("pkg/auth/auth.go");

  // All three have exactly one finding and one work block — shape is language-neutral.
  expect(tsReport.summary.finding_count).toBe(1);
  expect(pyReport.summary.finding_count).toBe(1);
  expect(goReport.summary.finding_count).toBe(1);

  expect(tsReport.summary.work_block_count).toBe(pyReport.summary.work_block_count);
  expect(pyReport.summary.work_block_count).toBe(goReport.summary.work_block_count);

  // The markdown render structure is the same across languages.
  const tsMd = renderAuditReportMarkdown(tsReport);
  const pyMd = renderAuditReportMarkdown(pyReport);
  const goMd = renderAuditReportMarkdown(goReport);

  for (const md of [tsMd, pyMd, goMd]) {
    expect(md).toMatch(/## Findings/);
    expect(md).toMatch(/- Severity: medium/);
  }
});

// ── INV-audit-reporting-08: structured stderr, not console.warn ───────────────

test("INV-08: renderSynthesisNarrativePrompt writes truncation notice to process.stderr (not console.warn) when findings exceed cap", () => {
  // Build a report with more than 120 findings (the render cap in synthesisNarrativePrompt.ts).
  const manyFindings = Array.from({ length: 130 }, (_, i) =>
    makeFinding({
      id: `F-${i}`,
      title: `Unique finding title for issue number ${i}`,
      lens: "correctness",
      severity: "medium",
      affected_files: [{ path: `src/module${i}.ts` }],
    }),
  );

  const model = buildAuditReportModel({
    results: [
      {
        task_id: "t-1",
        unit_id: "u-1",
        pass_id: "pass:correctness",
        lens: "correctness",
        file_coverage: manyFindings.map((f) => ({
          path: f.affected_files[0].path,
          total_lines: 10,
        })),
        findings: manyFindings,
      },
    ],
  });
  const report = buildAuditFindingsReport(model);

  // Replace process.stderr.write temporarily to capture output.
  const capturedStderr: string[] = [];
  const capturedConsoleWarn: string[] = [];

  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const origConsoleWarn = console.warn;

  process.stderr.write = (chunk, ..._args) => {
    capturedStderr.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  console.warn = (...args) => {
    capturedConsoleWarn.push(args.join(" "));
  };

  try {
    renderSynthesisNarrativePrompt(report);
  } finally {
    process.stderr.write = origStderrWrite;
    console.warn = origConsoleWarn;
  }

  // The truncation notice must go to stderr, not console.warn.
  expect(capturedConsoleWarn.length, "truncation notice must NOT use console.warn (INV-audit-reporting-08 / OBS-ad223196)").toBe(0);
  expect(capturedStderr.some((msg) => msg.includes("truncated findings list")), "truncation notice must be written to process.stderr").toBeTruthy();
});

test("INV-08: renderSynthesisNarrativePrompt does NOT write to stderr when findings are within the render cap", () => {
  const report = baseReport(); // only 3 findings, well below the 120 cap

  const capturedStderr: string[] = [];
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ..._args) => {
    capturedStderr.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };

  try {
    renderSynthesisNarrativePrompt(report);
  } finally {
    process.stderr.write = origStderrWrite;
  }

  const truncationMessages = capturedStderr.filter((msg) =>
    msg.includes("truncated findings list"),
  );
  expect(truncationMessages.length, "no truncation notice must be emitted when findings are within the render cap").toBe(0);
});

// ── OBL-INV-APR-09: contract_version single-source + deferred prompt has no Command argv ──

const { AUDIT_FINDINGS_CONTRACT_VERSION: sharedVersion } = await import("audit-tools/shared");

test("OBL-INV-APR-09: buildAuditFindingsReport stamps contract_version identical to shared AUDIT_FINDINGS_CONTRACT_VERSION", () => {
  const report = baseReport();

  // The re-export in synthesis.ts must equal the shared canonical constant.
  expect(AUDIT_FINDINGS_CONTRACT_VERSION, "synthesis.ts AUDIT_FINDINGS_CONTRACT_VERSION must re-export the shared constant, not define a local copy").toBe(sharedVersion);

  // buildAuditFindingsReport must stamp the canonical version.
  expect(report.contract_version, "buildAuditFindingsReport must produce contract_version === shared AUDIT_FINDINGS_CONTRACT_VERSION").toBe(sharedVersion);

  // The version string must be non-trivial so a blank re-export cannot pass.
  expect(typeof sharedVersion === "string" && sharedVersion.length > 0, "shared AUDIT_FINDINGS_CONTRACT_VERSION must be a non-empty string").toBeTruthy();
});
