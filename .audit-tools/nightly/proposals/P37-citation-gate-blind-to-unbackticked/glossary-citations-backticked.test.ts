// P37 red-green test. Belongs at tests/shared/glossary-citations-backticked.test.ts
// (under tests/ — vitest excludes .claude/**, so a test beside a hook never runs).
//
// RED before the patch: docs/glossary-ids.md writes every citation as a bare table
// cell, so check:doc-code-citations — which is backtick-gated — cannot see any of
// them. On 2026-08-19 a row cited a file deleted the previous day and all ten
// mechanical gates ran green.
// GREEN after: every path-shaped token in the glossary's table rows is backticked,
// which hands them to the existing gate.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const TARGET = "docs/glossary-ids.md";

// Path-shaped tokens NOT already wrapped in backticks, on table rows only.
const BARE_CITATION =
  /(?<!`)((?:src|tests|scripts|spec|schemas|skills)\/[A-Za-z0-9_.\/-]+\.[A-Za-z]{2,4})(?!`)/g;

describe("glossary code citations are backticked", () => {
  it("leaves no citation invisible to check:doc-code-citations", () => {
    const lines = readFileSync(join(REPO_ROOT, TARGET), "utf8").split("\n");
    const bare: string[] = [];

    lines.forEach((line, i) => {
      if (!line.startsWith("| ")) return;
      BARE_CITATION.lastIndex = 0;
      for (const m of line.matchAll(BARE_CITATION)) {
        bare.push(`${TARGET}:${i + 1}  ${m[1]}`);
      }
    });

    expect(
      bare,
      `Un-backticked code citations are invisible to the citation gate, so a deleted\n` +
        `file stays green there. Wrap each in backticks:\n  ${bare.join("\n  ")}`,
    ).toEqual([]);
  });
});
