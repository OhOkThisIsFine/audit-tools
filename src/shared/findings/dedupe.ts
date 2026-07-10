import type { Finding } from "../types/finding.js";
import { severityRank, confidenceRank } from "../types/lens.js";
import { findingIdentityKey } from "../findingIdentitySignature.js";
import { wordJaccard, filePathOverlap, primaryPath } from "../findingSimilarity.js";

/**
 * ONE shared finding-dedup core. There is no auditor-dedup vs remediator-dedup —
 * there is one skeleton (group-by-primary-path → pairwise cross-lens compare →
 * similarity gate → survivor selection → absorb), and each orchestrator DRAWS it
 * with its own POLICY. Audit draws it read-only for the report (mutate survivors
 * in place, grounding-precedence merge, cross-category merge allowed at a higher
 * threshold); remediate draws it for the auto-apply block machine (clone survivors,
 * hard category gate, exact-identity short-circuit, a mergeMap its blocks consume).
 * Single-sourcing the skeleton is what stops the two from silently drifting on the
 * grouping / thresholds / survivor rule; the divergences are the explicit named
 * policy knobs below, not forked code.
 */

/**
 * Consistent lens/category text normalization for BOTH draws (trim + lowercase).
 * Deliberate one-core convergence: audit already trimmed; remediate's former inline
 * copy lowercased WITHOUT trimming. Trimming is strictly safer for the hard category
 * gate — it can only collapse surrounding whitespace, never fuse two genuinely
 * different category NAMES, so a whitespace-typo can no longer bypass same-category
 * dedup. Kept as one normalization (not a policy knob) because the no-trim was an
 * accident, not a policy.
 */
function normalizeText(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/**
 * Merge two grounding verdicts by precedence: grounded > refuted > ungrounded >
 * absent (S7). Grounded-wins (a verified span/anchor on ANY pass upgrades the
 * survivor; an ungrounded/absent verdict never downgrades it). A refutation
 * outranks ungrounded/absent, so a finding refuted on any pass is quarantined
 * UNLESS another pass grounded it.
 */
export function mergeGrounding(
  existing: Finding["grounding"],
  incoming: Finding["grounding"],
): Finding["grounding"] {
  const rank = (g: Finding["grounding"]): number =>
    g?.status === "grounded" ? 3 : g?.status === "refuted" ? 2 : g?.status === "ungrounded" ? 1 : 0;
  const winner = rank(incoming) > rank(existing) ? incoming : existing;
  // Normalize a grounded winner to the bare verdict (grounded carries no reason).
  return winner?.status === "grounded" ? { status: "grounded" } : winner;
}

/**
 * Union `absorbed`'s affected_files into `survivor` (dedup by
 * path:line_start:line_end:symbol), optionally sorting by path then line. Shared by
 * the absorb mechanics AND audit's identity-key exact merge (`upsertFinding`).
 */
export function mergeAffectedFiles(survivor: Finding, absorbed: Finding, sort: boolean): void {
  const seen = new Set(
    survivor.affected_files.map(
      (f) => `${f.path}:${f.line_start ?? ""}:${f.line_end ?? ""}:${f.symbol ?? ""}`,
    ),
  );
  for (const file of absorbed.affected_files) {
    const key = `${file.path}:${file.line_start ?? ""}:${file.line_end ?? ""}:${file.symbol ?? ""}`;
    if (!seen.has(key)) {
      survivor.affected_files.push(file);
      seen.add(key);
    }
  }
  if (sort) {
    survivor.affected_files.sort(
      (a, b) => a.path.localeCompare(b.path) || (a.line_start ?? 0) - (b.line_start ?? 0),
    );
  }
}

export interface AbsorbOptions {
  /** Merge grounding verdicts by precedence (audit evidence integrity). */
  mergeGrounding: boolean;
  /** Sort the survivor's affected_files after the union (audit). */
  sortAffectedFiles: boolean;
}

/**
 * Merge `absorbed` INTO `survivor` in place: union affected_files + evidence,
 * systemic OR, longest summary; optionally grounding-precedence + sort. The caller
 * decides whether `survivor` is an original (mutate) or a clone (never-mutate).
 * Shared by the cross-lens core AND audit's same-lens pass.
 */
export function absorbFinding(survivor: Finding, absorbed: Finding, opts: AbsorbOptions): void {
  mergeAffectedFiles(survivor, absorbed, opts.sortAffectedFiles);
  survivor.evidence = [
    ...new Set([...(survivor.evidence ?? []), ...(absorbed.evidence ?? [])]),
  ];
  survivor.systemic = Boolean(survivor.systemic || absorbed.systemic);
  if (opts.mergeGrounding) {
    survivor.grounding = mergeGrounding(survivor.grounding, absorbed.grounding);
  }
  if (absorbed.summary.length > survivor.summary.length) {
    survivor.summary = absorbed.summary;
  }
}

/**
 * The shared finding-identity signature, but only when DISCRIMINATING enough to
 * stand alone as an exact-match key. A structural-anchor signature with empty
 * scope (`anchor|<path>|`) means only "same file" — too coarse to collapse two
 * findings by itself — so we return null and let the fuzzy layer refine it.
 */
function discriminatingIdentityKey(finding: Finding): string | null {
  const key = findingIdentityKey(finding);
  if (key.startsWith("anchor|") && key.endsWith("|")) return null;
  return key;
}

export interface CrossLensDedupePolicy {
  /**
   * Category handling: `soft` still merges two findings of different categories but
   * at a higher title-similarity threshold (audit review — a human reads the
   * report); `hard` NEVER merges across categories — a different category is a
   * structurally different fix, unsafe to auto-collapse (remediate, OBL-C003-DEDUP).
   */
  categoryGate: "soft" | "hard";
  /**
   * When true, two findings sharing a DISCRIMINATING shared-identity signature
   * collapse even below the title-Jaccard floor (remediate drift-plan R2).
   */
  exactIdentityShortCircuit: boolean;
  /**
   * `mutate` the survivor original in place (audit report); `clone` it first so the
   * caller's Finding objects are never mutated (remediate block state machine,
   * INV-remediate-state-05).
   */
  survivorMutation: "mutate" | "clone";
  /** Merge grounding verdicts by precedence (audit evidence integrity). */
  mergeGrounding: boolean;
  /** Sort a survivor's affected_files after each absorb (audit). */
  sortAffectedFiles: boolean;
  /**
   * Stop the inner scan once the i-slot finding is itself absorbed (remediate) —
   * there is no point comparing an absorbed finding with more candidates.
   */
  breakOnAbsorbedSurvivor: boolean;
  /** Called for each merge (remediate emits a structured audit log). */
  onMerge?: (info: { absorbed: Finding; survivor: Finding }) => void;
}

export interface CrossLensDedupeResult {
  findings: Finding[];
  /**
   * `absorbed.id → survivor.id` for every merge (empty when nothing merged). A
   * clone-mode caller uses it to rewrite downstream references (remediation blocks);
   * mutate-mode callers can ignore it.
   */
  mergeMap: Map<string, string>;
}

/**
 * Collapse cross-lens duplicate findings within each primary-path group. Only pairs
 * of DIFFERENT lenses are considered (same-lens dedup is a separate pass); the
 * winner by severity-then-confidence absorbs the loser's files/evidence. All policy
 * divergence between the two orchestrators is expressed through `policy`.
 */
export function crossLensDedupe(
  findings: Finding[],
  policy: CrossLensDedupePolicy,
): CrossLensDedupeResult {
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    const key = primaryPath(finding);
    const group = groups.get(key);
    if (group) group.push(finding);
    else groups.set(key, [finding]);
  }

  const removed = new Set<Finding>();
  const mergeMap = new Map<string, string>();
  /**
   * Maps each source survivor to its cloned merged copy (clone mode only), so the
   * caller's original Finding objects are never mutated and repeated merges into the
   * same survivor accumulate on one clone.
   */
  const cloneOf = new Map<Finding, Finding>();
  const absorbOpts: AbsorbOptions = {
    mergeGrounding: policy.mergeGrounding,
    sortAffectedFiles: policy.sortAffectedFiles,
  };

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      if (removed.has(group[i])) continue;
      for (let j = i + 1; j < group.length; j++) {
        if (removed.has(group[j])) continue;
        const a = group[i];
        const b = group[j];
        if (normalizeText(a.lens) === normalizeText(b.lens)) continue;

        const catMatch = normalizeText(a.category) === normalizeText(b.category);
        // Hard category gate applies ahead of BOTH the exact-match and fuzzy layers.
        if (policy.categoryGate === "hard" && !catMatch) continue;

        let matched = false;
        if (policy.exactIdentityShortCircuit) {
          const keyA = discriminatingIdentityKey(a);
          const keyB = discriminatingIdentityKey(b);
          matched = keyA !== null && keyA === keyB;
        }
        if (!matched) {
          const titleSim = wordJaccard(a.title, b.title);
          const threshold = policy.categoryGate === "soft" ? (catMatch ? 0.4 : 0.5) : 0.4;
          if (titleSim < threshold) continue;
          if (filePathOverlap(a, b) < 0.5) continue;
        }

        const aSev = severityRank(a.severity);
        const bSev = severityRank(b.severity);
        const aConf = confidenceRank(a.confidence);
        const bConf = confidenceRank(b.confidence);
        const keepA = aSev > bSev || (aSev === bSev && aConf >= bConf);
        const originalSurvivor = keepA ? a : b;
        const absorbed = keepA ? b : a;

        let survivor: Finding;
        if (policy.survivorMutation === "clone") {
          survivor =
            cloneOf.get(originalSurvivor) ?? {
              ...originalSurvivor,
              affected_files: [...originalSurvivor.affected_files],
              evidence: originalSurvivor.evidence ? [...originalSurvivor.evidence] : [],
            };
          if (!cloneOf.has(originalSurvivor)) {
            cloneOf.set(originalSurvivor, survivor);
            // Point the group slot at the clone so future pairs refer to it.
            group[keepA ? i : j] = survivor;
          }
        } else {
          survivor = originalSurvivor;
        }

        absorbFinding(survivor, absorbed, absorbOpts);
        removed.add(absorbed);
        mergeMap.set(absorbed.id, survivor.id);
        policy.onMerge?.({ absorbed, survivor });
        // If the i-slot finding was just absorbed (!keepA), stop the inner loop.
        if (policy.breakOnAbsorbedSurvivor && !keepA) break;
      }
    }
  }

  return {
    findings: findings.filter((f) => !removed.has(f)).map((f) => cloneOf.get(f) ?? f),
    mergeMap,
  };
}
