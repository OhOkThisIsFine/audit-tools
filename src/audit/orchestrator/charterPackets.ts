// Channel-pure charter-extraction PACKETS (design resolution 4, 2026-08-05):
// blindness enforced by FEEDING, never instruction. Each extraction lane gets a
// materialized packet holding ONLY its evidence channel —
//   stated     → doc-intent files + extracted comments (testimony),
//   structural → file tree + import/call edges + top-level declaration lines
//                (intent frozen into organization; no bodies, no docs, no
//                comments),
//   revealed   → comment-stripped member bodies (behavior)
// — so channel purity stops depending on agent obedience and the comment-dense
// collapse (headers doubling as the stated channel) is fixed as a side effect.
//
// This module is ALSO the single home of the charter layer's read-set
// (design-check resolution-4 constraint 6): `charterPacketReadSet` names exactly
// which repo files packet materialization consumes, and the staleness slice
// (`dependencySlices.ts` → `charterReadFileSlice`) derives from it, so the
// packets and the staleness edge can never drift apart.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CharterKind } from "audit-tools/shared";
import type { ArtifactBundle } from "../io/artifacts.js";
import { isDocIntentFile } from "../decompose/buildStructureDecomposition.js";
import {
  extractCommentText,
  stripCommentText,
} from "../extractors/commentDecomposition.js";

/** Per-file and per-packet content budgets (budget-context rule: bounded, never whole-repo). */
const PER_FILE_CHARS = 6_000;
const PACKET_TOTAL_CHARS = 150_000;
const MAX_READ_BYTES = 512 * 1024;

/**
 * The charter layer's read-set over the repo: consensus MEMBER files (every
 * channel is a projection of member content — comments for stated, organization
 * for structural, stripped bodies for revealed) plus every doc-intent file per
 * the pipeline's single doc predicate (`isDocIntentFile` — the stated channel's
 * doc universe). The staleness slice consumes this same function.
 */
export function charterPacketReadSet(bundle: ArtifactBundle): {
  memberPaths: string[];
  docPaths: string[];
} {
  const members = new Set<string>();
  for (const node of bundle.structure_decomposition?.consensus ?? []) {
    for (const member of node.members) members.add(member);
  }
  const docs = new Set<string>();
  for (const file of bundle.file_disposition?.files ?? []) {
    if (isDocIntentFile(file.path, file.status)) docs.add(file.path);
  }
  return {
    memberPaths: [...members].sort((a, b) => a.localeCompare(b)),
    docPaths: [...docs].sort((a, b) => a.localeCompare(b)),
  };
}

/**
 * The dependency-edge lines the STRUCTURAL channel's packet embeds: every
 * `imports`/`calls`/`references` edge whose BOTH endpoints are consensus
 * members, rendered one per line, sorted. The single home of this derivation —
 * the packet renders it and the staleness slice (`dependencySlices.ts` →
 * `charterGraphEdgeSlice`) compares it, so what the packet shows and what
 * re-stales it can never drift.
 */
export function memberDependencyEdgeLines(bundle: ArtifactBundle): string[] {
  const { memberPaths } = charterPacketReadSet(bundle);
  const members = new Set(memberPaths);
  const edges: string[] = [];
  const graphs = bundle.graph_bundle?.graphs;
  for (const family of ["imports", "calls", "references"] as const) {
    for (const edge of graphs?.[family] ?? []) {
      if (members.has(edge.from) && members.has(edge.to)) {
        edges.push(`${edge.from} → ${edge.to} (${edge.kind ?? family})`);
      }
    }
  }
  return edges.sort((a, b) => a.localeCompare(b));
}

/**
 * Top-level declaration lines of a comment-stripped source: non-blank lines at
 * indent zero that do not merely close a scope. A deliberate language-neutral
 * HEURISTIC (a lead, not a parse): in brace- and indent-family languages alike,
 * a file's organization — imports, exports, signatures, class/type heads — sits
 * at column 0 while implementation bodies sit indented. Good enough to show the
 * structural channel what the file declares without leaking how it works.
 */
export function topLevelDeclarationLines(strippedSource: string): string[] {
  const lines: string[] = [];
  for (const line of strippedSource.split("\n")) {
    if (line.length === 0) continue;
    if (/^[\s]/.test(line)) continue;
    if (/^[}\])`>,;]+\s*$/.test(line)) continue;
    lines.push(line.length > 200 ? `${line.slice(0, 200)}…` : line);
  }
  return lines;
}

interface PacketSection {
  heading: string;
  body: string;
}

interface PacketDraft {
  sections: PacketSection[];
  omitted: string[];
}

/** Render a packet draft to markdown, enforcing the total budget. */
function renderPacket(kind: CharterKind, draft: PacketDraft): string {
  const lines: string[] = [
    `# Charter evidence packet — \`${kind}\` channel`,
    "",
    "This packet is your ONLY input. It was materialized by the tool to contain",
    "exactly this channel's evidence; do not read repository files directly.",
    "",
  ];
  let budget = PACKET_TOTAL_CHARS;
  const omitted = [...draft.omitted];
  for (const section of draft.sections) {
    const cost = section.heading.length + section.body.length + 8;
    if (cost > budget) {
      omitted.push(section.heading);
      continue;
    }
    budget -= cost;
    lines.push(`## ${section.heading}`, "", section.body, "");
  }
  if (omitted.length > 0) {
    lines.push(
      "## Omitted (budget cap — content not shown, paths listed for honesty)",
      "",
      ...omitted.map((o) => `- ${o}`),
      "",
    );
  }
  return lines.join("\n");
}

/** Cap one file's contribution, marking truncation honestly. */
function capContent(content: string): string {
  if (content.length <= PER_FILE_CHARS) return content;
  return `${content.slice(0, PER_FILE_CHARS)}\n… (truncated at ${PER_FILE_CHARS} chars)`;
}

async function readRepoFile(
  root: string,
  path: string,
): Promise<string | undefined> {
  try {
    const buf = await readFile(join(root, path));
    if (buf.byteLength > MAX_READ_BYTES) return undefined;
    return buf.toString("utf8");
  } catch {
    return undefined;
  }
}

export interface MaterializeCharterPacketParams {
  root: string;
  bundle: ArtifactBundle;
  kind: CharterKind;
}

/**
 * Materialize ONE kind's evidence packet as markdown. Deterministic given the
 * bundle + file contents: stable path order, fixed budgets, explicit omitted
 * lists. Unreadable/oversized files are named in the omitted list (never
 * silently absent) so a lane can say "evidence missing" instead of guessing.
 */
export async function materializeCharterPacket(
  params: MaterializeCharterPacketParams,
): Promise<string> {
  const { memberPaths, docPaths } = charterPacketReadSet(params.bundle);
  const draft: PacketDraft = { sections: [], omitted: [] };

  if (params.kind === "stated") {
    for (const path of docPaths) {
      const text = await readRepoFile(params.root, path);
      if (text === undefined) {
        draft.omitted.push(`${path} (unreadable or oversized)`);
        continue;
      }
      draft.sections.push({ heading: `Doc: ${path}`, body: capContent(text) });
    }
    for (const path of memberPaths) {
      const text = await readRepoFile(params.root, path);
      if (text === undefined) {
        draft.omitted.push(`${path} (unreadable or oversized)`);
        continue;
      }
      const comments = extractCommentText(text, path).trim();
      if (comments.length === 0) continue;
      draft.sections.push({
        heading: `Comments extracted from: ${path}`,
        body: capContent(comments),
      });
    }
  } else if (params.kind === "structural") {
    const manifestByPath = new Map(
      (params.bundle.repo_manifest?.files ?? []).map((f) => [f.path, f]),
    );
    const tree = memberPaths
      .map((path) => {
        const entry = manifestByPath.get(path);
        return entry ? `${path} (${entry.size_bytes} bytes)` : path;
      })
      .join("\n");
    draft.sections.push({ heading: "File tree (members)", body: tree });

    const edgeLines = memberDependencyEdgeLines(params.bundle);
    if (edgeLines.length > 0) {
      draft.sections.push({
        heading: "Dependency edges among members",
        body: edgeLines.join("\n"),
      });
    }

    for (const path of memberPaths) {
      const text = await readRepoFile(params.root, path);
      if (text === undefined) {
        draft.omitted.push(`${path} (unreadable or oversized)`);
        continue;
      }
      const decls = topLevelDeclarationLines(stripCommentText(text, path));
      if (decls.length === 0) continue;
      draft.sections.push({
        heading: `Top-level declarations (heuristic lead): ${path}`,
        body: capContent(decls.join("\n")),
      });
    }
  } else if (params.kind === "revealed") {
    for (const path of memberPaths) {
      const text = await readRepoFile(params.root, path);
      if (text === undefined) {
        draft.omitted.push(`${path} (unreadable or oversized)`);
        continue;
      }
      draft.sections.push({
        heading: `Comment-stripped source: ${path}`,
        body: capContent(stripCommentText(text, path)),
      });
    }
  } else {
    // `true` is never an extraction lane (nominated by the miner at deepest);
    // materializing a packet for it is a caller bug, surfaced loudly.
    throw new Error(
      `no evidence packet exists for charter kind '${params.kind}' — 'true' is nominated downstream by the delta miner, never extracted`,
    );
  }

  return renderPacket(params.kind, draft);
}
