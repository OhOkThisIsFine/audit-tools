/**
 * Provider-neutral content-coherence decomposition.
 *
 * This module owns membership. Consumers may aggregate presentation metadata
 * over the returned components, but they must not split, merge, or reorder
 * those components.
 */

import { z } from "zod";

import { louvain, modularityOf, type Partition } from "./modularity.js";

export const CONTENT_COHERENCE_SCORES = Object.freeze({
  call_import_reference_adjacency: 70,
  same_directory: 10,
  shared_critical_flow: 60,
  shared_file: 100,
  shared_semantic_tag_or_same_lens: 30,
  shared_unit: 80,
} as const);

export const CONTENT_COHERENCE_THRESHOLD = 60;

/**
 * Which pairs may join at all — the ONE policy axis of the shared core, never a
 * fork. Both draws run the identical scan, union-find, and canonical ordering;
 * they differ only in this predicate and in {@link ContentCoherencePolicy.refineAtModularityPeak}.
 *
 * - `weighted_score_threshold` — a pair joins when its summed evidence weight
 *   reaches {@link CONTENT_COHERENCE_THRESHOLD}. Disjunctive: four of the six
 *   classes clear 60 alone.
 * - `shared_file_and_same_lens` — a pair joins only when it shares a FILE **and**
 *   a lens. Measured on the promoted 2026-08-18 run (3,230 findings): the
 *   threshold rule left 99.97% of findings in a single component, and no
 *   class-COUNT variant fixed it, because `shared_unit`/`same_lens`/`same_directory`
 *   are near-vacuous partitions at audit scale. The conjunction bounds by
 *   STRUCTURE, not density — `same_lens` is a hard partition no edge may cross.
 */
export type ContentCoherenceEligibility =
  | "weighted_score_threshold"
  | "shared_file_and_same_lens";

/** The per-draw policy. Every difference between the draws lands here. */
export interface ContentCoherencePolicy {
  readonly eligibility: ContentCoherenceEligibility;
  /**
   * Refine each eligible-edge component at its modularity peak (below), so a
   * loose component splits at its own data-derived thin seam while a true clique
   * survives whole. No budget, ceiling, or size target participates.
   */
  readonly refineAtModularityPeak: boolean;
}

/**
 * The audit TASK draw. Unmeasured for collapse — its eligibility is deliberately
 * left as-is until it is measured on its own lap (`docs/backlog/open-bugs.md`).
 */
export const TASK_DRAW_COHERENCE_POLICY: ContentCoherencePolicy = Object.freeze({
  eligibility: "weighted_score_threshold",
  refineAtModularityPeak: false,
});

/** The FINDINGS draw (work blocks + the findings deliverable). Owner cut, 2026-08-19. */
export const FINDINGS_DRAW_COHERENCE_POLICY: ContentCoherencePolicy = Object.freeze({
  eligibility: "shared_file_and_same_lens",
  refineAtModularityPeak: true,
});

/**
 * The canonical modularity resolution (γ). NOT a tuned knob and never to become
 * one: γ = 1 is the literature default, at which the trivial whole-component
 * partition scores exactly 0, so "did the split beat keeping the component
 * whole" is answered by the data alone.
 */
const MODULARITY_RESOLUTION = 1;

/**
 * Components at or below this size are handed back unrefined. A triviality
 * guard, not a size budget: modularity over one, two, or three nodes describes
 * noise rather than structure, and nothing downstream reads the number.
 */
const TRIVIAL_COMPONENT_SIZE = 3;

export type ContentCoherenceEvidence = {
  -readonly [Kind in keyof typeof CONTENT_COHERENCE_SCORES]: boolean;
};

export interface ContentCoherenceItem {
  id: string;
  file_paths: readonly string[];
  unit_ids: readonly string[];
  tags: readonly string[];
  critical_flow_ids?: readonly string[];
  annotations?: Readonly<Record<string, unknown>>;
}

export type ContentCoherenceRelationshipKind =
  | "shared_file"
  | "cross_lens_same_file"
  | "same_unit"
  | "call_adjacent"
  | "same_flow"
  | "same_lens"
  | "same_dir";

export interface ContentCoherenceRelationship {
  left: string;
  right: string;
  kind: ContentCoherenceRelationshipKind | string;
}

export interface ContentCoherenceInput {
  items: readonly ContentCoherenceItem[];
  relationships?: readonly ContentCoherenceRelationship[];
}

export interface NormalizedContentCoherenceItem {
  id: string;
  file_paths: string[];
  unit_ids: string[];
  tags: string[];
  critical_flow_ids?: string[];
}

/**
 * One eligible pair on the way to a component. MODULE-PRIVATE and deliberately
 * so: the pairwise layer is O(N²) intermediate scratch, never a payload.
 *
 * The trace used to return the whole pairwise layer (`pair_scores`,
 * `eligible_candidates`, `merge_trace`, `merge_decisions`). Nothing read them —
 * the only non-test reference copied them through a filter — and at 3,194
 * findings `pair_scores` alone reached 1.33 GB, exceeding V8's 512 MB string cap
 * inside `stableStringify` and wedging artifact hashing before any persist.
 * Keep this layer local; see the trace-shape contract test in
 * `tests/shared/content-coherence.test.ts`.
 */
interface CoherenceCandidate {
  left: string;
  right: string;
  score: number;
}

export interface ContentCoherenceTrace {
  normalized_items: NormalizedContentCoherenceItem[];
  components: string[][];
}

export const NormalizedContentCoherenceItemSchema = z
  .object({
    id: z.string().min(1),
    file_paths: z.array(z.string()),
    unit_ids: z.array(z.string()),
    tags: z.array(z.string()),
    critical_flow_ids: z.array(z.string()).optional(),
  })
  .strict();

export const ContentCoherenceTraceSchema = z
  .object({
    normalized_items: z.array(NormalizedContentCoherenceItemSchema),
    components: z.array(z.array(z.string())),
  })
  .strict();

const RELATION_EVIDENCE: Readonly<
  Record<ContentCoherenceRelationshipKind, keyof ContentCoherenceEvidence>
> = Object.freeze({
  call_adjacent: "call_import_reference_adjacency",
  cross_lens_same_file: "shared_file",
  same_dir: "same_directory",
  same_flow: "shared_critical_flow",
  same_lens: "shared_semantic_tag_or_same_lens",
  same_unit: "shared_unit",
  shared_file: "shared_file",
});

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePath(value: string): string {
  return value.replace(/\\/gu, "/");
}

function stableStrings(
  value: unknown,
  field: string,
  itemId: string,
  normalize: (entry: string) => string = (entry) => entry,
): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Content-coherence item '${itemId}' ${field} must be an array.`);
  }
  const entries = value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new Error(
        `Content-coherence item '${itemId}' ${field}[${index}] must be a string.`,
      );
    }
    return normalize(entry);
  });
  return [...new Set(entries)].sort(compareCodeUnits);
}

function validateAnnotations(value: unknown, itemId: string): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    throw new Error(
      `Content-coherence item '${itemId}' annotations must be an object.`,
    );
  }
  for (const [name, annotation] of Object.entries(value)) {
    if (typeof annotation === "number" && !Number.isFinite(annotation)) {
      throw new Error(
        `Content-coherence item '${itemId}' annotation '${name}' must be finite.`,
      );
    }
  }
}

function normalizeItems(value: unknown): NormalizedContentCoherenceItem[] {
  if (!Array.isArray(value)) {
    throw new Error("Content-coherence items must be an array.");
  }
  const ids = new Set<string>();
  const items = value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`Content-coherence item at index ${index} must be an object.`);
    }
    if (typeof entry.id !== "string" || entry.id.length === 0) {
      throw new Error(`Content-coherence item at index ${index} has an empty id.`);
    }
    if (ids.has(entry.id)) {
      throw new Error(`Duplicate content-coherence item id '${entry.id}'.`);
    }
    ids.add(entry.id);
    validateAnnotations(entry.annotations, entry.id);
    const normalized: NormalizedContentCoherenceItem = {
      id: entry.id,
      file_paths: stableStrings(
        entry.file_paths,
        "file_paths",
        entry.id,
        normalizePath,
      ),
      unit_ids: stableStrings(entry.unit_ids, "unit_ids", entry.id),
      tags: stableStrings(entry.tags, "tags", entry.id),
    };
    if (entry.critical_flow_ids !== undefined) {
      normalized.critical_flow_ids = stableStrings(
        entry.critical_flow_ids,
        "critical_flow_ids",
        entry.id,
      );
    }
    return normalized;
  });
  return items.sort((left, right) => compareCodeUnits(left.id, right.id));
}

function canonicalPair(left: string, right: string): readonly [string, string] {
  return compareCodeUnits(left, right) <= 0 ? [left, right] : [right, left];
}

function pairKey(left: string, right: string): string {
  const pair = canonicalPair(left, right);
  return `${pair[0]}\u0000${pair[1]}`;
}

function normalizeRelationshipEvidence(
  value: unknown,
  itemIds: ReadonlySet<string>,
): Map<string, Set<keyof ContentCoherenceEvidence>> {
  if (value === undefined) return new Map();
  if (!Array.isArray(value)) {
    throw new Error("Content-coherence relationships must be an array.");
  }
  const evidenceByPair = new Map<
    string,
    Set<keyof ContentCoherenceEvidence>
  >();
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) {
      throw new Error(
        `Content-coherence relationship at index ${index} must be an object.`,
      );
    }
    if (typeof entry.left !== "string" || typeof entry.right !== "string") {
      throw new Error(
        `Content-coherence relationship at index ${index} needs string endpoints.`,
      );
    }
    if (!itemIds.has(entry.left) || !itemIds.has(entry.right)) {
      throw new Error(
        `Content-coherence relationship has invalid endpoint '${entry.left}'/'${entry.right}'.`,
      );
    }
    if (entry.left === entry.right) {
      throw new Error(
        `Content-coherence relationship cannot self-reference '${entry.left}'.`,
      );
    }
    if (typeof entry.kind !== "string" || !(entry.kind in RELATION_EVIDENCE)) {
      throw new Error(
        `Unknown content-coherence relationship kind '${String(entry.kind)}'.`,
      );
    }
    const key = pairKey(entry.left, entry.right);
    const evidence = evidenceByPair.get(key) ?? new Set();
    evidence.add(
      RELATION_EVIDENCE[entry.kind as ContentCoherenceRelationshipKind],
    );
    evidenceByPair.set(key, evidence);
  }
  return evidenceByPair;
}

function intersects(left: readonly string[], right: readonly string[]): boolean {
  const values = new Set(left);
  return right.some((entry) => values.has(entry));
}

function parentDirectory(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

function directEvidence(
  left: NormalizedContentCoherenceItem,
  right: NormalizedContentCoherenceItem,
): ContentCoherenceEvidence {
  const leftDirectories = left.file_paths.map(parentDirectory);
  const rightDirectories = right.file_paths.map(parentDirectory);
  return {
    call_import_reference_adjacency: false,
    same_directory: intersects(leftDirectories, rightDirectories),
    shared_critical_flow: intersects(
      left.critical_flow_ids ?? [],
      right.critical_flow_ids ?? [],
    ),
    shared_file: intersects(left.file_paths, right.file_paths),
    shared_semantic_tag_or_same_lens: intersects(left.tags, right.tags),
    shared_unit: intersects(left.unit_ids, right.unit_ids),
  };
}

function scoreEvidence(evidence: ContentCoherenceEvidence): number {
  let score = 0;
  for (const [kind, weight] of Object.entries(CONTENT_COHERENCE_SCORES) as Array<
    [keyof ContentCoherenceEvidence, number]
  >) {
    if (evidence[kind]) score += weight;
  }
  return score;
}

/**
 * The two conjuncts of `shared_file_and_same_lens`, read from DIRECT evidence
 * only. `RELATION_EVIDENCE` maps `shared_file`/`cross_lens_same_file` onto the
 * file bit and `same_lens` onto the tag bit, so an unmasked predicate would let
 * a caller manufacture eligibility by passing those relationship kinds — the
 * lens partition would then hold only by call-site habit rather than by the
 * core. Relationship bits still raise the pair's SCORE, which is what
 * modularity refinement reads.
 */
interface DirectConjuncts {
  sharedFile: boolean;
  sameLens: boolean;
}

function isEligible(
  direct: DirectConjuncts,
  score: number,
  policy: ContentCoherencePolicy,
): boolean {
  return policy.eligibility === "shared_file_and_same_lens"
    ? direct.sharedFile && direct.sameLens
    : score >= CONTENT_COHERENCE_THRESHOLD;
}

/**
 * Split one eligible-edge component at its modularity PEAK, or hand it back
 * whole. The component's own eligible pairs are the weighted graph (edge weight =
 * the pair's evidence score), Louvain proposes a partition at the canonical γ,
 * and the proposal is accepted only when it scores strictly above keeping the
 * component whole. A component held together by one weak bridge splits there.
 * Nothing in the decision is a constant of any denomination.
 *
 * What survives whole is a UNIFORM-weight clique: with every edge equal, any cut
 * scores below the trivial partition, so it cannot be split. A clique whose
 * weights DIFFER can still split — six findings on one file and one lens but two
 * units weigh 220 within a unit and 140 across it, and that contrast alone beats
 * the whole. That is intended (the halves are genuinely less coupled), and the
 * shared file then surfaces as a seam between them rather than disappearing into
 * one block. "A clique stays whole" without the uniform qualifier is an
 * overclaim; the two cases are pinned separately in
 * `tests/shared/content-coherence.test.ts`.
 */
function refineAtModularityPeak(
  members: readonly string[],
  candidates: readonly CoherenceCandidate[],
): string[][] {
  if (members.length <= TRIVIAL_COMPONENT_SIZE) return [[...members]];
  const graph = {
    nodes: [...members],
    edges: candidates.map((candidate) => ({
      a: candidate.left,
      b: candidate.right,
      weight: candidate.score,
    })),
  };
  const proposed = louvain(graph, MODULARITY_RESOLUTION);
  const whole: Partition = new Map(
    members.map((id) => [id, members[0] ?? id] as const),
  );
  if (
    modularityOf(graph, proposed, MODULARITY_RESOLUTION) <=
    modularityOf(graph, whole, MODULARITY_RESOLUTION)
  ) {
    return [[...members]];
  }
  const communities = new Map<string, string[]>();
  for (const member of members) {
    const community = proposed.get(member) ?? member;
    const group = communities.get(community) ?? [];
    group.push(member);
    communities.set(community, group);
  }
  return [...communities.values()];
}

function findRoot(parent: Map<string, string>, id: string): string {
  const lineage: string[] = [];
  let root = id;
  while (parent.get(root) !== root) {
    lineage.push(root);
    root = parent.get(root) ?? root;
  }
  for (const member of lineage) parent.set(member, root);
  return root;
}

/**
 * Build the complete canonical trace used by both audit and findings draws.
 *
 * `policy` is REQUIRED and has no default: a draw that forgot to declare its
 * eligibility would otherwise silently inherit the other draw's, which is
 * exactly the class of latent failure this project refuses to leave to a
 * caller's memory. Pass {@link TASK_DRAW_COHERENCE_POLICY} or
 * {@link FINDINGS_DRAW_COHERENCE_POLICY}.
 */
export function buildContentCoherenceTrace(
  input: ContentCoherenceInput | Record<string, unknown>,
  policy: ContentCoherencePolicy,
): ContentCoherenceTrace {
  if (!isRecord(input)) {
    throw new Error("Content-coherence input must be an object.");
  }
  const normalizedItems = normalizeItems(input.items);
  const itemIds = new Set(normalizedItems.map((item) => item.id));
  const relationshipEvidence = normalizeRelationshipEvidence(
    input.relationships,
    itemIds,
  );
  // Only ELIGIBLE pairs are retained. The ineligible majority (82% of pairs on
  // the 3,194-finding dogfood run) can affect nothing downstream — union-find
  // consumes eligibility alone — so materializing the full O(N²) pair layer was
  // pure cost. Scoring itself is unchanged; the sort comparator below is total
  // over distinct (left,right) pairs, so filtering during the scan yields the
  // byte-identical candidate order the filter-then-sort form produced.
  const eligibleCandidates: CoherenceCandidate[] = [];

  for (let leftIndex = 0; leftIndex < normalizedItems.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < normalizedItems.length;
      rightIndex += 1
    ) {
      const left = normalizedItems[leftIndex]!;
      const right = normalizedItems[rightIndex]!;
      const evidence = directEvidence(left, right);
      // Captured BEFORE relationship evidence is folded in — the conjunctive
      // policy must read only what the items themselves assert.
      const direct: DirectConjuncts = {
        sharedFile: evidence.shared_file,
        sameLens: evidence.shared_semantic_tag_or_same_lens,
      };
      for (const kind of relationshipEvidence.get(pairKey(left.id, right.id)) ?? []) {
        evidence[kind] = true;
      }
      const score = scoreEvidence(evidence);
      if (!isEligible(direct, score, policy)) continue;
      eligibleCandidates.push({ left: left.id, right: right.id, score });
    }
  }

  eligibleCandidates.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    const leftDelta = compareCodeUnits(left.left, right.left);
    return leftDelta !== 0
      ? leftDelta
      : compareCodeUnits(left.right, right.right);
  });

  const parent = new Map(normalizedItems.map((item) => [item.id, item.id]));
  for (const candidate of eligibleCandidates) {
    const leftRoot = findRoot(parent, candidate.left);
    const rightRoot = findRoot(parent, candidate.right);
    if (leftRoot === rightRoot) continue;
    const root =
      compareCodeUnits(leftRoot, rightRoot) <= 0 ? leftRoot : rightRoot;
    const other = root === leftRoot ? rightRoot : leftRoot;
    parent.set(other, root);
  }

  const groups = new Map<string, string[]>();
  for (const item of normalizedItems) {
    const root = findRoot(parent, item.id);
    const members = groups.get(root) ?? [];
    members.push(item.id);
    groups.set(root, members);
  }
  // Bucket the eligible pairs by the component they ended up inside, so
  // refinement reads each component's own weighted evidence graph once.
  const candidatesByRoot = new Map<string, CoherenceCandidate[]>();
  if (policy.refineAtModularityPeak) {
    for (const candidate of eligibleCandidates) {
      const root = findRoot(parent, candidate.left);
      const bucket = candidatesByRoot.get(root) ?? [];
      bucket.push(candidate);
      candidatesByRoot.set(root, bucket);
    }
  }
  const merged = [...groups.entries()].map(
    ([root, members]) => [root, members.sort(compareCodeUnits)] as const,
  );
  const components = (
    policy.refineAtModularityPeak
      ? merged.flatMap(([root, members]) =>
          refineAtModularityPeak(members, candidatesByRoot.get(root) ?? []),
        )
      : merged.map(([, members]) => members)
  )
    .map((members) => [...members].sort(compareCodeUnits))
    .sort((left, right) =>
      compareCodeUnits(left[0] ?? "", right[0] ?? ""),
    );

  return {
    normalized_items: normalizedItems,
    components,
  };
}
