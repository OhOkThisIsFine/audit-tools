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
 * Host instruction emitted in dispatch step prompts: each subagent should
 * receive its `prompt_path` file path and follow it directly. Loading worker
 * prompts into the main conversation inflates context for no benefit — the
 * worker executes in its own context and reports results back through its
 * assigned result path. Single-sourced so audit-code and remediate-code stay
 * in parity on the dispatch handoff policy.
 */
export const DISPATCH_PROMPT_HANDOFF_NOTE =
  "For each subagent, pass its `prompt_path` to the agent tool directly — " +
  "do not read the worker prompt file into this conversation. " +
  "Each worker executes in its own context and writes only to its assigned result path.";

/**
 * Adversarial-review independence mandate — LANE-CLASS-conditional, never
 * capability-conditional (design resolution 2, gate-resolved 2026-08-05; origin
 * CP-BLOCK-IMPL-mandatory-independent-critic). The mandate keys on what the lane
 * IS (an adversarial review of work an agent authored), not on what the host
 * reports it can do: one capability-neutral text carries both the mandate and
 * the explicitly-degraded no-subagent fallback, so the same artifact renders on
 * every host and an author self-review is never licensed at full strength.
 * Single-sourced so audit-code and remediate-code stay in parity.
 *
 * `depth: "light"` is remediate's proportionate low-risk floor (T1 slice 3) — a
 * lightweight inline self-check, never skipped; it is a DEPTH policy, orthogonal
 * to capability, and stays.
 */
export function renderIndependentReviewMandate(
  depth?: "light" | "full",
): string {
  if (depth === "light") {
    return `\n## Adversarial Review — light inline self-check

The assessed risk for this change is low, so this adversarial phase runs as a **lightweight inline self-check** rather than a full independent review. Do a quick, honest adversarial pass yourself: scan the design for obvious gaps, contradictions, or unhandled cases and record any real concern you find. Keep it proportionate — this is a floor (never skipped), not an exhaustive independent counterexample search. If your self-check surfaces a genuine concern, treat that as evidence the change is harder than assessed and escalate to a full independent review.
`;
  }
  return `\n## Independent Review — MANDATORY

This is an adversarial review lane: its value comes from a reviewer who is **not** the author of the work under review. It MUST be executed by an agent that did not author that work and does not see the author's reasoning — an author grading their own work systematically misses the gaps this lane exists to catch. Dispatch it to a fresh, independent sub-agent. If — and only if — no sub-agent facility exists on this host, execute it inline as the explicitly-degraded fallback: adopt a fresh adversarial stance, set aside the author's reasoning, and attack the work as a hostile outside reviewer would. Inline self-review is the degraded fallback, never the intended path.
`;
}

/**
 * Capability-neutral fan-out execution instruction (design resolution 2,
 * 2026-08-05): every fan-out step materializes its lane prompt files and hands
 * the host ONE instruction that reads identically in every environment —
 * subagents when a facility exists, sequential self-execution when not. Only
 * the concurrency hint is capability-sensitive. Lane prompt files are
 * ADVANCE-FREE (no continue-command inside them); the step prompt owns the
 * advance. Single-sourced so audit-code and remediate-code stay in parity.
 */
export function renderFanoutExecutionLines(params: {
  /** Human label + prompt path (+ optional explicit result path) per lane. */
  lanes: { label: string; promptPath: string; resultPath?: string }[];
  /** Host-declared max concurrent subagents, when known. */
  concurrencyHint?: number | null;
}): string[] {
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
  return [
    `Execute the ${n} lane prompt file${plural} below: dispatch one subagent per file if a subagent facility exists, else read and follow each file sequentially yourself. The same files and result paths apply either way.`,
    "",
    ...concurrency,
    ...params.lanes.map(
      (lane) =>
        `- **${lane.label}**: ${lane.promptPath}${lane.resultPath ? ` → write results to ${lane.resultPath}` : ""}`,
    ),
    "",
    "When dispatching a lane to a subagent, pass its prompt path verbatim as the instruction — do not read the lane file into this conversation. When executing a lane yourself, read and follow its file directly. Lane prompt files carry no continue-command; return here once the lane results exist.",
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
