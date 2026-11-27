// sites-pinned: tests/audit/review-graph-lookup.test.ts, tests/audit/next-step-question-workload.test.ts
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { compareCodeUnits, hashContent, isSha256, type GraphBundle } from "audit-tools/shared";
import { getFlag } from "./args.js";
import { outputJson } from "./cliHelpers.js";
import { queryReviewerCbm, ReviewerCbmSchema, type ReviewerCbm } from "./reviewerCodebaseMemory.js";

const Relation = z.enum(["imports", "calls", "references"]);
const Direction = z.enum(["inbound", "outbound", "both"]);
const Edge = z.tuple([Relation, z.string(), z.string(), z.string()]);
const ReviewGraph = z.strictObject({ version: z.literal(1), paths: z.array(z.string()), edges: z.array(Edge), source_sha256: z.string().refine(isSha256).optional(), indexed: ReviewerCbmSchema.optional() });
type Link = z.infer<typeof Edge>;

/** Only navigation hints between files already admitted to the frozen review. */
export function buildReviewerGraph(graph: GraphBundle, admitted: readonly string[], indexed?: ReviewerCbm, sourceSha256?: string): string {
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
    ...(sourceSha256 && { source_sha256: sourceSha256 }),
    ...(indexed && { indexed }),
    edges: [...edges].sort(([a], [b]) => compareCodeUnits(a, b)).map(([, edge]) => edge),
  }) + "\n";
}

export function readReviewGraphSourceDigest(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  try {
    const result = ReviewGraph.safeParse(JSON.parse(text));
    return result.success ? result.data.source_sha256 : undefined;
  } catch { return undefined; }
}

const Query = z.strictObject({
  path: z.string().min(1),
  direction: Direction.default("both"),
  relation: Relation.optional(),
  detail: z.enum(["files", "symbols", "call-sites"]).default("files"),
  cursor: z.string().min(1).max(1024).optional(),
  symbol: z.string().min(1).max(512).optional(),
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
  if (query.detail !== "files") {
    if (query.offset !== 0 || query.relation) throw new Error("Use --cursor, not --offset or --relation, for indexed details.");
    if (!graph.indexed) return { path: query.path, detail: query.detail, status: "unavailable", reason: "This run has no qualified Codebase Memory index. Use file links and frozen source." };
    return queryReviewerCbm(index, graph.indexed, allowed, { ...query, detail: query.detail });
  }
  if (query.cursor || query.symbol) throw new Error("--cursor and --symbol require indexed details.");
  const edges: Array<{ relation: Link[0]; from: string; to: string; kind?: string }> = [];
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
    path, detail: getFlag(argv, "--detail"), cursor: getFlag(argv, "--cursor"), symbol: getFlag(argv, "--symbol"),
    direction: getFlag(argv, "--direction"), relation: getFlag(argv, "--relation"),
    offset: decimal("--offset"), limit: decimal("--limit"),
  }));
}
