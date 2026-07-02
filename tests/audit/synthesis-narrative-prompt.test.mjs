import { test, expect } from "vitest";

const { renderSynthesisNarrativePrompt } = await import("../../src/audit/reporting/synthesisNarrativePrompt.ts");

// MAX_RENDERED_FINDINGS is 120 (internal constant in synthesisNarrativePrompt.ts).
const MAX_RENDERED_FINDINGS = 120;

function makeFinding(i, overrides = {}) {
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

function makeReport(findings, workBlockCount = 1) {
  return {
    contract_version: "audit-findings/v1alpha1",
    generated_at: "2026-01-01T00:00:00.000Z",
    summary: {
      finding_count: findings.length,
      work_block_count: workBlockCount,
    },
    findings,
    work_blocks: [],
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
  const prompt = renderSynthesisNarrativePrompt(report);

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

test("renderSynthesisNarrativePrompt preserves contract-assessment distinctions", () => {
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
  const prompt = renderSynthesisNarrativePrompt(report);

  expect(prompt).toMatch(/DR-001 \[medium\/architecture\/inferred_contract_gap\]/);
  expect(prompt).toMatch(/DR-002 \[medium\/architecture\/design_simplification\]/);
  expect(prompt).toMatch(/contract assessment findings from conceptual design critique findings/);
  expect(prompt).toMatch(/Do not re-audit the code, change severities, or invent new findings/);
});

// ── Overflow path ────────────────────────────────────────────────────────────

test("renderSynthesisNarrativePrompt includes overflow note when findings exceed MAX_RENDERED_FINDINGS (120)", () => {
  const TOTAL = MAX_RENDERED_FINDINGS + 15; // 135
  const findings = Array.from({ length: TOTAL }, (_, i) => makeFinding(i + 1));
  const report = makeReport(findings);
  const prompt = renderSynthesisNarrativePrompt(report);

  const overflowNote = `... and ${TOTAL - MAX_RENDERED_FINDINGS} more findings (see audit-findings.json).`;
  expect(prompt.includes(overflowNote), `overflow note present: "${overflowNote}"`).toBeTruthy();

  // Count rendered finding lines (lines starting with "- F-")
  const findingLines = prompt.split("\n").filter((l) => /^- F-/.test(l));
  expect(findingLines.length, "exactly 120 finding lines rendered").toBe(MAX_RENDERED_FINDINGS);

  // The 121st finding's title should not appear in the prompt.
  expect(prompt, "121st finding title is not rendered").not.toMatch(new RegExp(`Finding title ${MAX_RENDERED_FINDINGS + 1}`));
});

// ── Empty findings ───────────────────────────────────────────────────────────

test("renderSynthesisNarrativePrompt renders sentinel line when findings array is empty", () => {
  const report = makeReport([]);
  const prompt = renderSynthesisNarrativePrompt(report);

  expect(prompt, "sentinel line present").toMatch(/\(no findings were recorded\)/);
  expect(prompt, "no overflow note when findings empty").not.toMatch(/more findings/);
});

// ── process.stderr on truncation (INV-audit-reporting-08 / OBS-ad223196) ─────
// The truncation notice MUST go through process.stderr.write, not console.warn.

/** Capture and restore process.stderr.write for a synchronous body. */
function withCapturedStderrSync(fn) {
  const original = process.stderr.write.bind(process.stderr);
  const chunks = [];
  process.stderr.write = (chunk) => {
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
    renderSynthesisNarrativePrompt(report),
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
    renderSynthesisNarrativePrompt(report),
  );

  const truncationChunks = stderrChunks.filter((c) => c.includes("truncated findings list"));
  expect(truncationChunks.length, "no stderr truncation notice when at exactly the cap").toBe(0);
});

test("renderSynthesisNarrativePrompt does NOT emit to process.stderr for fewer than MAX_RENDERED_FINDINGS findings", () => {
  const findings = Array.from({ length: 5 }, (_, i) => makeFinding(i + 1));
  const report = makeReport(findings);

  const { stderrChunks } = withCapturedStderrSync(() =>
    renderSynthesisNarrativePrompt(report),
  );

  const truncationChunks = stderrChunks.filter((c) => c.includes("truncated findings list"));
  expect(truncationChunks.length, "no stderr truncation notice for small finding list").toBe(0);
});

test("renderSynthesisNarrativePrompt still contains overflow note in prompt when stderr fires", () => {
  const TOTAL = MAX_RENDERED_FINDINGS + 10; // 130
  const findings = Array.from({ length: TOTAL }, (_, i) => makeFinding(i + 1));
  const report = makeReport(findings);

  let prompt;
  withCapturedStderrSync(() => {
    prompt = renderSynthesisNarrativePrompt(report);
  });

  const overflowNote = `... and ${TOTAL - MAX_RENDERED_FINDINGS} more findings (see audit-findings.json).`;
  expect(prompt.includes(overflowNote), "overflow note still present in returned prompt").toBeTruthy();
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
  const prompt = renderSynthesisNarrativePrompt(report);

  expect(prompt, "first file appears").toMatch(/src\/a\.ts/);
  expect(prompt, "second file appears").toMatch(/src\/b\.ts/);
  expect(prompt, "third file appears").toMatch(/src\/c\.ts/);
  expect(prompt, "fourth file appears").toMatch(/src\/d\.ts/);
  expect(prompt, "fifth file does not appear (truncated)").not.toMatch(/src\/e\.ts/);
  expect(prompt, "sixth file does not appear (truncated)").not.toMatch(/src\/f\.ts/);
});
