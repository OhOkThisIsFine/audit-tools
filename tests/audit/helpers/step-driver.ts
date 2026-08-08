// The one step-walking driver the audit test harnesses share.
//
// Three harnesses independently drove the same walk — answer each headless host
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
import { join } from "node:path";

/** Fetch the next step contract, however this harness talks to the orchestrator. */
export type NextStepTransport = () => Promise<any>;

export interface StepWalkOptions {
  /** Repo root; the `incoming` directory is derived from it. */
  root: string;
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
 * Prefer the path the step contract declares, falling back to the conventional
 * `incoming/` filename.
 *
 * Two of the three walks read the contract path and one hardcoded the
 * conventional name. The contract path is the robust choice — it is what the
 * orchestrator actually reads back — but falling back keeps the walk working for
 * a step kind whose contract omits the entry, which is exactly the case the
 * hardcoding was papering over.
 */
function resolveArtifactPath(
  step: any,
  key: string,
  incomingDir: string,
  fallbackFilename: string,
): string {
  const declared = step?.artifact_paths?.[key];
  return typeof declared === "string" && declared.length > 0
    ? declared
    : join(incomingDir, fallbackFilename);
}

/**
 * Answer one headless host pause. Returns false when the kind is not a pause
 * this driver knows how to answer, leaving the decision to the caller.
 */
async function answerHostPause(step: any, incomingDir: string): Promise<boolean> {
  switch (step.step_kind) {
    case "analyzer_consent":
      await mkdir(incomingDir, { recursive: true });
      await writeFile(
        resolveArtifactPath(
          step,
          "analyzer_consent_decisions",
          incomingDir,
          "analyzer-consent-decisions.json",
        ),
        pretty(DECLINED_ANALYZERS),
      );
      return true;

    case "analyzer_install":
      await mkdir(incomingDir, { recursive: true });
      await writeFile(
        resolveArtifactPath(
          step,
          "analyzer_decisions",
          incomingDir,
          "analyzer-decisions.json",
        ),
        pretty({ typescript: "skip" }),
      );
      return true;

    case "confirm_intent":
      await writeFile(step.artifact_paths.intent_checkpoint, pretty(CONFIRMED_INTENT));
      return true;

    case "critical_flow_fallback":
      await mkdir(incomingDir, { recursive: true });
      await writeFile(
        step.artifact_paths.critical_flow_fallback_results,
        pretty({ flows: [] }),
      );
      return true;

    // The pre-split single-pass design review.
    case "design_review":
      await mkdir(incomingDir, { recursive: true });
      await writeFile(
        join(incomingDir, "design-review-findings.json"),
        EMPTY_JSON_ARRAY,
      );
      return true;

    case "design_review_parallel":
      await mkdir(incomingDir, { recursive: true });
      await writeFile(
        join(incomingDir, "design-review-contract-findings.json"),
        EMPTY_JSON_ARRAY,
      );
      await writeFile(
        join(incomingDir, "design-review-conceptual-findings.json"),
        EMPTY_JSON_ARRAY,
      );
      return true;

    case "design_review_contract":
      await mkdir(incomingDir, { recursive: true });
      await writeFile(
        join(incomingDir, "design-review-contract-findings.json"),
        EMPTY_JSON_ARRAY,
      );
      return true;

    case "design_review_conceptual":
      await mkdir(incomingDir, { recursive: true });
      await writeFile(
        join(incomingDir, "design-review-conceptual-findings.json"),
        EMPTY_JSON_ARRAY,
      );
      return true;

    case "edge_reasoning_dispatch":
      await mkdir(incomingDir, { recursive: true });
      await writeFile(step.artifact_paths.edge_reasoning_results, EMPTY_JSON_ARRAY);
      return true;

    default:
      return false;
  }
}

/**
 * Drive `next-step` past every headless host pause and return the first step
 * whose kind is terminal for this walk.
 *
 * Throws descriptively on an unrecognised kind rather than returning a
 * mismatched step, and throws when the pause budget is exhausted.
 */
export async function walkStepsUntilTerminal(
  options: StepWalkOptions,
): Promise<any> {
  const { root, transport, terminalKinds, label } = options;
  const incomingDir = join(root, ".audit-tools/audit", "incoming");
  const maxPauses = options.maxPauses ?? MAX_HOST_PAUSES;

  for (let i = 0; i < maxPauses; i++) {
    const step = await transport();

    if (terminalKinds.has(step.step_kind)) {
      return step;
    }

    await options.observePause?.(step);

    if (await answerHostPause(step, incomingDir)) {
      continue;
    }

    throw new Error(
      `${label}: unexpected step kind '${step.step_kind}' (iteration ${i})`,
    );
  }

  throw new Error(`${label}: next-step did not reach a terminal step`);
}
