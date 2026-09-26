// sites-pinned: tests/shared/retired-args.test.ts
/**
 * Mechanical refusal of RETIRED backend-selection arguments.
 *
 * The routing/execution substrate that audit-tools once carried (provider,
 * model, routing, quota, backend window, launch configuration) was retired as
 * ONE architectural cut (owner directive 2026-08-09): the tool characterizes
 * work and the host makes every execution choice. Those choices were never
 * valid audit-tools CLI flags, but the loaders historically *asked the host to
 * avoid passing them* — a prose instruction the host could forget. This module
 * turns that instruction into a refusal at the command boundary, so an
 * unsupported argument fails loudly instead of being silently ignored (or of
 * depending on a host to refrain).
 *
 * The vocabulary is DECLARED DATA, kept deliberately narrow: only the
 * backend-selection axes the retirement removed. It must NOT grow to cover
 * ordinary or future workflow flags (`--root`, `--artifacts-dir`, `--input`,
 * `--since`, `--allow-auto-fix`, and the source-selection `--input` /
 * `--guidance-file` pair) — rejecting those would break the two orchestrators'
 * real surface.
 */

/** A single retired argument axis, with the flag spellings it may take. */
interface RetiredArg {
  /** Stable id; named in the refusal so a caller can see which axis fired. */
  id: string;
  /** The retired axis, rendered in the refusal. */
  label: string;
  /** Literal `--flag` spellings that select this retired axis. */
  flags: readonly string[];
}

/**
 * The retired backend-selection axes. One row per axis (not per spelling) so
 * the refusal names the axis, not a bare token.
 */
export const RETIRED_HOST_SELECTION_ARGS: readonly RetiredArg[] = [
  {
    id: "provider",
    label: "provider selection",
    flags: ["--provider", "--host-provider"],
  },
  {
    id: "model",
    label: "model selection",
    flags: ["--model", "--model-id"],
  },
  {
    id: "backend",
    label: "backend selection",
    flags: ["--backend"],
  },
  {
    id: "routing",
    label: "routing policy",
    flags: ["--routing", "--route"],
  },
  {
    id: "quota",
    label: "quota accounting",
    flags: ["--quota"],
  },
  {
    id: "window",
    label: "context-window / launch sizing",
    flags: [
      "--context-window",
      "--context-tokens",
      "--output-tokens",
      "--max-active-subagents",
      "--can-dispatch-subagents",
    ],
  },
  {
    id: "auditor",
    label: "auditor identity",
    flags: ["--auditor"],
  },
];

/**
 * Assert that `argv` does not request a retired backend-selection argument.
 *
 * Throws (loud, actionable) naming every offending axis — one refusal listing
 * all misses, not the first. Call once at each CLI's command-dispatch
 * chokepoint so every subcommand — including future ones — is covered without a
 * per-command call site, in the same shape as
 * {@link assertCliCommandAllowedFromCwd}.
 */
export function assertNoRetiredHostSelectionArgs(argv: readonly string[]): void {
  const seen = new Set<string>();
  for (const arg of argv) {
    for (const axis of RETIRED_HOST_SELECTION_ARGS) {
      if (axis.flags.includes(arg)) seen.add(axis.label);
    }
  }
  if (seen.size === 0) return;
  const labels = [...seen].sort().join(", ");
  throw new Error(
    `retired argument(s) rejected: ${labels}. ` +
      "audit-tools owns no provider, model, routing, quota, backend-window, or " +
      "launch configuration; those are host-owned execution choices and must " +
      "not be passed to audit-tools.",
  );
}
