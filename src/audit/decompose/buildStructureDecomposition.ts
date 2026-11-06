// Top-level Phase B orchestration: gather the structure-layer sources (behavior
// graphs + the two new intent extractors), run the overlay-and-delta operator,
// emit the non-co-localization findings, and assemble the
// structure_decomposition.json artifact. The single async entry point the
// executor calls; the pure pieces it composes are individually tested.

import type {
  FileDisposition,
  GraphBundle,
  Partition,
} from "audit-tools/shared";
import { clustersFromPartitions, decompose, toPosixPath, compareCodeUnits } from "audit-tools/shared";
import type { RepoManifest } from "../types.js";
import type { StructureDecomposition } from "../types/structureDecomposition.js";
import {
  deriveCommentDecomposition,
  deriveDocGroups,
} from "../extractors/commentDecomposition.js";
import { buildStructureSources } from "./sources.js";
import { detectNonColocalization } from "./findings.js";

const DOC_EXTENSION = /\.(md|markdown|adoc|rst|txt)$/i;

/**
 * The pipeline's ONE definition of a prose/doc-intent file: doc-extensioned
 * (prose), and not excluded/binary. Single-sourced here because its consumers
 * must agree exactly: the decomposition's doc-group universe below, the docs
 * digest, and the charter packet read-set (`charterPacketReadSet`), from which
 * the charter dependency slice derives.
 *
 * `doc_only` status alone does NOT make a file prose: disposition gives that
 * status to everything it judges "not auditable code" — examples and fixtures
 * (JSON, JSONL logs, harness `.ts`), licenses, and any file under a `docs/`
 * segment (baseline JSON included). Those state no intent, and admitting them
 * filled a dogfood stated packet with fixture data.
 */
// sites-pinned: tests/audit/charter-packets.test.ts
export function isDocIntentFile(path: string, status: string): boolean {
  if (status === "excluded" || status === "binary") return false;
  return DOC_EXTENSION.test(path.replace(/\\/g, "/"));
}
/** Threshold at which an intent source's partitions collapse into boundary groups. */
const INTENT_BOUNDARY_FRACTION = 0.5;

export interface BuildStructureDecompositionParams {
  /** Repo root (absolute); when absent, comment/doc extraction is skipped. */
  root?: string;
  repoManifest: RepoManifest;
  disposition: FileDisposition;
  graphBundle: GraphBundle;
  /** Injectable file reader (tests supply a map-backed reader). */
  readFileText?: (absPath: string) => Promise<string | undefined>;
}

/** Convert a partition into its non-trivial member groups (size ≥ 2). */
function partitionGroups(partition: Partition): string[][] {
  const byComm = new Map<string, string[]>();
  for (const [node, comm] of partition) {
    const list = byComm.get(comm);
    if (list) list.push(node);
    else byComm.set(comm, [node]);
  }
  const groups: string[][] = [];
  for (const members of byComm.values()) {
    if (members.length >= 2) {
      groups.push([...members].sort((a, b) => compareCodeUnits(a, b)));
    }
  }
  return groups;
}

export async function buildStructureDecomposition(
  params: BuildStructureDecompositionParams,
): Promise<StructureDecomposition> {
  // sites-pinned: tests/audit/structure-decomposition.test.ts
  // In-scope code universe = disposition-included files; doc files (prose
  // intent) are the `isDocIntentFile` set — prose by extension, whatever the
  // status, so a doc_only fixture or log never names files into a doc group.
  const universe: string[] = [];
  const docFiles: string[] = [];
  for (const item of params.disposition.files) {
    const path = toPosixPath(item.path);
    if (item.status === "included") universe.push(path);
    if (isDocIntentFile(path, item.status)) {
      docFiles.push(path);
    }
  }
  const sortedUniverse = [...new Set(universe)].sort((a, b) =>
    compareCodeUnits(a, b),
  );
  const sortedDocs = [...new Set(docFiles)].sort((a, b) => compareCodeUnits(a, b));

  // Async intent extraction (skipped without a root — degrades to empty).
  const commentResult = params.root
    ? await deriveCommentDecomposition({
        root: params.root,
        files: sortedUniverse,
        readFileText: params.readFileText,
      })
    : { edges: [], scannedFiles: 0 };
  const docGroups = params.root
    ? await deriveDocGroups({
        root: params.root,
        docFiles: sortedDocs,
        codeFiles: sortedUniverse,
        readFileText: params.readFileText,
      })
    : [];

  const sources = buildStructureSources({
    universe: sortedUniverse,
    graphBundle: params.graphBundle,
    commentEdges: commentResult.edges,
    docGroups,
  });

  const result = decompose(sources, "structure");

  // Finding inputs: pooled behavior partitions, all intent-declared boundaries,
  // and the stated-purpose subset (docs + comments) for the smeared-purpose side.
  const behaviorPartitions = sources
    .filter((s) => s.family === "behavior")
    .flatMap((s) => s.partitions);
  const intentBoundaries: string[][] = [];
  const purposeGroups: string[][] = [];
  for (const source of sources) {
    if (source.family !== "intent") continue;
    const groups =
      source.partitions.length === 1
        ? partitionGroups(source.partitions[0]!)
        : clustersFromPartitions(source.partitions, INTENT_BOUNDARY_FRACTION);
    intentBoundaries.push(...groups);
    if (source.id === "docs" || source.id === "comments") {
      purposeGroups.push(...groups);
    }
  }

  const findings = detectNonColocalization({
    behaviorPartitions,
    intentBoundaries,
    purposeGroups,
  });

  return {
    generated_at: new Date().toISOString(),
    target: result.target,
    node_universe_size: sortedUniverse.length,
    source_ids: sources.map((s) => s.id),
    consensus: result.consensus,
    contested: result.contested,
    findings,
  };
}
