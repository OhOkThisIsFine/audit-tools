// S7 tier-3 surfacing: the grounding verdict (set at ingest by the
// quote-and-verify pass) must survive synthesis and be visibly separated in the
// report — a per-status summary breakdown, an inline mark on each ungrounded
// finding, and a dedicated "Ungrounded Findings (quarantined)" section — so a
// hallucinated/stale finding is surfaced, never silently confirmed. Also guards
// the grounded-wins merge rule and the audit_findings.schema.json drift fix.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertMatchesJsonSchema } from "./helpers/auditSchemaRegistry.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

const { buildAuditReportModel, buildAuditFindingsReport, renderAuditReportMarkdown } =
  await import("../src/reporting/synthesis.ts");

const auditFindingsSchema = JSON.parse(
  await readFile(join(repoRoot, "schemas", "audit_findings.schema.json"), "utf8"),
);

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
  assertMatchesJsonSchema(auditFindingsSchema, plain, "plain");

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
  assertMatchesJsonSchema(auditFindingsSchema, mixed, "mixed");
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
  assert.match(md, /## Ungrounded Findings \(quarantined\)/);
  assert.match(md, /Hallucinated cycle/);
  assert.match(md, /Reason: src\/x\.ts: quoted_text not found on disk/);
  assert.match(md, /⚠ Grounding: ungrounded/);
  assert.match(
    md,
    /- Grounding \(S7\): grounded: 1, ungrounded: 1 — ungrounded findings are quarantined below/,
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
