import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// DC-1 — free_form_intent clause escalation (audit) + remediate interpretation.
//
// Covers the four DC-1 obligations:
//   1. Unencodable clauses HARD-GATE the audit confirm-intent step, keyed on
//      CLAUSE IDENTITY (clause_id) — not the rendered checkpoint_question
//      (CE-004: the question is a derived, non-injective presentation string).
//   2. Clause decomposition + encodability + identity route through the SINGLE
//      shared interpreter (one LENS_KEYWORD_MAP, one clauseIdentity).
//   3. The headless path auto-records a constraint (keyed on clause_id) so the
//      gate converges instead of looping; nothing is silently dropped.
//   4. Remediate folds the structured InterpretedIntent into block/finding
//      ORDERING (never dropping), and never threads free_form_intent verbatim
//      (the no-verbatim sentinel guard, on structured fields — CE-005).
// ---------------------------------------------------------------------------

const { deriveAuditState } = await import("../../src/audit/orchestrator/state.ts");
const { decideNextStep } = await import("../../src/audit/orchestrator/nextStep.ts");
const {
  interpretFreeFormIntentForAudit,
  unresolvedConstraintClauses,
} = await import("../../src/audit/orchestrator/intentInterpreter.ts");
const { runIntentCheckpointAutoComplete } = await import(
  "../../src/audit/orchestrator/intentCheckpointExecutor.ts"
);
const { renderConfirmIntentPrompt } = await import(
  "../../src/audit/cli/confirmIntentStep.ts"
);
const { interpretIntent, clauseIdentity, interpretFreeFormIntent } = await import(
  "audit-tools/shared"
);
const { applyIntentOrdering, findingIntentWeight } = await import(
  "../../src/remediate/intent/intentOrdering.ts"
);

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

// Two DISTINCT unencodable directives (neither maps to a lens/scope/priority).
const CLAUSE_A = "ensure the mascot stays cheerful";
const CLAUSE_B = "keep the easter egg hidden";
// A clause that maps cleanly to the security lens — must be encoded, never block.
const ENCODABLE = "focus on security and auth";

function obligationState(bundle, id) {
  return deriveAuditState(bundle).obligations.find((o) => o.id === id);
}

function bundleWithCheckpoint(checkpointExtra = {}) {
  return {
    provider_confirmation: {},
    repo_manifest: { files: [{ path: "src/a.ts" }] },
    file_disposition: { files: [{ path: "src/a.ts", status: "included" }] },
    auto_fixes_applied: {},
    syntax_resolution_status: {},
    external_analyzer_acquisition: { enabled: false, tool_statuses: [] },
    unit_manifest: { units: [] },
    surface_manifest: { surfaces: [] },
    graph_bundle: { graphs: {} },
    critical_flows: { flows: [] },
    risk_register: { items: [] },
    analyzer_capability: {},
    design_assessment: { reviewed: false },
    intent_checkpoint: {
      schema_version: "intent-checkpoint/v1",
      confirmed_at: "2026-06-19T00:00:00Z",
      confirmed_by: "host",
      scope_summary: "src only",
      intent_summary: "full-audit",
      ...checkpointExtra,
    },
  };
}

// ── 1. Clause identity is the resolution key (CE-004) ───────────────────────

await test("clause identity comes from the shared clauseIdentity authority", () => {
  const result = interpretIntent(CLAUSE_A);
  assert.equal(result.clauses.length, 1);
  assert.equal(result.clauses[0].clause_id, clauseIdentity(CLAUSE_A));
});

await test("clauseIdentity is stable across cosmetic punctuation/case/whitespace", () => {
  assert.equal(
    clauseIdentity("Ensure   the Mascot stays cheerful."),
    clauseIdentity(CLAUSE_A),
  );
});

await test("distinct directives get distinct clause ids", () => {
  assert.notEqual(clauseIdentity(CLAUSE_A), clauseIdentity(CLAUSE_B));
});

await test("unresolvedConstraintClauses surfaces a clause_id per unresolved clause", () => {
  const unresolved = unresolvedConstraintClauses(
    bundleWithCheckpoint({ free_form_intent: `${CLAUSE_A}; ${CLAUSE_B}` })
      .intent_checkpoint,
  );
  assert.equal(unresolved.length, 2);
  assert.deepEqual(
    unresolved.map((c) => c.clause_id).sort(),
    [clauseIdentity(CLAUSE_A), clauseIdentity(CLAUSE_B)].sort(),
  );
});

// CE-004 core: resolution keys on clause_id, NOT the rendered question. An entry
// carrying the correct clause_id resolves the clause even when its recorded
// checkpoint_question is stale / does not match the freshly-rendered one.
await test("CE-004: a constraint with the right clause_id but a STALE question still resolves", () => {
  const bundle = bundleWithCheckpoint({
    free_form_intent: CLAUSE_A,
    constraint_clauses: [
      {
        clause_id: clauseIdentity(CLAUSE_A),
        text: CLAUSE_A,
        checkpoint_question: "this is NOT the rendered question text at all",
        host_answer: "Treat as a non-functional note; no extra weighting.",
      },
    ],
  });
  assert.equal(
    obligationState(bundle, "intent_checkpoint_current").state,
    "satisfied",
  );
});

// CE-004 collision direction: answering ONE of two distinct clauses (by its
// clause_id) leaves the OTHER unresolved — no question-keyed collapse.
await test("CE-004: answering one clause does not resolve a different clause", () => {
  const bundle = bundleWithCheckpoint({
    free_form_intent: `${CLAUSE_A}; ${CLAUSE_B}`,
    constraint_clauses: [
      {
        clause_id: clauseIdentity(CLAUSE_A),
        text: CLAUSE_A,
        checkpoint_question: "irrelevant",
        host_answer: "Handled A.",
      },
    ],
  });
  const unresolved = unresolvedConstraintClauses(bundle.intent_checkpoint);
  assert.equal(unresolved.length, 1, "exactly the un-answered clause remains");
  assert.equal(unresolved[0].clause_id, clauseIdentity(CLAUSE_B));
});

// ── 2. Resolution-state parametric matrix ───────────────────────────────────

const RESOLUTION_CASES = [
  {
    name: "no constraint entries → blocked",
    clauses: [],
    expectUnresolved: 2,
    expectGate: "missing",
  },
  {
    name: "one of two answered by clause_id → still blocked",
    clauses: [
      { which: "A", clause_id: true, answer: "done" },
    ],
    expectUnresolved: 1,
    expectGate: "missing",
  },
  {
    name: "both answered by clause_id → satisfied",
    clauses: [
      { which: "A", clause_id: true, answer: "done" },
      { which: "B", clause_id: true, answer: "done" },
    ],
    expectUnresolved: 0,
    expectGate: "satisfied",
  },
  {
    name: "empty host_answer does NOT resolve → blocked",
    clauses: [
      { which: "A", clause_id: true, answer: "   " },
      { which: "B", clause_id: true, answer: "done" },
    ],
    expectUnresolved: 1,
    expectGate: "missing",
  },
  {
    name: "legacy entries with NO clause_id resolve by question text → satisfied",
    clauses: [
      { which: "A", clause_id: false, answer: "done" },
      { which: "B", clause_id: false, answer: "done" },
    ],
    expectUnresolved: 0,
    expectGate: "satisfied",
  },
];

for (const c of RESOLUTION_CASES) {
  await test(`resolution-state: ${c.name}`, () => {
    const free = `${CLAUSE_A}; ${CLAUSE_B}`;
    const interp = interpretIntent(free);
    const questionFor = (which) => {
      const text = which === "A" ? CLAUSE_A : CLAUSE_B;
      const id = clauseIdentity(text);
      return interp.clauses.find((cl) => cl.clause_id === id).checkpoint_question;
    };
    const constraint_clauses = c.clauses.map((entry) => {
      const text = entry.which === "A" ? CLAUSE_A : CLAUSE_B;
      const base = {
        text,
        checkpoint_question: questionFor(entry.which),
        host_answer: entry.answer,
      };
      return entry.clause_id ? { clause_id: clauseIdentity(text), ...base } : base;
    });
    const bundle = bundleWithCheckpoint({ free_form_intent: free, constraint_clauses });
    assert.equal(
      unresolvedConstraintClauses(bundle.intent_checkpoint).length,
      c.expectUnresolved,
    );
    assert.equal(
      obligationState(bundle, "intent_checkpoint_current").state,
      c.expectGate,
    );
  });
}

await test("unresolved clause routes next-step back to the intent checkpoint executor", () => {
  const bundle = bundleWithCheckpoint({ free_form_intent: CLAUSE_A });
  const decision = decideNextStep(bundle);
  assert.equal(decision.selected_obligation, "intent_checkpoint_current");
  assert.equal(decision.selected_executor, "intent_checkpoint_executor");
});

await test("encodable-only intent never blocks the gate", () => {
  const result = interpretFreeFormIntentForAudit(ENCODABLE);
  assert.equal(result.has_unencodable, false);
  assert.equal(
    obligationState(
      bundleWithCheckpoint({ free_form_intent: ENCODABLE }),
      "intent_checkpoint_current",
    ).state,
    "satisfied",
  );
});

// ── 3. confirm-intent prompt surfaces clause_id + headless convergence ───────

await test("confirm_intent prompt surfaces the clause_id and constraint_clauses shape", () => {
  const unresolved = unresolvedConstraintClauses(
    bundleWithCheckpoint({ free_form_intent: CLAUSE_A }).intent_checkpoint,
  );
  const prompt = renderConfirmIntentPrompt(
    {
      mode: "full",
      since: null,
      files_in_scope: 1,
      scope_dirs: [{ dir: "src", files: 1 }],
      excluded_summary: [],
      disposition_override_proposals: [],
      lens_propositions: [],
    },
    {
      intentCheckpointPath: "/repo/.audit-tools/audit/intent_checkpoint.json",
      continueCommand: "audit-code next-step",
      unresolvedConstraintClauses: unresolved,
    },
  );
  assert.match(prompt, /Blocking: unencodable intent clauses/);
  assert.match(prompt, /ensure the mascot stays cheerful/);
  assert.match(prompt, /clause_id/);
  assert.match(prompt, new RegExp(clauseIdentity(CLAUSE_A).replace(/[|]/g, "\\|")));
});

await test("headless auto-complete records each clause keyed on clause_id and converges", () => {
  const bundle = bundleWithCheckpoint({ free_form_intent: `${CLAUSE_A}; ${CLAUSE_B}` });
  const run = runIntentCheckpointAutoComplete(bundle, "/repo");
  const recorded = run.updated.intent_checkpoint.constraint_clauses ?? [];
  assert.equal(recorded.length, 2, "both unencodable clauses recorded");
  for (const entry of recorded) {
    assert.ok(entry.clause_id && entry.clause_id.length > 0, "each entry carries a clause_id");
    assert.ok(entry.host_answer && entry.host_answer.length > 0);
  }
});

// ── 4. Single shared interpreter — drift guards ─────────────────────────────

await test("drift: exactly one LENS_KEYWORD_MAP declaration (the shared authority)", () => {
  const declRe = /\b(?:const|let|var|export\s+const)\s+LENS_KEYWORD_MAP\b/;
  const hits = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
        if (declRe.test(readFileSync(full, "utf8"))) hits.push(full);
      }
    }
  };
  walk(join(repoRoot, "src"));
  assert.equal(hits.length, 1, `expected one LENS_KEYWORD_MAP, found:\n${hits.join("\n")}`);
  assert.match(hits[0].replace(/\\/g, "/"), /src\/shared\/intent\/sharedIntentData\.ts$/);
});

await test("drift: clause decomposition routes through the shared interpreter on both sides", () => {
  // Audit blocking gate delegates to the shared interpretIntent.
  const auditSrc = readFileSync(
    join(repoRoot, "src", "audit", "orchestrator", "intentInterpreter.ts"),
    "utf8",
  );
  assert.match(auditSrc, /interpretIntent/, "audit must delegate to shared interpretIntent");
  assert.doesNotMatch(auditSrc, /LENS_KEYWORD_MAP/, "audit must not carry its own keyword map");
  // Remediate ordering consumes the shared InterpretedIntent only.
  const orderSrc = readFileSync(
    join(repoRoot, "src", "remediate", "intent", "intentOrdering.ts"),
    "utf8",
  );
  assert.match(orderSrc, /InterpretedIntent/, "remediate ordering consumes the shared type");
  assert.doesNotMatch(orderSrc, /LENS_KEYWORD_MAP/);
});

// ── 5. No-verbatim sentinel guard (structured fields — CE-005) ──────────────

// A sentinel token that does not collide with any lens keyword / scope pattern /
// priority pattern, so it is treated as an unencodable directive.
const SENTINEL = "zzqq-sentinel-7f3a-do-not-leak";

await test("sentinel: the verbatim free_form_intent never appears in the audit interpreter output fields", () => {
  const result = interpretFreeFormIntentForAudit(SENTINEL);
  // encoded_clauses detail / checkpoint_questions are derived; the question
  // restates the clause by design, but no field equals the raw input verbatim,
  // and the structured signal fields never carry it.
  for (const clause of result.encoded_clauses) {
    assert.ok(!clause.detail.includes(SENTINEL), "encoded detail must not carry the raw token");
  }
  // The whole interpretation, minus the human-facing checkpoint_question render,
  // must be free of the sentinel (INV-S04 structured-signal surface).
  const structural = {
    schema_version: result.schema_version,
    encoded_clauses: result.encoded_clauses,
    has_unencodable: result.has_unencodable,
  };
  assert.ok(
    !JSON.stringify(structural).includes(SENTINEL),
    "structured interpreter output must not carry the verbatim free_form_intent",
  );
});

await test("sentinel: the remediate InterpretedIntent SIGNAL fields never carry the verbatim string", () => {
  const interpreted = interpretFreeFormIntent(SENTINEL);
  // INV-S04: the derived SIGNAL fields (what planning/ordering consume) must be
  // free of the raw string. The unencodableClauses channel deliberately carries
  // the clause text — it is the escalation surface for host promotion, never a
  // worker-prompt signal — so it is excluded from this guard.
  const signalOnly = {
    lensWeights: interpreted.lensWeights,
    prioritySignals: interpreted.prioritySignals,
    scopeEmphasis: interpreted.scopeEmphasis,
  };
  assert.ok(
    !JSON.stringify(signalOnly).includes(SENTINEL),
    "InterpretedIntent signal fields must not echo the raw free_form_intent",
  );
  // The sentinel is unencodable, so it is surfaced for promotion (never dropped).
  assert.ok(interpreted.unencodableClauses.includes(SENTINEL));
});

await test("sentinel: the remediate ordering result never carries the verbatim string", () => {
  const findings = [
    { id: "F-1", title: "t", category: "General", severity: "low", lens: "security", affected_files: [{ path: "src/a.ts" }], evidence: ["e"] },
  ];
  const blocks = [{ block_id: "B-1", items: ["F-1"], parallel_safe: true }];
  const { findings: of, blocks: ob } = applyIntentOrdering(
    findings,
    blocks,
    interpretFreeFormIntent(SENTINEL),
  );
  assert.ok(!JSON.stringify({ of, ob }).includes(SENTINEL), "ordering must not inject the raw string");
});

await test("sentinel: worker-prompt renderers carry no free_form_intent reference at all (CE-005)", () => {
  // Structured guard (not a fragile substring on values): the prompt renderers
  // that build the per-worker packet must not reference free_form_intent at all,
  // on either orchestrator — interpretation happens upstream.
  const FORBIDDEN = /free_form_intent|freeFormIntent/u;
  const RENDERERS = [
    join(repoRoot, "src", "audit", "cli", "dispatch", "packetPrompt.ts"),
    join(repoRoot, "src", "remediate", "steps", "dispatch.ts"),
  ];
  for (const file of RENDERERS) {
    const hits = readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => FORBIDDEN.test(line));
    assert.equal(
      hits.length,
      0,
      `${file} must not reference free_form_intent (interpret upstream — INV-S04/CE-005):\n` +
        hits.map(([n, l]) => `${n}: ${l.trim()}`).join("\n"),
    );
  }
});

// ── 6. Remediate fold: ordering only, never drops ───────────────────────────

await test("remediate fold: an emphasised lens sorts its finding/block first", () => {
  const findings = [
    { id: "F-low-maint", title: "m", category: "General", severity: "high", lens: "maintainability", affected_files: [{ path: "src/m.ts" }], evidence: ["e"] },
    { id: "F-sec", title: "s", category: "General", severity: "low", lens: "security", affected_files: [{ path: "src/s.ts" }], evidence: ["e"] },
  ];
  const blocks = [
    { block_id: "B-maint", items: ["F-low-maint"], parallel_safe: true },
    { block_id: "B-sec", items: ["F-sec"], parallel_safe: true },
  ];
  const interpreted = interpretFreeFormIntent("prioritize security");
  const { findings: of, blocks: ob } = applyIntentOrdering(findings, blocks, interpreted);
  // Security finding sorts first despite its lower severity (lens emphasis boost).
  assert.equal(of[0].id, "F-sec");
  assert.equal(ob[0].block_id, "B-sec");
  // Ordering-only: nothing dropped.
  assert.equal(of.length, 2);
  assert.equal(ob.length, 2);
  assert.deepEqual(of.map((f) => f.id).sort(), ["F-low-maint", "F-sec"]);
});

await test("remediate fold: empty/absent intent is a strict no-op (severity order preserved)", () => {
  const findings = [
    { id: "F-1", title: "a", category: "General", severity: "low", lens: "correctness", affected_files: [{ path: "src/a.ts" }], evidence: ["e"] },
    { id: "F-2", title: "b", category: "General", severity: "critical", lens: "correctness", affected_files: [{ path: "src/b.ts" }], evidence: ["e"] },
  ];
  const blocks = [
    { block_id: "B-1", items: ["F-1"], parallel_safe: true },
    { block_id: "B-2", items: ["F-2"], parallel_safe: true },
  ];
  const { findings: of, blocks: ob } = applyIntentOrdering(findings, blocks, interpretFreeFormIntent(""));
  // No signal → returned unchanged (no reordering at all).
  assert.deepEqual(of.map((f) => f.id), ["F-1", "F-2"]);
  assert.deepEqual(ob.map((b) => b.block_id), ["B-1", "B-2"]);
});

await test("remediate fold: scope emphasis lifts findings whose path matches", () => {
  const findings = [
    { id: "F-other", title: "o", category: "General", severity: "high", lens: "correctness", affected_files: [{ path: "src/other.ts" }], evidence: ["e"] },
    { id: "F-auth", title: "a", category: "General", severity: "high", lens: "correctness", affected_files: [{ path: "src/auth/login.ts" }], evidence: ["e"] },
  ];
  const blocks = [
    { block_id: "B-other", items: ["F-other"], parallel_safe: true },
    { block_id: "B-auth", items: ["F-auth"], parallel_safe: true },
  ];
  const interpreted = interpretFreeFormIntent("focus on src/auth");
  const wAuth = findingIntentWeight(findings[1], interpreted);
  const wOther = findingIntentWeight(findings[0], interpreted);
  assert.ok(wAuth > wOther, "the in-scope finding must outweigh the out-of-scope one");
  const { findings: of } = applyIntentOrdering(findings, blocks, interpreted);
  assert.equal(of[0].id, "F-auth");
});
