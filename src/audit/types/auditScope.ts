/**
 * Phase 3 — `--since` delta scope.
 *
 * `scope.json` records how the audit was scoped for a given run: a full audit
 * (the default), or a delta audit measured against a git ref. In delta mode the
 * orchestrator audits only the changed files (`seed_files`) and their nearest
 * graph neighbours (`expanded_files`); every other auditable file inherits its
 * prior completion or is excluded from this run. The artifact is a deterministic
 * function of the inputs (the ref, the changed files, the graph) so the same
 * inputs always yield the same scope, and it is recorded honestly in the report
 * header and the run log. It sits upstream of `coverage_matrix.json` in the
 * staleness DAG.
 */

import { z } from "zod";

export const AuditScopeBudgetSchema = z
  .object({
    /**
     * Upper bound on the number of in-scope files (seeds + expanded). Seeds are
     * always retained; expansion stops once this cap is reached.
     */
    max_files: z.number().int().min(1),
  })
  .strict();
export type AuditScopeBudget = z.infer<typeof AuditScopeBudgetSchema>;

export const AuditScopeManifestSchema = z
  .object({
    /**
     * `full` audits every auditable file; `delta` scopes to a changed
     * neighbourhood; `budget` dispatches only the top-K review packets under a
     * `max_packets` cap and defers the rest.
     */
    mode: z.enum(["full", "delta", "budget"]),
    /** Git ref/SHA the delta was measured against; `null` in full mode. */
    since: z.string().nullable(),
    /**
     * Changed auditable files (relative to `since`) that exist in the repo
     * manifest. Empty in full mode. Sorted for determinism.
     */
    seed_files: z.array(z.string()),
    /**
     * Auditable files pulled in by deterministic priority-frontier expansion over
     * the dependency graph (graph neighbours of the seeds). Sorted for determinism.
     */
    expanded_files: z.array(z.string()),
    /** The budget applied during expansion. */
    budget: AuditScopeBudgetSchema,
    /**
     * Human-readable note when the scope was truncated by the budget, or when a
     * requested `--since` could not be honoured and the run fell back to full.
     */
    dropped_note: z.string().optional(),
    /**
     * When `mode === 'budget'`: the number of review packets that were NOT
     * dispatched due to the `max_packets` cap. Present only in budget mode.
     */
    deferred_packet_count: z.number().int().min(0).optional(),
    /**
     * When `mode === 'budget'`: the task_ids skipped due to the budget cap.
     * Present only in budget mode.
     */
    deferred_task_ids: z.array(z.string()).optional(),
  })
  .strict();
export type AuditScopeManifest = z.infer<typeof AuditScopeManifestSchema>;
