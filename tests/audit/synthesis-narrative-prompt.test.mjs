import test from "node:test";
import assert from "node:assert/strict";

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

  assert.match(prompt, /# Synthesis narrative/, "prompt contains header");
  assert.match(prompt, /- Findings: 1/, "prompt shows finding count");
  assert.match(prompt, /- Work blocks: 2/, "prompt shows work block count");
  assert.match(prompt, /## Findings/, "prompt contains findings section header");
  // The finding summary line must include id, severity, lens, title, and summary.
  assert.match(prompt, /TST-0001/, "prompt includes finding id");
  assert.match(prompt, /high/, "prompt includes severity");
  assert.match(prompt, /security/, "prompt includes lens");
  assert.match(prompt, /high\/security\/test/, "prompt includes category");
  assert.match(prompt, /Weak token check/, "prompt includes title");
  assert.match(prompt, /Token boundary is weak\./, "prompt includes summary");
  assert.match(prompt, /src\/auth\.ts/, "prompt includes affected file path");
  assert.doesNotMatch(prompt, /more findings/, "no overflow note for small report");
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

  assert.match(prompt, /DR-001 \[medium\/architecture\/inferred_contract_gap\]/);
  assert.match(prompt, /DR-002 \[medium\/architecture\/design_simplification\]/);
  assert.match(prompt, /contract assessment findings from conceptual design critique findings/);
  assert.match(prompt, /Do not re-audit the code, change severities, or invent new findings/);
});

// ── Overflow path ────────────────────────────────────────────────────────────

test("renderSynthesisNarrativePrompt includes overflow note when findings exceed MAX_RENDERED_FINDINGS (120)", () => {
  const TOTAL = MAX_RENDERED_FINDINGS + 15; // 135
  const findings = Array.from({ length: TOTAL }, (_, i) => makeFinding(i + 1));
  const report = makeReport(findings);
  const prompt = renderSynthesisNarrativePrompt(report);

  const overflowNote = `... and ${TOTAL - MAX_RENDERED_FINDINGS} more findings (see audit-findings.json).`;
  assert.ok(prompt.includes(overflowNote), `overflow note present: "${overflowNote}"`);

  // Count rendered finding lines (lines starting with "- F-")
  const findingLines = prompt.split("\n").filter((l) => /^- F-/.test(l));
  assert.equal(findingLines.length, MAX_RENDERED_FINDINGS, "exactly 120 finding lines rendered");

  // The 121st finding's title should not appear in the prompt.
  assert.doesNotMatch(prompt, new RegExp(`Finding title ${MAX_RENDERED_FINDINGS + 1}`),
    "121st finding title is not rendered");
});

// ── Empty findings ───────────────────────────────────────────────────────────

test("renderSynthesisNarrativePrompt renders sentinel line when findings array is empty", () => {
  const report = makeReport([]);
  const prompt = renderSynthesisNarrativePrompt(report);

  assert.match(prompt, /\(no findings were recorded\)/, "sentinel line present");
  assert.doesNotMatch(prompt, /more findings/, "no overflow note when findings empty");
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
  assert.equal(truncationChunks.length, 1, "process.stderr.write called exactly once with the truncation notice");
  assert.ok(
    truncationChunks[0].includes(String(MAX_RENDERED_FINDINGS)),
    `stderr notice includes the cap (${MAX_RENDERED_FINDINGS})`,
  );
  assert.ok(
    truncationChunks[0].includes(String(TOTAL)),
    `stderr notice includes the total count (${TOTAL})`,
  );
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
  assert.equal(truncationChunks.length, 0, "no stderr truncation notice when at exactly the cap");
});

test("renderSynthesisNarrativePrompt does NOT emit to process.stderr for fewer than MAX_RENDERED_FINDINGS findings", () => {
  const findings = Array.from({ length: 5 }, (_, i) => makeFinding(i + 1));
  const report = makeReport(findings);

  const { stderrChunks } = withCapturedStderrSync(() =>
    renderSynthesisNarrativePrompt(report),
  );

  const truncationChunks = stderrChunks.filter((c) => c.includes("truncated findings list"));
  assert.equal(truncationChunks.length, 0, "no stderr truncation notice for small finding list");
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
  assert.ok(prompt.includes(overflowNote), "overflow note still present in returned prompt");
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

  assert.match(prompt, /src\/a\.ts/, "first file appears");
  assert.match(prompt, /src\/b\.ts/, "second file appears");
  assert.match(prompt, /src\/c\.ts/, "third file appears");
  assert.match(prompt, /src\/d\.ts/, "fourth file appears");
  assert.doesNotMatch(prompt, /src\/e\.ts/, "fifth file does not appear (truncated)");
  assert.doesNotMatch(prompt, /src\/f\.ts/, "sixth file does not appear (truncated)");
});
