import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Enforcement for the standing rule "design docs are declarative target
// contracts, not status logs" (CLAUDE.md: timeless conceptual docs only).
// The design docs describe the system we want; completion is checked SEPARATELY
// against code (audits, invariant tests). Current-state / status language
// ("currently X is broken", "not yet wired", defect tables, DONE markers,
// "remove entries as they ship") is what goes stale and turns specs into
// optional suggestions — so it is banned here and the build fails if it returns.
//
// backlog.md is deliberately exempt: it IS a status / to-do log by design.

const here = dirname(fileURLToPath(import.meta.url));
// tests/ -> audit-code/ -> packages/ -> repo root
const repoRoot = join(here, "..", "..", "..");

const DESIGN_DOCS = ["audit-workflow-design.md", "remediation-workflow-design.md"];

// Current-state / status phrases. Single words are word-bounded to avoid
// substring false positives (e.g. "done" inside "abandoned"). `DONE` is matched
// case-sensitively: the uppercase status marker is banned, but the ordinary word
// "done" (e.g. "work already done") is fine.
const BANNED = [
  /\bcurrently\b/i,
  /\bunwired\b/i,
  /\bnot yet\b/i,
  /\btoday\b/i,
  /\bverified defect\b/i,
  /\bdefect table\b/i,
  /\bstate today\b/i,
  /remove entries as they ship/i,
  /\bforward-looking\b/i,
  /\bstatus:\s*proposed\b/i,
  /\brecently shipped\b/i,
  /\bTODO\b/i,
  /\bFIXME\b/i,
  /\bDONE\b/, // case-sensitive: the status marker, not the word "done"
];

for (const docName of DESIGN_DOCS) {
  test(`design doc is declarative (no current-state/status language): ${docName}`, () => {
    const text = readFileSync(join(repoRoot, "docs", docName), "utf8");
    const lines = text.split(/\r?\n/);
    const violations = [];
    lines.forEach((line, i) => {
      for (const pattern of BANNED) {
        const m = line.match(pattern);
        if (m) violations.push(`${docName}:${i + 1}: banned "${m[0]}" — ${line.trim()}`);
      }
    });
    assert.equal(
      violations.length,
      0,
      `Design docs must be declarative target contracts, not status logs. ` +
        `Found current-state/status language — rewrite as the target the system ` +
        `should meet (completion is checked separately against code):\n` +
        violations.join("\n"),
    );
  });
}
