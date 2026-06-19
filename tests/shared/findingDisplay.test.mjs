// Single-sourced finding display (dogfood note 2 + auditor/remediator parity).
// Locks the standardized block contract so the auditor report and the
// remediator's host prompts — which both render findings through THIS module —
// cannot drift apart in field order, grounding handling, or trim behavior.
import test from "node:test";
import assert from "node:assert/strict";

const {
  findingLead,
  formatFindingFileRef,
  findingGroundingLine,
  renderFindingBadgeBody,
  renderFindingBlock,
} = await import("../../src/shared/reporting/findingDisplay.ts");

function finding(overrides = {}) {
  return {
    id: "ARC-001",
    title: "Module boundary leak",
    severity: "high",
    confidence: "medium",
    lens: "architecture",
    summary: "Intake reaches into dispatch internals. It bypasses the contract.",
    affected_files: [
      { path: "src/a.ts", line_start: 42, line_end: 78 },
      { path: "src/b.ts", line_start: 5 },
      { path: "src/c.ts" },
      { path: "src/d.ts" },
      { path: "src/e.ts" },
      { path: "src/f.ts" },
    ],
    evidence: ["ev one", "ev two", "ev three"],
    grounding: { status: "grounded" },
    ...overrides,
  };
}

test("findingLead is the first sentence only", () => {
  assert.equal(
    findingLead("Intake reaches into dispatch internals. It bypasses the contract."),
    "Intake reaches into dispatch internals.",
  );
  assert.equal(findingLead(undefined), "");
});

test("formatFindingFileRef handles bare paths and line ranges (en-dash)", () => {
  assert.equal(formatFindingFileRef("src/x.ts"), "`src/x.ts`");
  assert.equal(formatFindingFileRef({ path: "src/x.ts", line_start: 5 }), "`src/x.ts:5`");
  assert.equal(
    formatFindingFileRef({ path: "src/x.ts", line_start: 5, line_end: 9 }),
    "`src/x.ts:5–9`",
  );
});

test("findingGroundingLine — always renders, every status", () => {
  assert.equal(findingGroundingLine({ severity: "x", lens: "y" }), "- Grounding: not assessed");
  assert.equal(
    findingGroundingLine({ severity: "x", lens: "y", grounding: { status: "grounded" } }),
    "- Grounding: grounded",
  );
  assert.match(
    findingGroundingLine({ severity: "x", lens: "y", grounding: { status: "ungrounded", reason: "no quote" } }),
    /⚠ ungrounded — no quote/,
  );
  assert.match(
    findingGroundingLine({ severity: "x", lens: "y", grounding: { status: "refuted", reason: "madge" } }),
    /✗ refuted — madge/,
  );
});

test("badge body: fixed order, grounding always, files trimmed, evidence summarized (decision view)", () => {
  const body = renderFindingBadgeBody(finding());
  // Fixed order: Severity → Confidence → Lens → Grounding.
  assert.deepEqual(body.slice(0, 4), [
    "- Severity: high",
    "- Confidence: medium",
    "- Lens: architecture",
    "- Grounding: grounded",
  ]);
  // Files trimmed to 4 + "+2 more" (6 total).
  const files = body.find((l) => l.startsWith("- Files:"));
  assert.match(files, /`src\/a\.ts:42–78`.*\+2 more/);
  assert.ok(!files.includes("src/f.ts"), "trimmed files omit the tail");
  // Details = full summary (it carries more than the lead).
  assert.ok(body.some((l) => l.startsWith("- Details: Intake reaches")));
  // Evidence summarized with a count + pointer.
  assert.ok(
    body.some((l) => /- Evidence: 3 items \(top: "ev one"\) — see audit-findings\.json/.test(l)),
  );
});

test("badge body: worker view keeps the full file/evidence set (no trim) and can drop sections", () => {
  const body = renderFindingBadgeBody(finding(), {
    trimFiles: false,
    summarizeEvidence: false,
    showGrounding: false,
    showFiles: false,
    showEvidence: false,
    showDetails: false,
  });
  assert.ok(!body.some((l) => l.startsWith("- Grounding:")), "grounding dropped");
  assert.ok(!body.some((l) => l.startsWith("- Files:")), "files dropped");
  assert.ok(!body.some((l) => l.startsWith("- Evidence:")), "evidence dropped");
  assert.ok(!body.some((l) => l.startsWith("- Details:")), "details dropped");
  // Still the consistent Severity → Confidence → Lens spine.
  assert.deepEqual(body, ["- Severity: high", "- Confidence: medium", "- Lens: architecture"]);
});

test("badge body: confidence omitted when absent (review/projection inputs)", () => {
  const body = renderFindingBadgeBody({
    severity: "medium",
    lens: "security",
    affected_files: ["src/login.ts"],
  });
  assert.ok(!body.some((l) => l.startsWith("- Confidence:")));
  assert.equal(body[0], "- Severity: medium");
  assert.equal(body[1], "- Lens: security");
});

test("full block: heading (em-dash) + lead + badge", () => {
  const block = renderFindingBlock(finding());
  assert.match(block, /^### ARC-001 — Module boundary leak\n/);
  assert.ok(block.includes("\nIntake reaches into dispatch internals.\n"));
  assert.ok(block.includes("- Severity: high"));
});

test("systemic/impact/likelihood surface only when present", () => {
  const plain = renderFindingBadgeBody(finding());
  assert.ok(!plain.some((l) => l.startsWith("- Systemic:")));
  const rich = renderFindingBadgeBody(finding({ systemic: true, impact: "data loss", likelihood: "rare" }));
  assert.ok(rich.includes("- Systemic: yes"));
  assert.ok(rich.includes("- Impact: data loss"));
  assert.ok(rich.includes("- Likelihood: rare"));
});
