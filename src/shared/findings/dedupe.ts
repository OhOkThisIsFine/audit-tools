import type { Finding } from "../types/finding.js";
import { severityRank, confidenceRank } from "../types/lens.js";
import { findingIdentityKey } from "../findingIdentitySignature.js";
import { wordJaccard, filePathOverlap, primaryPath } from "../findingSimilarity.js";
import { compareCodeUnits } from "../compareCodeUnits.js";

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
 *     `"hard"`) silently falls through in the PERMISSIVE direction, in BOTH
 *     places `crossLensDedupe` consults it. The hard-gate refusal lives in the
 *     shared `compareFindingPair` and only special-cases the literal string
 *     `"hard"`, so anything else (including `undefined`) never blocks a
 *     cross-category pair; and the `PairMatchPolicy.titleThreshold`
 *     `crossLensDedupe` derives only special-cases `"soft"`, so an unrecognized
 *     value takes the LOWER cross-category title floor (0.4, the same-category
 *     one) instead of soft's 0.5.
 *   - A `Finding` missing `affected_files` throws an uncaught TypeError inside
 *     `mergeAffectedFiles` (`survivor.affected_files.map(...)` called on
 *     `undefined`) the first time that finding is absorbed or absorbs another.
 *   - Two input findings sharing the same `id` (precondition 2 violated) yield
 *     an UNSPECIFIED merge-chain target once `crossLensDedupe`'s post-fold
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
 * ONE shared finding-dedup core. There is no auditor-dedup vs remediator-dedup,
 * and no cross-lens-fold vs same-lens-fold — there is one skeleton
 * (group → pairwise compare → similarity gate → survivor selection → absorb →
 * remove), and every pass DRAWS it with its own POLICY. Two seams carry the whole
 * divergence:
 *
 *   - `collapseFindingGroups` — the survivor FOLD (grouping, the pair scan, the
 *     mid-scan absorbed-survivor conservation guard, absorption, removal, and the
 *     mutate-vs-clone survivor axis). Drawn by `crossLensDedupe` AND
 *     `sameLensDedupe`.
 *   - `compareFindingPair` — the one pair decision, parameterized by
 *     `PairMatchPolicy` (lens eligibility, category gate, title floors, what
 *     counts as the same place).
 *
 * Audit draws the core read-only for the report (mutate survivors in place,
 * grounding-precedence merge, cross-category merge allowed at a higher threshold);
 * remediate draws it for the auto-apply block machine (clone survivors, hard
 * category gate, exact-identity short-circuit, a mergeMap its blocks consume).
 * Single-sourcing the skeleton is what stops them drifting on the grouping /
 * thresholds / survivor rule; the divergences are the named policy fields, not
 * forked code. What stays per-draw is only what is genuinely terminal: cross-lens
 * merge-chain closure, dispositions, and the evidence-conservation check, all
 * post-fold phases in `crossLensDedupe`.
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
 * Precedence for the defect-presence claim when two findings collapse:
 * `judge_confirmed` > `asserted` > absent. Without it the survivor silently
 * keeps whatever it happened to carry, so a judge-confirmed claim vanishes into
 * an `asserted` survivor — the same silent-drop `mergeGrounding` exists to
 * prevent. `refuted_at_head` is deliberately NOT ranked: the adjudication
 * validator forces a refuted candidate to `rejected`, and a rejected candidate
 * maps to no final finding, so it can never reach a finding that is deduped.
 */
export function mergeVerificationStatus(
  existing: Finding["verification_status"],
  incoming: Finding["verification_status"],
): Finding["verification_status"] {
  const rank = (status: Finding["verification_status"]): number =>
    status === "judge_confirmed" ? 2 : status === "asserted" ? 1 : 0;
  return rank(incoming) > rank(existing) ? incoming : existing;
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
      (a, b) => compareCodeUnits(a.path, b.path) || (a.line_start ?? 0) - (b.line_start ?? 0),
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
  survivor.verification_status = mergeVerificationStatus(
    survivor.verification_status,
    absorbed.verification_status,
  );
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

/**
 * Do two findings describe the same place? `lineRangeOverlaps` is the finer of
 * the two "same place" signals: the same file AND touching line ranges, with an
 * explicit sentinel — two findings that both omit line information (both ends
 * degenerate to 0) are treated as overlapping rather than as disjoint.
 */
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

/** Shared pairwise comparison result: should these two findings be merged? */
interface PairwiseComparisonResult {
  /** If true, a is kept as survivor; if false, b is kept. */
  keepA: boolean;
  /** Did the pair match under the comparison criteria? */
  matched: boolean;
}

/**
 * The MATCHING half of the shared core, stated as data. Everything the two draws
 * genuinely disagree about — which lens pairs are eligible, whether a category
 * difference is fatal, the title floors, and what counts as "the same place" — is
 * a field here, which is what makes `compareFindingPair` the one comparison BOTH
 * draws actually run. (It claimed to be shared while same-lens kept a second
 * inline copy that had already drifted on thresholds and on the overlap gate.)
 */
interface PairMatchPolicy {
  /**
   * `different`: only pairs of DIFFERENT lenses are eligible (the cross-lens
   * draw — same-lens collapse is a separate pass). `any`: no lens condition,
   * because the same-lens draw's group key already fixes the lens.
   */
  lensGate: "different" | "any";
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
  /** Title-Jaccard floor, lowered when the two categories agree. */
  titleThreshold: { sameCategory: number; crossCategory: number };
  /**
   * What "the same place" means: `file` = file-path overlap alone (cross-lens);
   * `line-or-file` = an overlapping line range OR file-path overlap (same-lens).
   */
  overlapGate: "file" | "line-or-file";
}

/**
 * The ONE pairwise comparison: do these two findings merge, and which side
 * survives? Both `crossLensDedupe` and `sameLensDedupe` route their pair decision
 * through here, each with its own `PairMatchPolicy`.
 *
 * Survivor selection is severity-then-confidence with `aConf >= bConf`, so a
 * fully-tied pair keeps the FIRST-SEEN finding — input order is the tiebreak, and
 * that is a pinned property, not an accident.
 */
function compareFindingPair(
  a: Finding,
  b: Finding,
  policy: PairMatchPolicy,
): PairwiseComparisonResult {
  if (policy.lensGate === "different" && normalizeText(a.lens) === normalizeText(b.lens)) {
    return { matched: false, keepA: false };
  }

  const catMatch = normalizeText(a.category) === normalizeText(b.category);

  // Hard category gate applies ahead of both exact-match and fuzzy layers
  if (policy.categoryGate === "hard" && !catMatch) {
    return { matched: false, keepA: false };
  }

  let matched = false;
  if (policy.exactIdentityShortCircuit) {
    const keyA = discriminatingIdentityKey(a);
    const keyB = discriminatingIdentityKey(b);
    matched = keyA !== null && keyA === keyB;
  }

  if (!matched) {
    const titleSim = wordJaccard(a.title, b.title);
    const threshold = catMatch
      ? policy.titleThreshold.sameCategory
      : policy.titleThreshold.crossCategory;
    if (titleSim < threshold) {
      return { matched: false, keepA: false };
    }
    const sameProblemSite =
      (policy.overlapGate === "line-or-file" && lineRangeOverlaps(a, b)) ||
      filePathOverlap(a, b) >= 0.5;
    if (!sameProblemSite) {
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
 * The per-draw policy of the shared survivor FOLD. The fold owns the whole
 * survivor lifecycle — grouping, the pair scan, the mid-scan absorbed-survivor
 * conservation guard, winner selection, absorption, and removal — and every
 * genuine per-draw difference is a field here rather than a forked loop.
 */
interface FindingGroupFoldPolicy {
  /**
   * Group key. Groups are built in INPUT order and each group's members keep
   * input order, because merge OUTCOMES depend on scan order (first-seen tie
   * survival) and downstream artifact hashes depend on emission order.
   */
  groupKey: (finding: Finding) => string;
  /** The pair decision, run over the ACCUMULATED (canonical) views. */
  matchPair: (a: Finding, b: Finding) => PairwiseComparisonResult;
  /**
   * `mutate` the survivor original in place (audit report); `clone` it first so the
   * caller's Finding objects are never mutated (remediate block state machine,
   * INV-remediate-state-05).
   */
  survivorMutation: "mutate" | "clone";
  /** Absorption mechanics: grounding precedence, affected-file sort. */
  absorb: AbsorbOptions;
  /**
   * Called for every absorb. The cross-lens draw records its `mergeMap` and fires
   * its `onMerge` audit-log hook here; the same-lens draw records nothing.
   */
  onAbsorb?: (info: {
    /** The caller's ORIGINAL absorbed object — the emission filter's key. */
    absorbedOriginal: Finding;
    /** The absorbed side's ACCUMULATED view (what actually travelled). */
    absorbed: Finding;
    /** The live survivor object the data landed on (original or clone). */
    survivor: Finding;
  }) => void;
}

interface FindingGroupFoldResult {
  /** The ORIGINAL objects that were absorbed — the emission filter's authority. */
  removed: Set<Finding>;
  /** The accumulated view of a finding: its canonical clone when one exists. */
  canonical: (finding: Finding) => Finding;
}

/**
 * The ONE finding-survivor fold. There is no auditor-fold and remediator-fold:
 * group → pairwise scan → similarity gate → survivor selection → absorb → remove
 * is one skeleton, and both dedup passes DRAW it with their own policy.
 *
 * Removal and clone bookkeeping are BOTH keyed by the caller's ORIGINAL Finding
 * objects (group slots are never rewritten): `removed` holds absorbed originals,
 * and `cloneOf` maps each original survivor to its single canonical clone (clone
 * mode only). Keying by originals is what guarantees conservation — a caller's
 * final filter over its input array sees exactly the objects this fold marked, so
 * a finding is emitted exactly once XOR recorded as absorbed, never both, never
 * neither.
 *
 * ⚠ The clone/canonical accumulation is MID-FOLD state, not a post-fold phase:
 * `matchPair` and `absorbFinding` both read the CANONICAL views, so a later pair
 * compares (and absorbs) everything an earlier merge already accumulated. Lifting
 * it out of the fold changes merge outcomes.
 */
function collapseFindingGroups(
  findings: Finding[],
  policy: FindingGroupFoldPolicy,
): FindingGroupFoldResult {
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    const key = policy.groupKey(finding);
    const group = groups.get(key);
    if (group) group.push(finding);
    else groups.set(key, [finding]);
  }

  const removed = new Set<Finding>();
  const cloneOf = new Map<Finding, Finding>();
  const canonical = (f: Finding): Finding => cloneOf.get(f) ?? f;

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      if (removed.has(group[i])) continue;
      for (let j = i + 1; j < group.length; j++) {
        // The i-slot finding may have been absorbed mid-scan (!keepA below): an
        // absorbed finding never acts as a survivor again — it would re-absorb
        // data already unioned into ITS absorber, and the emission filter then
        // silently drops everything it won. Every remaining (i, j) pair is dead,
        // so stop unconditionally (conservation, never a policy knob). Checked
        // BEFORE the j-slot skip.
        if (removed.has(group[i])) break;
        if (removed.has(group[j])) continue;
        const originalA = group[i];
        const originalB = group[j];
        // Compare the CANONICAL views: in clone mode a prior merge's accumulation
        // lives on the survivor's single clone, never on the caller's object.
        const a = canonical(originalA);
        const b = canonical(originalB);

        const comparison = policy.matchPair(a, b);
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

        absorbFinding(survivor, absorbed, policy.absorb);
        removed.add(absorbedOriginal);
        policy.onAbsorb?.({ absorbedOriginal, absorbed, survivor });
      }
    }
  }

  return { removed, canonical };
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

  const matchPolicy: PairMatchPolicy = {
    lensGate: "different",
    categoryGate: policy.categoryGate,
    exactIdentityShortCircuit: policy.exactIdentityShortCircuit,
    // The soft gate keeps cross-category merges but raises their title floor.
    // Under the hard gate a cross-category pair is refused before any floor is
    // consulted, so both entries are the same number there.
    titleThreshold:
      policy.categoryGate === "soft"
        ? { sameCategory: 0.4, crossCategory: 0.5 }
        : { sameCategory: 0.4, crossCategory: 0.4 },
    overlapGate: "file",
  };

  const mergeMap = new Map<string, string>();
  const { removed, canonical } = collapseFindingGroups(findings, {
    groupKey: primaryPath,
    matchPair: (a, b) => compareFindingPair(a, b, matchPolicy),
    survivorMutation: policy.survivorMutation,
    absorb: {
      mergeGrounding: policy.mergeGrounding,
      sortAffectedFiles: policy.sortAffectedFiles,
    },
    onAbsorb: ({ absorbedOriginal, absorbed, survivor }) => {
      mergeMap.set(absorbedOriginal.id, survivor.id);
      policy.onMerge?.({ absorbed, survivor });
    },
  });

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

/**
 * The same-lens draw's matching policy. The group key already fixes the lens, so
 * there is no lens condition; the title floors sit BELOW the cross-lens ones
 * (two findings one lens raised about one place are more often one defect), and
 * "the same place" is additionally satisfied by an overlapping line range.
 */
const SAME_LENS_MATCH_POLICY: PairMatchPolicy = {
  lensGate: "any",
  // `soft`, not "no category gate": a category difference is not fatal here, it
  // only raises the title floor.
  categoryGate: "soft",
  exactIdentityShortCircuit: false,
  titleThreshold: { sameCategory: 0.35, crossCategory: 0.45 },
  overlapGate: "line-or-file",
};

/**
 * Same-lens dedup: within each (lens, primary-path) group, collapse fuzzily-similar
 * findings (title Jaccard with a category-lowered threshold, plus line-range OR file
 * overlap), the higher sev/conf survivor absorbing the loser in place with grounding-
 * precedence + sorted files. The audit draw of the shared survivor fold — same
 * skeleton as `crossLensDedupe`, a different `PairMatchPolicy`, mutate-in-place
 * survivors, and no merge record (a human reads the report; nothing consumes an
 * id-keyed same-lens provenance today).
 */
export function sameLensDedupe(findings: Finding[]): Finding[] {
  const { removed } = collapseFindingGroups(findings, {
    groupKey: (finding) => `${normalizeText(finding.lens)}:${primaryPath(finding)}`,
    matchPair: (a, b) => compareFindingPair(a, b, SAME_LENS_MATCH_POLICY),
    survivorMutation: "mutate",
    absorb: { mergeGrounding: true, sortAffectedFiles: true },
  });

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
  existing.verification_status = mergeVerificationStatus(
    existing.verification_status,
    finding.verification_status,
  );
  existing.impact = existing.impact ?? finding.impact;
  existing.likelihood = existing.likelihood ?? finding.likelihood;
  existing.summary =
    existing.summary.length >= finding.summary.length ? existing.summary : finding.summary;

  mergeAffectedFiles(existing, finding, true);
  existing.evidence = [
    ...new Set([...(existing.evidence ?? []), ...(finding.evidence ?? [])]),
  ];
}
