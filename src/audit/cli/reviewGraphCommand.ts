// sites-pinned: tests/audit/review-graph-lookup.test.ts, tests/audit/next-step-question-workload.test.ts
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { compareCodeUnits, hashContent, isSha256, type GraphBundle } from "audit-tools/shared";
import { getFlag } from "./args.js";
import { outputJson } from "./cliHelpers.js";

const Relation = z.enum(["imports", "calls", "references"]);
const Direction = z.enum(["inbound", "outbound", "both"]);
const Edge = z.tuple([Relation, z.string(), z.string(), z.string()]);
const ReviewGraph = z.strictObject({ version: z.literal(1), paths: z.array(z.string()), edges: z.array(Edge) });
type Link = z.infer<typeof Edge>;

/** Only navigation hints between files already admitted to the frozen review. */
export function buildReviewerGraph(graph: GraphBundle, admitted: readonly string[]): string {
  const paths = [...new Set(admitted)].sort(compareCodeUnits);
  const allowed = new Set(paths);
  const edges = new Map<string, Link>();
  for (const relation of Relation.options) {
    for (const { from, to, kind } of graph.graphs[relation] ?? []) {
      if (!allowed.has(from) || !allowed.has(to)) continue;
      const link: Link = [relation, from, to, kind ?? ""];
      edges.set(JSON.stringify(link), link);
    }
  }
  return JSON.stringify({
    version: 1,
    paths,
    edges: [...edges].sort(([a], [b]) => compareCodeUnits(a, b)).map(([, edge]) => edge),
  }) + "\n";
}

const Query = z.strictObject({
  path: z.string().min(1),
  direction: Direction.default("both"),
  relation: Relation.optional(),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.number().int().min(1).max(100).default(30),
});

export async function queryReviewerGraph(index: string, digest: string, rawQuery: unknown) {
  const query = Query.parse(rawQuery);
  if (!isSha256(digest)) throw new Error("Use the graph fingerprint issued with the review packet.");
  const text = await readFile(index, "utf8");
  if (hashContent(text) !== digest) throw new Error("Review graph no longer matches the issued fingerprint.");
  const graph = ReviewGraph.parse(JSON.parse(text));
  const allowed = new Set(graph.paths);
  if (!allowed.has(query.path)) throw new Error("Path is not in the admitted review graph.");
  const edges = [];
  let total = 0;
  for (const [relation, from, to, kind] of graph.edges) {
    if (query.relation && relation !== query.relation) continue;
    if (!((query.direction !== "inbound" && from === query.path) ||
          (query.direction !== "outbound" && to === query.path))) continue;
    if (!allowed.has(from) || !allowed.has(to)) continue;
    if (total >= query.offset && edges.length < query.limit) edges.push({ relation, from, to, ...(kind && { kind }) });
    total++;
  }
  const next = query.offset + edges.length;
  return { path: query.path, total, edges, ...(next < total && { next_offset: next }) };
}

export async function cmdReviewGraph(argv: string[]): Promise<void> {
  const path = getFlag(argv, "--path");
  const index = getFlag(argv, "--graph-index");
  const digest = getFlag(argv, "--graph-sha256");
  if (!path || !index || !digest) {
    throw new Error("Usage: audit-code review-graph --graph-index <issued index> --graph-sha256 <issued sha256> --path <repository-relative path>");
  }
  const decimal = (flag: string) => {
    const s = getFlag(argv, flag);
    if (s === undefined) return undefined;
    if (!/^\d+$/u.test(s)) throw new Error(flag + " must be an integer.");
    return Number(s);
  };
  outputJson(await queryReviewerGraph(index, digest, {
    path, direction: getFlag(argv, "--direction"), relation: getFlag(argv, "--relation"),
    offset: decimal("--offset"), limit: decimal("--limit"),
  }));
}
