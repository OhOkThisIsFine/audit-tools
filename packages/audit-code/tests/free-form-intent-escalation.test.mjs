import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// N-free-form-intent-interpretation
//
// Regression for the silent-drop gap: the clause-aware shared interpreter is
// WIRED so an unencodable free_form_intent clause escalates to a BLOCKING
// confirm_intent checkpoint question, while encodable clauses still drive lens
// weighting. The shared interpreter (shared/src/intent/*) is the single
// encodability authority.
// ---------------------------------------------------------------------------

const { deriveAuditState } = await import("../src/orchestrator/state.ts");
const { decideNextStep } = await import("../src/orchestrator/nextStep.ts");
const {
  interpretFreeFormIntentForAudit,
  unresolvedConstraintClauses,
  hasUnresolvedConstraintClauses,
} = await import("../src/orchestrator/intentInterpreter.ts");
const { interpretFreeFormIntent, runPlanningExecutor } = await import(
  "../src/orchestrator/planningExecutors.ts"
);
const { runIntentCheckpointAutoComplete } = await import(
  "../src/orchestrator/intentCheckpointExecutor.ts"
);
const { renderConfirmIntentPrompt } = await import(
  "../src/cli/confirmIntentStep.ts"
);

const here = dirname(fileURLToPath(import.meta.url));
const auditCodeRoot = join(here, "..");

// A clause that maps to no lens / scope / priority signal — must escalate.
const UNENCODABLE = "ensure the mascot stays cheerful";
// A clause that maps cleanly to the security lens — must be encoded.
const ENCODABLE = "focus on security and auth";

function obligationState(bundle, id) {
  return deriveAuditState(bundle).obligations.find((o) => o.id === id);
}

// Bundle with all obligations up to design_assessment satisfied, plus a present
// intent checkpoint carrying the given free_form_intent / constraint_clauses.
function bundleWithCheckpoint(checkpointExtra = {}) {
  return {
    provider_confirmation: {},
    repo_manifest: { files: [{ path: "src/a.ts" }] },
    file_disposition: { files: [{ path: "src/a.ts", status: "included" }] },
    auto_fixes_applied: {},
    syntax_resolution_status: {},
    unit_manifest: { units: [] },
    surface_manifest: { surfaces: [] },
    graph_bundle: { graphs: {} },
    critical_flows: { flows: [] },
    risk_register: { items: [] },
    analyzer_capability: {},
    design_assessment: { reviewed: false },
    intent_checkpoint: {
      schema_version: "intent-checkpoint/v1",
      confirmed_at: "2026-06-15T00:00:00Z",
      confirmed_by: "host",
      scope_summary: "src only",
      intent_summary: "full-audit",
      ...checkpointExtra,
    },
  };
}

// ── 1. Unencodable clause → blocking checkpoint question ────────────────────

await test("unencodable clause produces a blocking checkpoint question", () => {
  const result = interpretFreeFormIntentForAudit(UNENCODABLE);
  assert.equal(result.has_unencodable, true, "should flag an unencodable clause");
  assert.equal(
    result.checkpoint_questions.length,
    1,
    `expected one checkpoint question, got ${result.checkpoint_questions.length}`,
  );
  assert.match(result.checkpoint_questions[0], /could not be encoded/i);
});

await test("unencodable clause keeps intent_checkpoint_current unsatisfied (re-fires confirm_intent)", () => {
  const bundle = bundleWithCheckpoint({ free_form_intent: UNENCODABLE });
  const ob = obligationState(bundle, "intent_checkpoint_current");
  assert.equal(ob.state, "missing", "obligation must be unmet so confirm_intent re-fires");
  assert.match(ob.reason ?? "", /could not be encoded/i);

  // And the next-step decision routes back to the intent checkpoint executor.
  const decision = decideNextStep(bundle);
  assert.equal(decision.selected_obligation, "intent_checkpoint_current");
  assert.equal(decision.selected_executor, "intent_checkpoint_executor");
});

await test("confirm_intent prompt surfaces the blocking question and constraint_clauses shape", () => {
  const unresolved = unresolvedConstraintClauses(
    bundleWithCheckpoint({ free_form_intent: UNENCODABLE }).intent_checkpoint,
  );
  assert.equal(unresolved.length, 1);

  const prompt = renderConfirmIntentPrompt(
    {
      mode: "full",
      since: null,
      files_in_scope: 1,
      scope_dirs: [{ dir: "src", files: 1 }],
      excluded_summary: [],
      disposition_override_proposals: [],
      lens_proposals: [],
    },
    {
      intentCheckpointPath: "/repo/.audit-tools/audit/intent_checkpoint.json",
      continueCommand: "audit-code next-step",
      unresolvedConstraintClauses: unresolved,
    },
  );
  assert.match(prompt, /Blocking: unencodable intent clauses/);
  assert.match(prompt, /ensure the mascot stays cheerful/);
  assert.match(prompt, /"constraint_clauses"/);
});

// ── 2. Encodable clause → encoded, NOT silently dropped ─────────────────────

await test("encodable clause is encoded and does not block (no silent drop)", () => {
  const result = interpretFreeFormIntentForAudit(ENCODABLE);
  assert.equal(result.has_unencodable, false, "encodable clause must not be flagged");
  assert.ok(
    result.encoded_clauses.some((c) => c.kind === "lens_weight" && c.lens === "security"),
    "security clause must be encoded as a lens_weight",
  );

  // The gate stays satisfied for a purely-encodable intent.
  const bundle = bundleWithCheckpoint({ free_form_intent: ENCODABLE });
  assert.equal(
    obligationState(bundle, "intent_checkpoint_current").state,
    "satisfied",
  );
});

await test("planning interprets free_form_intent via the shared authority (encodable → lens boost)", () => {
  // The planning-path helper is now a thin wrapper over the shared interpreter.
  assert.deepEqual(interpretFreeFormIntent(ENCODABLE), ["security"]);
  assert.deepEqual(interpretFreeFormIntent(""), []);
});

await test("free_form_intent='security audit' still boosts security tasks end-to-end", async () => {
  const bundle = {
    repo_manifest: {
      repository: { name: "fixture" },
      generated_at: "2026-01-01T00:00:00.000Z",
      files: [{ path: "src/auth.ts" }],
    },
    file_disposition: { files: [{ path: "src/auth.ts", status: "included" }] },
    unit_manifest: {
      units: [
        {
          unit_id: "unit-1",
          name: "unit-1",
          files: ["src/auth.ts"],
          risk_score: 5,
          required_lenses: ["correctness", "security"],
        },
      ],
    },
    surface_manifest: { surfaces: [] },
    critical_flows: { flows: [] },
    risk_register: { items: [] },
    intent_checkpoint: {
      schema_version: "intent-checkpoint/v1",
      confirmed_at: "2026-01-01T00:00:00.000Z",
      confirmed_by: "host",
      scope_summary: "test",
      intent_summary: "test",
      free_form_intent: "security audit",
    },
  };
  const lineIndex = { "src/auth.ts": 100 };
  const result = await runPlanningExecutor(
    bundle,
    join(here, "__nonexistent_root__"),
    lineIndex,
  );
  const secTasks = result.updated.audit_tasks.filter((t) => t.lens === "security");
  assert.ok(secTasks.length > 0, "should produce security tasks");
  for (const task of secTasks) {
    assert.equal(task.priority, "high", "security task should be boosted to high");
  }
});

// ── 3. Resolving the clause closes the escalation ───────────────────────────

await test("answering the checkpoint question via constraint_clauses satisfies the obligation", () => {
  const question = interpretFreeFormIntentForAudit(UNENCODABLE).checkpoint_questions[0];
  const bundle = bundleWithCheckpoint({
    free_form_intent: UNENCODABLE,
    constraint_clauses: [
      {
        text: UNENCODABLE,
        checkpoint_question: question,
        host_answer: "Treat as a non-functional note; no extra weighting.",
      },
    ],
  });
  assert.equal(hasUnresolvedConstraintClauses(bundle.intent_checkpoint), false);
  assert.equal(
    obligationState(bundle, "intent_checkpoint_current").state,
    "satisfied",
  );
});

await test("an empty host_answer does NOT resolve the blocking clause", () => {
  const question = interpretFreeFormIntentForAudit(UNENCODABLE).checkpoint_questions[0];
  const bundle = bundleWithCheckpoint({
    free_form_intent: UNENCODABLE,
    constraint_clauses: [
      { text: UNENCODABLE, checkpoint_question: question, host_answer: "   " },
    ],
  });
  assert.equal(hasUnresolvedConstraintClauses(bundle.intent_checkpoint), true);
  assert.equal(
    obligationState(bundle, "intent_checkpoint_current").state,
    "missing",
  );
});

// ── Headless fallback: escalate (record), never silently drop, and converge ──

await test("headless auto-complete records unencodable clauses instead of dropping them", () => {
  const bundle = bundleWithCheckpoint({ free_form_intent: UNENCODABLE });
  const run = runIntentCheckpointAutoComplete(bundle, "/repo");
  const recorded = run.updated.intent_checkpoint.constraint_clauses ?? [];
  assert.equal(recorded.length, 1, "the unencodable clause must be recorded");
  assert.ok(recorded[0].host_answer && recorded[0].host_answer.length > 0);
  // The gate now converges (obligation satisfied on the rewritten checkpoint).
  assert.equal(hasUnresolvedConstraintClauses(run.updated.intent_checkpoint), false);
});

await test("headless auto-complete leaves an already-current checkpoint unchanged", () => {
  const bundle = bundleWithCheckpoint({ free_form_intent: ENCODABLE });
  const run = runIntentCheckpointAutoComplete(bundle, "/repo");
  assert.deepEqual(run.artifacts_written, []);
  assert.equal(run.updated.intent_checkpoint, bundle.intent_checkpoint);
});

// ── 4. Single interpreter authority guard ───────────────────────────────────

await test("single authority: only the shared module defines a LENS_KEYWORD_MAP", () => {
  // Walk all .ts source under packages/ and assert exactly one declaration of
  // LENS_KEYWORD_MAP (in shared/src/intent/sharedIntentData.ts). audit-code's
  // planning interpreter must delegate, never carry its own keyword/lens map.
  const repoPackages = join(auditCodeRoot, "..");
  const declRe = /\b(?:const|let|var|export\s+const)\s+LENS_KEYWORD_MAP\b/;
  const hits = [];

  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) {
        continue;
      }
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
        const text = readFileSync(full, "utf8");
        if (declRe.test(text)) hits.push(full);
      }
    }
  };
  walk(repoPackages);

  assert.equal(
    hits.length,
    1,
    `LENS_KEYWORD_MAP must be declared exactly once (the single shared authority); found ${hits.length}:\n${hits.join("\n")}`,
  );
  assert.match(
    hits[0].replace(/\\/g, "/"),
    /shared\/src\/intent\/sharedIntentData\.ts$/,
    `the sole LENS_KEYWORD_MAP must live in shared/src/intent/sharedIntentData.ts, got ${hits[0]}`,
  );
});

await test("single authority: audit-code planning interpreter delegates to interpretFreeFormIntentForAudit", () => {
  // Guard the wiring at the source level — the planning interpreter must call
  // the shared-backed bridge, not reintroduce an inline keyword scan.
  const src = readFileSync(
    join(auditCodeRoot, "src", "orchestrator", "planningExecutors.ts"),
    "utf8",
  );
  assert.match(
    src,
    /interpretFreeFormIntentForAudit/,
    "planningExecutors must delegate to interpretFreeFormIntentForAudit",
  );
  assert.doesNotMatch(
    src,
    /KEYWORD_LENS_MAP/,
    "planningExecutors must not declare its own keyword→lens map",
  );
});
