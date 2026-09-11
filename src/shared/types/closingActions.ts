// <!-- comment-symbol-exempt: names deliberately-retired symbols; this block records that history -->
/**
 * The closing-action vocabulary shared by the remediation plan
 * (`candidate_closing_actions`), the closing plan (`action`), and the intent
 * checkpoint the host confirms (`closing_action`). It lives in `src/shared`
 * because the checkpoint schema is shared by both orchestrators and the base
 * layer never imports an orchestrator (dependency-cruiser
 * `shared-imports-no-orchestrator`).
 *
 * Order is canonical: candidate lists are emitted in this order so a rendered
 * choice never churns.
 *
 * ── THE LANDING ACTION IS ABSENT BY DECISION, NOT BY OMISSION ───────────────
 *
 * `merge-to-base` — one revertable `--no-ff` merge into the launch branch —
 * was deleted in `467b1e8f` with the rest of the execution substrate. The
 * forward-tracks entry that asked for it back ("Isolated-branch landing gap")
 * conditioned its return on a premise this module can now check: that a
 * remediation run is dispatched ON its own `remediation/<runId>` branch.
 *
 * **That premise is gone, so the decision is that isolated-branch dispatch is
 * NOT returning.** The function that switched the primary checkout onto a run
 * branch (`ensureRemediationBranchCheckedOut`) was deleted in the same commit
 * and exists nowhere in `src/`; nothing in this package creates a branch. The
 * host owns worktree and branch selection entirely — the implement dispatch
 * carries per-work-item worktree bindings and the host decides what they are —
 * exactly as it owns every other execution choice (see CLAUDE.md, "audit-tools
 * does NOT route"). Re-adding a landing action would put a git-history decision
 * back inside the tool to solve a problem the tool no longer creates.
 *
 * What is NOT withdrawn: a branch named `remediation/*` may still exist, because
 * a HOST may create one. `.claude/hooks/commit-gate.mjs` keeps its
 * branch-strand refusal for that case — a docs-only staged set on such a HEAD is
 * main-bound prose that lost its branch. Its rationale comment still names the
 * deleted function; the refusal itself is about the HEAD's name, not the caller,
 * so it stands.
 */
export const CLOSING_ACTIONS = [
  "commit",
  "push",
  "open-pr",
  "publish",
  "tag",
  "none",
  "custom",
] as const;

export type ClosingAction = (typeof CLOSING_ACTIONS)[number];

/** True when `value` is one of the closing actions the tool knows. */
export function isClosingAction(value: unknown): value is ClosingAction {
  return typeof value === "string" && (CLOSING_ACTIONS as readonly string[]).includes(value);
}
