/**
 * Provider-neutral content-coherence decomposition.
 *
 * This module owns membership. Consumers may aggregate presentation metadata
 * over the returned components, but they must not split, merge, or reorder
 * those components.
 */

import { z } from "zod";

export const CONTENT_COHERENCE_SCORES = Object.freeze({
  call_import_reference_adjacency: 70,
  same_directory: 10,
  shared_critical_flow: 60,
  shared_file: 100,
  shared_semantic_tag_or_same_lens: 30,
  shared_unit: 80,
} as const);

export const CONTENT_COHERENCE_THRESHOLD = 60;

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

export interface ContentCoherencePairScore {
  left: string;
  right: string;
  evidence: ContentCoherenceEvidence;
  score: number;
  eligible: boolean;
}

export interface ContentCoherenceCandidate {
  left: string;
  right: string;
  score: number;
}

export interface ContentCoherenceMergeTraceEntry
  extends ContentCoherenceCandidate {
  decision: "merge" | "already_connected";
  root: string;
}

export interface ContentCoherenceTrace {
  normalized_items: NormalizedContentCoherenceItem[];
  pair_scores: ContentCoherencePairScore[];
  eligible_candidates: ContentCoherenceCandidate[];
  merge_trace: ContentCoherenceMergeTraceEntry[];
  merge_decisions: Array<ContentCoherenceMergeTraceEntry["decision"]>;
  components: string[][];
}

export const ContentCoherenceEvidenceSchema = z
  .object({
    call_import_reference_adjacency: z.boolean(),
    same_directory: z.boolean(),
    shared_critical_flow: z.boolean(),
    shared_file: z.boolean(),
    shared_semantic_tag_or_same_lens: z.boolean(),
    shared_unit: z.boolean(),
  })
  .strict();

export const NormalizedContentCoherenceItemSchema = z
  .object({
    id: z.string().min(1),
    file_paths: z.array(z.string()),
    unit_ids: z.array(z.string()),
    tags: z.array(z.string()),
    critical_flow_ids: z.array(z.string()).optional(),
  })
  .strict();

export const ContentCoherencePairScoreSchema = z
  .object({
    left: z.string(),
    right: z.string(),
    evidence: ContentCoherenceEvidenceSchema,
    score: z.number().int(),
    eligible: z.boolean(),
  })
  .strict();

export const ContentCoherenceCandidateSchema = z
  .object({
    left: z.string(),
    right: z.string(),
    score: z.number().int(),
  })
  .strict();

export const ContentCoherenceMergeTraceEntrySchema =
  ContentCoherenceCandidateSchema.extend({
    decision: z.enum(["merge", "already_connected"]),
    root: z.string(),
  }).strict();

export const ContentCoherenceTraceSchema = z
  .object({
    normalized_items: z.array(NormalizedContentCoherenceItemSchema),
    pair_scores: z.array(ContentCoherencePairScoreSchema),
    eligible_candidates: z.array(ContentCoherenceCandidateSchema),
    merge_trace: z.array(ContentCoherenceMergeTraceEntrySchema),
    merge_decisions: z.array(z.enum(["merge", "already_connected"])),
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

/** Build the complete canonical trace used by both audit and findings draws. */
export function buildContentCoherenceTrace(
  input: ContentCoherenceInput | Record<string, unknown>,
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
  const pairScores: ContentCoherencePairScore[] = [];

  for (let leftIndex = 0; leftIndex < normalizedItems.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < normalizedItems.length;
      rightIndex += 1
    ) {
      const left = normalizedItems[leftIndex]!;
      const right = normalizedItems[rightIndex]!;
      const evidence = directEvidence(left, right);
      for (const kind of relationshipEvidence.get(pairKey(left.id, right.id)) ?? []) {
        evidence[kind] = true;
      }
      const score = scoreEvidence(evidence);
      pairScores.push({
        left: left.id,
        right: right.id,
        evidence,
        score,
        eligible: score >= CONTENT_COHERENCE_THRESHOLD,
      });
    }
  }

  const eligibleCandidates = pairScores
    .filter((pair) => pair.eligible)
    .map(({ left, right, score }) => ({ left, right, score }))
    .sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score;
      const leftDelta = compareCodeUnits(left.left, right.left);
      return leftDelta !== 0
        ? leftDelta
        : compareCodeUnits(left.right, right.right);
    });

  const parent = new Map(normalizedItems.map((item) => [item.id, item.id]));
  const mergeTrace: ContentCoherenceMergeTraceEntry[] = [];
  for (const candidate of eligibleCandidates) {
    const leftRoot = findRoot(parent, candidate.left);
    const rightRoot = findRoot(parent, candidate.right);
    if (leftRoot === rightRoot) {
      mergeTrace.push({
        ...candidate,
        decision: "already_connected",
        root: leftRoot,
      });
      continue;
    }
    const root =
      compareCodeUnits(leftRoot, rightRoot) <= 0 ? leftRoot : rightRoot;
    const other = root === leftRoot ? rightRoot : leftRoot;
    parent.set(other, root);
    mergeTrace.push({ ...candidate, decision: "merge", root });
  }

  const groups = new Map<string, string[]>();
  for (const item of normalizedItems) {
    const root = findRoot(parent, item.id);
    const members = groups.get(root) ?? [];
    members.push(item.id);
    groups.set(root, members);
  }
  const components = [...groups.values()]
    .map((members) => members.sort(compareCodeUnits))
    .sort((left, right) =>
      compareCodeUnits(left[0] ?? "", right[0] ?? ""),
    );

  return {
    normalized_items: normalizedItems,
    pair_scores: pairScores,
    eligible_candidates: eligibleCandidates,
    merge_trace: mergeTrace,
    merge_decisions: mergeTrace.map((entry) => entry.decision),
    components,
  };
}
