// sites-pinned: tests/shared/charter-layer.test.ts, tests/shared/charter-lane-dag.test.ts
// The five-step charter layer — deterministic ENFORCEMENT half (design of record:
// spec/conceptual-design-review-design.md §"The estimator charters", steps 1–5;
// decision record docs/reviews/charter-redesign-feedback-2026-09-15.md).
//
// Division of labour: the host lanes emit JUDGMENT (three goal DAGs, the confirmed
// correspondences and typed differences, the fidelity verdicts); this module is the
// tool-owned half that grounds, validates, derives and routes:
//   1. `assembleLaneGraph`      — one lane submission → a persisted lane DAG (ids
//                                  unique, edges resolve, NO cycles, levels derived,
//                                  file scopes grounded against the repo universe).
//   2. `proposeCorrespondences` — tool candidates from file overlap + provenance
//                                  cross-refs (deterministic, content-keyed ids).
//   3. `assembleComparison`     — the comparison submission → confirmed
//                                  correspondences + difference records, each routed
//                                  by the FIXED `(dimension, relation, split)` table.
//   4. `applyFidelity`          — tool pre-check verdicts + lane verdicts stamped on.
//   5. `differenceFindings`     — `supported` finding candidates → Finding leads.
// PURE + deterministic + language-neutral: no IO, no LLM. Provenance-on-disk
// grounding is the ingest's concern (it hands the pre-check its read results).

import { z } from "zod";
import { hashContent } from "../hash.js";
import { compareCodeUnits } from "../compareCodeUnits.js";
import { parseCitationRef } from "../validation/citationGrounding.js";
import {
  CharterLaneGraphSchema,
  CharterLaneKindSchema,
  CharterProvenanceSchema,
  CharterConfidenceSchema,
  CorrespondenceMemberSchema,
  DifferenceDimensionSchema,
  DifferenceRelationSchema,
  DifferenceSplitSchema,
  DifferenceAccountSchema,
  type CharterLaneGraph,
  type CharterLaneKind,
  type CorrespondenceCandidate,
  type CharterCorrespondence,
  type CharterDifference,
  type CharterProvenance,
  type DifferenceRoute,
  type FidelityVerdict,
  type LaneGoalNode,
} from "../types/charter.js";
import type { Finding } from "../types/finding.js";

// ── Step 1: lane submission → lane DAG ─────────────────────────────────────────

/** A node as a LANE submits it: local id, telos, optional scope, evidence, confidence. */
const LaneNodeInputSchema = z
  .object({
    node_id: z.string().min(1),
    purpose: z.string().min(1),
    files: z.array(z.string()).optional(),
    provenance: z.array(CharterProvenanceSchema),
    confidence: CharterConfidenceSchema,
  })
  .strict();

const LaneEdgeInputSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    provenance: z.array(CharterProvenanceSchema),
  })
  .strict();

/**
 * The charter-EXTRACTION submission (step 1): ONE blind lane's goal DAG. The lane
 * mints local ids; `premise_height` is not asked for (the tool derives it);
 * `files` is optional (the Stated lane cites provenance only).
 *
 * It asks for NO `kind`. Each lane writes its own file at a lane-bound path
 * (`charter_extraction_<kind>`, `laneSubmissionPath`), so the TOOL already knows
 * which lane spoke and stamps the kind at merge. A lane restating its own kind
 * was the one thing in this contract that could only ever check the lane against
 * itself (owner review of prompt 8, 2026-09-17).
 */
export const CharterSubmissionSchema = z
  .object({
    nodes: z.array(LaneNodeInputSchema).default([]),
    edges: z.array(LaneEdgeInputSchema).default([]),
  })
  .strict();
export type CharterSubmission = z.infer<typeof CharterSubmissionSchema>;

/**
 * ONE lane's DAG as the TOOL records it: the lane's own submission plus the kind
 * the tool stamped from the bound path it arrived on. This is the shape every
 * consumer downstream of the merge reads, and the only one that carries `kind`.
 */
export const CharterMergedLaneSchema = CharterSubmissionSchema.extend({
  kind: CharterLaneKindSchema,
}).strict();
export type CharterMergedLane = z.infer<typeof CharterMergedLaneSchema>;

/** The TOOL-merged extraction submission: every lane's DAG, handed to the executor by path. */
export const CharterExtractionMergedSchema = z
  .object({ lanes: z.array(CharterMergedLaneSchema) })
  .strict();
export type CharterExtractionMerged = z.infer<typeof CharterExtractionMergedSchema>;

export interface AssembledLaneGraph {
  graph: CharterLaneGraph;
  validation_issues: string[];
}

/**
 * Validate one lane's submission into its persisted DAG. Deterministic: same
 * submission + same universe → same graph. Refusals, per node/edge, are recorded
 * as validation issues (surfaced, never silent):
 * - a duplicate `node_id` keeps the first and drops the rest;
 * - an edge naming an unknown node, or a self-edge, is dropped;
 * - a file outside the universe is dropped from the node's scope (a node left with
 *   an EMPTY declared scope keeps `files` absent, i.e. becomes provenance-only);
 * - a CYCLE refuses the whole edge set: every edge on a cycle is dropped and the
 *   issue names the cycle, because a level cannot be derived from a cyclic graph
 *   and a silently broken cycle would hide which edge the lane drafted backwards
 *   ([[inverted-neighbor-edges-manufacture-a-cycle]]).
 * `premise_height` = longest path from a ROOT (a node that serves nothing) down to
 * the node, so 0 is a top-level purpose and a leaf mechanism sits deepest.
 */
export function assembleLaneGraph(
  submission: CharterMergedLane,
  params: { universe: ReadonlySet<string> },
): AssembledLaneGraph {
  const validation_issues: string[] = [];
  const kind = submission.kind;

  // Nodes: unique ids, grounded scopes.
  const byId = new Map<string, LaneGoalNode>();
  for (const node of submission.nodes) {
    if (byId.has(node.node_id)) {
      validation_issues.push(
        `${kind}: duplicate node_id "${node.node_id}" — kept the first, dropped the rest`,
      );
      continue;
    }
    let files: string[] | undefined;
    if (node.files !== undefined) {
      const known = [...new Set(node.files)].filter((f) => params.universe.has(f));
      const unknown = node.files.filter((f) => !params.universe.has(f));
      if (unknown.length > 0) {
        validation_issues.push(
          `${kind}: node "${node.node_id}" cites file(s) outside the repo universe — dropped from its scope (${[...new Set(unknown)]
            .sort(compareCodeUnits)
            .join(", ")})`,
        );
      }
      files = known.length > 0 ? known.sort(compareCodeUnits) : undefined;
    }
    byId.set(node.node_id, {
      node_id: node.node_id,
      purpose: node.purpose,
      premise_height: 0,
      ...(files !== undefined ? { files } : {}),
      provenance: node.provenance,
      confidence: node.confidence,
    });
  }

  // Edges: resolve, no self-edges, no duplicates.
  const edgeKeys = new Set<string>();
  const edges: CharterLaneGraph["edges"] = [];
  for (const edge of submission.edges) {
    if (edge.from === edge.to) {
      validation_issues.push(`${kind}: edge "${edge.from}" serves itself — dropped`);
      continue;
    }
    if (!byId.has(edge.from) || !byId.has(edge.to)) {
      validation_issues.push(
        `${kind}: edge ${edge.from} → ${edge.to} names an unknown node — dropped`,
      );
      continue;
    }
    const key = `${edge.from} -> ${edge.to}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    edges.push({ from: edge.from, to: edge.to, provenance: edge.provenance });
  }

  // Cycle check (Kahn over the SERVES direction). Nodes left unprocessed lie on or
  // downstream of a cycle; every edge among them is refused and the issue names them.
  const acyclicEdges = refuseCycles(kind, [...byId.keys()], edges, validation_issues);

  // Levels: longest path from a root. `from` serves `to`, so `to` is the parent;
  // height(child) = max(height(parent)) + 1; roots (serve nothing) are 0.
  const parentsOf = new Map<string, string[]>();
  for (const e of acyclicEdges) {
    const list = parentsOf.get(e.from) ?? [];
    list.push(e.to);
    parentsOf.set(e.from, list);
  }
  const height = new Map<string, number>();
  const heightOf = (id: string): number => {
    const cached = height.get(id);
    if (cached !== undefined) return cached;
    const parents = parentsOf.get(id) ?? [];
    const h = parents.length === 0 ? 0 : Math.max(...parents.map(heightOf)) + 1;
    height.set(id, h);
    return h;
  };

  const nodes = [...byId.values()]
    .map((n) => ({ ...n, premise_height: heightOf(n.node_id) }))
    .sort((a, b) => compareCodeUnits(a.node_id, b.node_id));
  const sortedEdges = [...acyclicEdges].sort(
    (a, b) => compareCodeUnits(a.from, b.from) || compareCodeUnits(a.to, b.to),
  );

  return {
    graph: CharterLaneGraphSchema.parse({ kind, nodes, edges: sortedEdges }),
    validation_issues,
  };
}

function refuseCycles(
  kind: CharterLaneKind,
  ids: string[],
  edges: CharterLaneGraph["edges"],
  issues: string[],
): CharterLaneGraph["edges"] {
  const indegree = new Map<string, number>(ids.map((id) => [id, 0]));
  const out = new Map<string, string[]>();
  for (const e of edges) {
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
    const list = out.get(e.from) ?? [];
    list.push(e.to);
    out.set(e.from, list);
  }
  const queue = ids.filter((id) => (indegree.get(id) ?? 0) === 0).sort(compareCodeUnits);
  const done = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    done.add(id);
    for (const next of out.get(id) ?? []) {
      const d = (indegree.get(next) ?? 1) - 1;
      indegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  if (done.size === ids.length) return edges;
  const cyclic = ids.filter((id) => !done.has(id)).sort(compareCodeUnits);
  const cyclicSet = new Set(cyclic);
  const refused = edges.filter((e) => cyclicSet.has(e.from) && cyclicSet.has(e.to));
  issues.push(
    `${kind}: the goal graph has a cycle through ${cyclic.map((c) => `"${c}"`).join(", ")} — ${refused.length} edge(s) among those nodes refused; a level cannot be derived from a cycle (an edge drafted as "what the parent needs from me" instead of "what I serve" is the usual cause)`,
  );
  return edges.filter((e) => !(cyclicSet.has(e.from) && cyclicSet.has(e.to)));
}

// ── Step 2: tool-proposed correspondence candidates ────────────────────────────

/**
 * The path part of a provenance ref: `<path>#<symbol>` or `<path>:<line>` →
 * `<path>`. ONE home for the grammar — this delegates to `parseCitationRef`
 * rather than scanning the ref itself.
 *
 * It scanned the ref itself until 2026-09-17, and the two scanners disagreed on
 * half the forms prompt 8 teaches: this one stripped `#<symbol>` but not a
 * RANGE, the parser stripped a range but not `#<symbol>`. So `src/a.ts:12-19`
 * reached `crossRefPaths`, `assembleComparison` and the fidelity packet as a
 * path no file can match — a correspondence candidate silently missed, a
 * host-added correspondence silently dropped as "fewer than two checkable
 * evidence refs", and a packet slice that could only report the file as
 * unreadable. An unresolvable ref is returned unchanged, exactly as before.
 */
export function provenancePath(ref: string): string {
  return parseCitationRef(ref)?.path ?? ref;
}

function memberKey(members: readonly { kind: CharterLaneKind; node_ids: readonly string[] }[]): string {
  return [...members]
    .map((m) => `${m.kind}:${[...m.node_ids].sort(compareCodeUnits).join(",")}`)
    .sort(compareCodeUnits)
    .join("|");
}

/**
 * Propose correspondence candidates between every pair of lanes. Two signals, both
 * deterministic and content-derived:
 * - `file_overlap`: the nodes' file scopes share ≥1 path;
 * - `cross_ref`: a node's provenance cites a path (`<path>#<symbol>` / `<path>:<line>`)
 *   that lies in the other node's file scope (the Stated lane's usual key).
 * A pair related by both is reported once, as `file_overlap` (the stronger signal),
 * with the union of evidence paths. Candidate ids are content-keyed on the member
 * set, so re-proposal never churns the artifact.
 */
export function proposeCorrespondences(
  graphs: readonly CharterLaneGraph[],
): CorrespondenceCandidate[] {
  const byKey = new Map<string, CorrespondenceCandidate>();
  const sorted = [...graphs].sort((a, b) => compareCodeUnits(a.kind, b.kind));
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const a = sorted[i]!;
      const b = sorted[j]!;
      if (a.kind === b.kind) continue;
      for (const na of a.nodes) {
        for (const nb of b.nodes) {
          const overlap = fileOverlap(na, nb);
          const crossRefs = overlap.length > 0 ? [] : crossRefPaths(na, nb);
          if (overlap.length === 0 && crossRefs.length === 0) continue;
          const members = [
            { kind: a.kind, node_ids: [na.node_id] },
            { kind: b.kind, node_ids: [nb.node_id] },
          ];
          const key = memberKey(members);
          if (byKey.has(key)) continue;
          byKey.set(key, {
            candidate_id: `cand-${hashContent(key, { length: 10 })}`,
            members,
            basis: overlap.length > 0 ? "file_overlap" : "cross_ref",
            evidence_paths: (overlap.length > 0 ? overlap : crossRefs).sort(compareCodeUnits),
          });
        }
      }
    }
  }
  return [...byKey.values()].sort((a, b) => compareCodeUnits(a.candidate_id, b.candidate_id));
}

function fileOverlap(a: LaneGoalNode, b: LaneGoalNode): string[] {
  if (!a.files || !b.files) return [];
  const setB = new Set(b.files);
  return [...new Set(a.files.filter((f) => setB.has(f)))];
}

function crossRefPaths(a: LaneGoalNode, b: LaneGoalNode): string[] {
  const hits = new Set<string>();
  const collect = (from: LaneGoalNode, into: LaneGoalNode): void => {
    if (!into.files) return;
    const scope = new Set(into.files);
    for (const p of from.provenance) {
      const path = provenancePath(p.ref);
      if (scope.has(path)) hits.add(path);
    }
  };
  collect(a, b);
  collect(b, a);
  return [...hits];
}

// ── Step 3: the comparison submission → correspondences + differences ──────────

const CorrespondenceInputSchema = z
  .object({
    candidate_id: z.string().min(1).optional(),
    verdict: z.enum(["confirm", "reject", "widen"]),
    members: z.array(CorrespondenceMemberSchema).min(2),
    evidence: z.array(CharterProvenanceSchema).default([]),
  })
  .strict();

/**
 * The account minimum is CONDITIONAL on the dimension (owner, 2026-09-17), not flat.
 * `presence` means one channel of the correspondence has no node for the goal, and
 * the tool identifies that channel by its ABSENCE from `accounts` — so a presence
 * difference always carries one account fewer than its correspondence has channels.
 * A flat minimum of two made a presence gap inexpressible on a two-channel
 * correspondence: the silent channel must supply nothing, which left one account.
 * Every other dimension still needs two, because an account that contradicts no
 * other account is not a difference.
 */
const DifferenceInputSchema = z
  .object({
    /** The candidate_id, or the 0-based index into `correspondences`, this rests on. */
    correspondence: z.union([z.string().min(1), z.number().int().min(0)]),
    dimension: DifferenceDimensionSchema,
    relation: DifferenceRelationSchema,
    split: DifferenceSplitSchema.optional(),
    accounts: z.array(DifferenceAccountSchema).min(1),
    gap: z.string().min(1),
    covered_channel_gap: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.dimension !== "presence" && value.accounts.length < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["accounts"],
        message: `a ${value.dimension} difference needs an account from at least two channels; only a presence difference may carry one`,
      });
    }
  });

/**
 * The charter-COMPARISON submission (steps 2–3): the comparison reader's verdicts
 * on the tool candidates (plus any it adds), and the typed differences. An empty
 * result must affirm `no_correspondences: true` (a silent empty is indistinguishable
 * from a reader that never ran).
 */
export const CharterComparisonSubmissionSchema = z
  .object({
    correspondences: z.array(CorrespondenceInputSchema).default([]),
    differences: z.array(DifferenceInputSchema).default([]),
    no_correspondences: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const confirmed = value.correspondences.filter((c) => c.verdict !== "reject").length;
    if (confirmed === 0 && value.no_correspondences !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["no_correspondences"],
        message:
          "a submission that confirms or adds no correspondence must affirm `no_correspondences: true`",
      });
    }
    if (confirmed > 0 && value.no_correspondences === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["no_correspondences"],
        message: "`no_correspondences: true` alongside confirmed correspondences is contradictory",
      });
    }
  });
export type CharterComparisonSubmission = z.infer<typeof CharterComparisonSubmissionSchema>;

export interface AssembledComparison {
  correspondences: CharterCorrespondence[];
  differences: CharterDifference[];
  validation_issues: string[];
}

interface Route {
  routed_to: DifferenceRoute;
  severity: Finding["severity"];
}

/**
 * The design's routing table (step 5), keyed on `(dimension, relation, split)`.
 * The host never picks a route. Non-incompatible records route nowhere except a
 * covered-channel Presence gap, which routes by the silent channel (Stated silent →
 * doc rot for the remediator; a code channel silent → a clarification).
 */
export function routeDifference(input: {
  dimension: CharterDifference["dimension"];
  relation: CharterDifference["relation"];
  split?: CharterDifference["split"];
  covered_channel_gap?: boolean;
  silent?: CharterLaneKind;
}): Route {
  const { dimension, relation, split } = input;
  if (relation !== "incompatible") {
    if (dimension === "presence" && input.covered_channel_gap === true) {
      return input.silent === "stated"
        ? { routed_to: "remediator", severity: "low" }
        : { routed_to: "clarification", severity: "medium" };
    }
    return { routed_to: "none", severity: "info" };
  }
  if (!split || split.kind === "three_way") {
    return { routed_to: "clarification", severity: "high" };
  }
  const odd = split.odd;
  switch (dimension) {
    case "purpose":
    case "scope":
      return odd === "stated"
        ? { routed_to: "remediator", severity: "low" }
        : { routed_to: "clarification", severity: "medium" };
    case "responsibility":
    case "hierarchy":
      return { routed_to: "clarification", severity: "medium" };
    case "standing":
    case "standard":
      return { routed_to: "clarification", severity: "medium" };
    case "presence":
      return odd === "stated"
        ? { routed_to: "remediator", severity: "low" }
        : { routed_to: "clarification", severity: "medium" };
    default:
      return { routed_to: "clarification", severity: "medium" };
  }
}

/**
 * Assemble the confirmed correspondences and the difference records from the
 * comparison submission. Refusals are validation issues, never silent:
 * - a member naming a node absent from its lane's DAG;
 * - a `confirm`/`widen` naming an unknown candidate;
 * - a host-added correspondence (no candidate) with fewer than two evidence refs
 *   whose PATHS lie in the repo universe, or whose refs are all on one side;
 * - a difference naming no confirmed correspondence, an account for a lane not in
 *   that correspondence, an `incompatible` relation without a `split`, or a split
 *   with a non-incompatible relation;
 * - a `presence` difference that does not leave EXACTLY ONE channel of its
 *   correspondence out of `accounts` — the omission is what names the silent
 *   channel, and the route turns on which channel it is.
 * Ids are content-keyed (member set / correspondence + dimension + gap).
 */
export function assembleComparison(
  submission: CharterComparisonSubmission,
  params: { candidates: readonly CorrespondenceCandidate[]; graphs: readonly CharterLaneGraph[]; universe: ReadonlySet<string> },
): AssembledComparison {
  const validation_issues: string[] = [];
  const nodeIdsByKind = new Map<CharterLaneKind, Set<string>>(
    params.graphs.map((g) => [g.kind, new Set(g.nodes.map((n) => n.node_id))]),
  );
  const candidateById = new Map(params.candidates.map((c) => [c.candidate_id, c]));

  const correspondences: CharterCorrespondence[] = [];
  const byInputIndex = new Map<number, string>();
  const byCandidate = new Map<string, string>();
  const seenKeys = new Set<string>();

  submission.correspondences.forEach((input, index) => {
    if (input.verdict === "reject") return;
    const badMember = input.members.find(
      (m) => m.node_ids.some((id) => !(nodeIdsByKind.get(m.kind)?.has(id) ?? false)),
    );
    if (badMember) {
      validation_issues.push(
        `correspondence #${index}: names node(s) absent from the ${badMember.kind} DAG — dropped`,
      );
      return;
    }
    if (new Set(input.members.map((m) => m.kind)).size < 2) {
      validation_issues.push(`correspondence #${index}: spans fewer than two lanes — dropped`);
      return;
    }
    let basis: CharterCorrespondence["basis"] = "host";
    if (input.candidate_id !== undefined) {
      if (!candidateById.has(input.candidate_id)) {
        validation_issues.push(
          `correspondence #${index}: candidate "${input.candidate_id}" is not a tool candidate — dropped`,
        );
        return;
      }
      basis = "tool";
    } else {
      // A host-added correspondence needs two CHECKABLE refs (their paths lie in
      // the repo universe) on at least two different sides — one per lane it joins.
      // A ref is attributed to the member whose scope holds its path; a checkable
      // ref no member scope holds counts, but only as one unattributed side.
      const sides = new Set<string>();
      for (const p of input.evidence) {
        const path = provenancePath(p.ref);
        if (!params.universe.has(path)) continue;
        sides.add(ownerOfPath(input.members, params.graphs, path) ?? `unattributed:${path}`);
      }
      if (sides.size < 2) {
        validation_issues.push(
          `correspondence #${index}: host-added with fewer than two checkable evidence refs on different sides — dropped`,
        );
        return;
      }
    }
    const key = memberKey(input.members);
    if (seenKeys.has(key)) {
      validation_issues.push(`correspondence #${index}: duplicates an earlier member set — dropped`);
      return;
    }
    seenKeys.add(key);
    const correspondence_id = `corr-${hashContent(key, { length: 10 })}`;
    correspondences.push({
      correspondence_id,
      members: [...input.members]
        .map((m) => ({ kind: m.kind, node_ids: [...m.node_ids].sort(compareCodeUnits) }))
        .sort((a, b) => compareCodeUnits(a.kind, b.kind)),
      basis,
      ...(input.candidate_id !== undefined ? { candidate_id: input.candidate_id } : {}),
      evidence: input.evidence,
    });
    byInputIndex.set(index, correspondence_id);
    if (input.candidate_id !== undefined) byCandidate.set(input.candidate_id, correspondence_id);
  });

  const corrById = new Map(correspondences.map((c) => [c.correspondence_id, c]));
  const differences: CharterDifference[] = [];
  const seenDiff = new Set<string>();
  submission.differences.forEach((input, index) => {
    const corrId =
      typeof input.correspondence === "number"
        ? byInputIndex.get(input.correspondence)
        : (byCandidate.get(input.correspondence) ?? (corrById.has(input.correspondence) ? input.correspondence : undefined));
    const corr = corrId ? corrById.get(corrId) : undefined;
    if (!corr) {
      validation_issues.push(
        `difference #${index}: names no confirmed correspondence (${String(input.correspondence)}) — dropped`,
      );
      return;
    }
    const lanes = new Set(corr.members.map((m) => m.kind));
    const stray = input.accounts.find((a) => !lanes.has(a.kind));
    if (stray) {
      validation_issues.push(
        `difference #${index}: carries an account for "${stray.kind}", a lane outside its correspondence — dropped`,
      );
      return;
    }
    if (input.relation === "incompatible" && !input.split) {
      validation_issues.push(`difference #${index}: incompatible without a split — dropped`);
      return;
    }
    if (input.relation !== "incompatible" && input.split) {
      validation_issues.push(`difference #${index}: a split on a ${input.relation} relation — dropped`);
      return;
    }
    if (input.split?.kind === "two_against_one" && !lanes.has(input.split.odd)) {
      validation_issues.push(
        `difference #${index}: split names "${input.split.odd}" as the odd channel, which is not in its correspondence — dropped`,
      );
      return;
    }
    if (input.split?.kind === "three_way" && lanes.size < 3) {
      validation_issues.push(`difference #${index}: three_way split on a two-lane correspondence — dropped`);
      return;
    }
    const accounts = [...input.accounts].sort((a, b) => compareCodeUnits(a.kind, b.kind));
    // A presence difference names its silent channel by OMITTING it, and the route
    // turns on which channel that is (a silent Stated channel is doc rot for the
    // remediator; a silent code channel is a clarification). So exactly one channel
    // of the correspondence may be silent: none makes the record self-contradictory,
    // and two would let the route be picked by lane order instead of by evidence.
    let silent: CharterLaneKind | undefined;
    if (input.dimension === "presence") {
      const silentLanes = [...lanes].filter((k) => !accounts.some((a) => a.kind === k));
      if (silentLanes.length !== 1) {
        validation_issues.push(
          `difference #${index}: a presence difference must leave EXACTLY ONE channel of its correspondence out of \`accounts\` — ${silentLanes.length === 0 ? "every channel is accounted for, so nothing is absent" : `${silentLanes.length} are absent (${silentLanes.join(", ")})`} — dropped`,
        );
        return;
      }
      silent = silentLanes[0];
    }
    const route = routeDifference({
      dimension: input.dimension,
      relation: input.relation,
      split: input.split,
      covered_channel_gap: input.covered_channel_gap,
      silent,
    });
    const difference_id = `diff-${hashContent(`${corr.correspondence_id}|${input.dimension}|${input.gap}`, { length: 10 })}`;
    if (seenDiff.has(difference_id)) {
      validation_issues.push(`difference #${index}: duplicates an earlier record — dropped`);
      return;
    }
    seenDiff.add(difference_id);
    differences.push({
      difference_id,
      correspondence_id: corr.correspondence_id,
      dimension: input.dimension,
      relation: input.relation,
      ...(input.split ? { split: input.split } : {}),
      accounts,
      gap: input.gap,
      ...(input.covered_channel_gap !== undefined ? { covered_channel_gap: input.covered_channel_gap } : {}),
      routed_to: route.routed_to,
      finding_candidate:
        input.relation === "incompatible" ||
        (input.dimension === "presence" && input.covered_channel_gap === true),
    });
  });

  correspondences.sort((a, b) => compareCodeUnits(a.correspondence_id, b.correspondence_id));
  differences.sort((a, b) => compareCodeUnits(a.difference_id, b.difference_id));
  return { correspondences, differences, validation_issues };
}

function ownerOfPath(
  members: readonly { kind: CharterLaneKind; node_ids: readonly string[] }[],
  graphs: readonly CharterLaneGraph[],
  path: string,
): CharterLaneKind | undefined {
  for (const m of members) {
    const graph = graphs.find((g) => g.kind === m.kind);
    if (!graph) continue;
    for (const id of m.node_ids) {
      const node = graph.nodes.find((n) => n.node_id === id);
      if (node?.files?.includes(path)) return m.kind;
    }
  }
  return undefined;
}

// ── Step 4: fidelity ───────────────────────────────────────────────────────────

/** The fidelity lane's submission: one verdict per difference in its packet. */
export const CharterFidelitySubmissionSchema = z
  .object({
    verdicts: z
      .array(
        z
          .object({
            difference_id: z.string().min(1),
            verdict: z.enum(["supported", "interpretation", "unverifiable"]),
            over_read_side: CharterLaneKindSchema.optional(),
            rationale: z.string().min(1),
          })
          .strict()
          .superRefine((v, ctx) => {
            if (v.verdict === "interpretation" && !v.over_read_side) {
              ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["over_read_side"], message: "an interpretation verdict names the side that over-read" });
            }
            if (v.verdict !== "interpretation" && v.over_read_side) {
              ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["over_read_side"], message: "over_read_side only with an interpretation verdict" });
            }
          }),
      )
      .default([]),
  })
  .strict();
export type CharterFidelitySubmission = z.infer<typeof CharterFidelitySubmissionSchema>;

/**
 * The MECHANICAL pre-check (step 4, first half): given, per provenance ref, whether
 * its quote was found at its ref on disk (`quoteFound(ref, quote)` — the ingest reads
 * the files; this module never does), stamp `unverifiable` (decided_by `tool`) on
 * every finding candidate that has a side whose cited quote is absent. Records with
 * every quote present are left for the lane. Returns the differences with the tool
 * verdicts stamped, plus the ids still owed a lane verdict.
 */
export function precheckFidelity(
  differences: readonly CharterDifference[],
  quoteFound: (provenance: CharterProvenance) => boolean | undefined,
): { differences: CharterDifference[]; pendingLane: string[] } {
  const pendingLane: string[] = [];
  const stamped = differences.map((d) => {
    if (!d.finding_candidate) return d;
    const missing = d.accounts.flatMap((a) =>
      a.provenance
        .filter((p) => p.quote !== undefined && quoteFound(p) === false)
        .map((p) => `${a.kind}: ${p.ref}`),
    );
    if (missing.length > 0) {
      const verdict: FidelityVerdict = {
        verdict: "unverifiable",
        rationale: `cited quote not found at ${missing.sort(compareCodeUnits).join("; ")}`,
        decided_by: "tool",
      };
      return { ...d, fidelity: verdict };
    }
    pendingLane.push(d.difference_id);
    return d;
  });
  return { differences: stamped, pendingLane: pendingLane.sort(compareCodeUnits) };
}

/**
 * Stamp the lane's verdicts (step 4, second half). A verdict naming an unknown
 * difference, or a difference the tool already settled, is a validation issue; a
 * finding candidate left without any verdict stays pending (never assumed
 * `supported`).
 */
export function applyFidelity(
  differences: readonly CharterDifference[],
  submission: CharterFidelitySubmission,
): { differences: CharterDifference[]; validation_issues: string[]; still_pending: string[] } {
  const validation_issues: string[] = [];
  const byId = new Map(differences.map((d) => [d.difference_id, d]));
  const verdicts = new Map<string, FidelityVerdict>();
  for (const v of submission.verdicts) {
    const d = byId.get(v.difference_id);
    if (!d) {
      validation_issues.push(`fidelity verdict for unknown difference "${v.difference_id}" — dropped`);
      continue;
    }
    if (d.fidelity?.decided_by === "tool") {
      validation_issues.push(
        `fidelity verdict for "${v.difference_id}" ignored — the tool pre-check already settled it as unverifiable`,
      );
      continue;
    }
    if (verdicts.has(v.difference_id)) {
      validation_issues.push(`duplicate fidelity verdict for "${v.difference_id}" — kept the first`);
      continue;
    }
    verdicts.set(v.difference_id, {
      verdict: v.verdict,
      ...(v.over_read_side ? { over_read_side: v.over_read_side } : {}),
      rationale: v.rationale,
      decided_by: "lane",
    });
  }
  const stamped = differences.map((d) => {
    const v = verdicts.get(d.difference_id);
    return v ? { ...d, fidelity: v } : d;
  });
  const still_pending = stamped
    .filter((d) => d.finding_candidate && !d.fidelity)
    .map((d) => d.difference_id)
    .sort(compareCodeUnits);
  return { differences: stamped, validation_issues, still_pending };
}

// ── Step 5: findings (leads) ───────────────────────────────────────────────────

/**
 * Surface every `supported` finding candidate as a Finding LEAD (leads-not-verdicts).
 * `affected_files` = the union of the corresponding nodes' scopes (the report's
 * grouping evidence); `confidence` = the weakest account's source confidence.
 */
export function differenceFindings(
  differences: readonly CharterDifference[],
  correspondences: readonly CharterCorrespondence[],
  graphs: readonly CharterLaneGraph[],
): Finding[] {
  const corrById = new Map(correspondences.map((c) => [c.correspondence_id, c]));
  const findings: Finding[] = [];
  for (const d of differences) {
    if (!d.finding_candidate || d.fidelity?.verdict !== "supported") continue;
    const corr = corrById.get(d.correspondence_id);
    const files = new Set<string>();
    let weakest: "high" | "medium" | "low" = "high";
    for (const m of corr?.members ?? []) {
      const graph = graphs.find((g) => g.kind === m.kind);
      for (const id of m.node_ids) {
        const node = graph?.nodes.find((n) => n.node_id === id);
        for (const f of node?.files ?? []) files.add(f);
        if (node && rank(node.confidence) < rank(weakest)) weakest = node.confidence;
      }
    }
    const route = routeDifference({
      dimension: d.dimension,
      relation: d.relation,
      split: d.split,
      covered_channel_gap: d.covered_channel_gap,
    });
    findings.push({
      id: d.difference_id,
      title: `Charter ${d.dimension} difference (${describeSplit(d)})`,
      category: `charter_difference:${d.dimension}`,
      severity: route.severity,
      confidence: weakest,
      lens: "architecture",
      summary: `${d.gap} ${d.accounts.map((a) => `[${a.kind}] ${a.claim}`).join(" ")}`,
      affected_files: [...files].sort(compareCodeUnits).map((path) => ({ path })),
      systemic: true,
    });
  }
  return findings.sort((a, b) => compareCodeUnits(a.id, b.id));
}

function rank(c: "high" | "medium" | "low"): number {
  return c === "high" ? 2 : c === "medium" ? 1 : 0;
}

function describeSplit(d: CharterDifference): string {
  if (!d.split) return d.relation;
  return d.split.kind === "three_way" ? "three-way" : `${d.split.odd} against the rest`;
}
