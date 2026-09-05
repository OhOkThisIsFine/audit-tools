/**
 * The ONE declared list of checks result ingestion performs before it accepts a
 * host result — the source `docs/audit-pkg/contracts.md`'s check block is
 * RENDERED from (`scripts/shared/generate-ingestion-checks.mjs`).
 *
 * WHY THIS EXISTS. The check set used to be written out by hand in three docs
 * (the contracts page, the operator guide, the concurrent-runs design), and the
 * three lists disagreed: only one named the result path, only one the strict
 * result schema, only one the workload version. Nothing reconciled them, so
 * whoever added a check added it to whichever doc they had open. Owner decision
 * 2026-09-05 (nightly item l1-4): derive the list from the validator itself.
 *
 * The registry is LOAD-BEARING, not a fourth prose copy: every refusal a draw's
 * ingestion emits cites one of these ids (`refuse(check, detail)`,
 * `invalidResult(check, reason)`, a `check:` on an issue), the id type below
 * refuses an unregistered citation at compile time, and
 * `tests/shared/ingestion-checks-drift.test.ts` extracts the citations
 * structurally and pins them against the declared `draws` in both directions —
 * a row nothing cites is dead, and a citation nothing declares is an
 * undocumented check.
 *
 * `cited_by` says WHERE the citation lives. The shared submission scan
 * (`submissionScan.ts`) owns the path, read and duplicate checks for both
 * draws; everything else is cited from the draw's own host-handoff module. Row
 * order is the render order: envelope and binding first, then per-draw content
 * checks, then corroboration, then the ledger.
 *
 * Keep every field a plain literal: the generator reads this file as TEXT
 * through the TypeScript compiler API (no build, no import), and refuses a
 * value it cannot read rather than rendering without it.
 */

export const INGESTION_DRAWS = [
  { id: "audit", source: "src/audit/cli/dispatch/hostHandoff.ts" },
  { id: "remediate", source: "src/remediate/steps/dispatch/hostHandoff.ts" },
] as const;

export type IngestionDraw = (typeof INGESTION_DRAWS)[number]["id"];

/** Where the shared-cited checks live. */
export const INGESTION_SHARED_SOURCE = "src/shared/submission/submissionScan.ts";

export interface IngestionCheck {
  readonly id: string;
  /** One sentence, host-facing: what must hold for the result to be accepted. */
  readonly verifies: string;
  readonly draws: readonly IngestionDraw[];
  /** `shared`: cited from the shared scan; `draw`: cited from each listed draw's module. */
  readonly cited_by: "shared" | "draw";
}

export const INGESTION_CHECKS = [
  {
    id: "result_path",
    verifies:
      "The submission is read only from the tool-derived bound path (`<run dir>/<sha256(work item id)>.json`) inside the run's artifacts directory; a result written anywhere else is never consulted.",
    draws: ["audit", "remediate"],
    cited_by: "shared",
  },
  {
    id: "result_json",
    verifies: "The bytes at the bound path parse as JSON.",
    draws: ["audit", "remediate"],
    cited_by: "shared",
  },
  {
    id: "result_envelope",
    verifies:
      "The top-level key set is exactly the draw's result contract and `contract_version` is the version the workload was issued under.",
    draws: ["audit", "remediate"],
    cited_by: "draw",
  },
  {
    id: "identity_binding",
    verifies:
      "`run_id` is the run that emitted the workload, `work_item_id` is the work item the result was read for, and `prompt_sha256` is the digest of the prompt that work item was issued with — an answer to another run, item or a stale prompt is refused.",
    draws: ["audit", "remediate"],
    cited_by: "draw",
  },
  {
    id: "workload_binding",
    verifies:
      "The persisted workload, result map and task bindings still derive from this run (versions, bound paths, prompt digests, scopes); a result cannot be accepted against a binding the tool cannot re-derive.",
    draws: ["audit", "remediate"],
    cited_by: "draw",
  },
  {
    id: "file_coverage",
    verifies:
      "`file_coverage` names exactly the assigned files, each fully reviewed, with `total_lines` equal to the line count bound at dispatch.",
    draws: ["audit"],
    cited_by: "draw",
  },
  {
    id: "findings_contract",
    verifies: "Every finding satisfies the audit finding contract (lens, ids, evidence shape).",
    draws: ["audit"],
    cited_by: "draw",
  },
  {
    id: "result_schema",
    verifies:
      "The bound result converts to the persisted `AuditResult` schema (`schemas/audit_result.schema.json`).",
    draws: ["audit"],
    cited_by: "draw",
  },
  {
    id: "result_validation",
    verifies:
      "The per-result content rules hold before acceptance (evidence present, line spans inside the file, line counts matching disk); warnings ride an advisory channel and never refuse.",
    draws: ["audit"],
    cited_by: "draw",
  },
  {
    id: "outcome_shape",
    verifies:
      "A decision result's `outcome` carries exactly the fields its status requires (`resolved_no_change` evidence, `blocked` failure reason, `needs_clarification` question).",
    draws: ["remediate"],
    cited_by: "draw",
  },
  {
    id: "write_scope",
    verifies:
      "`changed_files` is non-empty, sorted, unique and normalized, lies within the prompt-bound `allowed_files`, and equals the files the landed commit actually changed.",
    draws: ["remediate"],
    cited_by: "draw",
  },
  {
    id: "commit_evidence",
    verifies:
      "`commit_evidence` binds the workload baseline to a distinct landed commit; both exist, the baseline is an ancestor of the landed commit (waived only under a genuinely orphaned baseline in recovery), and the landed commit is reachable from HEAD.",
    draws: ["remediate"],
    cited_by: "draw",
  },
  {
    id: "test_evidence",
    verifies:
      "`test_evidence` carries exactly one passed entry per required test echoing the bound command, and the tool's own mechanical rerun of those tests passes.",
    draws: ["remediate"],
    cited_by: "draw",
  },
  {
    id: "obligation_evidence",
    verifies:
      "`obligation_evidence` cites non-empty evidence for every prompt-bound obligation, none twice, and none the work item does not bind.",
    draws: ["remediate"],
    cited_by: "draw",
  },
  {
    id: "worktree_evidence",
    verifies:
      "`worktree_evidence` binds the workload baseline and the same changed-file list, and no landed file overlaps dirt that pre-dated the run.",
    draws: ["remediate"],
    cited_by: "draw",
  },
  {
    id: "landing_attestation",
    verifies: "`acceptance` and `merge` both attest a completed landing.",
    draws: ["remediate"],
    cited_by: "draw",
  },
  {
    id: "no_change_corroboration",
    verifies:
      "A `resolved_no_change` claim is corroborated against git and the persisted write-scope binding; attestation-only acceptance is refused.",
    draws: ["remediate"],
    cited_by: "draw",
  },
  {
    id: "duplicate_result",
    verifies:
      "`result_id` has not already been accepted this run: a byte-identical replay is a no-op, a different body under an accepted id is refused.",
    draws: ["audit", "remediate"],
    cited_by: "shared",
  },
] as const satisfies readonly IngestionCheck[];

export type IngestionCheckId = (typeof INGESTION_CHECKS)[number]["id"];

/** The ids a draw declares, in registry order — draw-cited and shared-cited alike. */
export function ingestionCheckIdsFor(draw: IngestionDraw): readonly IngestionCheckId[] {
  return INGESTION_CHECKS.filter((check) =>
    (check.draws as readonly IngestionDraw[]).includes(draw),
  ).map((check) => check.id);
}

/** The ids whose citation lives in the given place, in registry order. */
export function ingestionCheckIdsCitedBy(
  citedBy: IngestionCheck["cited_by"],
  draw?: IngestionDraw,
): readonly IngestionCheckId[] {
  return INGESTION_CHECKS.filter(
    (check) =>
      check.cited_by === citedBy &&
      (draw === undefined || (check.draws as readonly IngestionDraw[]).includes(draw)),
  ).map((check) => check.id);
}
