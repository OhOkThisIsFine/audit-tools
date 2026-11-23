// sites-pinned: tests/audit/intent-checkpoint.test.ts
import type { ArtifactBundle } from "../io/artifacts.js";
import type { AuditScopeManifest } from "../types/auditScope.js";
import type { FileDispositionStatus } from "audit-tools/shared";
import type { DesignAssessment } from "../types/designAssessment.js";
import type { DocsDigestEntry } from "../types/docsDigest.js";
import { resolveAuditScope } from "./scope.js";
import { hasReviewableOperation } from "./questionPlanning.js";
import { detectMisScopeSmells } from "./intakeExecutors.js";
import {
  isAuditExcludedStatus,
  VCS_IGNORED_REASON,
  UNTRACKED_REASON,
} from "../extractors/disposition.js";
import type {
  FileDispositionWithScopeRules,
  ScopeRuleSummary,
} from "../extractors/disposition.js";
import {
  isBuildOutput,
  isVendorPath,
  isGeneratedPath,
  isGeneratedTestArtifactPath,
  normalizeExtractorPath,
} from "../extractors/pathPatterns.js";
import { compareCodeUnits } from "audit-tools/shared";
import { BUILT_IN_REVIEW_LENSES } from "../../shared/types/reviewQuestion.js";

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
 * `confirm_intent` step.
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
   * files). Every row is a recommendation; the operator owns the selection. The host
   * reviews/adjusts these (and may add custom rows) invisibly before showing the
   * user the final table.
   */
  lens_propositions: LensProposition[];
  /**
   * Render-ready docs digest (change 3): the repo's STATED purpose, extracted
   * deterministically from the doc universe (`docs_digest.json`). Empty when the
   * digest artifact is absent or the repo
   * has no prose docs — the render omits the section then.
   */
  docs_digest: DocsDigestEntry[];
  /**
   * Signals that the resolved root may be the wrong audit target (docsN-5) —
   * recomputed deterministically from the root, the same input intake used.
   * Intake only folds a COUNT into its progress summary, so the confirm-intent
   * pause is the first place a host both sees the warning text and can act on
   * it. Empty on a well-targeted root — the render omits the section then.
   */
  mis_scope_smells: string[];
  /**
   * Outcome of each of the disposition's two SCOPE RULES (gitignore /
   * untracked), including the ones that were SKIPPED — a clean fallback (git
   * absent, not a work tree) or a guard (`root_ignored` / `root_untracked` /
   * `share_exceeded`).
   *
   * This is the operator-facing half of the summary `buildFileDisposition`
   * already persists on `file_disposition.json`: the per-file entry list shows
   * WHICH files were excluded but can never express "a rule declined to run",
   * so the files a skipped rule WOULD have excluded sit in scope with nothing
   * saying so. Ordered by the fixed rule sequence (gitignore, then untracked),
   * never by object key order. Empty when the digest has no scope-rule records
   * (a heuristics-only disposition built without a root) — the render omits the
   * section then, so absence reads as "no rules to report" rather than as a
   * silent claim that both ran clean.
   */
  scope_rules?: ScopeRuleOutcome[];
}

/** One scope rule's outcome, flattened for the pre-digest render. */
export interface ScopeRuleOutcome {
  /** Which rule this row reports. */
  rule: "vcs_ignore" | "untracked";
  /** True when the rule's exclusions were applied to the disposition. */
  applied: boolean;
  /** Candidate files the rule matched (the count it would have excluded). */
  matched_count: number;
  /** Why the rule was skipped, as the disposition recorded it. */
  skipped_reason?: string;
  /** Which guard branch fired, when a guard (not a clean fallback) skipped it. */
  guard_branch?: ScopeRuleSummary["guard_branch"];
  /**
   * Files the disposition actually holds at this rule's reason — the rule's
   * DELIVERED effect, as opposed to `matched_count`, which is the raw match
   * count and includes files an earlier, higher-precedence exclusion claimed.
   * Both numbers are shown because they disagree exactly when the rules
   * interact, and only the pair lets an operator read that correctly.
   */
  excluded_count: number;
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
    // Count (status+reason) combinations to find the majority; each tally keeps
    // its first file as the representative of that status and reason.
    const tally = new Map<string, { count: number; status: string; reason: string }>();
    for (const f of files) {
      const key = `${f.status}|${f.reason}`;
      const entry = tally.get(key);
      if (entry) entry.count += 1;
      else tally.set(key, { count: 1, status: f.status, reason: f.reason });
    }
    const [majorityKey, majority] = [...tally.entries()].sort((a, b) => b[1].count - a[1].count)[0];

    const oddballs = files.filter((f) => `${f.status}|${f.reason}` !== majorityKey);

    if (majority.count > 1) {
      // Emit aggregate row for the majority
      rows.push({
        prefix,
        file_count: majority.count,
        status: majority.status,
        reason: majority.reason,
      });
      // Emit oddball rows individually (files that differ from the majority)
      for (const f of oddballs) {
        rows.push({ path: f.path, status: f.status, reason: f.reason });
      }
    } else {
      // A majority count of 1 means every file has a unique status+reason
      // combination (a one-file group included). Emit ALL files individually —
      // emitting only the oddballs would silently drop the "majority" file.
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
 * Count lens-tagged design-assessment findings per lens, across every finding
 * group (base structural + the review passes when present on a re-run). A
 * lens-tagged finding is direct evidence that lens applies to this codebase —
 * the evidence overlay in `buildLensPropositions` consumes these counts.
 * Absence is deliberately NO-SIGNAL: an empty or auto-completed assessment
 * means "unreviewed / nothing detected", never "the lens does not apply".
 *
 * The two kinds are counted apart because they are different evidence: the
 * base `findings` group is the deterministic structural pass (heuristic leads
 * such as complexity hotspots and duplication, present before any review ran),
 * while the contract/conceptual groups are review output.
 */
interface LensEvidence {
  /** Structural-pass lead count per category. */
  structural: Map<string, number>;
  structuralTotal: number;
  review: number;
}

function collectLensEvidence(
  assessment: DesignAssessment | undefined,
): Map<string, LensEvidence> {
  const evidence = new Map<string, LensEvidence>();
  if (!assessment) return evidence;
  const entryFor = (lens: string): LensEvidence => {
    let entry = evidence.get(lens);
    if (!entry) {
      entry = { structural: new Map(), structuralTotal: 0, review: 0 };
      evidence.set(lens, entry);
    }
    return entry;
  };
  for (const finding of assessment.findings ?? []) {
    if (!finding.lens) continue;
    const entry = entryFor(finding.lens);
    entry.structural.set(finding.category, (entry.structural.get(finding.category) ?? 0) + 1);
    entry.structuralTotal += 1;
  }
  for (const group of [assessment.contract_findings, assessment.conceptual_findings]) {
    for (const finding of group ?? []) {
      if (!finding.lens) continue;
      entryFor(finding.lens).review += 1;
    }
  }
  return evidence;
}

/** Operator-facing "Why" for an evidence-flipped lens: states exactly what was counted. */
function describeLensEvidence(lens: string, evidence: LensEvidence): string {
  const parts: string[] = [];
  if (evidence.structuralTotal > 0) {
    const byCategory = [...evidence.structural.entries()]
      .sort(([a, an], [b, bn]) => bn - an || compareCodeUnits(a, b))
      .map(([category, count]) => `${category} ${count}`)
      .join(", ");
    parts.push(
      `structural design assessment (deterministic, pre-review) flagged ${evidence.structuralTotal} ` +
        `${lens}-tagged lead(s): ${byCategory}`,
    );
  }
  if (evidence.review > 0) {
    parts.push(`design review carries ${evidence.review} ${lens}-tagged finding(s)`);
  }
  return parts.join("; ");
}

/**
 * Derive the canonical lens proposition table from codebase character (dogfood
 * note 1). Emits exactly ONE disposition per canonical lens, in registry order:
 * `recommend_include` or `recommend_exclude` from intake evidence (network surface, test
 * units, config files, module spread), overlaid with design-assessment evidence
 * (change 3: a lens-tagged structural finding flips that lens's heuristic
 * exclude to an include — evidence only ever widens, absence never narrows).
 * This is the deterministic first pass; the host's invisible LLM review
 * confirms/adjusts dispositions and may append custom-lens rows before the
 * final table is shown to the user.
 */
function buildLensPropositions(
  bundle: ArtifactBundle,
  inScopePaths: string[],
  scope: AuditScopeManifest,
): LensProposition[] {
  const { unit_manifest: unitManifest, surface_manifest: surfaces, design_assessment: designAssessment } = bundle;
  const inScope = new Set(inScopePaths);
  const units = (unitManifest?.units ?? []).filter((unit) => unit.files.some((path) => inScope.has(path)));
  const observedSurfaces = (surfaces?.surfaces ?? []).filter(({ entrypoint }) => inScope.has(entrypoint));
  // Each kind lower-cased and each in-scope path normalized ONCE; every signal
  // below tests these.
  const unitKinds = units.map((u) => (u.kind ?? "").toLowerCase());
  const normalizedPaths = inScopePaths.map(normalizeExtractorPath);
  const kindHasAny = (...tokens: string[]) =>
    unitKinds.some((kind) => tokens.some((token) => kind.includes(token)));
  const pathHasAny = (...tokens: string[]) =>
    normalizedPaths.some((path) => tokens.some((token) => path.includes(token)));
  const basename = (path: string) => path.split("/").at(-1) ?? "";

  // Network-surface signal (kind contains interface/api/http, or path heuristics).
  const hasNetworkSurface = observedSurfaces.some(({ exposure }) => exposure === "network") ||
    kindHasAny("interface", "api", "http", "network") ||
    pathHasAny("/api/", "/routes/", "/controllers/");

  // Test-unit signal.
  const hasTestUnits =
    kindHasAny("test", "spec") ||
    pathHasAny("/test/", "/tests/", "/spec/", ".test.", ".spec.");

  // Config/deployment signal.
  const hasConfigFiles = normalizedPaths.some((path) => {
    const base = basename(path);
    return base === "package.json" || base === "pyproject.toml" || base === "cargo.toml" ||
      base.startsWith("runtime-config.") || base.startsWith("config.") ||
      base.endsWith(".yaml") || base.endsWith(".yml") || base.endsWith(".env") ||
      base.endsWith(".config.js") || base.endsWith(".config.ts") ||
      base.startsWith(".env") || base === "config.json" || base === "settings.json";
  });

  // Logging/metrics-surface signal (kind contains logging/metrics/telemetry, or path heuristics).
  const hasLoggingMetricsSurface =
    kindHasAny("logging", "metrics", "telemetry", "observability", "tracing") ||
    pathHasAny("/logging/", "/metrics/", "/tracing/", "/observability/", "logger.", "metric");

  // Structural-complexity signal: code spread across more than one top-level dir.
  const topDirs = new Set(normalizedPaths.map((path) => path.split("/")[0] || "."));
  const isMultiModule = topDirs.size > 1 || units.length > 1;
  const hasBackground = observedSurfaces.some(({ kind }) => kind === "background") ||
    kindHasAny("background", "worker", "queue", "schedule");
  const hasOperatorSurface = observedSurfaces.length > 0 || hasNetworkSurface || hasBackground ||
    kindHasAny("cli", "ops") || pathHasAny("/cli/", "/ops/", "/logging/", "logger.");

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
  for (const lens of BUILT_IN_REVIEW_LENSES) {
    switch (lens) {
      case "behavior":
        propositions.push(inScopePaths.length > 0
          ? include(lens, "in-scope source may implement supported operations and state invariants")
          : exclude(lens, "no in-scope implementation candidate detected"));
        break;
      case "security":
        propositions.push(hasNetworkSurface || pathHasAny("/auth/", "/keys/", "/permissions/")
          ? include(lens, "external caller or authority-boundary signals detected")
          : exclude(lens, "no authority-boundary signal detected yet; include for a known trust boundary"));
        break;
      case "architecture":
        propositions.push(
          hasNetworkSurface || isMultiModule
            ? include(lens, "cross-component design or trust-boundary scenario detected")
            : exclude(lens, "no structural signal yet; include for a charter scenario or local maintainability concern"),
        );
        break;
      case "tests":
        if (hasTestUnits) propositions.push(include(lens, "test units present"));
        else if (hasReviewableOperation(bundle, scope)) {
          propositions.push(include(lens, "in-scope operation whose regression coverage can be reviewed"));
        } else {
          propositions.push(exclude(lens, "no test units or reviewable operations detected"));
        }
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
          hasOperatorSurface || hasLoggingMetricsSurface
            ? include(lens, "operator entry point, background transition, or diagnostic signal detected")
            : exclude(lens, "no operator decision surface detected"),
        );
        break;
      case "performance":
        propositions.push(
          hasBackground
            ? include(lens, "repeating workload candidate detected")
            : exclude(lens, "no representative repeating workload detected yet; include for a known costly operation"),
        );
        break;
    }
  }

  // Design-assessment evidence overlay: a lens-tagged finding is direct
  // evidence the lens applies, so it flips a heuristic exclude to an include.
  // One direction only — evidence widens, absence is no-signal (see
  // collectLensEvidence) — so an include is never demoted here.
  const lensEvidence = collectLensEvidence(designAssessment);
  return propositions.map((proposition) => {
    if (proposition.disposition !== "recommend_exclude") return proposition;
    const evidence = lensEvidence.get(proposition.lens);
    if (!evidence) return proposition;
    return {
      lens: proposition.lens,
      disposition: "recommend_include" as const,
      reason: describeLensEvidence(proposition.lens, evidence),
    };
  });
}

const NO_RULE_RECORD_REASON =
  "no rule record on file_disposition.json (heuristics-only disposition)";

/**
 * Flatten the disposition's two scope-rule outcomes into render rows, in the
 * FIXED rule sequence the disposition applies them (gitignore, then untracked)
 * — never `Object.entries` order, which would let a key rename reorder the
 * operator-facing prompt. A rule with no recorded summary (heuristics-only
 * disposition, or an older artifact written before the summaries existed) is
 * reported as SKIPPED with the explicit reason rather than omitted: a missing
 * record is exactly the "we could not tell you which rule ran" case this
 * section exists to surface, and silence would read as "the rule ran clean".
 */
function buildScopeRuleOutcomes(
  disposition: FileDispositionWithScopeRules | undefined,
): ScopeRuleOutcome[] {
  if (!disposition) return [];
  const files = disposition.files;
  const countAt = (reason: string) =>
    files.filter((file) => file.reason === reason).length;
  const summaries: Array<
    [ScopeRuleOutcome["rule"], string, ScopeRuleSummary | undefined]
  > = [
    ["vcs_ignore", VCS_IGNORED_REASON, disposition.vcs_ignore],
    ["untracked", UNTRACKED_REASON, disposition.untracked],
  ];
  return summaries.map(([rule, reason, summary]) => ({
    rule,
    applied: summary?.applied ?? false,
    matched_count: summary?.ignored_count ?? 0,
    excluded_count: countAt(reason),
    ...(summary === undefined
      ? { skipped_reason: NO_RULE_RECORD_REASON }
      : summary.skipped_reason
        ? { skipped_reason: summary.skipped_reason }
        : {}),
    ...(summary?.guard_branch ? { guard_branch: summary.guard_branch } : {}),
  }));
}

export async function computeScopePreDigest(
  bundle: ArtifactBundle,
  root: string,
  since?: string,
): Promise<ScopePreDigest> {
  const scope = await resolveAuditScope({ root, since, bundle });
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
  const lens_propositions = buildLensPropositions(bundle, inScopePaths, scope);

  return {
    mode: scope.mode,
    since: scope.since,
    files_in_scope: inScopePaths.length,
    scope_dirs,
    excluded_summary,
    disposition_override_proposals,
    lens_propositions,
    docs_digest: bundle.docs_digest?.docs ?? [],
    mis_scope_smells: await detectMisScopeSmells(root),
    scope_rules: buildScopeRuleOutcomes(bundle.file_disposition),
  };
}
