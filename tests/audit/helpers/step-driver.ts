// The one step-walking driver the audit test harnesses share.
//
// Three harnesses independently drove the same walk — answer each scripted host
// pause, stop at the first terminal step — and two of them
// (`completion-harness.advanceToDispatchReady`,
// `wrapper-harness.startDispatchRun`) had byte-identical pause bodies differing
// only in how they fetched the next step. The third
// (`next-step-harness.advancePastDesignReview`) had drifted: it answered two
// pause kinds the others would have thrown on, and it hardcoded two artifact
// paths the others read from the step contract.
//
// Only three things legitimately differ between the walks, and all three are
// parameters here: the TRANSPORT (in-process command vs spawned wrapper), the
// TERMINAL kind set, and an optional per-step observation hook for a walk that
// also asserts something about a pause. Everything else is this module.
//
// The pause answerer covers the UNION of the kinds the three walks handled.
// That is deliberate, and it is a real trade-off worth stating: the two
// dispatch walks previously THREW on `critical_flow_fallback` and the legacy
// `design_review`, and now answer them instead. So a hypothetical orchestrator
// regression that made a dispatch flow emit one of those would once have failed
// loudly here and would now be absorbed.
//
// It is taken anyway, because the narrower sets were incidental rather than
// contractual — each harness had only ever taught itself the kinds it happened
// to hit, and all three exist to do the same job: answer whatever host pause
// arrives and stop at a terminal step. No test depended on either throw (the one
// test that asserted on an unrecognised kind is still green, and now drives this
// driver directly). The cost of the alternative is concrete: a per-walk
// answerable set puts every new pause kind back to a three-file edit, which is
// the drift that produced these three copies to begin with.
//
// Unknown kinds — the case that actually signals a regression — still throw.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Fetch the next step contract, however this harness talks to the orchestrator. */
export type NextStepTransport = () => Promise<any>;

export interface StepWalkOptions {
  /** How this harness obtains the next step contract. */
  transport: NextStepTransport;
  /** Step kinds that end the walk and are returned to the caller. */
  terminalKinds: ReadonlySet<string>;
  /** Name used in the two failure messages, so a timeout still names its caller. */
  label: string;
  /** Pause budget. Each pause kind is expected at most once; 8 leaves headroom. */
  maxPauses?: number;
  /**
   * Extra work for a pause this walk wants to ASSERT on, run before the pause is
   * answered. Used by the next-step walk to pin the double-driver regression
   * (the dispatched worker packet must not carry the orchestrator advance).
   */
  observePause?: (step: any) => Promise<void> | void;
}

/**
 * Pause kinds are expected at most once each (analyzer consent + install,
 * intent confirmation, the design-review passes, optional edge reasoning and
 * critical-flow fallback); the cap leaves headroom above that.
 */
export const MAX_HOST_PAUSES = 8;

const DECLINED_ANALYZERS = {
  semgrep: "declined",
  eslint: "declined",
  knip: "declined",
  jscpd: "declined",
  "osv-scanner": "declined",
};

const CONFIRMED_INTENT = {
  schema_version: "intent-checkpoint/v1",
  confirmed_at: "2026-04-22T00:00:00Z",
  confirmed_by: "host",
  scope_summary: "test scope",
  intent_summary: "full-audit",
};

const EMPTY_JSON_ARRAY = "[]\n";

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

/**
 * The path the step contract DECLARES, and nothing else.
 *
 * This used to fall back to a conventional `incoming/<name>.json` filename when
 * the contract omitted an entry. Post-P25 that fallback is not merely redundant
 * but wrong: the submission path is a digest of a tool-minted id, so a harness
 * cannot reconstruct it and must not pretend to. A missing entry is now a loud
 * failure — which is the right signal, since a step that does not declare where
 * its answer goes is a step no host could answer either.
 */
function declaredArtifactPath(step: any, key: string): string {
  const declared = step?.artifact_paths?.[key];
  if (typeof declared !== "string" || declared.length === 0) {
    throw new Error(
      `step '${step?.step_kind}' declares no artifact path for '${key}' — ` +
        "the submission path is tool-computed and cannot be guessed",
    );
  }
  return declared;
}

/** Write one scripted submission at the path the step bound for it. */
async function submit(step: any, key: string, body: string): Promise<void> {
  const path = declaredArtifactPath(step, key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
}

/**
 * Answer one scripted host pause. Returns false when the kind is not a pause
 * this driver knows how to answer, leaving the decision to the caller.
 *
 * Exported for the walks whose terminal condition is an ARTIFACT rather than a
 * step kind (the acquisition-marker hermeticity pin), so they answer pauses
 * through this one answerer instead of teaching themselves a second copy.
 */
export async function answerHostPause(step: any): Promise<boolean> {
  switch (step.step_kind) {
    case "analyzer_consent":
      await submit(step, "analyzer_consent_decisions", pretty(DECLINED_ANALYZERS));
      return true;

    case "analyzer_install":
      await submit(step, "analyzer_decisions", pretty({ typescript: "skip" }));
      return true;

    case "confirm_intent":
      await submit(step, "intent_checkpoint", pretty(CONFIRMED_INTENT));
      return true;

    case "critical_flow_fallback":
      await submit(step, "critical_flow_fallback_results", pretty({ flows: [] }));
      return true;

    // The pre-split single-pass design review.
    case "design_review":
      await submit(step, "design_review_results", EMPTY_JSON_ARRAY);
      return true;

    case "design_review_parallel":
      await submit(step, "contract_results", EMPTY_JSON_ARRAY);
      await submit(step, "conceptual_results", EMPTY_JSON_ARRAY);
      return true;

    case "design_review_contract":
      await submit(step, "contract_results", EMPTY_JSON_ARRAY);
      return true;

    case "design_review_conceptual":
      await submit(step, "conceptual_results", EMPTY_JSON_ARRAY);
      return true;

    case "edge_reasoning_dispatch":
      await submit(step, "edge_reasoning_results", EMPTY_JSON_ARRAY);
      return true;

    default:
      return false;
  }
}

/**
 * Drive `next-step` past every scripted host pause and return the first step
 * whose kind is terminal for this walk.
 *
 * Throws descriptively on an unrecognised kind rather than returning a
 * mismatched step, and throws when the pause budget is exhausted.
 */
export async function walkStepsUntilTerminal(
  options: StepWalkOptions,
): Promise<any> {
  const { transport, terminalKinds, label } = options;
  const maxPauses = options.maxPauses ?? MAX_HOST_PAUSES;

  for (let i = 0; i < maxPauses; i++) {
    const step = await transport();

    if (terminalKinds.has(step.step_kind)) {
      return step;
    }

    await options.observePause?.(step);

    if (await answerHostPause(step)) {
      continue;
    }

    throw new Error(
      `${label}: unexpected step kind '${step.step_kind}' (iteration ${i})`,
    );
  }

  throw new Error(`${label}: next-step did not reach a terminal step`);
}
