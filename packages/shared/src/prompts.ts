/**
 * Host instruction emitted in dispatch step prompts: control-plane orchestrator
 * commands (`next-step`, `merge-and-ingest`, the per-phase merge commands) must be
 * run directly, never piped through a token-compression wrapper that would corrupt
 * their JSON / prompt-contract output. Single-sourced so audit-code and
 * remediate-code stay in parity on the command-class wrap policy.
 */
export const DO_NOT_TOKEN_WRAP_NOTE =
  "Run these backend commands directly — do not pipe them through a " +
  "token-compression wrapper (e.g. `opentoken wrap`); their JSON / " +
  "prompt-contract output is parsed verbatim and wrapping corrupts it.";

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
