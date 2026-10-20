/**
 * basename-grounding-regression.test.ts — INV-B3-2 at the quote-and-verify
 * boundary: a citation that names only a basename, whose real file is nested,
 * must ground against the one tracked path bearing that basename and have that
 * path written back; an ambiguous or untracked one must still un-ground, and a
 * canonical full path must behave exactly as it did before.
 *
 * Synthetic files satisfy the current source-containment check; an explicit
 * corpus exercises the real groundFinding without invoking git.
 */
import { afterAll, beforeAll, test, expect, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { groundFinding } from "audit-tools/shared";
import type { Finding, FindingLocation } from "audit-tools/shared";

const ROOT = mkdtempSync(join(tmpdir(), "audit-basename-grounding-"));
const OUTSIDE = mkdtempSync(join(tmpdir(), "audit-basename-outside-"));
const NESTED = "src/nested/advance.ts";
const SOURCE = "// header\nexport const ADVANCE = 1;\n";
const QUOTE = "export const ADVANCE = 1;";

/** Two corpus entries share one basename, so that basename names no single file. */
const KNOWN: ReadonlySet<string> = new Set([
  NESTED,
  "src/other/keep.ts",
  "a/dup.ts",
  "b/dup.ts",
]);

beforeAll(() => {
  mkdirSync(join(ROOT, "src/nested"), { recursive: true });
  writeFileSync(join(ROOT, NESTED), SOURCE);
  writeFileSync(join(OUTSIDE, "external.ts"), SOURCE);
});
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(OUTSIDE, { recursive: true, force: true });
});

function finding(affected_files: FindingLocation[]): Finding {
  return {
    id: "F-1",
    title: "t",
    category: "c",
    severity: "medium",
    confidence: "high",
    lens: "security",
    summary: "s",
    affected_files,
    evidence: ["e"],
  };
}

test("a unique tracked basename resolves, and the real path is written back", async () => {
  const loc: FindingLocation = { path: "advance.ts", quoted_text: QUOTE };
  const verdict = await groundFinding(ROOT, finding([loc]), undefined, KNOWN);
  expect(verdict.status).toBe("grounded");
  expect(loc.path).toBe(NESTED);
  expect(loc.line_start).toBe(2);
  expect(loc.line_end).toBe(2);
});

test("an ambiguous basename stays ungrounded and is never rewritten", async () => {
  const loc: FindingLocation = { path: "dup.ts", quoted_text: QUOTE };
  const verdict = await groundFinding(ROOT, finding([loc]), undefined, KNOWN);
  expect(verdict.status).toBe("ungrounded");
  expect(loc.path).toBe("dup.ts");
  expect(loc.line_start).toBeUndefined();
});

test("an untracked basename stays ungrounded and is never rewritten", async () => {
  const loc: FindingLocation = { path: "missing.ts", quoted_text: QUOTE };
  const verdict = await groundFinding(ROOT, finding([loc]), undefined, KNOWN);
  expect(verdict.status).toBe("ungrounded");
  expect(loc.path).toBe("missing.ts");
  expect(loc.line_start).toBeUndefined();
});

test("a canonical full path is unchanged, with and without a corpus", async () => {
  const withCorpus: FindingLocation = { path: NESTED, quoted_text: QUOTE };
  const a = await groundFinding(ROOT, finding([withCorpus]), undefined, KNOWN);
  expect(a.status).toBe("grounded");
  expect(withCorpus.path).toBe(NESTED);
  expect(withCorpus.line_start).toBe(2);
  const noCorpus: FindingLocation = { path: NESTED, quoted_text: QUOTE };
  const b = await groundFinding(ROOT, finding([noCorpus]));
  expect(b.status).toBe("grounded");
  expect(noCorpus.path).toBe(NESTED);
  expect(noCorpus.line_start).toBe(2);
});

test("a real root-file citation keeps its lookup when its basename is also nested", async () => {
  writeFileSync(join(ROOT, "advance.ts"), SOURCE);
  const loc: FindingLocation = { path: "advance.ts", quoted_text: QUOTE };
  const known = new Set(["advance.ts", NESTED]);
  const verdict = await groundFinding(ROOT, finding([loc]), undefined, known);
  expect(verdict.status).toBe("grounded");
  expect(loc.path).toBe("advance.ts");
});

test("a resolved basename cannot bypass source containment", async () => {
  const loc: FindingLocation = { path: "external.ts", quoted_text: QUOTE };
  const known = new Set([relative(ROOT, join(OUTSIDE, "external.ts"))]);
  const verdict = await groundFinding(ROOT, finding([loc]), undefined, known);
  expect(verdict.status).toBe("ungrounded");
  expect(loc.line_start).toBeUndefined();
});

test("an admitted untracked root file wins over a unique tracked nested namesake", async () => {
  writeFileSync(join(ROOT, "foo.ts"), SOURCE);
  writeFileSync(join(ROOT, "src/foo.ts"), "different content\n");
  const loc: FindingLocation = { path: "foo.ts", quoted_text: QUOTE };
  const verdict = await groundFinding(ROOT, finding([loc]), undefined, new Set(["src/foo.ts"]));
  expect(verdict.status).toBe("grounded");
  expect(loc.path).toBe("foo.ts");
  expect(loc.line_start).toBe(2);
  expect(loc.line_end).toBe(2);
});

test("an existing rejected directory is not rehabilitated by a tracked namesake", async () => {
  mkdirSync(join(ROOT, "blocked.ts"));
  writeFileSync(join(ROOT, "src/blocked.ts"), SOURCE);
  const loc: FindingLocation = { path: "blocked.ts", quoted_text: QUOTE };
  const readSource = vi.fn(async () => SOURCE);
  const verdict = await groundFinding(ROOT, finding([loc]), readSource, new Set(["src/blocked.ts"]));
  expect(verdict.status).toBe("ungrounded");
  expect(loc.path).toBe("blocked.ts");
  expect(readSource).not.toHaveBeenCalled();
});
