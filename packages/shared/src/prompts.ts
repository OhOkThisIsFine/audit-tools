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
