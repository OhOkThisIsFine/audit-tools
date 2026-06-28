/**
 * Parts of a cacheable prompt: a static shared prefix (identical across all
 * agents in a wave) and a per-agent payload (varies per invocation).
 *
 * Anthropic's prompt-caching mechanism requires the cacheable portion to appear
 * at the start of the prompt and remain byte-identical across calls. Only the
 * trailing per-agent payload should vary.
 */
export interface CacheablePromptParts {
  /** Static context shared across all agents in a wave (design spec, codebase
   *  summary, repo conventions, etc.). Must be identical across calls for
   *  caching to apply. */
  sharedPrefix: string;
  /** Per-invocation task-specific payload that varies between agents. */
  perAgentPayload: string;
}

/**
 * Assemble a prompt that places the cacheable shared prefix first, followed by
 * the per-agent payload. This ordering is required for Anthropic's prompt-caching
 * mechanism: the static portion must appear at the start and remain identical
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
