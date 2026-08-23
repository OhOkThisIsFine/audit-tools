import type { Finding } from "../types/finding.js";
import { severityRank, confidenceRank } from "../types/lens.js";
import { findingIdentityKey } from "../findingIdentitySignature.js";
import { wordJaccard, filePathOverlap, primaryPath } from "../findingSimilarity.js";

/**
 * PUBLISHED PRECONDITION CONTRACT — artifact:cross-lens-dedup-core
 *
 * This module performs NO runtime validation of its inputs. Every exported
 * function here (`crossLensDedupe`, `sameLensDedupe`, `upsertFindingByIdentity`,
 * `absorbFinding`, `mergeAffectedFiles`, `mergeGrounding`, `findingReEmissionKey`)
 * TRUSTS its caller to already satisfy the three preconditions below before
 * calling in. Runtime enforcement of these preconditions is deliberately the
 * CALLER's responsibility (CP-NODE-7's runtime validation lands against exactly
 * this contract) — this module will not detect a violation, by design.
 *
 * Preconditions (caller-owned, NOT checked here):
 *   1. Every `Finding` is schema-valid (matches `FindingSchema` in
 *      `../types/finding.js`).
 *   2. Every `Finding.id` is UNIQUE across one call's input array.
 *   3. `affected_files` and `evidence` are well-formed arrays (present, even
 *      when empty) on every `Finding`.
 *
 * validation_boundary — the concrete failure mode when a precondition is
 * violated, recorded here so a caller-side check has something to test
 * against. This is NOT a promise that this module will start enforcing it:
 *   - A missing/unrecognized `policy.categoryGate` (neither `"soft"` nor
 *     `"hard"`) silently falls through in the PERMISSIVE direction: the
 *     hard-gate check in `crossLensDedupe` only special-cases the literal
 *     string `"hard"`, so anything else (including `undefined`) never blocks
 *     a cross-category pair — it falls through to the exact/fuzzy match layers
 *     as if the gate were absent.
 *   - A `Finding` missing `affected_files` throws an uncaught TypeError inside
 *     `mergeAffectedFiles` (`survivor.affected_files.map(...)` called on
 *     `undefined`) the first time that finding is absorbed or absorbs another.
 *   - Two input findings sharing the same `id` (precondition 2 violated) yield
 *     an UNSPECIFIED merge-chain target once `crossLensDedupe`'s post-loop
 *     chain-collapse runs: the `visited`-guard there stops the walk instead of
 *     spinning forever on the resulting id cycle, but which of the colliding
 *     ids the chain resolves to is not a contract this module makes.
 *
 * seam_adjustments[1] (CDC-010, advisory, NOT decided here): a reviewer raised
 * that the existing `audit-cli-commands` validate path — which already owns
 * AuditResult validation — may be a better landing site for the new runtime
 * check than opening a second validation seam inside a module whose contract
 * says it validates almost nothing. Recorded as a scoping question for
 * whoever implements the caller-side check, not settled by this module.
 */

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
   * Stop the inner scan immediately when the i-slot finding is itself absorbed
   * (remediate). This is an OPTIMIZATION knob only: correctness never depends on
   * it — an absorbed finding is unconditionally excluded from every subsequent
   * pairwise comparison in both loops (conservation: once removed, a finding can
   * neither absorb nor be re-emitted).
   */
  breakOnAbsorbedSurvivor: boolean;
  /**
   * What the caller's finding ids MEAN, which decides whether id-keyed provenance
   * is well-defined:
   *
   * - `global` (remediate): ids are globally unique (they come from
   *   `audit-findings.json`, re-keyed at the synthesis boundary). Duplicate or
   *   empty input ids are REFUSED, a merge-chain cycle is an internal invariant
   *   failure, and the result carries `dispositionById` plus the terminal
   *   evidence-conservation check.
   * - `local` (audit report merge): ids are packet-scoped (`MNT-001` collides
   *   across units by construction) and only become unique AFTER this pass, at
   *   `assignStableFindingIds`. Id-keyed provenance is meaningless here, so no
   *   refusal, no `dispositionById`, and a chain cycle from a reused id breaks
   *   tolerantly instead of throwing (`mergeMap` is unused by this caller).
   */
  idDiscipline: "global" | "local";
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
  /**
   * Membership-closed disposition for every unique input id. Merge paths retain
   * the direct provenance chain while `terminalFindingId` always names an
   * emitted finding. Present ONLY under `idDiscipline: "global"` — with
   * packet-local ids the map would be mis-keyed, and an empty map here must
   * never read as "nothing merged" ([[success-shaped-empty-needs-affirmation]]).
   */
  dispositionById: Map<string, FindingDedupeDisposition> | null;
}

export interface FindingDedupeDisposition {
  status: "retained" | "merged";
  terminalFindingId: string;
  mergePath: string[];
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
  const evidenceByInputId = new Map<string, string[]>();
  if (policy.idDiscipline === "global") {
    for (const finding of findings) {
      if (finding.id.trim().length === 0) {
        throw new TypeError("Finding ids must be non-empty before deduplication.");
      }
      if (evidenceByInputId.has(finding.id)) {
        throw new TypeError(
          `Duplicate finding id "${finding.id}" makes terminal dedupe disposition ambiguous.`,
        );
      }
      evidenceByInputId.set(finding.id, [...(finding.evidence ?? [])]);
    }
  }

  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    const key = primaryPath(finding);
    const group = groups.get(key);
    if (group) group.push(finding);
    else groups.set(key, [finding]);
  }

  /**
   * Removal and clone bookkeeping are BOTH keyed by the caller's ORIGINAL Finding
   * objects (group slots are never rewritten): `removed` holds absorbed originals,
   * and `cloneOf` maps each original survivor to its single canonical clone (clone
   * mode only). Keying by originals is what guarantees conservation — the final
   * filter over `findings` sees exactly the objects the loop marked, so a finding
   * is emitted exactly once XOR recorded in `mergeMap`, never both, never neither.
   */
  const removed = new Set<Finding>();
  const mergeMap = new Map<string, string>();
  const cloneOf = new Map<Finding, Finding>();
  /** The accumulated view of a finding: its canonical clone when one exists. */
  const canonical = (f: Finding): Finding => cloneOf.get(f) ?? f;
  const absorbOpts: AbsorbOptions = {
    mergeGrounding: policy.mergeGrounding,
    sortAffectedFiles: policy.sortAffectedFiles,
  };

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      if (removed.has(group[i])) continue;
      for (let j = i + 1; j < group.length; j++) {
        // The i-slot finding may have been absorbed mid-scan (!keepA below): an
        // absorbed finding never acts as a survivor, so every remaining (i, j)
        // pair is dead — stop unconditionally (not policy-gated; conservation).
        if (removed.has(group[i])) break;
        if (removed.has(group[j])) continue;
        const originalA = group[i];
        const originalB = group[j];
        // Compare the CANONICAL views: in clone mode a prior merge's accumulation
        // lives on the survivor's single clone, never on the caller's object.
        const a = canonical(originalA);
        const b = canonical(originalB);
        // crossLensDedupe only pairs findings of DIFFERENT lenses
        if (normalizeText(a.lens) === normalizeText(b.lens)) continue;

        const comparison = compareFindingPair(a, b, {
          categoryGate: policy.categoryGate,
          exactIdentityShortCircuit: policy.exactIdentityShortCircuit,
        });
        if (!comparison.matched) continue;

        const keepA = comparison.keepA;
        const survivorOriginal = keepA ? originalA : originalB;
        const absorbedOriginal = keepA ? originalB : originalA;
        // Absorb the absorbed side's ACCUMULATED view so data it absorbed earlier
        // travels to the new survivor instead of being stranded (no loss).
        const absorbed = keepA ? b : a;

        let survivor: Finding;
        if (policy.survivorMutation === "clone") {
          // Exactly ONE canonical clone per original survivor: every subsequent
          // merge into this survivor mutates the SAME clone (a first-time survivor
          // cannot already carry foreign data, so cloning the original is exact).
          const existing = cloneOf.get(survivorOriginal);
          if (existing) {
            survivor = existing;
          } else {
            survivor = {
              ...survivorOriginal,
              affected_files: [...survivorOriginal.affected_files],
              evidence: survivorOriginal.evidence ? [...survivorOriginal.evidence] : [],
            };
            cloneOf.set(survivorOriginal, survivor);
          }
        } else {
          survivor = survivorOriginal;
        }

        absorbFinding(survivor, absorbed, absorbOpts);
        removed.add(absorbedOriginal);
        mergeMap.set(absorbedOriginal.id, survivor.id);
        policy.onMerge?.({ absorbed, survivor });
        // If the i-slot finding was just absorbed (!keepA), stop the inner loop.
        if (policy.breakOnAbsorbedSurvivor && !keepA) break;
      }
    }
  }

  // Preserve the direct edges before terminal collapse so the disposition map can
  // explain B→A→C rather than reducing all provenance to B→C.
  const directMergeMap = new Map(mergeMap);

  // Collapse merge chains (B→A recorded before A→C): every mergeMap value must be
  // the id of a finding present in the returned array, so follow each chain to its
  // final (non-absorbed) survivor. Under `global` ids duplicates were rejected
  // above, so a cycle is an internal invariant failure; under `local` ids a reused
  // id can manufacture an apparent cycle from two unrelated merges, so the walk
  // breaks tolerantly (this caller never consumes mergeMap).
  for (const [absorbedId, survivorId] of mergeMap) {
    let target = survivorId;
    const visited = new Set([absorbedId]);
    while (mergeMap.has(target) && !visited.has(target)) {
      visited.add(target);
      target = mergeMap.get(target)!;
    }
    if (visited.has(target) && mergeMap.has(target) && policy.idDiscipline === "global") {
      throw new Error(`Dedupe merge cycle detected at finding id "${target}".`);
    }
    if (target !== survivorId) mergeMap.set(absorbedId, target);
  }

  const emittedFindings = findings
    .filter((finding) => !removed.has(finding))
    .map((finding) => canonical(finding));

  if (policy.idDiscipline === "local") {
    return { findings: emittedFindings, mergeMap, dispositionById: null };
  }

  const emittedById = new Map(emittedFindings.map((finding) => [finding.id, finding]));
  if (emittedById.size !== emittedFindings.length) {
    throw new Error("Dedupe emitted duplicate finding ids after terminal merge collapse.");
  }

  const dispositionById = new Map<string, FindingDedupeDisposition>();
  for (const finding of findings) {
    const mergePath = [finding.id];
    const visited = new Set(mergePath);
    let terminalFindingId = finding.id;
    while (directMergeMap.has(terminalFindingId)) {
      terminalFindingId = directMergeMap.get(terminalFindingId)!;
      if (visited.has(terminalFindingId)) {
        throw new Error(`Dedupe provenance cycle detected at finding id "${terminalFindingId}".`);
      }
      visited.add(terminalFindingId);
      mergePath.push(terminalFindingId);
    }
    if (!emittedById.has(terminalFindingId)) {
      throw new Error(
        `Dedupe disposition for "${finding.id}" terminates at non-emitted id "${terminalFindingId}".`,
      );
    }
    dispositionById.set(finding.id, {
      status: mergePath.length === 1 ? "retained" : "merged",
      terminalFindingId,
      mergePath,
    });
  }

  // Evidence is conserved by terminal destination, including through an
  // intermediate survivor that is later absorbed. Check the invariant at the
  // boundary so future absorb-policy edits cannot silently strand provenance.
  const requiredEvidenceByTerminal = new Map<string, Set<string>>();
  for (const [inputId, disposition] of dispositionById) {
    const required = requiredEvidenceByTerminal.get(disposition.terminalFindingId) ?? new Set<string>();
    for (const evidence of evidenceByInputId.get(inputId) ?? []) required.add(evidence);
    requiredEvidenceByTerminal.set(disposition.terminalFindingId, required);
  }
  for (const [terminalFindingId, requiredEvidence] of requiredEvidenceByTerminal) {
    const actualEvidence = new Set(emittedById.get(terminalFindingId)?.evidence ?? []);
    for (const evidence of requiredEvidence) {
      if (!actualEvidence.has(evidence)) {
        throw new Error(
          `Terminal finding "${terminalFindingId}" lost evidence from an absorbed finding.`,
        );
      }
    }
  }

  return {
    findings: emittedFindings,
    mergeMap,
    dispositionById,
  };
}

/**
 * Shared pairwise comparison result: should these two findings be merged?
 * Extracted to eliminate duplication between crossLensDedupe and sameLensDedupe.
 */
interface PairwiseComparisonResult {
  /** If true, a is kept as survivor; if false, b is kept. */
  keepA: boolean;
  /** Did the pair match under the comparison criteria? */
  matched: boolean;
}

/**
 * Perform pairwise comparison of two findings using similarity metrics.
 * Returns whether they match and which should be the survivor.
 * This logic is shared by both crossLensDedupe and sameLensDedupe.
 */
function compareFindingPair(
  a: Finding,
  b: Finding,
  options: {
    skipLensCheck?: boolean; // Skip the lens equality check (crossLensDedupe sets different-lens requirement in its own logic)
    categoryGate?: "soft" | "hard";
    exactIdentityShortCircuit?: boolean;
  },
): PairwiseComparisonResult {
  const catMatch = normalizeText(a.category) === normalizeText(b.category);

  // Hard category gate applies ahead of both exact-match and fuzzy layers
  if (options.categoryGate === "hard" && !catMatch) {
    return { matched: false, keepA: false };
  }

  let matched = false;
  if (options.exactIdentityShortCircuit) {
    const keyA = discriminatingIdentityKey(a);
    const keyB = discriminatingIdentityKey(b);
    matched = keyA !== null && keyA === keyB;
  }

  if (!matched) {
    const titleSim = wordJaccard(a.title, b.title);
    const threshold = options.categoryGate === "soft" ? (catMatch ? 0.4 : 0.5) : 0.4;
    if (titleSim < threshold) {
      return { matched: false, keepA: false };
    }
    if (filePathOverlap(a, b) < 0.5) {
      return { matched: false, keepA: false };
    }
    matched = true;
  }

  // Rank by severity then confidence
  const aSev = severityRank(a.severity);
  const bSev = severityRank(b.severity);
  const aConf = confidenceRank(a.confidence);
  const bConf = confidenceRank(b.confidence);
  const keepA = aSev > bSev || (aSev === bSev && aConf >= bConf);

  return { matched, keepA };
}

/**
 * File-independent finding identity for exact re-emission collapse: the same logical
 * finding (normalized lens + category + title) re-emitted across files / units /
 * passes shares one key. Distinct from `findingIdentityKey` (the 3-tier structural-
 * anchor ladder) — this is the coarse lens|category|title exact key the identity
 * upsert collapses on. Cross-file merging happens ONLY on this exact equality; the
 * fuzzy same/cross-lens passes stay grouped by primary path so distinct problems in
 * different units never collapse on mere similarity.
 */
export function findingReEmissionKey(finding: Finding): string {
  return [
    normalizeText(finding.lens),
    normalizeText(finding.category),
    normalizeText(finding.title),
  ].join("|");
}

function lineRangeOverlaps(a: Finding, b: Finding): boolean {
  const aFile = a.affected_files[0];
  const bFile = b.affected_files[0];
  if (!aFile || !bFile) return false;
  if (aFile.path !== bFile.path) return false;
  const aStart = aFile.line_start ?? 0;
  const aEnd = aFile.line_end ?? aStart;
  const bStart = bFile.line_start ?? 0;
  const bEnd = bFile.line_end ?? bStart;
  if (aEnd === 0 && bEnd === 0) return true;
  return aStart <= bEnd && bStart <= aEnd;
}

/**
 * Same-lens dedup: within each (lens, primary-path) group, collapse fuzzily-similar
 * findings (title Jaccard with a category-lowered threshold, plus line-range OR file
 * overlap), the higher sev/conf survivor absorbing the loser in place with grounding-
 * precedence + sorted files. A core capability only audit currently draws (remediate
 * consumes findings the auditor already collapsed), single-sourced here so the whole
 * finding-dedup family lives in one place.
 */
export function sameLensDedupe(findings: Finding[]): Finding[] {
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    const key = `${normalizeText(finding.lens)}:${primaryPath(finding)}`;
    const group = groups.get(key);
    if (group) group.push(finding);
    else groups.set(key, [finding]);
  }

  const removed = new Set<Finding>();

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      if (removed.has(group[i])) continue;
      for (let j = i + 1; j < group.length; j++) {
        // The i-slot finding may have been absorbed mid-scan (as b of an earlier
        // pair): an absorbed finding must never act as a survivor again, or it
        // re-absorbs data that was already unioned into ITS absorber and the
        // final filter silently drops everything it then wins — the same
        // conservation guard crossLensDedupe carries. Checked BEFORE the j-slot
        // skip, mirroring that pass.
        if (removed.has(group[i])) break;
        if (removed.has(group[j])) continue;
        const a = group[i];
        const b = group[j];

        // sameLensDedupe has different similarity thresholds than crossLensDedupe
        const catMatch = normalizeText(a.category) === normalizeText(b.category);
        const titleSim = wordJaccard(a.title, b.title);
        const threshold = catMatch ? 0.35 : 0.45;
        if (titleSim < threshold) continue;
        if (!lineRangeOverlaps(a, b) && filePathOverlap(a, b) < 0.5) continue;

        const aSev = severityRank(a.severity);
        const bSev = severityRank(b.severity);
        const aConf = confidenceRank(a.confidence);
        const bConf = confidenceRank(b.confidence);
        const keepA = aSev > bSev || (aSev === bSev && aConf >= bConf);
        const [survivor, absorbed] = keepA ? [a, b] : [b, a];
        absorbFinding(survivor, absorbed, { mergeGrounding: true, sortAffectedFiles: true });
        removed.add(absorbed);
      }
    }
  }

  return findings.filter((f) => !removed.has(f));
}

/**
 * Insert a finding into an identity-keyed map, or absorb it into the existing finding
 * of the same re-emission identity (`findingReEmissionKey`): affected_files + evidence
 * union, severity / confidence ESCALATE to the maximum rank seen, `systemic` ORs,
 * impact / likelihood backfill, longest summary wins. (Audit's exact re-emission
 * collapse — remediate has no identity-key merge today.)
 */
export function upsertFindingByIdentity(merged: Map<string, Finding>, finding: Finding): void {
  const key = findingReEmissionKey(finding);
  const existing = merged.get(key);
  if (!existing) {
    merged.set(key, {
      ...finding,
      affected_files: [...finding.affected_files],
      evidence: [...(finding.evidence ?? [])],
    });
    return;
  }

  if (severityRank(finding.severity) > severityRank(existing.severity)) {
    existing.severity = finding.severity;
  }
  if (confidenceRank(finding.confidence) > confidenceRank(existing.confidence)) {
    existing.confidence = finding.confidence;
  }
  existing.systemic = Boolean(existing.systemic || finding.systemic);
  existing.grounding = mergeGrounding(existing.grounding, finding.grounding);
  existing.impact = existing.impact ?? finding.impact;
  existing.likelihood = existing.likelihood ?? finding.likelihood;
  existing.summary =
    existing.summary.length >= finding.summary.length ? existing.summary : finding.summary;

  mergeAffectedFiles(existing, finding, true);
  existing.evidence = [
    ...new Set([...(existing.evidence ?? []), ...(finding.evidence ?? [])]),
  ];
}
