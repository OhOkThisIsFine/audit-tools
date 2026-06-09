import type { ScopePreDigest } from "../orchestrator/intentCheckpointExecutor.js";

/**
 * Render the host-facing prompt for the `confirm_intent` step. Shows the
 * deterministically-computed scope picture and asks the host to write (or
 * refine) `intent_checkpoint.json` — confirming scope/intent and optionally
 * adding exclusions the disposition pass missed (the scope-pollution case),
 * must-not-touch globs, and free-form audit intent that is threaded into
 * worker prompts.
 */
export function renderConfirmIntentPrompt(
  preDigest: ScopePreDigest,
  opts: { intentCheckpointPath: string; continueCommand: string },
): string {
  const dirLines =
    preDigest.scope_dirs
      .slice(0, 20)
      .map((d) => `- \`${d.dir}\` — ${d.files} file(s)`)
      .join("\n") || "_(none)_";
  const excludedLines =
    preDigest.auto_excluded.length > 0
      ? preDigest.auto_excluded
          .map((e) => `- \`${e.path}\` (${e.status})`)
          .join("\n")
      : "_(none)_";

  return [
    "# Confirm Audit Scope and Intent",
    "",
    "Before planning, confirm what this audit should cover. The scope below was",
    "discovered deterministically from intake. Your job is to **confirm it** and,",
    "if needed, **prune scope pollution** the automatic disposition missed (build",
    "output, vendored code, fixtures, generated files, scratch directories).",
    "",
    `**Mode:** ${preDigest.mode}${preDigest.since ? ` (since ${preDigest.since})` : ""}`,
    `**Files in scope:** ${preDigest.files_in_scope}`,
    "",
    "## In-scope top-level directories",
    "",
    dirLines,
    "",
    "## Already excluded (deterministic disposition)",
    "",
    excludedLines,
    "",
    "## What to do",
    "",
    "Write `intent_checkpoint.json` to:",
    "",
    `  ${opts.intentCheckpointPath}`,
    "",
    "Use this shape (only `scope_summary` and `intent_summary` are required; add",
    "the optional fields to constrain the run):",
    "",
    "```json",
    "{",
    '  "schema_version": "intent-checkpoint/v1",',
    '  "confirmed_at": "<ISO-8601 timestamp>",',
    '  "confirmed_by": "host",',
    '  "scope_summary": "<what is in scope>",',
    '  "intent_summary": "<the goal, e.g. full-audit / security-focused>",',
    '  "free_form_intent": "<optional: what to focus on; threaded into worker prompts>",',
    '  "excluded_scope": [{ "path": "<path or prefix>", "reason": "<why>" }],',
    '  "must_not_touch": ["<glob>"]',
    "}",
    "```",
    "",
    "- `excluded_scope` entries are pruned from planning so excluded files never",
    "  become audit tasks, and they are listed in the final report under",
    '  "Excluded / Out-of-Scope".',
    "- Leave the optional fields out to audit the full discovered scope.",
    "",
    `Then run: ${opts.continueCommand}`,
    "",
  ].join("\n");
}
