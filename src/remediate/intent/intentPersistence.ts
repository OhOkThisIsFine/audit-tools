// sites-pinned: tests/remediate/intent-constraint-clauses.test.ts
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { interpretFreeFormIntent, interpretIntent, constraintClausesFromIntent, writeJsonFile, isRecord, type ConstraintClauseRecord, type InterpretedIntent, type IntentCheckpoint, type RunLogger } from "audit-tools/shared";

// ---------------------------------------------------------------------------
// Deterministic free_form_intent interpretation at the call site (INV-S04)
// ---------------------------------------------------------------------------
//
// The IntentCheckpoint contract states `free_form_intent` is "interpreted into
// priority/lens/scope signals at planning time via freeFormIntentInterpreter.
// Never threaded verbatim into worker or dispatch prompts (INV-S04)." This is
// the call site that honours that: when a CONFIRMED checkpoint carries a
// free_form_intent, we run the shared deterministic interpreter HERE — never
// pass the raw string downstream — and persist the structured signals so
// planning consumes the encoded lens-weights/priority/scope, and so the
// unencodable clauses are surfaced (never silently dropped) rather than relying
// on an LLM-authored free-text `intent_interpretation`.

/** Sidecar artifact recording the deterministic interpretation of free_form_intent. */
export const INTENT_INTERPRETATION_FILENAME = "intent-interpretation.json";
// v1alpha2: unencodable_clauses carries identity-keyed records (clause_id +
// checkpoint_question), not bare strings — the shape the blocking consumer
// reads. A v1alpha1 sidecar (string[]) is stale and is repaired by
// re-derivation; it had no readers, so no migration path is owed.
export const INTENT_INTERPRETATION_SCHEMA_VERSION =
  "remediate-code-intent-interpretation/v1alpha2";

export interface PersistedIntentInterpretation {
  schema_version: typeof INTENT_INTERPRETATION_SCHEMA_VERSION;
  /** The interpreter's structured output (lens weights / priority / scope). */
  interpreted: InterpretedIntent;
  /**
   * Clauses the clause pipeline could not encode as a lens weight, priority
   * signal, or scope emphasis — with their stable identity and blocking
   * question. CONSUMED by the interpret_intent obligation: an unanswered
   * record blocks the decide loop until the host resolves it via a
   * `constraint_clauses` entry on the checkpoint (CE-004, identity-keyed).
   */
  unencodable_clauses: ConstraintClauseRecord[];
  created_at: string;
}

/**
 * Interpret a confirmed checkpoint's `free_form_intent` via the shared
 * deterministic interpreter and persist the structured signals to a sidecar
 * artifact. Idempotent and best-effort: returns the persisted interpretation (or
 * null when there is nothing to interpret / no confirmed checkpoint) and never
 * throws into the decide loop. The raw `free_form_intent` string is NOT returned
 * or threaded anywhere — only the structured `InterpretedIntent` is (INV-S04).
 */
export async function interpretConfirmedCheckpointIntent(
  artifactsDir: string,
  checkpoint: IntentCheckpoint | undefined,
  // Optional so the exported helper stays callable standalone; the decide loop
  // always supplies it, because an unencodable clause is an operator-visible
  // loss of intent and belongs in the durable log, not only on stderr.
  runLogger?: RunLogger,
): Promise<PersistedIntentInterpretation | null> {
  if (!checkpoint || checkpoint.confirmed_by !== "host") return null;
  const raw = checkpoint.free_form_intent;
  if (typeof raw !== "string" || raw.trim().length === 0) return null;

  const interpreted = interpretFreeFormIntent(raw);
  // The clause pipeline (interpretIntent) owns identity + blocking questions;
  // the hint interpreter above owns lens/priority/scope signals. Both are
  // deterministic draws over the same input.
  const clauseResult = interpretIntent(raw);
  const unencodable_clauses = constraintClausesFromIntent(clauseResult.clauses);
  const persisted: PersistedIntentInterpretation = {
    schema_version: INTENT_INTERPRETATION_SCHEMA_VERSION,
    interpreted,
    unencodable_clauses,
    created_at: new Date().toISOString(),
  };
  try {
    await writeJsonFile(
      join(artifactsDir, INTENT_INTERPRETATION_FILENAME),
      persisted,
    );
  } catch {
    // Best-effort WRITE: a write failure must never crash the decide loop.
    // Enforcement does not depend on it — the consumer re-derives when the
    // sidecar is missing (readOrRepairIntentInterpretation).
  }
  if (unencodable_clauses.length > 0) {
    const clauseTexts = unencodable_clauses.map((c) => c.text);
    runLogger?.event({
      phase: "next-step",
      kind: "outcome",
      obligation: "interpret_intent",
      note:
        `intent_unencodable_clauses count=${String(unencodable_clauses.length)} ` +
        `clauses=${clauseTexts.join("; ")}`,
    });
    process.stderr.write(
      `[remediate-code] free_form_intent: ${unencodable_clauses.length} ` +
        `clause(s) could not be encoded as lens/priority/scope signals and ` +
        `block planning until answered via constraint_clauses: ` +
        `${clauseTexts.join("; ")}\n`,
    );
  }
  return persisted;
}

/**
 * Read the persisted intent interpretation — the LOAD-BEARING input to the
 * constraint-clause gate — repairing it by re-derivation when it is missing,
 * unparseable, or carries a stale schema_version. Returns null only when
 * there is nothing to interpret (no confirmed checkpoint / empty intent).
 */
export async function readOrRepairIntentInterpretation(
  artifactsDir: string,
  checkpoint: IntentCheckpoint | undefined,
  runLogger?: RunLogger,
): Promise<PersistedIntentInterpretation | null> {
  if (!checkpoint || checkpoint.confirmed_by !== "host") return null;
  const raw = checkpoint.free_form_intent;
  if (typeof raw !== "string" || raw.trim().length === 0) return null;

  const sidecarPath = join(artifactsDir, INTENT_INTERPRETATION_FILENAME);
  try {
    const parsed = parsePersistedIntentInterpretation(
      JSON.parse(await readFile(sidecarPath, "utf8")),
    );
    if (parsed) return parsed;
  } catch {
    // Missing or unreadable — fall through to repair.
  }
  return interpretConfirmedCheckpointIntent(artifactsDir, checkpoint, runLogger);
}

/** Pure shape gate for the sidecar: current version + record-shaped clauses, else null. */
function parsePersistedIntentInterpretation(
  parsed: unknown,
): PersistedIntentInterpretation | null {
  if (
    isRecord(parsed) &&
    parsed.schema_version === INTENT_INTERPRETATION_SCHEMA_VERSION &&
    Array.isArray(parsed.unencodable_clauses) &&
    parsed.unencodable_clauses.every(
      (c): c is ConstraintClauseRecord =>
        isRecord(c) &&
        typeof c.clause_id === "string" &&
        typeof c.text === "string" &&
        typeof c.checkpoint_question === "string",
    )
  ) {
    return parsed as unknown as PersistedIntentInterpretation;
  }
  return null;
}

/**
 * Sync sidecar read for the obligation's derive scan. Returns the persisted
 * interpretation, or null when the sidecar is missing, unreadable, or stale —
 * the execute path repairs via {@link readOrRepairIntentInterpretation}.
 */
export function readPersistedIntentInterpretationSync(
  sidecarPath: string,
): PersistedIntentInterpretation | null {
  try {
    return parsePersistedIntentInterpretation(
      JSON.parse(readFileSync(sidecarPath, "utf8")),
    );
  } catch {
    return null;
  }
}
