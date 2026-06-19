import type { ArtifactBundle } from "../io/artifacts.js";
import type { ExecutorRunResult } from "./executorResult.js";
import type { IntentCheckpoint, FileDispositionStatus } from "audit-tools/shared";
import type { Lens } from "../types.js";
import { resolveAuditScope } from "./scope.js";
import { isAuditExcludedStatus } from "../extractors/disposition.js";
import {
  isBuildOutput,
  isVendorPath,
  isGeneratedPath,
  isGeneratedTestArtifactPath,
  normalizeExtractorPath,
} from "../extractors/pathPatterns.js";
import { isMandatoryLens } from "./lensSelection.js";
import { unresolvedConstraintClauses } from "./intentInterpreter.js";
import { LENSES } from "audit-tools/shared";

/**
 * A row in the excluded_summary that represents a collapsed directory.
 * Present when all files under a directory prefix share the same status+reason.
 */
export interface AggregatedExcludedRow {
  prefix: string;
  file_count: number;
  status: string;
  reason: string;
}

/**
 * A row in the excluded_summary that represents an individual "oddball" file —
 * a file that is excluded while its sibling files in the same directory are
 * included (or have a different status/reason than the directory majority).
 */
export interface IndividualExcludedRow {
  path: string;
  status: string;
  reason: string;
}

/** Union type discriminated by presence of `prefix` vs `path`. */
export type ExcludedSummaryRow = AggregatedExcludedRow | IndividualExcludedRow;

export interface DispositionOverrideProposal {
  path: string;
  proposed_status: FileDispositionStatus;
  reason: string;
}

/**
 * A single row in the canonical lens proposition table (dogfood note 1). Every
 * canonical lens gets exactly one disposition; the host's invisible LLM review
 * may flip a disposition or append rows for non-canonical (custom) lenses it
 * decides would help — those appear in the same table, undistinguished from
 * canonical rows. Dispositions are exactly three: there is no "available".
 */
export type LensDisposition =
  | "mandatory"
  | "recommend_include"
  | "recommend_exclude";

export interface LensProposition {
  /** Canonical lens name OR an LLM-authored custom lens name. */
  lens: string;
  disposition: LensDisposition;
  reason: string;
}

/**
 * Deterministic pre-digest of the audit scope, shown to the host in the
 * `confirm_intent` step and used to seed the headless auto-complete checkpoint.
 * Everything here is computed deterministically from the intake artifacts; the
 * host uses it to confirm the discovered scope and add any exclusions the
 * disposition pass missed (the scope-pollution case).
 */
export interface ScopePreDigest {
  mode: "full" | "delta";
  since: string | null;
  files_in_scope: number;
  /** Top-level directories of in-scope files, with file counts (desc). */
  scope_dirs: Array<{ dir: string; files: number }>;
  /**
   * Collapsed excluded-scope summary. Directories where all files share the
   * same status+reason are emitted as a single aggregate row; individual
   * "oddball" files are emitted as individual rows.
   */
  excluded_summary: ExcludedSummaryRow[];
  /**
   * Suspicious inclusions: files whose path matches build-output, vendor, or
   * generated patterns but whose disposition status is `included`. These are
   * heuristic misses that the host may want to override.
   */
  disposition_override_proposals: DispositionOverrideProposal[];
  /**
   * Canonical lens proposition table (dogfood note 1) — ONE disposition per
   * canonical lens, in registry order, derived deterministically from codebase
   * character (language distribution, test presence, network surface, config
   * files). Mandatory lenses always carry the `mandatory` disposition. The host
   * reviews/adjusts these (and may add custom rows) invisibly before showing the
   * user the final table.
   */
  lens_propositions: LensProposition[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the collapsed excluded-scope summary from the full excluded file list.
 *
 * Algorithm:
 *  1. Group excluded files by top-level prefix.
 *  2. For each prefix group, check if ALL files in the group share the same
 *     status+reason. If so, emit one aggregate row.
 *  3. If not all files in the group agree, emit individual rows only for the
 *     files whose status+reason differs from the majority in that prefix (the
 *     "oddballs"). Files matching the majority are still collapsed into an
 *     aggregate row.
 */
function buildExcludedSummary(
  excluded: Array<{ path: string; status: string; reason?: string }>,
): ExcludedSummaryRow[] {
  // Group by top-level prefix
  const byPrefix = new Map<string, Array<{ path: string; status: string; reason: string }>>();
  for (const file of excluded) {
    const prefix = file.path.split(/[\\/]/)[0] || ".";
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix)!.push({ path: file.path, status: file.status, reason: file.reason ?? "" });
  }

  const rows: ExcludedSummaryRow[] = [];
  for (const [prefix, files] of byPrefix) {
    if (files.length === 1) {
      // Single file — emit as individual row
      rows.push({ path: files[0].path, status: files[0].status, reason: files[0].reason });
      continue;
    }

    // Count (status+reason) combinations to find majority
    const keyCount = new Map<string, number>();
    for (const f of files) {
      const key = `${f.status}|${f.reason}`;
      keyCount.set(key, (keyCount.get(key) ?? 0) + 1);
    }
    const majorityEntry = [...keyCount.entries()].sort((a, b) => b[1] - a[1])[0];
    const [majorityKey, majorityCount] = majorityEntry;
    const [majorityStatus, majorityReason] = majorityKey.split("|") as [string, string];

    const oddballs = files.filter((f) => `${f.status}|${f.reason}` !== majorityKey);

    if (majorityCount > 1) {
      // Emit aggregate row for the majority
      rows.push({
        prefix,
        file_count: majorityCount,
        status: majorityStatus,
        reason: majorityReason,
      });
      // Emit oddball rows individually (files that differ from the majority)
      for (const f of oddballs) {
        rows.push({ path: f.path, status: f.status, reason: f.reason });
      }
    } else {
      // COR-2e048b54: majorityCount === 1 means every file has a unique
      // status+reason combination. Emit ALL files individually — the original
      // code emitted only the oddballs and silently dropped the "majority" file.
      for (const f of files) {
        rows.push({ path: f.path, status: f.status, reason: f.reason });
      }
    }
  }

  return rows;
}

/**
 * Scan included files for suspicious inclusions (build-output, vendor, or
 * generated patterns) and emit override proposals.
 */
function buildDispositionOverrideProposals(
  dispositionFiles: Array<{ path: string; status: string }>,
): DispositionOverrideProposal[] {
  const proposals: DispositionOverrideProposal[] = [];
  for (const file of dispositionFiles) {
    if (file.status !== "included") continue;
    const norm = normalizeExtractorPath(file.path);
    if (isBuildOutput(norm)) {
      proposals.push({ path: file.path, proposed_status: "generated", reason: "path matches build-output pattern (dist/build)" });
    } else if (isVendorPath(norm)) {
      proposals.push({ path: file.path, proposed_status: "vendor", reason: "path matches vendor pattern" });
    } else if (isGeneratedPath(norm)) {
      proposals.push({ path: file.path, proposed_status: "generated", reason: "path matches generated-file pattern" });
    } else if (isGeneratedTestArtifactPath(norm)) {
      proposals.push({ path: file.path, proposed_status: "generated", reason: "path matches generated test-artifact pattern" });
    }
  }
  return proposals;
}

/**
 * Derive the canonical lens proposition table from codebase character (dogfood
 * note 1). Emits exactly ONE disposition per canonical lens, in registry order:
 * mandatory lenses always `mandatory`; the rest `recommend_include` or
 * `recommend_exclude` from deterministic heuristics (network surface, test
 * units, config files, module spread). This is the deterministic first pass; the
 * host's invisible LLM review confirms/adjusts dispositions and may append
 * custom-lens rows before the final table is shown to the user.
 */
function buildLensPropositions(
  unitManifest: { units: Array<{ kind?: string; required_lenses?: string[] }> } | undefined,
  inScopePaths: string[],
  dispositionFiles: Array<{ path: string; status: string }>,
): LensProposition[] {
  const units = unitManifest?.units ?? [];

  // Network-surface signal (kind contains interface/api/http, or path heuristics).
  const hasNetworkSurface = units.some((u) => {
    const kind = (u.kind ?? "").toLowerCase();
    return kind.includes("interface") || kind.includes("api") || kind.includes("http") || kind.includes("network");
  }) || inScopePaths.some((p) => {
    const norm = normalizeExtractorPath(p);
    return norm.includes("/api/") || norm.includes("/routes/") || norm.includes("/controllers/");
  });

  // Test-unit signal.
  const hasTestUnits = units.some((u) => {
    const kind = (u.kind ?? "").toLowerCase();
    return kind.includes("test") || kind.includes("spec");
  }) || inScopePaths.some((p) => {
    const norm = normalizeExtractorPath(p);
    return norm.includes("/test/") || norm.includes("/tests/") || norm.includes("/spec/") || norm.includes(".test.") || norm.includes(".spec.");
  });

  // Config/deployment signal.
  const hasConfigFiles = inScopePaths.some((p) => {
    const norm = normalizeExtractorPath(p);
    const base = norm.split("/").at(-1) ?? "";
    return base.endsWith(".yaml") || base.endsWith(".yml") || base.endsWith(".env") ||
      base.endsWith(".config.js") || base.endsWith(".config.ts") ||
      base.startsWith(".env") || base === "config.json" || base === "settings.json";
  }) || dispositionFiles.some((f) => {
    const norm = normalizeExtractorPath(f.path);
    const base = norm.split("/").at(-1) ?? "";
    return base.endsWith(".yaml") || base.endsWith(".yml");
  });

  // Structural-complexity signal: code spread across more than one top-level dir.
  const topDirs = new Set(
    inScopePaths.map((p) => normalizeExtractorPath(p).split("/")[0] || "."),
  );
  const isMultiModule = topDirs.size > 1;

  const include = (lens: string, reason: string): LensProposition => ({
    lens,
    disposition: "recommend_include",
    reason,
  });
  const exclude = (lens: string, reason: string): LensProposition => ({
    lens,
    disposition: "recommend_exclude",
    reason,
  });

  const propositions: LensProposition[] = [];
  for (const lens of LENSES as readonly Lens[]) {
    if (isMandatoryLens(lens)) {
      propositions.push({ lens, disposition: "mandatory", reason: "always audited" });
      continue;
    }
    switch (lens) {
      case "architecture":
        propositions.push(
          hasNetworkSurface || isMultiModule
            ? include(lens, "network-surface units and/or multi-module structure")
            : exclude(lens, "single small module; limited structural surface"),
        );
        break;
      case "tests":
        propositions.push(
          hasTestUnits
            ? include(lens, "test units present")
            : exclude(lens, "no test units detected"),
        );
        break;
      case "config_deployment":
        propositions.push(
          hasConfigFiles
            ? include(lens, "config/deployment files detected")
            : exclude(lens, "no config/deployment files detected"),
        );
        break;
      case "operability":
        propositions.push(
          hasNetworkSurface
            ? include(lens, "network-surface units present")
            : exclude(lens, "no network-surface units detected"),
        );
        break;
      case "performance":
        propositions.push(
          exclude(lens, "no hot-path / perf-sensitive units detected"),
        );
        break;
      case "observability":
        propositions.push(
          exclude(lens, "no logging/metrics surface detected in scope"),
        );
        break;
      case "maintainability":
        propositions.push(
          exclude(lens, "broadly applicable but low signal-to-noise; include on request"),
        );
        break;
      default:
        // Any future canonical lens defaults to recommend_include.
        propositions.push(include(lens, "applies to this codebase"));
    }
  }

  return propositions;
}

export function computeScopePreDigest(
  bundle: ArtifactBundle,
  root: string,
  since?: string,
): ScopePreDigest {
  const scope = resolveAuditScope({ root, since, bundle });
  const dispositionFiles = bundle.file_disposition?.files ?? [];

  const auditable = dispositionFiles.filter(
    (file) => !isAuditExcludedStatus(file.status),
  );
  const excluded = dispositionFiles.filter((file) =>
    isAuditExcludedStatus(file.status),
  );

  let inScopePaths: string[];
  if (scope.mode === "delta") {
    inScopePaths = [...scope.seed_files, ...scope.expanded_files];
  } else if (auditable.length > 0) {
    inScopePaths = auditable.map((file) => file.path);
  } else {
    inScopePaths = bundle.repo_manifest?.files.map((file) => file.path) ?? [];
  }

  const dirCounts = new Map<string, number>();
  for (const path of inScopePaths) {
    const top = path.split(/[\\/]/)[0] || ".";
    dirCounts.set(top, (dirCounts.get(top) ?? 0) + 1);
  }
  const scope_dirs = [...dirCounts.entries()]
    .map(([dir, files]) => ({ dir, files }))
    .sort((a, b) => b.files - a.files);

  const excluded_summary = buildExcludedSummary(excluded);
  const disposition_override_proposals = buildDispositionOverrideProposals(dispositionFiles);
  const lens_propositions = buildLensPropositions(bundle.unit_manifest, inScopePaths, dispositionFiles);

  return {
    mode: scope.mode === "delta" ? "delta" : "full",
    since: scope.since ?? null,
    files_in_scope: inScopePaths.length,
    scope_dirs,
    excluded_summary,
    disposition_override_proposals,
    lens_propositions,
  };
}

/**
 * Headless deterministic fallback for the intent checkpoint — the analog of
 * `runDesignReviewAutoComplete`. The conversation-first flow instead emits a
 * `confirm_intent` host step (see `cli/confirmIntentStep.ts`); this runs only
 * when `advanceAudit` is driven headlessly with no host to confirm scope,
 * writing a default full-scope checkpoint so the pipeline can proceed.
 *
 * Idempotent over an existing checkpoint: an already-written checkpoint (e.g. a
 * host-confirmed one with `free_form_intent`) is preserved, not clobbered. If
 * such a checkpoint carries unencodable clauses, headless mode cannot pose a
 * blocking question, so each unresolved clause is recorded as a
 * `constraint_clauses` entry with an explicit headless default answer — the
 * directive is escalated into the contract (never silently dropped) and the
 * `intent_checkpoint_current` gate converges instead of looping.
 */
export function runIntentCheckpointAutoComplete(
  bundle: ArtifactBundle,
  root: string,
  since?: string,
): ExecutorRunResult {
  const existing = bundle.intent_checkpoint;
  if (existing) {
    const unresolved = unresolvedConstraintClauses(existing);
    if (unresolved.length === 0) {
      // Already current — nothing to do; do not overwrite a confirmed checkpoint.
      return {
        updated: bundle,
        artifacts_written: [],
        progress_summary:
          "Scope/intent checkpoint already present and current; left unchanged (headless).",
      };
    }
    // Record each unresolved unencodable clause as a host-answered constraint so
    // it survives into planning rather than being silently dropped headlessly.
    const recorded = unresolved.map((c) => ({
      text: c.text,
      checkpoint_question: c.checkpoint_question,
      host_answer:
        "Headless auto-resolution: no host available to clarify; clause recorded as a planning constraint with no extra weighting.",
    }));
    const intent: IntentCheckpoint = {
      ...existing,
      constraint_clauses: [...(existing.constraint_clauses ?? []), ...recorded],
    };
    return {
      updated: { ...bundle, intent_checkpoint: intent },
      artifacts_written: ["intent_checkpoint.json"],
      progress_summary: `Auto-resolved ${recorded.length} unencodable free_form_intent clause(s) into recorded constraints (headless); none dropped.`,
    };
  }

  const preDigest = computeScopePreDigest(bundle, root, since);
  const intent: IntentCheckpoint = {
    schema_version: "intent-checkpoint/v1",
    confirmed_at: new Date().toISOString(),
    confirmed_by: "host",
    scope_summary: `Root: ${root}${preDigest.since ? ` (since ${preDigest.since})` : ""}, files in scope: ${preDigest.files_in_scope}`,
    intent_summary:
      preDigest.mode === "delta"
        ? `delta-audit since ${preDigest.since}`
        : "full-audit",
  };

  return {
    updated: { ...bundle, intent_checkpoint: intent },
    artifacts_written: ["intent_checkpoint.json"],
    progress_summary: `Auto-completed scope/intent checkpoint (headless): ${intent.scope_summary} (${intent.intent_summary}).`,
  };
}
