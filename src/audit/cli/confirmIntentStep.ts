import { LENSES } from "audit-tools/shared";
import { MANDATORY_LENSES } from "../orchestrator/lensSelection.js";
import {
  CONCEPTUAL_PERSPECTIVES,
  DEFAULT_CONCEPTUAL_PERSPECTIVES,
} from "../orchestrator/designReviewPrompt.js";
import type { ScopePreDigest, AggregatedExcludedRow } from "../orchestrator/intentCheckpointExecutor.js";

function isAggregatedRow(row: { prefix?: string; path?: string }): row is AggregatedExcludedRow {
  return "prefix" in row && row.prefix !== undefined;
}

// One-line meaning per canonical lens, shown in the confirm-intent catalog so the
// user can choose deliberately instead of guessing from the bare lens name.
const LENS_DESCRIPTIONS: Record<string, string> = {
  correctness: "Logic errors, wrong results, broken invariants, mishandled edge cases.",
  architecture: "Structure, boundaries, coupling, dependency direction, layering.",
  maintainability: "Readability, duplication, complexity, naming, dead code, change cost.",
  security: "Injection, authn/authz, secret handling, unsafe input, privilege boundaries.",
  reliability: "Failure modes, error handling, retries, resource leaks, recovery.",
  performance: "Hot paths, algorithmic complexity, allocation, avoidable I/O and work.",
  data_integrity: "Persistence correctness, schema/serialization drift, races, lost or duplicated state.",
  tests: "Coverage gaps, brittle or flaky tests, missing negative cases, weak assertions.",
  operability: "Deploy / runbooks, health, config surface, diagnosability in production.",
  config_deployment: "Build, packaging, CI/CD, release, environment and config wiring.",
  observability: "Logging, metrics, tracing, and signal quality for debugging incidents.",
};

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
  opts: {
    intentCheckpointPath: string;
    continueCommand: string;
    /**
     * Blocking checkpoint questions raised by unencodable `free_form_intent`
     * clauses that the host has not yet answered. When non-empty, the audit
     * cannot proceed past planning until each is answered via
     * `constraint_clauses` — so the prompt leads with them. Computed
     * deterministically from the single shared intent interpreter.
     */
    unresolvedConstraintClauses?: Array<{ text: string; checkpoint_question: string }>;
  },
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

  // Render the canonical lens proposition table (note 1) — one glyph-labelled
  // row per lens, in registry order. Mandatory rows always show ● mandatory.
  const dispositionCell: Record<string, string> = {
    mandatory: "● mandatory",
    recommend_include: "✓ recommend include",
    recommend_exclude: "✗ recommend exclude",
  };
  const lensTableRows = preDigest.lens_propositions
    .map(
      (p) =>
        `| ${p.lens.padEnd(18)} | ${(dispositionCell[p.disposition] ?? p.disposition).padEnd(21)} | ${p.reason} |`,
    )
    .join("\n");

  const hasOverrideProposals = preDigest.disposition_override_proposals.length > 0;
  // Derive the mandatory-lens prose from the authoritative MANDATORY_LENSES
  // constant so the rendered guidance can never drift from the enforced set
  // (MNT-df8c4551).
  const mandatoryLensList = MANDATORY_LENSES.join(", ");
  const unresolvedClauses = opts.unresolvedConstraintClauses ?? [];
  const hasBlockingClauses = unresolvedClauses.length > 0;

  return [
    "# Confirm Audit Scope and Intent",
    "",
    ...(hasBlockingClauses
      ? [
          "## ⚠ Blocking: unencodable intent clauses",
          "",
          "Your `free_form_intent` contains directive(s) that could NOT be encoded",
          "as a lens weight, priority signal, or scope emphasis. They will be",
          "**silently lost** unless you resolve them here — the audit will not",
          "proceed past planning until each is answered. For every question below,",
          "add a `constraint_clauses` entry (with the exact `checkpoint_question`",
          "text and a concrete `host_answer`) to `intent_checkpoint.json`, or remove",
          "the clause from `free_form_intent`:",
          "",
          ...unresolvedClauses.map(
            (c, i) =>
              `${i + 1}. Clause: \`${c.text}\`\n   Question: ${c.checkpoint_question}`,
          ),
          "",
        ]
      : []),
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
    "## Lens proposition",
    "",
    "Deterministic first pass over the codebase. ● = mandatory (always audited,",
    "never re-confirmed), ✓ = recommend include, ✗ = recommend exclude.",
    "",
    "| Lens               | Disposition           | Why |",
    "|--------------------|-----------------------|-----|",
    lensTableRows,
    "",
    "### Review and finalize this table (do this BEFORE asking the user)",
    "",
    "Using your own judgment — research the code if it helps — review every",
    "disposition above. You MAY:",
    "- flip any `✓ recommend include` / `✗ recommend exclude` row when the codebase",
    "  warrants it;",
    "- append rows for non-canonical (custom) lenses you decide would help this",
    "  audit — give each a disposition and a reason; they sit in the same table,",
    "  undistinguished from canonical lenses.",
    `You may NOT change the ● mandatory rows — Mandatory lenses (${mandatoryLensList})`,
    "are always audited. This review is **invisible to the user** — they see only your final,",
    "merged table, never a \"deterministic said X, I changed it to Y\" diff.",
    "",
    "Canonical lens meanings (for your review; you need not show these to the user):",
    "",
    ...LENSES.map((lens) => {
      const desc = LENS_DESCRIPTIONS[lens];
      return `- **${lens}**${desc ? ` — ${desc}` : ""}`;
    }),
    "",
    "## Conceptual design-review depth",
    "",
    "The audit runs a conceptual design-review pass (philosophy / alternatives /",
    "better directions, distinct from the contract pass). Choose its depth:",
    "",
    "- **shallow** *(default)* — a single conceptual reviewer. Faster, cheaper.",
    `- **deep** — fan out ${DEFAULT_CONCEPTUAL_PERSPECTIVES} independent reviewers, each with a maximally`,
    "  dissimilar value system, then compile via an independent judge. Surfaces more,",
    "  costs more. The default perspectives are:",
    ...CONCEPTUAL_PERSPECTIVES.slice(0, DEFAULT_CONCEPTUAL_PERSPECTIVES).map(
      (p) => `    - **${p.name}** — ${p.lens}`,
    ),
    "  Set `design_review.perspectives` to widen or narrow the fan-out.",
    "",
    "This records *how much* review to do, not which model runs it — model choice",
    "is resolved at dispatch against whatever models the provider has then.",
    "",
    "## Ask the user (single round)",
    "",
    "After you have finalized the lens table, confirm with the user in ONE round,",
    "using whatever native question mechanism your host provides (do not assume any",
    "specific tool). Ask:",
    "",
    "1. Present the scope summary above.",
    "2. Show the user ONLY your final lens table. Ask which **optional** lenses to",
    "   **layer on top** of the always-on mandatory set (and whether to flip any",
    "   recommend-include / recommend-exclude). Do NOT re-confirm or even mention the",
    "   mandatory lenses — they are always on. The user may add **any number** of",
    "   additional custom lenses (freeform names).",
    "3. Ask the conceptual design-review depth (default **shallow**).",
    "4. Wait for the user to confirm before proceeding.",
    "",
    "Record the result in `lens_selection`: optional + custom lenses the user wants",
    "go in `include`; recommend-include lenses the user drops go in `exclude`.",
    "(Mandatory lenses are always audited and need not be listed.)",
    "",
    "## What to do",
    "",
    "After the user confirms, write `intent_checkpoint.json` to:",
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
    '  "free_form_intent": "<optional: what to focus on; interpreted into lens/priority signals at planning, never threaded verbatim into worker prompts>",',
    '  "constraint_clauses": [{ "text": "<unencodable clause>", "checkpoint_question": "<the question above>", "host_answer": "<how to apply it>" }],',
    '  "excluded_scope": [{ "path": "<path or prefix>", "reason": "<why>" }],',
    '  "must_not_touch": ["<glob>"],',
    '  "disposition_overrides": [{ "path": "<path>", "status": "<generated|vendor|excluded|...>", "reason": "<why>" }],',
    '  "lens_selection": { "include": ["<lens>"], "exclude": ["<lens>"] },',
    '  "design_review": { "conceptual_depth": "shallow", "perspectives": 5 }',
    "}",
    "```",
    "",
    "- `constraint_clauses` resolves the blocking questions above: each unencodable",
    "  `free_form_intent` clause needs one entry with a concrete `host_answer`.",
    "  Until every blocking question is answered (or its clause removed from",
    "  `free_form_intent`), this confirm-intent step re-fires and planning is held.",
    "- `excluded_scope` entries are pruned from planning so excluded files never",
    "  become audit tasks, and they are listed in the final report under",
    '  "Excluded / Out-of-Scope".',
    "- `disposition_overrides` patches the file disposition before coverage",
    "  initialization — overridden files never enter coverage at all.",
    "- `lens_selection.include` and `lens_selection.exclude` accept both canonical",
    "  and custom lens names. Custom lenses generate tasks using the unit's files",
    "  with context derived from the lens name and `free_form_intent`.",
    "- `design_review.conceptual_depth` is `shallow` (default) or `deep`; on `deep`,",
    "  `perspectives` bounds the parallel-reviewer fan-out. Omit for shallow.",
    "- Leave the optional fields out to audit the full discovered scope.",
    "",
    `Then run: ${opts.continueCommand}`,
    "",
  ].join("\n");
}
