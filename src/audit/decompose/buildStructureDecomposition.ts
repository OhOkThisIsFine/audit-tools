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
import { clustersFromPartitions, decompose } from "audit-tools/shared";
import type { RepoManifest } from "../types.js";
import type { StructureDecomposition } from "../types/structureDecomposition.js";
import {
  deriveCommentDecomposition,
  deriveDocGroups,
} from "../extractors/commentDecomposition.js";
import { buildStructureSources } from "./sources.js";
import { detectNonColocalization } from "./findings.js";

const DOC_EXTENSION = /\.(md|markdown|adoc|rst|txt)$/i;
/** Threshold at which an intent source's partitions collapse into boundary groups. */
const INTENT_BOUNDARY_FRACTION = 0.5;

function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

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
      groups.push([...members].sort((a, b) => a.localeCompare(b)));
    }
  }
  return groups;
}

export async function buildStructureDecomposition(
  params: BuildStructureDecompositionParams,
): Promise<StructureDecomposition> {
  // In-scope code universe = disposition-included files; doc files (prose intent)
  // are the doc_only status plus markdown/asciidoc/rst by extension.
  const universe: string[] = [];
  const docFiles: string[] = [];
  for (const item of params.disposition.files) {
    const path = toPosix(item.path);
    if (item.status === "included") universe.push(path);
    if (item.status === "doc_only" || DOC_EXTENSION.test(path)) {
      if (item.status !== "excluded" && item.status !== "binary") {
        docFiles.push(path);
      }
    }
  }
  const sortedUniverse = [...new Set(universe)].sort((a, b) =>
    a.localeCompare(b),
  );
  const sortedDocs = [...new Set(docFiles)].sort((a, b) => a.localeCompare(b));

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
