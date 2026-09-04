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
