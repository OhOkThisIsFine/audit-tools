/**
 * O2 — the intent_checkpoint semantic-equivalence gate (DD-9, wired).
 *
 * Decides whether a re-confirmed intent_checkpoint is semantically EQUIVALENT to
 * the form downstreams last derived against (so dependents need not re-stale) or
 * CHANGED (so the planning cascade re-derives). A raw byte/JSON compare
 * over-stales: a host re-confirming the same intent with a fresh timestamp,
 * reordered keys, or a benign rephrase would needlessly invalidate the whole
 * planning tree. A pure structural compare under-stales: a genuine intent change
 * phrased to normalize identically would be silently dropped.
 *
 * The semantic surface is SPLIT into two normal forms:
 *
 *  - STRUCTURED (`structuredFields`): scope/lens/filter/constraint/design-review
 *    fields. A structured delta is DETERMINISTICALLY `changed` — an LLM judge
 *    never arbitrates a numeric/list delta (a `ceiling` 3→5 must never be waved
 *    through as "equivalent prose").
 *  - PROSE (`proseFields`): the free-text summaries. A prose-only delta is the
 *    ONLY thing the bounded host judge arbitrates, and the judge is FAIL-SAFE:
 *    anything but an explicit `equivalent` verdict resolves to `changed`.
 *
 * The judge is the HOST via a bounded step (conversation-first — audit-code has
 * no in-process LLM): see `intentEquivalenceExecutor.ts` for the obligation /
 * commit machinery and `artifactMetadata.ts` for how the committed baseline
 * mirrors the intent entry's revision. There is no in-process lock choreography
 * and no verdict cache: a verdict is materialized into the persisted baseline at
 * commit, and the step round-trip re-checks the judged pair against the live
 * pair before committing (an interleaved intent edit discards the verdict and
 * re-fires the obligation).
 *
 * VERSION KEYING (INV-O2-inv-5/6): `computeGateVersion` is a LOCALLY-resolved
 * token — `hash(normalizeConfig) + judge-id token + prompt-template version` —
 * computed with NO network/API probe. The judge id is the constant `"host"`
 * (conversation-first: the host agent is always the judge), so every component
 * is derivable at compare time; a stale component invalidates the persisted
 * baseline, which the executor resolves as `changed` (over-stale, safe).
 */
import { hashContent, stableStringify } from 'audit-tools/shared';
import type { IntentCheckpoint } from 'audit-tools/shared';

/** A gate verdict over a (prior, new) intent_checkpoint pair. */
export type IntentCheckpointVerdict = 'unchanged' | 'changed';

/**
 * Deterministic normalization config. Bumping any field bumps `gate_version` and
 * invalidates the persisted baseline. Kept as data (not code) so the version
 * hash captures the active policy, not the module's source text.
 */
export interface NormalizeConfig {
  /** Schema/recipe version of the normalization itself. Bump on any change. */
  readonly version: string;
  /**
   * Fields whose delta is DETERMINISTICALLY `changed` — never LLM-judged.
   * Everything semantic except the free-prose summaries.
   */
  readonly structuredFields: readonly (keyof IntentCheckpoint)[];
  /**
   * Free-prose fields whose delta (with structured equal) is arbitrated by the
   * bounded host judge.
   */
  readonly proseFields: readonly (keyof IntentCheckpoint)[];
}

/**
 * The single active normalization config (INV-O2-inv-5 input). The two lists
 * together cover every `IntentCheckpoint` field except the provenance pair
 * (`confirmed_at`, `confirmed_by`) — which `NON_SEMANTIC_FIELDS_BY_ARTIFACT`
 * also strips from the canonical content hash. `schema_version` is deliberately
 * STRUCTURED (a schema migration is a semantic reinterpretation, not
 * provenance).
 */
export const DEFAULT_NORMALIZE_CONFIG: NormalizeConfig = {
  version: 'intent-checkpoint-normalize/v2',
  structuredFields: [
    'schema_version',
    'excluded_scope',
    'must_not_touch',
    'filters',
    'disposition_overrides',
    'lens_selection',
    'design_review',
  ],
  // `constraint_clauses` is PROSE per DD-9's explicit listing (host_answer
  // rephrases are judge-arbitrated): the clauses array rides the prose normal
  // form in full, so a clause addition/removal is visible to the judge and a
  // benign answer rephrase is judgeable rather than deterministically re-staling
  // the cascade.
  proseFields: [
    'scope_summary',
    'intent_summary',
    'free_form_intent',
    'constraint_clauses',
  ],
};

/** Static prompt-template version — bump on any judge-prompt change. */
export const INTENT_GATE_PROMPT_TEMPLATE_VERSION = 'intent-checkpoint-judge-prompt/v1';

/**
 * The locally-resolved judge id (conversation-first: the host agent is always
 * the judge). A constant so every `gate_version` component is derivable at
 * compare time with no probe.
 */
export const HOST_JUDGE_ID = 'host';

/** The two semantic normal forms of one checkpoint value. */
export interface CheckpointNormalForms {
  structured: string;
  prose: string;
}

function projectFields(
  checkpoint: IntentCheckpoint,
  fields: readonly (keyof IntentCheckpoint)[],
): string {
  const projection: Record<string, unknown> = {};
  for (const field of fields) {
    const value = checkpoint[field];
    if (value !== undefined) {
      // Prose is whitespace-insensitive at the edges; structured values are
      // compared structurally via the stable serializer (key order invisible).
      projection[field as string] =
        typeof value === 'string' ? value.trim() : value;
    }
  }
  return stableStringify(projection);
}

/**
 * Deterministically normalize an intent_checkpoint value to its two semantic
 * normal forms. An absent checkpoint normalizes to a stable empty marker so
 * present-vs-absent is a real difference, not a crash.
 */
export function normalizeCheckpointForms(
  checkpoint: IntentCheckpoint | undefined,
  config: NormalizeConfig = DEFAULT_NORMALIZE_CONFIG,
): CheckpointNormalForms {
  if (!checkpoint) {
    const absent = stableStringify({ __absent: true });
    return { structured: absent, prose: absent };
  }
  return {
    structured: projectFields(checkpoint, config.structuredFields),
    prose: projectFields(checkpoint, config.proseFields),
  };
}

/**
 * Compute the LOCALLY-resolved `gate_version` token:
 * `hash(normalizeConfig) + judge-id token + prompt-template version`.
 * NO network/API probe (INV-O2-inv-6). Bumping the normalize config, the judge
 * id, or the prompt template deterministically invalidates the persisted
 * baseline (the executor resolves the mismatch as `changed` — over-stale, the
 * safe direction).
 */
export function computeGateVersion(input?: {
  normalizeConfig?: NormalizeConfig;
  /** Locally-resolved judge id token. Defaults to the conversation-first constant. */
  judgeId?: string;
  promptTemplateVersion?: string;
}): string {
  const normalizeConfig = input?.normalizeConfig ?? DEFAULT_NORMALIZE_CONFIG;
  const judgeId = input?.judgeId ?? HOST_JUDGE_ID;
  const promptTemplateVersion =
    input?.promptTemplateVersion ?? INTENT_GATE_PROMPT_TEMPLATE_VERSION;
  const configHash = hashContent(stableStringify(normalizeConfig), { length: 16 });
  return `${configHash}:${judgeId}:${promptTemplateVersion}`;
}

/**
 * Hash one normal form for pair identification (the judge submission names the
 * pair it judged by these hashes, and consumption re-derives them from the live
 * checkpoint to detect an interleaved edit).
 */
export function normalFormHash(normalized: string): string {
  return hashContent(normalized, { length: 16 });
}
