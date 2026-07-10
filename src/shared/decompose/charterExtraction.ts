// The charter layer of the conceptual design-review — assemble a gated charter
// register from a host LLM submission (Phase C; design of record
// spec/conceptual-design-review-design.md §"The four charters" + §"The True
// charter needs hard gates").
//
// Division of labour ([[contract-authoring-determinism-direction]]): the LLM emits
// JUDGMENT (per consensus subsystem, the four charter families in telos terms +
// the interpreted pairwise deltas it sees); this module is the deterministic
// ENFORCEMENT half — it assigns stable ids, derives each delta's kind + routing
// from its charter pair (the design's routing table, never host discretion), runs
// the Phase-A hard gates (applyTrueCharterGate drops un-falsifiable True;
// gateCharterDelta forces a low-confidence side to the human channel), grounds
// every subsystem against the Phase-B consensus scaffold, and surfaces the
// surviving deltas as Finding leads for synthesis. PURE + deterministic +
// language-neutral (operates on abstract node-id partitions + telos strings, no
// IO): provenance-on-disk grounding is the ingest's concern, not this module's.

import { z } from "zod";
import {
  CharterSchema,
  CharterKindSchema,
  GoalGraphSchema,
  type Charter,
  type CharterKind,
  type CharterDelta,
  type GoalGraph,
} from "../types/charter.js";
import {
  applyTrueCharterGate,
  gateCharterDelta,
} from "../validation/charterGate.js";
import type { Finding } from "../types/finding.js";

// ── Submission contract (what the host LLM writes to incoming/) ────────────────

/**
 * A single charter as the host emits it — the persisted `Charter` minus its
 * `charter_id`, which the tool assigns deterministically (`node_id:kind`) so
 * charter identity can never drift from the host's free choice.
 */
const CharterInputSchema = CharterSchema.omit({ charter_id: true });

/**
 * A delta as the host emits it: the symmetric charter-kind `pair` it sees a gap
 * across + the interpreted `summary` of that gap. The tool derives `kind`,
 * `routed_to`, and `delta_id` — the host never picks the routing (that is the
 * design's fixed table, enforced here).
 */
const CharterDeltaInputSchema = z
  .object({
    pair: z.tuple([CharterKindSchema, CharterKindSchema]),
    summary: z.string(),
  })
  .strict();

/** One reviewed subsystem's charters (extraction phase — charters only). */
const CharterSubsystemInputSchema = z
  .object({
    node_id: z.string(),
    charters: z.array(CharterInputSchema),
  })
  .strict();

/**
 * The charter-EXTRACTION submission (Phase C.1): per consensus subsystem, its
 * charters. Deltas are NOT authored here — an independent delta-miner mines them in
 * a second pass over the assembled charters, so no author marks its own homework and
 * `revealed` can be extracted blind to `stated`. Multiple entries sharing a
 * `node_id` (one per independent per-kind extractor) are merged at assembly.
 */
export const CharterSubmissionSchema = z
  .object({
    subsystems: z.array(CharterSubsystemInputSchema).default([]),
  })
  .strict();
export type CharterSubmission = z.infer<typeof CharterSubmissionSchema>;

/** One subsystem's mined deltas (delta phase). */
const CharterDeltaSubsystemInputSchema = z
  .object({
    node_id: z.string(),
    deltas: z.array(CharterDeltaInputSchema).default([]),
  })
  .strict();

/**
 * The charter-DELTA submission (Phase C.2): the independent delta-miner's pairwise
 * gaps across the already-assembled charters, plus the goal DAG it reads off all
 * subsystems (it is the only pass that sees every merged subsystem, so it owns
 * `goal_graph`).
 */
export const CharterDeltaSubmissionSchema = z
  .object({
    subsystems: z.array(CharterDeltaSubsystemInputSchema).default([]),
    goal_graph: GoalGraphSchema.optional(),
  })
  .strict();
export type CharterDeltaSubmission = z.infer<typeof CharterDeltaSubmissionSchema>;

// ── Assembled register (the persisted, gated product) ──────────────────────────

/** One subsystem's surviving charters, joined to its consensus-scaffold members. */
export interface CharterSubsystem {
  node_id: string;
  members: string[];
  charters: Charter[];
}

/**
 * The assembled charter layer (Phase C.1): gated per-subsystem charters + a record
 * of everything the gates dropped (surfaced, never silently discarded).
 */
export interface AssembledCharters {
  subsystems: CharterSubsystem[];
  validation_issues: string[];
}

/**
 * The assembled delta layer (Phase C.2): the routed+gated deltas across all
 * subsystems, the deltas surfaced as Finding leads, the goal DAG, and the gate
 * drops.
 */
export interface AssembledDeltas {
  deltas: CharterDelta[];
  findings: Finding[];
  goal_graph: GoalGraph;
  validation_issues: string[];
}

// ── Deterministic routing table (design §"The four charters") ──────────────────

/**
 * Canonical charter-kind order — pairs are sorted by this so `[stated, revealed]`
 * and `[revealed, stated]` map to one key (the deltas are symmetric).
 */
const KIND_ORDER: CharterKind[] = ["stated", "inferred", "revealed", "true"];

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
 * A pair OUTSIDE this table has no defined owner and is a validation issue (the
 * tool never invents a route). `severity` ranks the surfaced lead: a wrong-goal
 * provocation is the highest-blast, an unstated assumption the lowest.
 */
const DELTA_ROUTES: Record<string, DeltaRoute> = {
  "stated|inferred": {
    kind: "unstated_assumption",
    routed_to: "clarification",
    severity: "low",
  },
  "stated|revealed": {
    kind: "spec_drift",
    routed_to: "remediator",
    severity: "medium",
  },
  "revealed|true": {
    kind: "wrong_goal",
    routed_to: "human",
    severity: "high",
  },
  "stated|true": {
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

// ── Assembly ───────────────────────────────────────────────────────────────────

/**
 * Assemble the gated charters (Phase C.1) from a validated extraction submission.
 *
 * `membersByNode` grounds each submitted subsystem against the Phase-B consensus
 * scaffold: a `node_id` the structure decomposition never surfaced is an invented
 * subsystem → dropped with an issue (the host cannot conjure boundaries the
 * deterministic layer didn't find). Entries sharing a `node_id` — one per
 * independent per-kind extractor — are merged before assembly. Deterministic: same
 * submission + same scaffold always yields the same charters.
 */
export function assembleCharters(
  submission: CharterSubmission,
  membersByNode: Map<string, string[]>,
): AssembledCharters {
  const subsystems: CharterSubsystem[] = [];
  const validation_issues: string[] = [];

  // Merge input entries sharing a node_id (independent per-kind files each
  // contribute one kind) into one charter list per subsystem before assembly.
  const chartersByNode = new Map<string, z.infer<typeof CharterInputSchema>[]>();
  for (const sub of submission.subsystems) {
    const list = chartersByNode.get(sub.node_id) ?? [];
    list.push(...sub.charters);
    chartersByNode.set(sub.node_id, list);
  }

  // Stable output order: sort by node_id (content-derived, never input order — an
  // incidentally-ordered array churns the artifact hash, cascading phantom
  // staleness; see the extractor-ordering invariant in CLAUDE.md).
  const sortedNodeIds = [...chartersByNode.keys()].sort((a, b) =>
    a.localeCompare(b),
  );

  for (const node_id of sortedNodeIds) {
    const members = membersByNode.get(node_id);
    if (!members) {
      validation_issues.push(
        `subsystem "${node_id}" is not a consensus node in the structure decomposition — dropped (charters may only review discovered subsystems)`,
      );
      continue;
    }

    // Assign ids + enforce one charter per kind (a dup kind — including one from a
    // second per-kind file — is a submission error; keep the first, flag the rest).
    const seenKinds = new Set<CharterKind>();
    const withIds: Charter[] = [];
    for (const input of chartersByNode.get(node_id)!) {
      if (seenKinds.has(input.kind)) {
        validation_issues.push(
          `subsystem "${node_id}" has more than one "${input.kind}" charter — kept the first, dropped the rest`,
        );
        continue;
      }
      seenKinds.add(input.kind);
      withIds.push({ ...input, charter_id: `${node_id}:${input.kind}` });
    }

    // Phase-A True gate: drop un-falsifiable True nominations (no concrete
    // alternative + cost). Surface each drop as an issue.
    const { kept, dropped } = applyTrueCharterGate(withIds);
    for (const drop of dropped) {
      validation_issues.push(`${drop.charter_id}: ${drop.reason}`);
    }

    subsystems.push({
      node_id,
      members,
      charters: [...kept].sort((a, b) => a.charter_id.localeCompare(b.charter_id)),
    });
  }

  return { subsystems, validation_issues };
}

/**
 * Assemble the routed+gated deltas (Phase C.2) from the independent delta-miner's
 * submission, given the already-assembled charters. The miner never picks routing —
 * `kind`/`routed_to` derive from the charter pair (the design's fixed table). A
 * delta whose `node_id` has no assembled charters, or that references a
 * missing/dropped charter kind, is dropped with an issue.
 */
export function assembleDeltas(
  submission: CharterDeltaSubmission,
  subsystems: CharterSubsystem[],
): AssembledDeltas {
  const deltas: CharterDelta[] = [];
  const findings: Finding[] = [];
  const validation_issues: string[] = [];
  const byNode = new Map(subsystems.map((s) => [s.node_id, s]));

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

  deltas.sort((a, b) => a.delta_id.localeCompare(b.delta_id));
  findings.sort((a, b) => a.id.localeCompare(b.id));

  return {
    deltas,
    findings,
    goal_graph: submission.goal_graph ?? { nodes: [], edges: [] },
    validation_issues,
  };
}

/**
 * Surface a routed charter delta as a Finding LEAD ([[leads-not-verdicts]] — the
 * owner judges it; a charter delta is never a verdict). `lens` is `architecture`:
 * a charter-boundary gap is a design defect. Members of the subsystem are the
 * affected files (structure decomposition operates over file ids).
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
