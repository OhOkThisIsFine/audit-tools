import type { ScopePreDigest, AggregatedExcludedRow } from "../orchestrator/intentCheckpointExecutor.js";

function isAggregatedRow(row: { prefix?: string; path?: string }): row is AggregatedExcludedRow {
  return "prefix" in row && row.prefix !== undefined;
}

/**
 * Render the host-facing prompt for the `confirm_intent` step. Shows the
 * deterministically-computed scope picture and asks the host to write (or
 * refine) `intent_checkpoint.json` — confirming scope/intent and optionally
 * adding exclusions the disposition pass missed (the scope-pollution case),
 * must-not-touch globs, free-form audit intent, disposition overrides for
 * suspicious inclusions, and lens selection.
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

  // Render collapsed excluded-scope summary
  const excludedLines =
    preDigest.excluded_summary.length > 0
      ? preDigest.excluded_summary
          .map((row) =>
            isAggregatedRow(row)
              ? `- \`${row.prefix}/\` — ${row.file_count} file(s) (${row.status}${row.reason ? `: ${row.reason}` : ""})`
              : `- \`${row.path}\` (${row.status}${row.reason ? `: ${row.reason}` : ""})`,
          )
          .join("\n")
      : "_(none)_";

  // Render disposition override proposals
  const overrideProposalLines =
    preDigest.disposition_override_proposals.length > 0
      ? preDigest.disposition_override_proposals
          .map((p) => `- \`${p.path}\` → \`${p.proposed_status}\` (${p.reason})`)
          .join("\n")
      : "_(none)_";

  // Render lens proposals
  const lensProposalLines =
    preDigest.lens_proposals.length > 0
      ? preDigest.lens_proposals
          .map((p) => `- **${p.lens}**: ${p.action === "exclude" ? "suggest excluding" : "include"} — ${p.reason}`)
          .join("\n")
      : "_(none)_";

  const hasOverrideProposals = preDigest.disposition_override_proposals.length > 0;
  const hasLensProposals = preDigest.lens_proposals.length > 0;

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
    ...(hasOverrideProposals
      ? [
          "## Suspicious inclusions (proposed overrides)",
          "",
          "The following files match build-output, vendor, or generated patterns but",
          "are currently included. Accept proposals by adding them to `disposition_overrides`.",
          "",
          overrideProposalLines,
          "",
        ]
      : []),
    ...(hasLensProposals
      ? [
          "## Lens proposals",
          "",
          "Based on codebase character. Mandatory lenses (security, correctness,",
          "reliability, data_integrity) cannot be excluded regardless of selection.",
          "",
          lensProposalLines,
          "",
        ]
      : []),
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
    '  "must_not_touch": ["<glob>"],',
    '  "disposition_overrides": [{ "path": "<path>", "status": "<generated|vendor|excluded|...>", "reason": "<why>" }],',
    '  "lens_selection": { "include": ["<lens>"], "exclude": ["<lens>"] }',
    "}",
    "```",
    "",
    "- `excluded_scope` entries are pruned from planning so excluded files never",
    "  become audit tasks, and they are listed in the final report under",
    '  "Excluded / Out-of-Scope".',
    "- `disposition_overrides` patches the file disposition before coverage",
    "  initialization — overridden files never enter coverage at all.",
    "- `lens_selection.exclude` removes non-mandatory lenses from task generation.",
    "  Mandatory lenses (security, correctness, reliability, data_integrity) are",
    "  always included regardless of this field.",
    "- Leave the optional fields out to audit the full discovered scope.",
    "",
    `Then run: ${opts.continueCommand}`,
    "",
  ].join("\n");
}
