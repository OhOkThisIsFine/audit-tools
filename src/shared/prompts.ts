// sites-pinned: tests/remediate/contract-pipeline-prompts.test.ts
//   The independence mandate's wording (an independent CONTEXT, never a
//   mechanism) is pinned by the contract-pipeline prompts suite, which renders
//   it through every adversarial role and asserts the mechanism words absent.
/**
 * Parts of a cacheable prompt: a static shared prefix (identical across all
 * agents in a wave) and a per-agent payload (varies per invocation).
 *
 * Keeping the shared portion at the start and byte-identical across calls lets
 * hosts reuse that context efficiently. Only the trailing task payload varies.
 */
export interface CacheablePromptParts {
  /** Static context shared across all agents in a wave (design spec, codebase
   *  summary, repo conventions, etc.). Must be identical across calls for
   *  reuse to apply. */
  sharedPrefix: string;
  /** Per-invocation task-specific payload that varies between agents. */
  perAgentPayload: string;
}

/**
 * Assemble a prompt that places the cacheable shared prefix first, followed by
 * the per-agent payload. The static portion remains at the start and identical
 * across all agents in a wave; only the trailing payload varies.
 *
 * - If `sharedPrefix` is non-empty, the result is `sharedPrefix + "\n\n" + perAgentPayload`.
 * - If `sharedPrefix` is empty, the result is just `perAgentPayload` (no leading separator).
 *
 * Use for design-review prompts, auditor-worker review packets, and
 * seam-negotiation prompts rather than free-form string concatenation.
 */
export function buildCacheablePrompt(parts: CacheablePromptParts): string {
  const { sharedPrefix, perAgentPayload } = parts;
  if (sharedPrefix.length === 0) {
    return perAgentPayload;
  }
  return `${sharedPrefix}\n\n${perAgentPayload}`;
}

/**
 * Host instruction emitted in dispatch step prompts: each worker should
 * receive its `prompt_path` file path and follow it directly. Loading worker
 * prompts into the main conversation inflates context for no benefit — the
 * worker executes in its own context and reports results back through its
 * assigned result path. Single-sourced so audit-code and remediate-code stay
 * in parity on the dispatch handoff policy.
 */
export const DISPATCH_PROMPT_HANDOFF_NOTE =
  "For each worker, pass its `prompt_path` to the execution context directly — " +
  "do not read the worker prompt file into this conversation. " +
  "Each worker executes in its own context and writes only to its assigned result path.";

/**
 * The single shared statement of a lane's independence NEED, keyed by review
 * mode. One body of prose for both draws (one core, two draws): the audit
 * dispatch and the remediate adversarial mandate state the SAME requirement with
 * the SAME words, so the two cannot drift. The mode is the CLOSED vocabulary in
 * `types/stepContract.ts` (`LaneReviewMode`); this renderer turns it into host
 * prose.
 *
 * The statement names the NEED (an independent context that did not author the
 * work, and cannot see the author's reasoning), never a MECHANISM: "dispatch to a
 * fresh subagent" presumes the host has in-process subagents, which are not
 * universal (packet 10 / O28 / O49). Independence is a property of the CONTEXT,
 * not of any execution tool.
 *
 * Three modes, three outcomes — and the ordering is the whole point:
 *   - `independence_required` — the lane's value IS independence, so an
 *     unavailable independent context PAUSES the step. It never degrades into a
 *     self-review. (A self-conducted "review" of one's own work is not this lane
 *     at a lower strength; it is a different lane with no value.)
 *   - `degraded_permitted` — the lane wants independence but an inline degraded
 *     fallback is EXPLICITLY accepted (a proportionate low-risk floor that must
 *     never be skipped). The degraded fallback must RECORD itself in the output,
 *     so the degradation is visible rather than assumed.
 *   - `ordinary` — no independence need; execute or dispatch however the host
 *     can.
 */
export function renderLaneReviewRequirement(
  declaration:
    | "ordinary"
    | "independence_required"
    | "degraded_permitted"
    | {
        lane?: string;
        mode: "ordinary" | "independence_required" | "degraded_permitted";
        reason?: string;
      },
): string {
  const mode = typeof declaration === "string" ? declaration : declaration.mode;
  if (mode === "independence_required") {
    return renderIndependentReviewMandate("independence_required");
  }
  if (mode === "degraded_permitted") {
    return renderIndependentReviewMandate("degraded_permitted");
  }
  return "";
}

/**
 * Adversarial-review independence mandate — LANE-CLASS-conditional, never
 * capability-conditional (design resolution 2, gate-resolved 2026-08-05; origin
 * CP-BLOCK-IMPL-mandatory-independent-critic). The mandate keys on what the lane
 * IS (an adversarial review of work an agent authored), not on what the host
 * reports it can do: one capability-neutral text carries both the mandate and
 * the explicitly-degraded no-independent-context fallback, so the same artifact
 * renders on every host and an author self-review is never licensed at full
 * strength. Single-sourced so audit-code and remediate-code stay in parity.
 *
 * ⚠ THE MANDATE STATES THE NEED, NEVER A MECHANISM. It used to say "dispatch it
 * to a fresh, independent sub-agent", which names one way to get independence
 * and presumes the host has it — in-process subagents are not universal, and a
 * host without them read an instruction it could not follow (the same defect the
 * contract-pipeline fan-out carried; see `module_contract_drafting`'s "what this
 * work needs" line in contractPipeline.ts). Independence is a property of the
 * CONTEXT, so that is what the text requires and the host owns the mechanism.
 *
 * For `independence_required`, the review PAUSES when an independent context is
 * unavailable; required independent review never accepts a self-review fallback.
 * For `degraded_permitted`, an explicitly degraded inline fallback is accepted
 * and must record itself in the output.
 */
export function renderIndependentReviewMandate(
  modeOrDepth?: "light" | "full" | "independence_required" | "degraded_permitted",
): string {
  if (modeOrDepth === "light") {
    return `\n## Adversarial Review — light inline self-check

The assessed risk for this change is low, so this adversarial phase runs as a **lightweight inline self-check** rather than a full independent review. Do a quick, honest adversarial pass yourself: scan the design for obvious gaps, contradictions, or unhandled cases and record any real concern you find. Keep it proportionate — this is a floor (never skipped), not an exhaustive independent counterexample search. If your self-check surfaces a genuine concern, treat that as evidence the change is harder than assessed and escalate to a full independent review.
`;
  }
  if (modeOrDepth === "degraded_permitted") {
    return `\n## Independent Review — degraded fallback permitted

This is an adversarial review lane: an independent context that did not author the work is preferred. If the host genuinely cannot produce one, execute it inline as the explicitly-degraded fallback — adopt a fresh adversarial stance, set aside the author's reasoning, and attack the work as a hostile outside reviewer would — and say in the output that the review was self-conducted, so the degraded independence is visible rather than assumed. Inline self-review is the degraded fallback, never the intended path.
`;
  }
  if (modeOrDepth === "independence_required") {
    return `\n## Independent Review — MANDATORY

This is an adversarial review lane: its value comes from a reviewer who is **not** the author of the work under review. **What this needs is an independent context** — a review produced without shared authorship of the work and without the author's reasoning in view. An author grading their own work systematically misses the gaps this lane exists to catch, and that failure is a property of sharing the authorship, not of any particular execution mechanism.

Produce the review from a context that did not author the work and cannot see the author's reasoning — the host chooses how that context is obtained. If no independent context is available, pause and report that this review could not be performed independently. Do not write a self-conducted result or advance: required independent review cannot fall back to self-review.
`;
  }
  return `\n## Independent Review — MANDATORY

This is an adversarial review lane: its value comes from a reviewer who is **not** the author of the work under review. **What this needs is an independent context** — a review produced without shared authorship of the work and without the author's reasoning in view. An author grading their own work systematically misses the gaps this lane exists to catch, and that failure is a property of sharing the authorship, not of any particular execution mechanism.

Produce the review from a context that did not author the work and cannot see the author's reasoning — the host chooses how that context is obtained. If the host genuinely cannot produce one, execute it inline as the explicitly-degraded fallback — adopt a fresh adversarial stance, set aside the author's reasoning, and attack the work as a hostile outside reviewer would — and say in the output that the review was self-conducted, so the degraded independence is visible rather than assumed. Inline self-review is the degraded fallback, never the intended path.
`;
}

/**
 * Capability-neutral fan-out execution instruction (design resolution 2,
 * 2026-08-05): every fan-out step materializes its lane prompt files and hands
 * the host ONE instruction that reads identically in every environment —
 * sequential self-execution is available unless the lane requires independence.
 * Only the concurrency hint is capability-sensitive. Lane prompt files are
 * ADVANCE-FREE (no continue-command inside them); the step prompt owns the
 * advance. Single-sourced so audit-code and remediate-code stay in parity.
 */
// sites-pinned: tests/shared/prompts.test.ts tests/audit/systemic-round-identity.test.ts
export function renderFanoutExecutionLines(params: {
  /**
   * Human label + prompt path (+ optional explicit result path) per lane. A
   * lane MAY carry its demand ranking; when it does, the ranking is rendered
   * with the lane so the host can size the dispatch without reading the lane
   * file first. Optional because this renderer is also used for lanes that are
   * not demand-ranked — a hand-written caller's list is not a lane spec.
   */
  lanes: {
    label: string;
    promptPath: string;
    resultPath?: string;
    demand?: { size: string; complexity: string; risk: string };
  }[];
  /** Host-declared max concurrent subagents, when known. */
  concurrencyHint?: number | null;
  /**
   * The lanes' review MODE (the closed `LaneReviewMode` vocabulary, shared with
   * remediation). Determines the fallback sentence: `ordinary` lanes may run
   * inline sequentially; `independence_required` lanes PAUSE when no independent
   * context exists (they never degrade to a self-review); `degraded_permitted`
   * lanes accept an explicitly degraded inline fallback that must say so in its
   * output. Defaults to `ordinary`.
   */
  reviewMode?: "ordinary" | "independence_required" | "degraded_permitted";
  /** @deprecated Prefer `reviewMode`; `true` maps to `independence_required`. */
  independenceRequired?: boolean;
}): string[] {
  const mode: "ordinary" | "independence_required" | "degraded_permitted" =
    params.reviewMode ??
    (params.independenceRequired ? "independence_required" : "ordinary");
  const n = params.lanes.length;
  // Defensive coherence: emitters gate on pending work before rendering, so a
  // zero-lane call is unreachable by construction today — but if a future path
  // reaches it, the text must state the truth instead of "Execute the 0 lane
  // prompt files below:".
  if (n === 0) {
    return [
      "Every lane's result already exists on disk — there is nothing to execute; run the continue command below.",
    ];
  }
  const plural = n === 1 ? "" : "s";
  const concurrency =
    params.concurrencyHint != null && n > 1
      ? [
          `Concurrency hint: run at most ${params.concurrencyHint} lane(s) at a time.`,
          "",
        ]
      : [];
  // The fallback sentence is keyed on the review mode, single-sourced so the
  // audit dispatch and the remediation mandate name the SAME requirement with
  // the SAME words. `independence_required` is the one that must never become a
  // self-review: an unavailable independent context PAUSES the step.
  const lead =
    mode === "independence_required"
      ? `Execute the ${n} lane prompt file${plural} below in an independent context that did not drive this audit, and that cannot see the author's reasoning. The host chooses how to obtain that context. If none is available, stop and report that this review could not be performed independently. Do not write a result or run the continue command in that case; this overrides the output and continuation instructions below. An unavailable review is not an empty findings result.`
      : mode === "degraded_permitted"
        ? `Execute the ${n} lane prompt file${plural} below — an independent context is preferred but not required for this lane. If one is available, use it; if none is, execute the lane inline as the explicitly-degraded fallback (adopt a fresh adversarial stance, set aside the author's reasoning) and say in the output that the review was self-conducted, so the degraded independence is visible rather than assumed.`
        : `Execute the ${n} lane prompt file${plural} below: execute each file in parallel if concurrent execution is supported, else read and follow each file sequentially yourself. The same files and result paths apply either way.`;
  return [
    lead,
    "",
    ...concurrency,
    ...(params.lanes.some((lane) => lane.demand !== undefined)
      ? [
          "Each lane states its demand (size / complexity / risk) — match the model you dispatch to it against that ranking. The tool names demand only; which backend or model satisfies it is your choice.",
          "",
        ]
      : []),
    ...params.lanes.map(
      (lane) =>
        `- **${lane.label}**: ${lane.promptPath}` +
        (lane.demand
          ? ` [demand: size=${lane.demand.size}, complexity=${lane.demand.complexity}, risk=${lane.demand.risk}]`
          : "") +
        (lane.resultPath ? ` → write results to ${lane.resultPath}` : ""),
    ),
    "",
    mode === "independence_required"
      ? "Pass each lane's prompt path verbatim to its independent executor. Lane prompt files carry no continue-command; return here once the independently produced lane results exist."
      : "When dispatching a lane to a separate worker, pass its prompt path verbatim as the instruction — do not read the lane file into this conversation. When executing a lane yourself, read and follow its file directly. Lane prompt files carry no continue-command; return here once the lane results exist.",
  ];
}

/**
 * Host instruction emitted in dispatch step prompts: any working files the
 * host improvises while driving the dispatch (batch lists, generated helper
 * scripts, notes) go into the run-scoped scratch directory, never the audited
 * repository's tree. Untracked scratch left at the repo root enters the next
 * audit's intake walk and findings end up citing the previous run's litter.
 * Single-sourced so audit-code and remediate-code stay in parity.
 */
export function renderHostScratchNote(scratchDirPath: string): string {
  return (
    "If you need any working files while driving this dispatch (batch lists, " +
    `helper scripts, notes), write them under \`${scratchDirPath}\` — ` +
    "never at the repository root or anywhere else in the repository's tree."
  );
}
