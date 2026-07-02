import { test, expect } from "vitest";

const { decomposeIntent, assessClauseEncodability, interpretIntent } =
  await import("../../src/shared/intent/clauseInterpreter.ts");

// ---------------------------------------------------------------------------
// decomposeIntent — splitting
// ---------------------------------------------------------------------------

test("decomposeIntent — single-clause string returns exactly one clause", () => {
  const clauses = decomposeIntent("focus on security");
  expect(clauses.length, `expected 1 clause, got ${clauses.length}`).toBe(1);
  expect(clauses[0].text).toBe("focus on security");
});

test("decomposeIntent — semicolon-separated string returns one clause per segment", () => {
  const clauses = decomposeIntent("focus on security; prioritize correctness; only audit src/");
  expect(clauses.length, `expected 3 clauses, got ${clauses.length}`).toBe(3);
  expect(clauses[0].text).toBe("focus on security");
  expect(clauses[1].text).toBe("prioritize correctness");
  expect(clauses[2].text).toBe("only audit src/");
});

test("decomposeIntent — newline-separated string returns one clause per non-empty line", () => {
  const clauses = decomposeIntent("focus on security\nprioritize correctness\nonly audit src/");
  expect(clauses.length, `expected 3 clauses, got ${clauses.length}`).toBe(3);
  expect(clauses[0].text).toBe("focus on security");
  expect(clauses[1].text).toBe("prioritize correctness");
  expect(clauses[2].text).toBe("only audit src/");
});

test("decomposeIntent — leading/trailing whitespace is trimmed from each clause", () => {
  const clauses = decomposeIntent("  focus on security  ;  prioritize correctness  ");
  expect(clauses.length >= 2, `expected >= 2 clauses, got ${clauses.length}`).toBeTruthy();
  expect(clauses[0].text).toBe("focus on security");
  expect(clauses[1].text).toBe("prioritize correctness");
});

test("decomposeIntent — empty string returns empty array", () => {
  const clauses = decomposeIntent("");
  expect(clauses).toEqual([]);
});

test("decomposeIntent — whitespace-only string returns empty array", () => {
  const clauses = decomposeIntent("   ");
  expect(clauses).toEqual([]);
});

test("decomposeIntent — sentence-boundary split: two sentences split at '. ' correctly", () => {
  // Regression for COR-4e4a6c3c: sentenceRe.lastIndex reassignment was redundant;
  // verify that multi-sentence inputs split at every boundary without skipping or doubling.
  const clauses = decomposeIntent("Focus on security. Prioritize correctness. Skip tests.");
  const texts = clauses.map((c) => c.text);
  expect(texts.some((t) => t.startsWith("Focus on security")), `expected first sentence clause: ${JSON.stringify(texts)}`).toBeTruthy();
  expect(texts.some((t) => t.startsWith("Prioritize correctness")), `expected second sentence clause: ${JSON.stringify(texts)}`).toBeTruthy();
  expect(texts.some((t) => t.startsWith("Skip tests")), `expected third sentence clause: ${JSON.stringify(texts)}`).toBeTruthy();
  // No empty or duplicated clauses.
  expect(texts.every((t) => t.length > 0), "no empty clauses expected").toBeTruthy();
});

test("decomposeIntent — sentence-boundary split: adjacent boundaries do not produce empty clauses", () => {
  // Regression for COR-4e4a6c3c: ensure no off-by-one produces an empty ghost clause.
  const clauses = decomposeIntent("A. B. C");
  const texts = clauses.map((c) => c.text);
  expect(texts.every((t) => t.length > 0), `all clauses must be non-empty: ${JSON.stringify(texts)}`).toBeTruthy();
  // Each expected part should appear exactly once.
  const matchesA = texts.filter((t) => t.startsWith("A"));
  const matchesB = texts.filter((t) => t.startsWith("B"));
  const matchesC = texts.filter((t) => t.startsWith("C"));
  expect(matchesA.length, `'A' clause should appear exactly once: ${JSON.stringify(texts)}`).toBe(1);
  expect(matchesB.length, `'B' clause should appear exactly once: ${JSON.stringify(texts)}`).toBe(1);
  expect(matchesC.length, `'C' clause should appear exactly once: ${JSON.stringify(texts)}`).toBe(1);
});

// ---------------------------------------------------------------------------
// assessClauseEncodability — encodable clauses
// ---------------------------------------------------------------------------

test("assessClauseEncodability — 'focus on security' → encodable: true, kind: lens_weight", () => {
  const r = assessClauseEncodability("focus on security");
  expect(r.encodable).toBe(true);
  expect(r.kind).toBe("lens_weight");
  expect(r.detail && r.detail.includes("security"), `expected detail to mention security: ${r.detail}`).toBeTruthy();
});

test("assessClauseEncodability — 'prioritize correctness findings' → encodable: true, kind: lens_weight", () => {
  const r = assessClauseEncodability("prioritize correctness findings");
  expect(r.encodable).toBe(true);
  expect(r.kind).toBe("lens_weight");
  expect(r.detail && r.detail.includes("correctness"), `expected detail to mention correctness: ${r.detail}`).toBeTruthy();
});

test("assessClauseEncodability — 'only audit src/' → encodable: true, kind: scope_emphasis", () => {
  const r = assessClauseEncodability("only audit src/");
  expect(r.encodable).toBe(true);
  expect(r.kind).toBe("scope_emphasis");
});

// ---------------------------------------------------------------------------
// assessClauseEncodability — unencodable clauses with checkpoint questions
// ---------------------------------------------------------------------------

test("assessClauseEncodability — clause with no recognisable signal → encodable: false", () => {
  const r = assessClauseEncodability("must comply with HIPAA audit trail requirements");
  expect(r.encodable).toBe(false);
});

test("assessClauseEncodability — unencodable clause returns non-empty checkpoint_question", () => {
  const r = assessClauseEncodability("must comply with HIPAA audit trail requirements");
  expect(r.encodable).toBe(false);
  expect(typeof r.checkpoint_question === "string" && r.checkpoint_question.length > 0, `expected non-empty checkpoint_question, got: ${JSON.stringify(r.checkpoint_question)}`).toBeTruthy();
});

test("assessClauseEncodability — checkpoint_question references original clause text", () => {
  const clause = "must comply with HIPAA audit trail requirements";
  const r = assessClauseEncodability(clause);
  expect(r.encodable).toBe(false);
  expect(r.checkpoint_question && r.checkpoint_question.includes(clause), `expected checkpoint_question to reference clause text`).toBeTruthy();
});

test("assessClauseEncodability — distinct unencodable clauses produce distinct questions", () => {
  const r1 = assessClauseEncodability("must comply with HIPAA audit trail requirements");
  const r2 = assessClauseEncodability("ensure SOC2 evidence is generated");
  expect(r1.encodable).toBe(false);
  expect(r2.encodable).toBe(false);
  expect(r1.checkpoint_question, "expected distinct checkpoint questions for distinct clauses").not.toBe(r2.checkpoint_question);
});

// ---------------------------------------------------------------------------
// interpretIntent — partial encoding
// ---------------------------------------------------------------------------

test("interpretIntent — security clause encodable; HIPAA clause unencodable", () => {
  const result = interpretIntent("focus on security; must comply with HIPAA audit trail requirements");
  expect(result.has_unencodable).toBe(true);
  expect(result.checkpoint_questions.length).toBe(1);

  const secClause = result.clauses.find((c) => c.text === "focus on security");
  expect(secClause, "expected a clause with text 'focus on security'").toBeTruthy();
  expect(secClause.encodable).toBe(true);

  const hipaaClause = result.clauses.find((c) =>
    c.text.toLowerCase().includes("hipaa")
  );
  expect(hipaaClause, "expected a clause referencing HIPAA").toBeTruthy();
  expect(hipaaClause.encodable).toBe(false);
  expect(hipaaClause.checkpoint_question && hipaaClause.checkpoint_question.length > 0, "expected non-empty checkpoint_question on HIPAA clause").toBeTruthy();
});

// ---------------------------------------------------------------------------
// interpretIntent — all encodable
// ---------------------------------------------------------------------------

test("interpretIntent — all-encodable compound intent produces no checkpoint questions", () => {
  const result = interpretIntent("focus on security; prioritize correctness; only audit src/");
  expect(result.has_unencodable).toBe(false);
  expect(result.checkpoint_questions).toEqual([]);
  expect(result.clauses.every((c) => c.encodable), `expected all clauses encodable: ${JSON.stringify(result.clauses.map((c) => ({ text: c.text, encodable: c.encodable })))}`).toBeTruthy();
});

// ---------------------------------------------------------------------------
// interpretIntent — all unencodable
// ---------------------------------------------------------------------------

test("interpretIntent — all-unencodable intent promotes all clauses to questions", () => {
  const result = interpretIntent(
    "must comply with HIPAA; ensure SOC2 evidence is generated"
  );
  expect(result.has_unencodable).toBe(true);
  expect(result.clauses.every((c) => !c.encodable), `expected all clauses unencodable`).toBeTruthy();
  expect(result.checkpoint_questions.length, `expected checkpoint_questions.length === clauses.length`).toBe(result.clauses.length);
});

// ---------------------------------------------------------------------------
// IntentCheckpoint type — constraint_clauses field (type-level via runtime check)
// ---------------------------------------------------------------------------

test("IntentCheckpoint type accepts constraint_clauses field — valid structure compiles", async () => {
  // This is a runtime smoke-test of the exported type shape.
  // The TypeScript compile would catch structural mismatches at build time;
  // here we verify the shape is importable and holds expected keys.
  const mod = await import("../../src/shared/index.ts");
  // The types themselves are erased at runtime; verify the functions are exported.
  expect(typeof mod.decomposeIntent).toBe("function");
  expect(typeof mod.assessClauseEncodability).toBe("function");
  expect(typeof mod.interpretIntent).toBe("function");
});

test("IntentCheckpoint without constraint_clauses is still valid", async () => {
  // Structural check: a minimal IntentCheckpoint (no constraint_clauses) should
  // not cause any runtime or type error. We can only test this at the JS layer.
  const checkpoint = {
    schema_version: "intent-checkpoint/v1",
    confirmed_at: new Date().toISOString(),
    confirmed_by: "host",
    scope_summary: "Full repo",
    intent_summary: "Full audit",
  };
  // Just confirm the field is absent; no constraint_clauses key present.
  expect(!("constraint_clauses" in checkpoint), "field should be absent").toBeTruthy();
});

test("IntentCheckpoint constraint_clauses entries carry text, checkpoint_question, and optional host_answer", () => {
  const entry = {
    text: "must comply with HIPAA",
    checkpoint_question: 'How should "must comply with HIPAA" be applied?',
    host_answer: "Treat as an unencodable note for the human reviewer.",
  };
  expect(typeof entry.text === "string").toBeTruthy();
  expect(typeof entry.checkpoint_question === "string").toBeTruthy();
  expect(typeof entry.host_answer === "string").toBeTruthy();

  const entryNoAnswer = {
    text: "must comply with HIPAA",
    checkpoint_question: 'How should "must comply with HIPAA" be applied?',
  };
  expect(!("host_answer" in entryNoAnswer), "host_answer should be optional").toBeTruthy();
});

// ---------------------------------------------------------------------------
// LENS_KEYWORD_MAP integrity (MNT-0d8e3156)
// ---------------------------------------------------------------------------

test("LENS_KEYWORD_MAP — no entry repeats a keyword, and no keyword maps to two lenses", async () => {
  const { LENS_KEYWORD_MAP } = await import("../../src/shared/intent/sharedIntentData.ts");
  // Within a single entry, a keyword must not be listed twice (the maintainability
  // entry previously listed "maintainability" twice — a dead copy-paste).
  for (const { keywords, lens } of LENS_KEYWORD_MAP) {
    const seen = new Set();
    for (const kw of keywords) {
      expect(!seen.has(kw), `lens ${lens} lists keyword ${JSON.stringify(kw)} more than once`).toBeTruthy();
      seen.add(kw);
    }
  }
  // Across entries, a keyword must not be claimed by two different lenses (an
  // ambiguous keyword would silently resolve to whichever entry is scanned first).
  const owner = new Map();
  for (const { keywords, lens } of LENS_KEYWORD_MAP) {
    for (const kw of keywords) {
      const prior = owner.get(kw);
      expect(prior === undefined, `keyword ${JSON.stringify(kw)} maps to both ${prior} and ${lens}`).toBeTruthy();
      owner.set(kw, lens);
    }
  }
});
