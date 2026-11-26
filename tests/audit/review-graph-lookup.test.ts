import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { hashContent, type GraphBundle } from "audit-tools/shared";
import { buildReviewerGraph, queryReviewerGraph } from "../../src/audit/cli/reviewGraphCommand.js";

function fixture() {
  const graph: GraphBundle = { graphs: {
    calls: [
      { from: "main.ts", to: "view.ts", kind: "resolved" },
      { from: "main.ts", to: "view.ts", kind: "resolved" },
      { from: "view.ts", to: "main.ts" },
      { from: "main.ts", to: "private.ts" },
      { from: "private.ts", to: "main.ts" },
    ],
    imports: [{ from: "main.ts", to: "view.ts" }],
    references: [{ from: "build.yml", to: "main.ts" }],
  } };
  return { graph, paths: ["view.ts", "main.ts", "build.yml", "isolated.ts"] };
}
async function withGraph(visit: (file: string, text: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "review-graph-"));
  try {
    const { graph, paths } = fixture();
    const text = buildReviewerGraph(graph, paths);
    const file = join(dir, "graph.json");
    await writeFile(file, text);
    await visit(file, text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("stable projection omits non-admitted edges, retaining isolated paths and relation direction", async () => {
  const { graph, paths } = fixture();
  const projection = buildReviewerGraph(graph, paths);
  expect(projection).not.toContain("private.ts");
  expect(buildReviewerGraph({ graphs: { ...graph.graphs, calls: [...graph.graphs.calls!].reverse() } }, [...paths].reverse())).toBe(projection);
  await withGraph(async (file, text) => {
    const q = (args: unknown) => queryReviewerGraph(file, hashContent(text), args);
    const page = await q({ path: "main.ts", limit: 1 });
    expect(page).toMatchObject({ total: 4, next_offset: 1, edges: [{ relation: "calls", from: "main.ts", to: "view.ts" }] });
    expect(await q({ path: "main.ts", offset: page.next_offset, limit: 100 })).toMatchObject({ total: 4, edges: [
      { from: "view.ts", to: "main.ts" }, { relation: "imports" }, { relation: "references" },
    ] });
    expect(await q({ path: "main.ts", direction: "inbound", relation: "references" })).toEqual({
      path: "main.ts", total: 1, edges: [{ relation: "references", from: "build.yml", to: "main.ts" }],
    });
    expect(await q({ path: "isolated.ts" })).toEqual({ path: "isolated.ts", total: 0, edges: [] });
    await expect(q({ path: "private.ts" })).rejects.toThrow("not in the admitted review graph");
    await expect(q({ path: "main.ts", limit: 101 })).rejects.toThrow();
  });
});

test("lookup refuses changed index bytes and cannot use a path to read source files", async () => {
  await withGraph(async (file, text) => {
    await expect(queryReviewerGraph(file, hashContent(text), { path: "../not-admitted" })).rejects.toThrow("not in the admitted review graph");
    await writeFile(file, text + "\n");
    await expect(queryReviewerGraph(file, hashContent(text), { path: "main.ts" })).rejects.toThrow("no longer matches");
  });
});
