/**
 * DD-9 — the intent-equivalence obligation's executor.
 *
 * Decides whether the live `intent_checkpoint.json` is semantically equivalent
 * to the baseline downstreams last derived against, and COMMITS the resolution
 * into `artifact_metadata.intent_baseline` — the revision authority the
 * metadata stamper mirrors (see `artifactMetadata.ts`): a committed `changed`
 * advances `baseline.revision` (downstreams re-stale exactly once); an
 * `equivalent` advances only the normal forms (downstreams never notice).
 *
 * Arms (see `deriveIntentEquivalenceStatus`):
 *  - `satisfied` — no checkpoint, or forms match the gate-current baseline.
 *  - `stamp_baseline` — no baseline yet: stamp from the current checkpoint
 *    (deterministic, drainable). First-contact on legacy run dirs.
 *  - `gate_version_stale` — the persisted baseline predates the current
 *    normalize-config / judge / prompt-template trio: resolve as CHANGED
 *    (over-stale, the safe direction; the old normal forms are not comparable).
 *  - `structured_changed` — the STRUCTURED normal form moved: deterministically
 *    CHANGED, no judge (an LLM must never arbitrate a numeric/list delta).
 *  - `prose_judgment_pending` — structured equal, prose moved: the bounded host
 *    judge owns the verdict (conversation flow emits the judge step; pure
 *    headless resolves as CHANGED, fail-safe).
 *
 * A judge submission names the pair it judged (`judged_pair` normal-form
 * hashes); consumption re-derives the live pair and DISCARDS a stale verdict
 * (the checkpoint moved again mid-judgment) so the obligation re-fires on the
 * new pair — the O2 interleave property realized by the step round-trip itself.
 */
import { z } from "zod";
import { METADATA_SCHEMA_VERSION } from "../types/artifactMetadata.js";
import type { IntentBaseline } from "../types/artifactMetadata.js";
import type { ArtifactBundle } from "../io/artifacts.js";
import type { ExecutorRunResult } from "./executorResult.js";
import {
  computeGateVersion,
  normalizeCheckpointForms,
  normalFormHash,
} from "./intentCheckpointGate.js";
import { hashArtifactValue } from "./artifactFreshness.js";

export const IntentEquivalenceVerdictSchema = z
  .object({
    verdict: z.enum(["equivalent", "changed"]),
    judged_pair: z
      .object({
        prior_hash: z.string(),
        new_hash: z.string(),
      })
      .strict(),
  })
  .strict();
export type IntentEquivalenceVerdictSubmission = z.infer<
  typeof IntentEquivalenceVerdictSchema
>;

export type IntentEquivalenceStatus =
  | { kind: "satisfied" }
  | { kind: "stamp_baseline" }
  | { kind: "gate_version_stale" }
  | { kind: "structured_changed" }
  | {
      kind: "prose_judgment_pending";
      prior_prose: string;
      current_prose: string;
      prior_hash: string;
      new_hash: string;
    };

/** Pure derivation of the obligation's state from the live bundle. */
export function deriveIntentEquivalenceStatus(
  bundle: ArtifactBundle,
): IntentEquivalenceStatus {
  const checkpoint = bundle.intent_checkpoint;
  if (!checkpoint) return { kind: "satisfied" };
  const baseline = bundle.artifact_metadata?.intent_baseline;
  if (!baseline) return { kind: "stamp_baseline" };
  if (baseline.gate_version !== computeGateVersion()) {
    return { kind: "gate_version_stale" };
  }
  const forms = normalizeCheckpointForms(checkpoint);
  if (forms.structured !== baseline.normalized_structured) {
    return { kind: "structured_changed" };
  }
  if (forms.prose !== baseline.normalized_prose) {
    return {
      kind: "prose_judgment_pending",
      prior_prose: baseline.normalized_prose,
      current_prose: forms.prose,
      prior_hash: normalFormHash(baseline.normalized_prose),
      new_hash: normalFormHash(forms.prose),
    };
  }
  return { kind: "satisfied" };
}

function withBaseline(
  bundle: ArtifactBundle,
  baseline: IntentBaseline,
): ArtifactBundle {
  const manifest = bundle.artifact_metadata ?? {
    metadata_schema_version: METADATA_SCHEMA_VERSION,
    artifacts: {},
  };
  return {
    ...bundle,
    artifact_metadata: { ...manifest, intent_baseline: baseline },
  };
}

function currentEntryRevision(bundle: ArtifactBundle): number {
  return (
    bundle.artifact_metadata?.artifacts["intent_checkpoint.json"]?.revision ?? 0
  );
}

/**
 * Resolve the obligation. `verdict` is the consumed judge submission when one
 * arrived this step; absent, every arm resolves deterministically — including
 * `prose_judgment_pending` → CHANGED, which is only reachable verdict-less in
 * the pure-headless drain (the conversation flow emits the judge step instead)
 * and is the fail-safe direction there.
 */
export function runIntentEquivalenceResolve(
  bundle: ArtifactBundle,
  verdict?: IntentEquivalenceVerdictSubmission,
): ExecutorRunResult {
  const status = deriveIntentEquivalenceStatus(bundle);
  const checkpoint = bundle.intent_checkpoint;
  if (status.kind === "satisfied" || !checkpoint) {
    return {
      updated: bundle,
      artifacts_written: [],
      progress_summary:
        "Intent-equivalence baseline already current; nothing to resolve.",
    };
  }

  const forms = normalizeCheckpointForms(checkpoint);
  const gateVersion = computeGateVersion();

  const resolveChanged = (why: string): ExecutorRunResult => {
    const baseline: IntentBaseline = {
      normalized_structured: forms.structured,
      normalized_prose: forms.prose,
      revision: currentEntryRevision(bundle) + 1,
      gate_version: gateVersion,
    };
    return {
      updated: withBaseline(bundle, baseline),
      artifacts_written: [],
      progress_summary: `Intent checkpoint resolved as CHANGED (${why}); downstream planning artifacts re-stale once.`,
    };
  };

  if (status.kind === "stamp_baseline") {
    // First contact. If the recorded entry hash does NOT match the live
    // checkpoint, a change is PENDING whose prior semantics are unknowable (no
    // baseline was ever recorded) — adopting the old revision here would let
    // the revision mirror restamp the entry and silently evaporate the
    // downstream staleness that change legitimately owes (fail-OPEN on legacy
    // run dirs). Resolve it as CHANGED instead (over-stale, safe). Only a
    // hash-consistent first contact stamps quietly at the current revision.
    const entry =
      bundle.artifact_metadata?.artifacts["intent_checkpoint.json"];
    if (
      entry &&
      entry.content_hash !== hashArtifactValue("intent_checkpoint.json", checkpoint)
    ) {
      return resolveChanged(
        "first contact with a pending checkpoint change; prior semantics unrecorded",
      );
    }
    const baseline: IntentBaseline = {
      normalized_structured: forms.structured,
      normalized_prose: forms.prose,
      // Mirror what the ordinary bump rules will assign this entry at the next
      // metadata pass: an existing entry keeps its revision; a first-ever entry
      // gets 1 (0 + 1).
      revision: Math.max(currentEntryRevision(bundle), 1),
      gate_version: gateVersion,
    };
    return {
      updated: withBaseline(bundle, baseline),
      artifacts_written: [],
      progress_summary:
        "Stamped the intent-equivalence baseline from the current checkpoint (first contact).",
    };
  }

  if (status.kind === "gate_version_stale") {
    return resolveChanged("normalize/judge/prompt version moved; prior baseline not comparable");
  }
  if (status.kind === "structured_changed") {
    return resolveChanged("structured intent fields differ — deterministic, never LLM-judged");
  }

  // prose_judgment_pending
  if (!verdict) {
    return resolveChanged(
      "prose differs and no host judge is available (headless fail-safe)",
    );
  }
  if (
    verdict.judged_pair.prior_hash !== status.prior_hash ||
    verdict.judged_pair.new_hash !== status.new_hash
  ) {
    // The checkpoint moved again mid-judgment: discard the stale verdict; the
    // obligation stays pending and the judge step re-fires on the live pair.
    // Loud on stderr (mirrors the quarantine path) — the host otherwise sees a
    // fresh judge step with different hashes and no statement of why its
    // verdict vanished.
    process.stderr.write(
      `[audit-code] intent-equivalence verdict discarded: it judged pair ` +
        `${verdict.judged_pair.prior_hash}:${verdict.judged_pair.new_hash} but the live pair is ` +
        `${status.prior_hash}:${status.new_hash} (the checkpoint changed again mid-judgment). ` +
        `The judge step re-fires with the current pair.\n`,
    );
    return {
      updated: bundle,
      artifacts_written: [],
      progress_summary:
        "Discarded a stale intent-equivalence verdict (the checkpoint changed again mid-judgment); the judge step re-fires on the live pair.",
    };
  }
  if (verdict.verdict === "changed") {
    return resolveChanged("host judge verdict: changed");
  }
  // equivalent: advance the normal forms; the revision authority stays put, so
  // downstream `dependency_revisions` compares stay clean and nothing re-derives.
  const baseline: IntentBaseline = {
    normalized_structured: forms.structured,
    normalized_prose: forms.prose,
    revision:
      bundle.artifact_metadata?.intent_baseline?.revision ??
      Math.max(currentEntryRevision(bundle), 1),
    gate_version: gateVersion,
  };
  return {
    updated: withBaseline(bundle, baseline),
    artifacts_written: [],
    progress_summary:
      "Host judge verdict: EQUIVALENT — baseline normal forms advanced; downstream planning artifacts stay fresh (no re-derivation).",
  };
}
