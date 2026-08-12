// The charter layer of the conceptual design-review — assemble a gated charter
// register from host LLM submissions (Phase C; design of record
// spec/conceptual-design-review-design.md §"The estimator charters" + §"The True
// charter needs hard gates").
//
// Division of labour ([[contract-authoring-determinism-direction]]): each blind
// LANE emits JUDGMENT — a self-organized leveled teleology whose nodes carry FILE
// SCOPES (purpose in telos terms + premise height + the files it claims to
// describe); the independent delta miner emits the channel-pair gaps it sees plus
// a triangulated telos per subsystem. This module is the deterministic
// ENFORCEMENT half — it grounds every file scope against the repo universe,
// JOINS the per-kind teleologies to each other and to the decomposition HINT by
// file-set overlap (the decomposition is a scaffold suggestion, never a forced
// node list), selects each unit's per-kind charter mechanically, derives each
// delta's kind + routing from its channel pair (the design's routing table, never
// host discretion), runs the Phase-A hard gates (applyTrueCharterGate drops
// un-falsifiable True; gateCharterDelta forces a low-confidence side to the human
// channel), computes the per-channel-pair disagreement density, and surfaces the
// surviving deltas as Finding leads for synthesis. PURE + deterministic +
// language-neutral (operates on abstract file-path scopes + telos strings, no
// IO): provenance-on-disk grounding is the ingest's concern, not this module's.

import { z } from "zod";
import {
  CharterSchema,
  CharterKindSchema,
  CharterConfidenceSchema,
  CharterProvenanceSchema,
  GoalGraphSchema,
  TeleologyNodeSchema,
  TriangulatedTelosSchema,
  type Charter,
  type CharterKind,
  type CharterDelta,
  type ChannelDisagreement,
  type GoalGraph,
  type TeleologyNode,
  type TriangulatedTelos,
} from "../types/charter.js";
import {
  applyTrueCharterGate,
  gateCharterDelta,
} from "../validation/charterGate.js";
import type { Finding } from "../types/finding.js";

// ── Submission contracts (what the host LLM writes to its bound path) ───────

/**
 * One teleology node as a lane emits it: a charter statement WITH its file scope
 * and emergent level (the `TeleologyNodeSchema` fields, single-sourced — minus
 * `purpose`, which the charter half already carries). The tool assigns unit
 * membership and `charter_id` — the host never picks a join key beyond the
 * content-derived file scope itself.
 */
const CharterNodeInputSchema = CharterSchema.omit({ charter_id: true })
  .extend(TeleologyNodeSchema.omit({ purpose: true }).shape)
  .strict();
type CharterNodeInput = z.infer<typeof CharterNodeInputSchema>;

/**
 * The charter-EXTRACTION submission (Phase C.1): ONE blind lane's self-organized
 * teleology. Deltas are NOT authored here — the independent delta miner mines
 * them in a second pass over the joined charters, so no author marks its own
 * homework. Lanes from every kind are merged (concatenated) before assembly;
 * the join is by file-set overlap, so lanes never need to agree on node ids.
 */
export const CharterSubmissionSchema = z
  .object({
    nodes: z.array(CharterNodeInputSchema).default([]),
  })
  .strict();
export type CharterSubmission = z.infer<typeof CharterSubmissionSchema>;

/**
 * A delta as the miner emits it: the symmetric channel `pair` it sees a gap
 * across + the interpreted `summary` of that gap. The tool derives `kind`,
 * `routed_to`, and `delta_id` — the miner never picks the routing (that is the
 * design's fixed table, enforced here).
 */
const CharterDeltaInputSchema = z
  .object({
    pair: z.tuple([CharterKindSchema, CharterKindSchema]),
    summary: z.string(),
  })
  .strict();

/** One subsystem's mined deltas (delta phase). */
const CharterDeltaSubsystemInputSchema = z
  .object({
    node_id: z.string(),
    deltas: z.array(CharterDeltaInputSchema).default([]),
  })
  .strict();

/**
 * A True nomination as the miner emits it — downstream of triangulation, at the
 * `deepest` ceiling only (the assembly refuses them otherwise; the consent gate
 * moved here when `true` stopped being an extraction lane). Falsifiable-or-drop:
 * `applyTrueCharterGate` enforces the concrete alternative + concrete cost.
 */
const TrueNominationInputSchema = z
  .object({
    node_id: z.string(),
    /** The nominated ideal, in telos terms. */
    purpose: z.string(),
    nominated_alternative: z.string(),
    nominated_cost: z.string(),
    confidence: CharterConfidenceSchema,
    /** May be empty — the ideal cites no source. */
    provenance: z.array(CharterProvenanceSchema).default([]),
  })
  .strict();

/**
 * The charter-DELTA submission (Phase C.2): the independent miner's channel-pair
 * gaps across the already-joined charters, its TRIANGULATED TELOS per subsystem
 * (a unified opinion the owner reacts to — a lead, never a reconciliation), any
 * True nominations (deepest only), plus the goal DAG it reads off all subsystems
 * (it is the only pass that sees every joined unit, so it owns `goal_graph`).
 */
export const CharterDeltaSubmissionSchema = z
  .object({
    subsystems: z.array(CharterDeltaSubsystemInputSchema).default([]),
    triangulated: z.array(TriangulatedTelosSchema).default([]),
    true_nominations: z.array(TrueNominationInputSchema).default([]),
    goal_graph: GoalGraphSchema.optional(),
    /**
     * Explicit clean affirmation — "I mined every subsystem and found no deltas."
     * REQUIRED when the submission carries zero deltas, and REFUSED alongside any
     * delta, so a dead miner (which submits nothing) can never be mistaken for a
     * clean one (same contract as `reviewed_clean` on a zero-finding AuditResult).
     * Keyed to DELTAS only: a clean mine may still carry triangulated teloses.
     */
    no_deltas: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const deltaCount = value.subsystems.reduce((n, s) => n + s.deltas.length, 0);
    if (deltaCount === 0 && value.no_deltas !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["no_deltas"],
        message:
          "a submission with zero deltas must affirm `no_deltas: true` — an empty result " +
          "without the affirmation is indistinguishable from a miner that never ran.",
      });
    }
    if (deltaCount > 0 && value.no_deltas === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["no_deltas"],
        message:
          "`no_deltas: true` alongside mined deltas is contradictory — drop the flag or the deltas.",
      });
    }
  });
export type CharterDeltaSubmission = z.infer<typeof CharterDeltaSubmissionSchema>;

// ── Assembled register (the persisted, gated product) ──────────────────────────

/**
 * One joined subsystem UNIT: its file members, the tool-selected per-kind
 * charters, and every lane's full teleology slice that joined into it (levels
 * preserved — the self-organized structure is the product, the charter is the
 * unit's best-overlap representative of it).
 */
export interface CharterSubsystem {
  node_id: string;
  members: string[];
  charters: Charter[];
  teleologies: Partial<Record<CharterKind, TeleologyNode[]>>;
}

/**
 * The assembled charter layer (Phase C.1): joined per-unit charters + a record
 * of everything the gates dropped (surfaced, never silently discarded).
 */
export interface AssembledCharters {
  subsystems: CharterSubsystem[];
  validation_issues: string[];
}

/**
 * The assembled delta layer (Phase C.2): the routed+gated deltas across all
 * units, the deltas surfaced as Finding leads, the triangulated teloses, the
 * tool-computed disagreement density, the (possibly True-augmented) subsystems,
 * the goal DAG, and the gate drops.
 */
export interface AssembledDeltas {
  subsystems: CharterSubsystem[];
  deltas: CharterDelta[];
  findings: Finding[];
  triangulated: TriangulatedTelos[];
  disagreement: ChannelDisagreement[];
  goal_graph: GoalGraph;
  validation_issues: string[];
}

// ── Deterministic routing table (design §"The estimator charters") ─────────────

/**
 * Canonical charter-kind order — pairs are sorted by this so `[stated, revealed]`
 * and `[revealed, stated]` map to one key (the deltas are symmetric).
 */
const KIND_ORDER: CharterKind[] = ["stated", "structural", "revealed", "true"];

function canonicalPair(pair: [CharterKind, CharterKind]): [CharterKind, CharterKind] {
  return [...pair].sort(
    (a, b) => KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b),
  ) as [CharterKind, CharterKind];
}

interface DeltaRoute {
  kind: CharterDelta["kind"];
  routed_to: CharterDelta["routed_to"];
  severity: Finding["severity"];
}

/**
 * The design's routing table, keyed by canonical `pair` — who acts on each gap.
 * Every ESTIMATOR pair has one defined meaning; `true` pairs exist only for the
 * miner's deepest-rung nominations. A pair OUTSIDE this table has no defined
 * owner and is a validation issue (the tool never invents a route). `severity`
 * ranks the surfaced lead: a wrong-goal provocation is the highest-blast, doc
 * rot the lowest.
 */
const DELTA_ROUTES: Record<string, DeltaRoute> = {
  "stated|structural": {
    kind: "doc_rot",
    routed_to: "remediator",
    severity: "low",
  },
  "stated|revealed": {
    kind: "says_does_drift",
    routed_to: "remediator",
    severity: "medium",
  },
  "structural|revealed": {
    kind: "architecture_betrayal",
    routed_to: "clarification",
    severity: "medium",
  },
  "stated|true": {
    kind: "wrong_goal",
    routed_to: "human",
    severity: "high",
  },
  "structural|true": {
    kind: "wrong_goal",
    routed_to: "human",
    severity: "high",
  },
  "revealed|true": {
    kind: "wrong_goal",
    routed_to: "human",
    severity: "high",
  },
};

/** Lower of two charter confidences — a delta is only as strong as its weaker side. */
function weakerConfidence(a: Charter, b: Charter): Charter["confidence"] {
  const rank = { high: 2, medium: 1, low: 0 } as const;
  return rank[a.confidence] <= rank[b.confidence] ? a.confidence : b.confidence;
}

// ── Assembly: the file-set-overlap JOIN (Phase C.1) ────────────────────────────

/** Stable content-derived node order so assembly never depends on input order. */
function sortNodeInputs(nodes: CharterNodeInput[]): CharterNodeInput[] {
  return [...nodes].sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      a.premise_height - b.premise_height ||
      a.purpose.localeCompare(b.purpose) ||
      (a.files[0] ?? "").localeCompare(b.files[0] ?? ""),
  );
}

/** Sorted intersection size of a node's files against a member set. */
function overlapSize(files: string[], members: ReadonlySet<string>): number {
  let n = 0;
  for (const f of files) if (members.has(f)) n += 1;
  return n;
}

export interface AssembleChartersParams {
  /**
   * The decomposition HINT: consensus `node_id → members`. A scaffold
   * suggestion the join prefers when a node's scope overlaps it — never a
   * forced node list (a lane may organize boundaries the decomposition missed).
   */
  hint: Map<string, string[]>;
  /**
   * The repo file universe. Every teleology node's scope must ground here —
   * a node citing files outside the universe is dropped with an issue (the
   * host cannot conjure files the repo does not contain). The ingest
   * chokepoint additionally REFUSES such lanes loudly before assembly.
   */
  universe: ReadonlySet<string>;
}

/**
 * Assemble the joined charter layer (Phase C.1) from the merged per-lane
 * submissions. Deterministic: same nodes + same hint + same universe always
 * yield the same units, ids, and charter selection.
 *
 * Join: each grounded node maps to the hint unit with the largest file overlap
 * (ties → lexicographically first hint id); nodes overlapping NO hint unit are
 * union-found into residual units on any shared file, across kinds. A unit's id
 * is its hint `node_id` when hinted, else the lexicographically first file of
 * its scope union (provably collision-free: a residual scope contains no hint
 * member, so its first file can never equal a hint id, which IS a hint member).
 * Per unit per kind, the best-overlap node becomes the kind's charter
 * (`charter_id = unit:kind`); every joined node persists in the unit's
 * teleology, levels intact.
 */
export function assembleCharters(
  submission: CharterSubmission,
  params: AssembleChartersParams,
): AssembledCharters {
  const validation_issues: string[] = [];

  // Ground every node against the universe; drop whole nodes on unknown paths
  // (a silently narrowed scope would corrupt the join key).
  const grounded: CharterNodeInput[] = [];
  for (const node of sortNodeInputs(submission.nodes)) {
    const unknown = node.files.filter((f) => !params.universe.has(f));
    if (unknown.length > 0) {
      validation_issues.push(
        `${node.kind} teleology node "${node.purpose.slice(0, 80)}" cites file(s) outside the repo universe — dropped (${unknown
          .sort((a, b) => a.localeCompare(b))
          .join(", ")})`,
      );
      continue;
    }
    grounded.push({ ...node, files: [...new Set(node.files)].sort((a, b) => a.localeCompare(b)) });
  }

  // Hint mapping: node → best-overlap consensus unit.
  const hintIds = [...params.hint.keys()].sort((a, b) => a.localeCompare(b));
  const hintMembers = new Map<string, ReadonlySet<string>>(
    hintIds.map((id) => [id, new Set(params.hint.get(id)!)]),
  );
  const hinted = new Map<string, CharterNodeInput[]>();
  const residual: CharterNodeInput[] = [];
  for (const node of grounded) {
    let bestId: string | undefined;
    let bestOverlap = 0;
    for (const id of hintIds) {
      const overlap = overlapSize(node.files, hintMembers.get(id)!);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestId = id;
      }
    }
    if (bestId !== undefined) {
      const list = hinted.get(bestId) ?? [];
      list.push(node);
      hinted.set(bestId, list);
    } else {
      residual.push(node);
    }
  }

  // Residual union-find: any shared file joins nodes into one unit, across kinds.
  const parent = residual.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const byFile = new Map<string, number>();
  residual.forEach((node, i) => {
    for (const f of node.files) {
      const seen = byFile.get(f);
      if (seen === undefined) byFile.set(f, i);
      else union(seen, i);
    }
  });
  const residualUnits = new Map<number, CharterNodeInput[]>();
  residual.forEach((node, i) => {
    const root = find(i);
    const list = residualUnits.get(root) ?? [];
    list.push(node);
    residualUnits.set(root, list);
  });

  // Materialize units.
  interface UnitDraft {
    node_id: string;
    members: string[];
    nodes: CharterNodeInput[];
  }
  const drafts: UnitDraft[] = [];
  for (const id of hintIds) {
    const nodes = hinted.get(id);
    if (!nodes || nodes.length === 0) continue; // partial coverage is designed
    const members = new Set(params.hint.get(id)!);
    for (const node of nodes) for (const f of node.files) members.add(f);
    drafts.push({
      node_id: id,
      members: [...members].sort((a, b) => a.localeCompare(b)),
      nodes,
    });
  }
  for (const nodes of residualUnits.values()) {
    const members = new Set<string>();
    for (const node of nodes) for (const f of node.files) members.add(f);
    const sorted = [...members].sort((a, b) => a.localeCompare(b));
    drafts.push({ node_id: sorted[0]!, members: sorted, nodes });
  }
  drafts.sort((a, b) => a.node_id.localeCompare(b.node_id));

  // Per unit: teleologies per kind + tool-selected charter per kind + True gate.
  const subsystems: CharterSubsystem[] = [];
  for (const draft of drafts) {
    const memberSet = new Set(draft.members);
    const byKind = new Map<CharterKind, CharterNodeInput[]>();
    for (const node of draft.nodes) {
      const list = byKind.get(node.kind) ?? [];
      list.push(node);
      byKind.set(node.kind, list);
    }
    const teleologies: Partial<Record<CharterKind, TeleologyNode[]>> = {};
    const selected: Charter[] = [];
    for (const kind of KIND_ORDER) {
      const nodes = byKind.get(kind);
      if (!nodes || nodes.length === 0) continue;
      teleologies[kind] = nodes
        .map((n) => ({
          purpose: n.purpose,
          premise_height: n.premise_height,
          files: n.files,
        }))
        .sort(
          (a, b) =>
            a.premise_height - b.premise_height ||
            a.purpose.localeCompare(b.purpose),
        );
      const best = [...nodes].sort(
        (a, b) =>
          overlapSize(b.files, memberSet) - overlapSize(a.files, memberSet) ||
          a.premise_height - b.premise_height ||
          a.purpose.localeCompare(b.purpose),
      )[0]!;
      selected.push({
        charter_id: `${draft.node_id}:${kind}`,
        kind,
        purpose: best.purpose,
        provenance: best.provenance,
        confidence: best.confidence,
        ...(best.nominated_alternative !== undefined
          ? { nominated_alternative: best.nominated_alternative }
          : {}),
        ...(best.nominated_cost !== undefined
          ? { nominated_cost: best.nominated_cost }
          : {}),
      });
    }

    // Phase-A True gate: extraction lanes never author `true`, but the gate
    // stays as the mechanical backstop (falsifiable-or-drop).
    const { kept, dropped } = applyTrueCharterGate(selected);
    for (const drop of dropped) {
      validation_issues.push(`${drop.charter_id}: ${drop.reason}`);
    }
    if (kept.length === 0) continue;

    subsystems.push({
      node_id: draft.node_id,
      members: draft.members,
      charters: [...kept].sort((a, b) => a.charter_id.localeCompare(b.charter_id)),
      teleologies,
    });
  }

  return { subsystems, validation_issues };
}

// ── Assembly: deltas + triangulation (Phase C.2) ───────────────────────────────

export interface AssembleDeltasParams {
  /**
   * Whether True nominations are admissible — true ONLY at the `deepest`
   * ceiling (the consent gate that used to live on the extraction lane set;
   * the executor derives this from the confirmed checkpoint's ceiling).
   */
  allowTrueNominations: boolean;
}

/**
 * Assemble the routed+gated deltas, triangulated teloses, and disagreement
 * density (Phase C.2) from the independent miner's submission, given the
 * already-joined charters. The miner never picks routing — `kind`/`routed_to`
 * derive from the channel pair (the design's fixed table). A delta whose
 * `node_id` has no joined charters, or that references a missing/dropped
 * charter kind, is dropped with an issue; so is a triangulated telos or True
 * nomination naming an unknown unit.
 */
export function assembleDeltas(
  submission: CharterDeltaSubmission,
  subsystems: CharterSubsystem[],
  params: AssembleDeltasParams,
): AssembledDeltas {
  const deltas: CharterDelta[] = [];
  const findings: Finding[] = [];
  const validation_issues: string[] = [];
  const augmented = subsystems.map((s) => ({
    ...s,
    charters: [...s.charters],
  }));
  const byNode = new Map(augmented.map((s) => [s.node_id, s]));

  // True nominations first (deepest only): survivors join the unit's charters
  // and are pair-eligible for this same submission's deltas.
  const nominations = [...submission.true_nominations].sort(
    (a, b) => a.node_id.localeCompare(b.node_id) || a.purpose.localeCompare(b.purpose),
  );
  if (nominations.length > 0 && !params.allowTrueNominations) {
    validation_issues.push(
      `submission carries ${nominations.length} true nomination(s) but the ceiling does not authorize the deepest rung — all dropped (true provocations require explicit deepest opt-in)`,
    );
  } else {
    for (const nomination of nominations) {
      const subsystem = byNode.get(nomination.node_id);
      if (!subsystem) {
        validation_issues.push(
          `true nomination for "${nomination.node_id}" names no joined subsystem — dropped`,
        );
        continue;
      }
      if (subsystem.charters.some((c) => c.kind === "true")) {
        validation_issues.push(
          `subsystem "${nomination.node_id}" has more than one true nomination — kept the first, dropped the rest`,
        );
        continue;
      }
      const candidate: Charter = {
        charter_id: `${nomination.node_id}:true`,
        kind: "true",
        purpose: nomination.purpose,
        provenance: nomination.provenance,
        confidence: nomination.confidence,
        nominated_alternative: nomination.nominated_alternative,
        nominated_cost: nomination.nominated_cost,
      };
      const { kept, dropped } = applyTrueCharterGate([candidate]);
      for (const drop of dropped) {
        validation_issues.push(`${drop.charter_id}: ${drop.reason}`);
      }
      if (kept.length > 0) {
        subsystem.charters.push(kept[0]!);
        subsystem.charters.sort((a, b) => a.charter_id.localeCompare(b.charter_id));
      }
    }
  }

  // Deltas: route by channel pair, gate by confidence, surface as leads.
  const sorted = [...submission.subsystems].sort((a, b) =>
    a.node_id.localeCompare(b.node_id),
  );
  for (const sub of sorted) {
    const subsystem = byNode.get(sub.node_id);
    if (!subsystem) {
      validation_issues.push(
        `delta subsystem "${sub.node_id}" has no assembled charters — dropped (deltas may only span reviewed subsystems)`,
      );
      continue;
    }
    const kept = subsystem.charters;
    const keptByKind = new Map<CharterKind, Charter>(kept.map((c) => [c.kind, c]));

    for (const draft of sub.deltas) {
      const [ka, kb] = canonicalPair(draft.pair);
      if (ka === kb) {
        validation_issues.push(
          `subsystem "${sub.node_id}" delta pairs "${ka}" with itself — dropped`,
        );
        continue;
      }
      const route = DELTA_ROUTES[`${ka}|${kb}`];
      if (!route) {
        validation_issues.push(
          `subsystem "${sub.node_id}" delta [${ka}, ${kb}] has no routing in the design's table — dropped`,
        );
        continue;
      }
      const charterA = keptByKind.get(ka);
      const charterB = keptByKind.get(kb);
      if (!charterA || !charterB) {
        const missing = [!charterA ? ka : null, !charterB ? kb : null]
          .filter((m): m is CharterKind => m !== null)
          .join(" + ");
        validation_issues.push(
          `subsystem "${sub.node_id}" delta [${ka}, ${kb}] references a missing/dropped charter (${missing}) — dropped`,
        );
        continue;
      }

      const baseDelta: CharterDelta = {
        delta_id: `${sub.node_id}:${ka}-${kb}`,
        pair: [ka, kb],
        kind: route.kind,
        routed_to: route.routed_to,
        summary: draft.summary,
      };
      // Phase-A low-confidence gate: a shaky side forces the human channel.
      const gated = gateCharterDelta(baseDelta, kept);
      deltas.push(gated);

      findings.push(
        deltaToFinding(
          gated,
          sub.node_id,
          subsystem.members,
          route.severity,
          weakerConfidence(charterA, charterB),
        ),
      );
    }
  }

  // Triangulated teloses: one per known unit; a lead the owner reacts to.
  const triangulated: TriangulatedTelos[] = [];
  const seenTelos = new Set<string>();
  for (const telos of [...submission.triangulated].sort((a, b) =>
    a.node_id.localeCompare(b.node_id),
  )) {
    if (!byNode.has(telos.node_id)) {
      validation_issues.push(
        `triangulated telos for "${telos.node_id}" names no joined subsystem — dropped`,
      );
      continue;
    }
    if (seenTelos.has(telos.node_id)) {
      validation_issues.push(
        `subsystem "${telos.node_id}" has more than one triangulated telos — kept the first, dropped the rest`,
      );
      continue;
    }
    seenTelos.add(telos.node_id);
    triangulated.push(telos);
  }

  // Disagreement density: tool-computed, per unit per channel pair — the
  // quantitative surface for "which parts of the triangulation need
  // clarification."
  const densityByKey = new Map<string, ChannelDisagreement>();
  for (const delta of deltas) {
    const key = `${delta.delta_id.slice(0, delta.delta_id.lastIndexOf(":"))}|${delta.pair[0]}|${delta.pair[1]}`;
    const nodeId = delta.delta_id.slice(0, delta.delta_id.lastIndexOf(":"));
    const existing = densityByKey.get(key);
    if (existing) {
      densityByKey.set(key, { ...existing, count: existing.count + 1 });
    } else {
      densityByKey.set(key, { node_id: nodeId, pair: delta.pair, count: 1 });
    }
  }
  const disagreement = [...densityByKey.values()].sort(
    (a, b) =>
      a.node_id.localeCompare(b.node_id) ||
      a.pair[0].localeCompare(b.pair[0]) ||
      a.pair[1].localeCompare(b.pair[1]),
  );

  deltas.sort((a, b) => a.delta_id.localeCompare(b.delta_id));
  findings.sort((a, b) => a.id.localeCompare(b.id));

  return {
    subsystems: augmented,
    deltas,
    findings,
    triangulated,
    disagreement,
    goal_graph: submission.goal_graph ?? { nodes: [], edges: [] },
    validation_issues,
  };
}

/**
 * Surface a routed charter delta as a Finding LEAD ([[leads-not-verdicts]] — the
 * owner judges it; a charter delta is never a verdict). `lens` is `architecture`:
 * a charter-boundary gap is a design defect. Members of the subsystem are the
 * affected files (the charter layer operates over file ids).
 */
function deltaToFinding(
  delta: CharterDelta,
  nodeId: string,
  members: string[],
  severity: Finding["severity"],
  confidence: Finding["confidence"],
): Finding {
  const kindLabel = delta.kind.replace(/_/g, " ");
  return {
    id: delta.delta_id,
    title: `Charter delta (${kindLabel}) in subsystem ${nodeId}`,
    category: `charter_delta:${delta.kind}`,
    severity,
    confidence,
    lens: "architecture",
    summary: delta.summary,
    affected_files: members.map((path) => ({ path })),
    systemic: true,
  };
}
