/**
 * finding-grounding.test.mjs — the shared grounding primitives (drift-plan E3/P7)
 * with emphasis on INV-GND-02: grounding is a TOTAL function — a finding with no
 * grounding verdict (undefined/absent) is treated as ungrounded → verify.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeForMatch,
  normalizeRepoPath,
  quoteMatches,
  verifyFindingGrounding,
  findingIsGrounded,
  findingNeedsVerificationBeforeFix,
} from "audit-tools/shared";

function finding(affected_files) {
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

test("normalizeForMatch strips CR and collapses whitespace", () => {
  assert.equal(normalizeForMatch("  a\r\n  b\t c  "), "a b c");
});

test("normalizeRepoPath: trims, backslash→slash, strips ./, lowercases", () => {
  assert.equal(normalizeRepoPath(".\\SRC\\A.ts"), "src/a.ts");
  assert.equal(normalizeRepoPath("  src/B.TS  "), "src/b.ts");
  assert.equal(normalizeRepoPath("./pkg/x.ts"), "pkg/x.ts");
});

test("quoteMatches is whitespace/CRLF-insensitive and content-based", () => {
  const file = "function foo() {\r\n    return bar();\r\n}\n";
  assert.equal(quoteMatches(file, "return bar();"), true);
  assert.equal(quoteMatches(file, "return baz();"), false);
  assert.equal(quoteMatches(file, "   "), false);
});

test("verifyFindingGrounding grounds a matching quote and flags an absent one", async () => {
  const reader = async () => "const secret = process.env.SECRET;\nreturn sign(secret);\n";
  const ok = await verifyFindingGrounding(
    "/repo",
    finding([{ path: "src/auth.ts", quoted_text: "return sign(secret);" }]),
    reader,
  );
  assert.equal(ok.status, "grounded");

  const bad = await verifyFindingGrounding(
    "/repo",
    finding([{ path: "src/auth.ts", quoted_text: "DROP TABLE users;" }]),
    reader,
  );
  assert.equal(bad.status, "ungrounded");
  assert.match(bad.reason ?? "", /not found on disk/);
});

test("INV-GND-02: an undefined/absent grounding verdict is treated as ungrounded → verify", () => {
  // No grounding field at all → NOT grounded → needs verification.
  const noVerdict = { grounding: undefined };
  assert.equal(findingIsGrounded(noVerdict), false);
  assert.equal(findingNeedsVerificationBeforeFix(noVerdict), true);

  const missingField = {};
  assert.equal(findingIsGrounded(missingField), false);
  assert.equal(findingNeedsVerificationBeforeFix(missingField), true);

  // Explicitly ungrounded → needs verification.
  const ungrounded = { grounding: { status: "ungrounded", reason: "x" } };
  assert.equal(findingIsGrounded(ungrounded), false);
  assert.equal(findingNeedsVerificationBeforeFix(ungrounded), true);

  // Only a positive 'grounded' verdict skips verification.
  const grounded = { grounding: { status: "grounded" } };
  assert.equal(findingIsGrounded(grounded), true);
  assert.equal(findingNeedsVerificationBeforeFix(grounded), false);
});
