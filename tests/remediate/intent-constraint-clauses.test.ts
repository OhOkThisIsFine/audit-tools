/**
 * Unencodable free_form_intent clauses BLOCK remediation planning until the
 * host answers them via `constraint_clauses` (owner decision 896100e34412fa40:
 * the persisted intent-interpretation.json sidecar gets a real consumer, so
 * the persisted data is load-bearing and its correctness is tested).
 *
 * Mirrors the audit-side blocking-escalation gate (CE-004: resolution is keyed
 * on clause identity, never the rendered question). The remediate draw READS
 * the persisted sidecar; a missing or stale sidecar is repaired by
 * re-derivation through the shared interpreter, never silently skipped.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { IntentCheckpoint } from "audit-tools/shared";
import { interpretIntent } from "../../src/shared/intent/clauseInterpreter.js";
import {
  decideNextStep,
  INTENT_INTERPRETATION_FILENAME,
} from "../../src/remediate/steps/nextStep.js";
import {
  INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION,
  INTAKE_SUMMARY_SCHEMA_VERSION,
} from "../../src/remediate/intake.js";
import { scratchDir } from "../helpers/scratch.js";

const TEST_DIR = scratchDir(".test-intent-constraint-clauses");
const REPO_DIR = join(TEST_DIR, "repo");
const ARTIFACTS_DIR = join(REPO_DIR, ".audit-tools", "remediation");

// A clause the shared clause pipeline cannot encode as lens/priority/scope —
// the same fixture the shared interpreter tests use.
const UNENCODABLE_INTENT = "Freeze the public API of PackageX.";

/** The shared pipeline's own derivation for the fixture clause. */
function derivedClause(): { clause_id: string; text: string; checkpoint_question: string } {
  const result = interpretIntent(UNENCODABLE_INTENT);
  const clause = result.clauses.find((c) => !c.encodable && c.checkpoint_question);
  if (!clause || !clause.checkpoint_question) {
    throw new Error(
      "fixture assumption broken: the intent is no longer unencodable — pick a new fixture clause",
    );
  }
  return {
    clause_id: clause.clause_id,
    text: clause.text,
    checkpoint_question: clause.checkpoint_question,
  };
}

async function writeCheckpoint(overrides: Partial<IntentCheckpoint> = {}): Promise<void> {
  const checkpoint: IntentCheckpoint = {
    schema_version: "intent-checkpoint/v1",
    confirmed_at: "2026-08-25T00:00:00Z",
    confirmed_by: "host",
    scope_summary: "all packages",
    intent_summary: "full remediation",
    free_form_intent: UNENCODABLE_INTENT,
    ...overrides,
  };
  await writeFile(
    join(ARTIFACTS_DIR, "intent_checkpoint.json"),
    JSON.stringify(checkpoint),
    "utf8",
  );
}

async function writeReadySummary(): Promise<void> {
  const intakeDir = join(ARTIFACTS_DIR, "intake");
  const docPath = join(REPO_DIR, "input.md");
  await writeFile(docPath, "# Findings\nFix src/a.ts.", "utf8");
  await writeFile(
    join(intakeDir, "source-manifest.json"),
    JSON.stringify({
      schema_version: INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION,
      created_from: "input",
      sources: [{ type: "document", path: docPath, label: "input-01" }],
    }),
    "utf8",
  );
  await writeFile(join(intakeDir, "remediation-brief.md"), "# Brief\nFix it.", "utf8");
  const summary = {
    schema_version: INTAKE_SUMMARY_SCHEMA_VERSION,
    ready: true,
    source_type: "documents",
    goals: ["Remediate all high findings"],
    non_goals: [],
    constraints: [],
    affected_files: [{ path: "src/a.ts" }],
    open_questions: [],
  };
  await writeFile(
    join(intakeDir, "intake-summary.json"),
    JSON.stringify(summary),
    "utf8",
  );
}

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(join(ARTIFACTS_DIR, "intake"), { recursive: true });
});

describe("unresolved constraint clauses block the decide loop", () => {
  it("an unanswered unencodable clause yields a blocked step naming the clause and constraint_clauses", async () => {
    await writeCheckpoint();
    await writeReadySummary();

    const step = await decideNextStep({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });
    expect(step.status).toBe("blocked");
    const promptText = await readFile(step.prompt_path, "utf8");
    expect(promptText).toContain("constraint_clauses");
    expect(promptText).toContain(derivedClause().clause_id);

    // The consumer repaired/produced the sidecar, and the persisted record
    // carries clause identity — not just bare strings.
    const sidecarPath = join(ARTIFACTS_DIR, INTENT_INTERPRETATION_FILENAME);
    expect(existsSync(sidecarPath)).toBe(true);
    const sidecar = JSON.parse(await readFile(sidecarPath, "utf8"));
    const persistedIds = (sidecar.unencodable_clauses as Array<{ clause_id?: string }>).map(
      (c) => c.clause_id,
    );
    expect(persistedIds).toContain(derivedClause().clause_id);
  });

  it("a clause answered in constraint_clauses (by clause_id) does not block", async () => {
    const clause = derivedClause();
    await writeCheckpoint({
      constraint_clauses: [
        {
          clause_id: clause.clause_id,
          text: clause.text,
          checkpoint_question: clause.checkpoint_question,
          host_answer: "Do not change exported signatures anywhere.",
        },
      ],
    } as Partial<IntentCheckpoint>);
    await writeReadySummary();

    const step = await decideNextStep({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });
    const promptText = await readFile(step.prompt_path, "utf8");
    // The run proceeds past the constraint gate: the step is not the
    // unresolved-constraint block for this clause.
    expect(promptText).not.toContain(clause.clause_id);
  });

  it("the persisted sidecar is the consumed input — a doctored question surfaces verbatim", async () => {
    const clause = derivedClause();
    await writeCheckpoint();
    await writeReadySummary();
    // Run once so the tool itself writes the sidecar (pinning the real shape),
    // then doctor the persisted question.
    await decideNextStep({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });
    const sidecarPath = join(ARTIFACTS_DIR, INTENT_INTERPRETATION_FILENAME);
    const sidecar = JSON.parse(await readFile(sidecarPath, "utf8"));
    const doctored = "DOCTORED-QUESTION-TOKEN-4d1c";
    for (const entry of sidecar.unencodable_clauses as Array<{
      clause_id: string;
      checkpoint_question: string;
    }>) {
      if (entry.clause_id === clause.clause_id) entry.checkpoint_question = doctored;
    }
    await writeFile(sidecarPath, JSON.stringify(sidecar), "utf8");

    const step = await decideNextStep({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });
    const promptText = await readFile(step.prompt_path, "utf8");
    expect(promptText).toContain(doctored);
  });

  it("a stale-version sidecar is repaired by re-derivation, not trusted and not skipped", async () => {
    await writeCheckpoint();
    await writeReadySummary();
    const sidecarPath = join(ARTIFACTS_DIR, INTENT_INTERPRETATION_FILENAME);
    await writeFile(
      sidecarPath,
      JSON.stringify({
        schema_version: "remediate-code-intent-interpretation/v1alpha1",
        interpreted: {},
        unencodable_clauses: [UNENCODABLE_INTENT],
        created_at: "2026-08-01T00:00:00Z",
      }),
      "utf8",
    );

    const step = await decideNextStep({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });
    expect(step.status).toBe("blocked");
    const promptText = await readFile(step.prompt_path, "utf8");
    expect(promptText).toContain(derivedClause().clause_id);
    // The stale sidecar was rewritten to the current shape.
    const sidecar = JSON.parse(await readFile(sidecarPath, "utf8"));
    expect(sidecar.schema_version).not.toBe(
      "remediate-code-intent-interpretation/v1alpha1",
    );
  });
});
