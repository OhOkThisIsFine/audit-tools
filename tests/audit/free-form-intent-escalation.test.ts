import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type { AuditObligation } from "../../src/audit/types/auditState.js";
import type { IntentCheckpoint } from "../../src/shared/types/intentCheckpoint.js";

// ---------------------------------------------------------------------------
// N-free-form-intent-interpretation
//
// Regression for the silent-drop gap: the clause-aware shared interpreter is
// WIRED so an unencodable free_form_intent clause escalates to a BLOCKING
// confirm_intent checkpoint question, while encodable clauses still drive lens
// weighting. The shared interpreter (shared/src/intent/*) is the single
// encodability authority.
// ---------------------------------------------------------------------------

const { deriveAuditState } = await import("../../src/audit/orchestrator/state.js");
const { decideNextStep } = await import("../../src/audit/orchestrator/nextStep.js");
const {
  interpretFreeFormIntentForAudit,
  unresolvedConstraintClauses,
} = await import("../../src/audit/orchestrator/intentInterpreter.js");
const { interpretFreeFormIntent, runPlanningExecutor } = await import("../../src/audit/orchestrator/planningExecutors.js");
const { renderConfirmIntentPrompt } = await import("../../src/audit/cli/confirmIntentStep.js");

const here = dirname(fileURLToPath(import.meta.url));
const auditCodeRoot = join(here, "..", "..");

// A clause that maps to no lens / scope / priority signal — must escalate.
const UNENCODABLE = "ensure the mascot stays cheerful";
// A clause that maps cleanly to the security lens — must be encoded.
const ENCODABLE = "focus on security and auth";

function obligationState(bundle: ArtifactBundle, id: string): AuditObligation {
  const obligation = deriveAuditState(bundle).obligations.find((o) => o.id === id);
  if (!obligation) throw new Error(`Expected audit obligation ${id}`);
  return obligation;
}

// Bundle with all obligations up to design_assessment satisfied, plus a present
// intent checkpoint carrying the given free_form_intent / constraint_clauses.
function bundleWithCheckpoint(
  checkpointExtra: Partial<IntentCheckpoint> = {},
): ArtifactBundle & { intent_checkpoint: IntentCheckpoint } {
  const intentCheckpoint: IntentCheckpoint = {
    schema_version: "intent-checkpoint/v1",
    confirmed_at: "2026-06-15T00:00:00Z",
    confirmed_by: "host",
    scope_summary: "src only",
    intent_summary: "full-audit",
    ...checkpointExtra,
  };
  return {
    repo_manifest: {
      repository: { name: "fixture" },
      generated_at: "2026-01-01T00:00:00.000Z",
      files: [{ path: "src/a.ts", language: "typescript", size_bytes: 1 }],
    },
    file_disposition: { files: [{ path: "src/a.ts", status: "included" }] },
    auto_fixes_applied: {},
    syntax_resolution_status: {},
    external_analyzer_acquisition: { enabled: false, tool_statuses: [] },
    unit_manifest: { units: [] },
    surface_manifest: { surfaces: [] },
    graph_bundle: { graphs: {} },
    critical_flows: { flows: [] },
    risk_register: { items: [] },
    analyzer_capability: { status: "omitted", analyzers: [] },
    design_assessment: {
      generated_at: "2026-01-01T00:00:00.000Z",
      findings: [],
      reviewed: false,
    },
    docs_digest: { generated_at: "2026-01-01T00:00:00.000Z", docs: [] },
    structure_decomposition: {
      generated_at: "2026-01-01T00:00:00.000Z",
      target: "structure",
      node_universe_size: 0,
      source_ids: [],
      consensus: [],
      contested: [],
      findings: [],
    },
    intent_checkpoint: intentCheckpoint,
  };
}

// ── 1. Unencodable clause → blocking checkpoint question ────────────────────

await test("unencodable clause produces a blocking checkpoint question", () => {
  const result = interpretFreeFormIntentForAudit(UNENCODABLE);
  expect(result.has_unencodable, "should flag an unencodable clause").toBe(true);
  expect(result.checkpoint_questions.length, `expected one checkpoint question, got ${result.checkpoint_questions.length}`).toBe(1);
  expect(result.checkpoint_questions[0]).toMatch(/could not be encoded/i);
});

await test("unencodable clause keeps intent_checkpoint_current unsatisfied (re-fires confirm_intent)", () => {
  const bundle = bundleWithCheckpoint({ free_form_intent: UNENCODABLE });
  const ob = obligationState(bundle, "intent_checkpoint_current");
  expect(ob.state, "obligation must be unmet so confirm_intent re-fires").toBe("missing");
  expect(ob.reason ?? "").toMatch(/could not be encoded/i);

  // And the next-step decision routes back to the intent checkpoint executor.
  const decision = decideNextStep(bundle);
  expect(decision.selected_obligation).toBe("intent_checkpoint_current");
  expect(decision.selected_executor).toBe("intent_checkpoint_executor");
});

await test("confirm_intent prompt surfaces the blocking question and constraint_clauses shape", () => {
  const unresolved = unresolvedConstraintClauses(
    bundleWithCheckpoint({ free_form_intent: UNENCODABLE }).intent_checkpoint,
  );
  expect(unresolved.length).toBe(1);

  const prompt = renderConfirmIntentPrompt(
    {
      mode: "full",
      since: null,
      files_in_scope: 1,
      scope_dirs: [{ dir: "src", files: 1 }],
      excluded_summary: [],
      disposition_override_proposals: [],
      lens_propositions: [],
      docs_digest: [],
      mis_scope_smells: [],
    },
    {
      intentCheckpointPath: "/repo/.audit-tools/audit/intent_checkpoint.json",
      continueCommand: "audit-code next-step",
      unresolvedConstraintClauses: unresolved,
    },
  );
  expect(prompt).toMatch(/Blocking: unencodable intent clauses/);
  expect(prompt).toMatch(/ensure the mascot stays cheerful/);
  expect(prompt).toMatch(/"constraint_clauses"/);
});

// ── 2. Encodable clause → encoded, NOT silently dropped ─────────────────────

await test("encodable clause is encoded and does not block (no silent drop)", () => {
  const result = interpretFreeFormIntentForAudit(ENCODABLE);
  expect(result.has_unencodable, "encodable clause must not be flagged").toBe(false);
  expect(result.encoded_clauses.some((c) => c.kind === "lens_weight" && c.lens === "security"), "security clause must be encoded as a lens_weight").toBeTruthy();

  // The gate stays satisfied for a purely-encodable intent.
  const bundle = bundleWithCheckpoint({ free_form_intent: ENCODABLE });
  expect(obligationState(bundle, "intent_checkpoint_current").state).toBe("satisfied");
});

await test("planning interprets free_form_intent via the shared authority (encodable → lens boost)", () => {
  // The planning-path helper is now a thin wrapper over the shared interpreter.
  expect(interpretFreeFormIntent(ENCODABLE)).toEqual(["security"]);
  expect(interpretFreeFormIntent("")).toEqual([]);
});

await test("free_form_intent='security audit' still boosts security tasks end-to-end", async () => {
  const bundle = {
    repo_manifest: {
      repository: { name: "fixture" },
      generated_at: "2026-01-01T00:00:00.000Z",
      files: [{ path: "src/auth.ts", language: "typescript", size_bytes: 1 }],
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
  } satisfies ArtifactBundle;
  const lineIndex = { "src/auth.ts": 100 };
  const result = await runPlanningExecutor(
    bundle,
    join(here, "__nonexistent_root__"),
    lineIndex,
  );
  if (!result.updated.audit_tasks) throw new Error("Expected planned audit tasks");
  const secTasks = result.updated.audit_tasks.filter((t) => t.lens === "security");
  expect(secTasks.length > 0, "should produce security tasks").toBeTruthy();
  for (const task of secTasks) {
    expect(task.priority, "security task should be boosted to high").toBe("high");
  }
});

// ── 3. Resolving the clause closes the escalation ───────────────────────────

await test("answering the checkpoint question via constraint_clauses satisfies the obligation", () => {
  const question = interpretFreeFormIntentForAudit(UNENCODABLE).checkpoint_questions[0];
  if (!question) throw new Error("Expected checkpoint question");
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
  expect(obligationState(bundle, "intent_checkpoint_current").state).toBe("satisfied");
});

await test("an empty host_answer does NOT resolve the blocking clause", () => {
  const question = interpretFreeFormIntentForAudit(UNENCODABLE).checkpoint_questions[0];
  if (!question) throw new Error("Expected checkpoint question");
  const bundle = bundleWithCheckpoint({
    free_form_intent: UNENCODABLE,
    constraint_clauses: [
      { text: UNENCODABLE, checkpoint_question: question, host_answer: "   " },
    ],
  });
  expect(obligationState(bundle, "intent_checkpoint_current").state).toBe("missing");
});

// ── 4. Single interpreter authority guard ───────────────────────────────────

await test("single authority: only the shared module defines a LENS_KEYWORD_MAP", async () => {
  // The canonical LENS_KEYWORD_MAP lives in src/shared/intent/sharedIntentData.ts.
  // Import it (proving it is reachable from exactly one module) and assert the
  // audit planning interpreter carries NO declaration of its own — it must
  // delegate. This replaces a recursive readdirSync regex-walk of src/ (the
  // structural invariant — single authority + no audit-side redeclaration — is
  // captured by the import plus the negative guard, with no full-tree walk).
  const { LENS_KEYWORD_MAP } = await import(
    "../../src/shared/intent/sharedIntentData.js"
  );
  expect(Array.isArray(LENS_KEYWORD_MAP) && LENS_KEYWORD_MAP.length > 0, "the shared LENS_KEYWORD_MAP must be the single, non-empty authority").toBeTruthy();

  const planningSrc = readFileSync(
    join(auditCodeRoot, "src", "audit", "orchestrator", "planningExecutors.ts"),
    "utf8",
  );
  expect(planningSrc, "audit planning interpreter must delegate to the shared LENS_KEYWORD_MAP, never declare its own").not.toMatch(/\b(?:const|let|var|export\s+const)\s+LENS_KEYWORD_MAP\b/);
});

await test("single authority: audit-code planning interpreter delegates to interpretFreeFormIntentForAudit", () => {
  // Guard the wiring at the source level — the planning interpreter must call
  // the shared-backed bridge, not reintroduce an inline keyword scan.
  const src = readFileSync(
    join(auditCodeRoot, "src", "audit", "orchestrator", "planningExecutors.ts"),
    "utf8",
  );
  expect(src, "planningExecutors must delegate to interpretFreeFormIntentForAudit").toMatch(/interpretFreeFormIntentForAudit/);
  expect(src, "planningExecutors must not declare its own keyword→lens map").not.toMatch(/KEYWORD_LENS_MAP/);
});
