import { test, expect } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { answerHostPause } from "./helpers/step-driver.js";
import { withTempRepo } from "./helpers/next-step-harness.js";
import { runWrapper } from "./helpers/run-wrapper.mjs";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type { AuditObligation } from "../../src/audit/types/auditState.js";
import type { IntentCheckpoint } from "../../src/shared/types/intentCheckpoint.js";

// ---------------------------------------------------------------------------
// N-free-form-intent-interpretation
//
// Regression for the silent-drop gap: the clause-aware shared interpreter is
// WIRED so an unencodable free_form_intent clause escalates to a BLOCKING
// confirm_intent checkpoint question, while the interpreter still recognizes lens
// signals without changing the confirmed question lens selection. The shared interpreter (shared/src/intent/*) is the single
// encodability authority.
// ---------------------------------------------------------------------------

const { deriveAuditState } = await import("../../src/audit/orchestrator/state.js");
const { decideNextStep } = await import("../../src/audit/orchestrator/nextStep.js");
const {
  interpretFreeFormIntentForAudit,
  unresolvedConstraintClauses,
} = await import("../../src/audit/orchestrator/intentInterpreter.js");
const { renderConfirmIntentPrompt } = await import("../../src/audit/cli/confirmIntentStep.js");


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
    analyzer_capability: { coverage: "not_applicable", analyzers: [] },
    design_assessment: {
      generated_at: "2026-01-01T00:00:00.000Z",
      findings: [],
      contract_reviewed: false,
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


test("normal CLI blocks on unresolved free-form intent and then publishes only confirmed questions", async () => {
  await withTempRepo(async (root) => {
    const dir = join(root, ".audit-tools/audit");
    const raw = `${ENCODABLE}. ${UNENCODABLE}.`;
    const checkpoint: IntentCheckpoint = {
      ...bundleWithCheckpoint().intent_checkpoint,
      free_form_intent: raw,
      lens_selection: { include: ["behavior"] },
    };
    let confirmations = 0;
    const transport = async () => {
      const step = JSON.parse((await runWrapper(["next-step"], { cwd: root })).stdout);
      if (step.step_kind === "confirm_intent") {
        confirmations++;
        const path = step.artifact_paths.intent_checkpoint;
        expect(typeof path).toBe("string");
        if (confirmations === 2) {
          const prompt = await readFile(step.prompt_path, "utf8");
          expect(prompt).toContain(UNENCODABLE);
          expect(prompt).toMatch(/Blocking: unencodable intent clauses/);
          const unresolved = unresolvedConstraintClauses(checkpoint);
          expect(unresolved).toHaveLength(1);
          checkpoint.constraint_clauses = unresolved.map(clause => ({
            ...clause, host_answer: "Treat as a non-functional note; no extra weighting.",
          }));
        } else {
          expect(confirmations).toBe(1);
        }
        await writeFile(path, JSON.stringify(checkpoint));
        // Handle this pause here, not through the default fixture checkpoint.
        return { ...step, step_kind: "intent_fixture_answered" };
      }
      return step;
    };
    let step: Awaited<ReturnType<typeof transport>> | undefined;
    for (let i = 0; i < 18; i++) {
      step = await transport();
      if (step.step_kind === "dispatch_review") break;
      if (step.step_kind !== "intent_fixture_answered") expect(await answerHostPause(step), step.step_kind).toBe(true);
    }
    expect(confirmations).toBe(2);
    expect(step?.step_kind).toBe("dispatch_review");
    const persisted = JSON.parse(await readFile(join(dir, "intent_checkpoint.json"), "utf8"));
    expect(persisted.constraint_clauses).toEqual(checkpoint.constraint_clauses);
    const bytes = await readFile(step!.artifact_paths.host_workload, "utf8");
    expect(bytes).not.toContain(raw);
    const workload = JSON.parse(bytes);
    expect(workload.contract_version).toBe("audit-tools/question-review/v1");
    expect(workload.work_items.length).toBeGreaterThan(0);
    expect(workload.work_items.map((item: { binding: { question: { lens: string } } }) => item.binding.question.lens))
      .toEqual(workload.work_items.map(() => "behavior"));
  });
});
