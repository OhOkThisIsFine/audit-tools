import { test, expect } from "vitest";
import type { AuditFindingsReport, Finding } from "../../src/shared/types/finding.js";
import { buildAuditFindingsDeliverable } from "../../src/shared/reporting/auditDeliverable.js";

const { renderSynthesisNarrativePrompt } = await import("../../src/audit/reporting/synthesisNarrativePrompt.js");

// MAX_RENDERED_FINDINGS is 120 (internal constant in synthesisNarrativePrompt.ts).
const MAX_RENDERED_FINDINGS = 120;

/**
 * The complete findings report's host-facing path. The emitter passes the real
 * one and GRANTS it in the step's `read_paths` (owner review 2026-09-17, prompt
 * 14): the overflow line is only actionable if the reader can open what it names.
 */
const FINDINGS_PATH = "/tmp/.audit-tools/audit/audit-findings.json";

function makeFinding(i: number, overrides: Partial<Finding> = {}): Finding {
  return {
    id: `F-${String(i).padStart(4, "0")}`,
    title: `Finding title ${i}`,
    severity: "medium",
    confidence: "high",
    lens: "correctness",
    summary: `Summary of finding ${i}.`,
    affected_files: [{ path: `src/file${i}.ts`, line_start: i }],
    evidence: [],
    category: "test",
    ...overrides,
  };
}

function makeReport(findings: Finding[], workBlockCount?: number): AuditFindingsReport {
  const report = buildAuditFindingsDeliverable(findings, null);
  if (workBlockCount === undefined) return report;
  return {
    ...report,
    summary: {
      ...report.summary,
      work_block_count: workBlockCount,
    },
  };
}

// ── Normal path (findings under MAX_RENDERED_FINDINGS) ──────────────────────

test("renderSynthesisNarrativePrompt renders header and finding summaries for a small report", () => {
  const findings = [
    makeFinding(1, {
      id: "TST-0001",
      title: "Weak token check",
      summary: "Token boundary is weak.",
      affected_files: [{ path: "src/auth.ts", line_start: 10 }],
      lens: "security",
      severity: "high",
    }),
  ];
  const report = makeReport(findings, 2);
  const prompt = renderSynthesisNarrativePrompt(report, FINDINGS_PATH);

  expect(prompt, "prompt contains header").toMatch(/# Synthesis narrative/);
  expect(prompt, "prompt shows finding count").toMatch(/- Findings: 1/);
  expect(prompt, "prompt shows work block count").toMatch(/- Work blocks: 2/);
  expect(prompt, "prompt contains findings section header").toMatch(/## Findings/);
  // The finding summary line must include id, severity, lens, title, and summary.
  expect(prompt, "prompt includes finding id").toMatch(/TST-0001/);
  expect(prompt, "prompt includes severity").toMatch(/high/);
  expect(prompt, "prompt includes lens").toMatch(/security/);
  expect(prompt, "prompt includes category").toMatch(/high\/security\/test/);
  expect(prompt, "prompt includes title").toMatch(/Weak token check/);
  expect(prompt, "prompt includes summary").toMatch(/Token boundary is weak\./);
  expect(prompt, "prompt includes affected file path").toMatch(/src\/auth\.ts/);
  expect(prompt, "no overflow note for small report").not.toMatch(/more findings/);
});

// Owner review 2026-09-17 (prompt 14 of docs/reviews/prompt-refinement-2026-09-13.md)
// removed two sentences. This test states WHY each one went, so a later reader
// who wants to put one back has the measurement rather than the absence.
test("renderSynthesisNarrativePrompt asks for no distinction the rendered line cannot carry", () => {
  const report = makeReport([
    makeFinding(1, {
      id: "DR-001",
      category: "inferred_contract_gap",
      lens: "architecture",
      title: "Implicit tenancy contract is unenforced",
    }),
    makeFinding(2, {
      id: "DR-002",
      category: "design_simplification",
      lens: "architecture",
      title: "Configuration layers can collapse",
    }),
  ]);
  const prompt = renderSynthesisNarrativePrompt(report, FINDINGS_PATH);

  // The line still carries severity / lens / category, unchanged.
  expect(prompt).toMatch(/DR-001 \[medium\/architecture\/inferred_contract_gap\]/);
  expect(prompt).toMatch(/DR-002 \[medium\/architecture\/design_simplification\]/);

  // But the prompt no longer asks the reader to separate "contract assessment"
  // from "design critique" findings: the lens vocabulary has ONE architecture
  // value and `category` is a free string the reviewer writes, so no rendered
  // line tells the two apart and the request was unanswerable.
  expect(
    prompt,
    "the observational-vs-conceptual request is not answerable from the rendered line",
  ).not.toMatch(/contract assessment/i);

  // And the three-part negative is gone: two of its three parts name things the
  // reader never writes back (`SynthesisNarrative` carries no severity field).
  expect(
    prompt,
    "the prompt must not warn against changing a field the reader does not submit",
  ).not.toMatch(/change severities/i);
});

test("renderSynthesisNarrativePrompt orders findings most-severe-first before the cap applies", () => {
  // Merge order, deliberately worst-last: `buildAuditFindingsDeliverable` copies
  // the findings array untouched, so without a sort the cap would cut by arrival.
  const findings = [
    ...Array.from({ length: MAX_RENDERED_FINDINGS }, (_, i) =>
      makeFinding(i + 1, { severity: "info" }),
    ),
    makeFinding(9001, { id: "F-CRIT", severity: "critical" }),
    makeFinding(9002, { id: "F-HIGH", severity: "high" }),
  ];
  const prompt = renderSynthesisNarrativePrompt(makeReport(findings), FINDINGS_PATH);

  const lines = prompt.split("\n").filter((l) => /^- F-/.test(l));
  expect(lines.length, "the cap still holds").toBe(MAX_RENDERED_FINDINGS);
  expect(lines[0], "the critical finding is rendered first, not cut").toMatch(/F-CRIT/);
  expect(lines[1], "the high finding is rendered second").toMatch(/F-HIGH/);
});

// ── Overflow path ────────────────────────────────────────────────────────────

test("renderSynthesisNarrativePrompt includes overflow note when findings exceed MAX_RENDERED_FINDINGS (120)", () => {
  const TOTAL = MAX_RENDERED_FINDINGS + 15; // 135
  const findings = Array.from({ length: TOTAL }, (_, i) => makeFinding(i + 1));
  const report = makeReport(findings);
  const prompt = renderSynthesisNarrativePrompt(report, FINDINGS_PATH);

  expect(
    prompt,
    "the overflow line states how many findings it omitted",
  ).toContain(`... and ${TOTAL - MAX_RENDERED_FINDINGS} more findings`);
  // The note must name a path the reader can actually open — a bare filename
  // sends it looking for a file it is granted no access to.
  expect(
    prompt,
    "the overflow line names the complete findings report by its granted path",
  ).toContain(FINDINGS_PATH);

  // Count rendered finding lines (lines starting with "- F-")
  const findingLines = prompt.split("\n").filter((l) => /^- F-/.test(l));
  expect(findingLines.length, "exactly 120 finding lines rendered").toBe(MAX_RENDERED_FINDINGS);

  // The 121st finding's title should not appear in the prompt.
  expect(prompt, "121st finding title is not rendered").not.toMatch(new RegExp(`Finding title ${MAX_RENDERED_FINDINGS + 1}`));
});

// ── Empty findings ───────────────────────────────────────────────────────────

test("renderSynthesisNarrativePrompt renders sentinel line when findings array is empty", () => {
  const report = makeReport([]);
  const prompt = renderSynthesisNarrativePrompt(report, FINDINGS_PATH);

  expect(prompt, "sentinel line present").toMatch(/\(no findings were recorded\)/);
  expect(prompt, "no overflow note when findings empty").not.toMatch(/more findings/);
});

// ── process.stderr on truncation (INV-audit-reporting-08 / OBS-ad223196) ─────
// The truncation notice MUST go through process.stderr.write, not console.warn.

/** Capture and restore process.stderr.write for a synchronous body. */
function withCapturedStderrSync<T>(fn: () => T): { result: T; stderrChunks: string[] } {
  const original = process.stderr.write.bind(process.stderr);
  const chunks: string[] = [];
  process.stderr.write = (chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  try {
    const result = fn();
    return { result, stderrChunks: chunks };
  } finally {
    process.stderr.write = original;
  }
}

test("renderSynthesisNarrativePrompt emits to process.stderr when findings exceed MAX_RENDERED_FINDINGS", () => {
  const TOTAL = MAX_RENDERED_FINDINGS + 1; // 121
  const findings = Array.from({ length: TOTAL }, (_, i) => makeFinding(i + 1));
  const report = makeReport(findings);

  const { stderrChunks } = withCapturedStderrSync(() =>
    renderSynthesisNarrativePrompt(report, FINDINGS_PATH),
  );

  const truncationChunks = stderrChunks.filter((c) => c.includes("synthesisNarrative: truncated"));
  expect(truncationChunks.length, "process.stderr.write called exactly once with the truncation notice").toBe(1);
  expect(truncationChunks[0].includes(String(MAX_RENDERED_FINDINGS)), `stderr notice includes the cap (${MAX_RENDERED_FINDINGS})`).toBeTruthy();
  expect(truncationChunks[0].includes(String(TOTAL)), `stderr notice includes the total count (${TOTAL})`).toBeTruthy();
});

test("renderSynthesisNarrativePrompt does NOT emit to process.stderr for exactly MAX_RENDERED_FINDINGS findings", () => {
  const findings = Array.from({ length: MAX_RENDERED_FINDINGS }, (_, i) =>
    makeFinding(i + 1),
  );
  const report = makeReport(findings);

  const { stderrChunks } = withCapturedStderrSync(() =>
    renderSynthesisNarrativePrompt(report, FINDINGS_PATH),
  );

  const truncationChunks = stderrChunks.filter((c) => c.includes("truncated findings list"));
  expect(truncationChunks.length, "no stderr truncation notice when at exactly the cap").toBe(0);
});

test("renderSynthesisNarrativePrompt does NOT emit to process.stderr for fewer than MAX_RENDERED_FINDINGS findings", () => {
  const findings = Array.from({ length: 5 }, (_, i) => makeFinding(i + 1));
  const report = makeReport(findings);

  const { stderrChunks } = withCapturedStderrSync(() =>
    renderSynthesisNarrativePrompt(report, FINDINGS_PATH),
  );

  const truncationChunks = stderrChunks.filter((c) => c.includes("truncated findings list"));
  expect(truncationChunks.length, "no stderr truncation notice for small finding list").toBe(0);
});

test("renderSynthesisNarrativePrompt still contains overflow note in prompt when stderr fires", () => {
  const TOTAL = MAX_RENDERED_FINDINGS + 10; // 130
  const findings = Array.from({ length: TOTAL }, (_, i) => makeFinding(i + 1));
  const report = makeReport(findings);

  let prompt!: string;
  withCapturedStderrSync(() => {
    prompt = renderSynthesisNarrativePrompt(report, FINDINGS_PATH);
  });

  expect(
    prompt,
    "overflow note still present in returned prompt",
  ).toContain(`... and ${TOTAL - MAX_RENDERED_FINDINGS} more findings`);
});

// ── summarizeFinding truncation ───────────────────────────────────────────────

test("summarizeFinding truncates affected_files to 4 paths", () => {
  const finding = makeFinding(99, {
    affected_files: [
      { path: "src/a.ts", line_start: 1 },
      { path: "src/b.ts", line_start: 2 },
      { path: "src/c.ts", line_start: 3 },
      { path: "src/d.ts", line_start: 4 },
      { path: "src/e.ts", line_start: 5 },
      { path: "src/f.ts", line_start: 6 },
    ],
  });
  const report = makeReport([finding]);
  const prompt = renderSynthesisNarrativePrompt(report, FINDINGS_PATH);

  expect(prompt, "first file appears").toMatch(/src\/a\.ts/);
  expect(prompt, "second file appears").toMatch(/src\/b\.ts/);
  expect(prompt, "third file appears").toMatch(/src\/c\.ts/);
  expect(prompt, "fourth file appears").toMatch(/src\/d\.ts/);
  expect(prompt, "fifth file does not appear (truncated)").not.toMatch(/src\/e\.ts/);
  expect(prompt, "sixth file does not appear (truncated)").not.toMatch(/src\/f\.ts/);
});
