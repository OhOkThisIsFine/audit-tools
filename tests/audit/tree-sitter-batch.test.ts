import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { analyzeTreeSitterFiles } from "../../src/audit/extractors/analyzers/treeSitterBatch.js";
import type { AnalyzerContext } from "../../src/audit/extractors/analyzers/types.js";
import type { TsNode } from "../../src/audit/extractors/analyzers/treeSitter.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
function context(root = ""): AnalyzerContext {
  return { root, includedFiles: [], pathLookup: new Map(), repoManifest: {
    repository: { name: "batch" }, generated_at: "2026-10-17T00:00:00Z", files: [],
  } };
}
function node(text: string): TsNode {
  return { text, type: "root", namedChildren: [], childForFieldName: () => null, descendantsOfType: () => [] };
}
async function fixture(files: Record<string, string>): Promise<AnalyzerContext> {
  const root = await mkdtemp(join(tmpdir(), "tree-sitter-batch-"));
  roots.push(root);
  for (const [file, content] of Object.entries(files)) await writeFile(join(root, file), content);
  return context(root);
}
function blockedContext(): AnalyzerContext {
  const ctx = context();
  Object.defineProperty(ctx, "root", { get() { throw new Error("root accessed"); } });
  return ctx;
}
test("empty batch avoids loader and context access", async () => {
  const loader = vi.fn(async () => { throw new Error("loader called"); });
  const ctx = blockedContext();
  Object.defineProperty(ctx, "dependencyPath", { get() { throw new Error("dependency accessed"); } });
  expect(await analyzeTreeSitterFiles([], ctx, "css", "css-analyzer", vi.fn(), loader)).toEqual({ edges: [] });
  expect(loader).not.toHaveBeenCalled();
});
test("missing parser returns before root resolution or file reads and forwards dependency path", async () => {
  const ctx = blockedContext();
  ctx.dependencyPath = "/optional/runtime";
  const loader = vi.fn(async () => undefined);
  const collect = vi.fn();
  expect(await analyzeTreeSitterFiles(["unreadable"], ctx, "html", "html-analyzer", collect, loader)).toEqual({ edges: [] });
  expect(loader).toHaveBeenCalledExactlyOnceWith("html", "/optional/runtime");
  expect(collect).not.toHaveBeenCalled();
});
test("loader rejection propagates before root access", async () => {
  const failure = new Error("load failed");
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  await expect(analyzeTreeSitterFiles(["a"], blockedContext(), "python", "python-analyzer", vi.fn(),
    async () => { throw failure; })).rejects.toBe(failure);
  expect(stderr).not.toHaveBeenCalled();
});
test("one parser processes input order and duplicates sequentially with normalized collector paths", async () => {
  const ctx = await fixture({ "a": "A", "b": "B" });
  ctx.root = relative(process.cwd(), ctx.root);
  const events: string[] = [];
  const parser = { setLanguage: vi.fn(), parse: vi.fn((source: string) => {
    events.push(`parse:${source}`); return { rootNode: node(source) };
  }) };
  const loader = vi.fn(async () => parser);
  const output = await analyzeTreeSitterFiles(["./b", "a", "./b"], ctx, "css", "css-analyzer", (from, root, lookup, edges) => {
    expect(lookup).toBe(ctx.pathLookup);
    events.push(`collect:${root.text}`);
    edges.push({ from, to: root.text, kind: "test" });
  }, loader);
  expect(loader).toHaveBeenCalledTimes(1);
  expect(events).toEqual(["parse:B", "collect:B", "parse:A", "collect:A", "parse:B", "collect:B"]);
  expect(output.edges.map((edge) => edge.from)).toEqual(["b", "a", "b"]);
});
test("unreadable and over-limit sources skip; inclusive threshold counts JS code units, not UTF-8 bytes", async () => {
  const limit = 524288;
  const ctx = await fixture({ below: "x".repeat(limit - 1), exact: "x".repeat(limit), over: "x".repeat(limit + 1), multibyte: "é".repeat(limit), astral: "😀".repeat(limit / 2), later: "ok" });
  await mkdir(join(ctx.root, "directory"));
  const parser = { setLanguage: vi.fn(), parse: vi.fn((source: string) => ({ rootNode: node(source) })) };
  const collect = vi.fn();
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  await analyzeTreeSitterFiles(["missing", "directory", "below", "exact", "over", "multibyte", "astral", "later"], ctx, "css", "css-analyzer", collect, async () => parser);
  expect(parser.parse.mock.calls.map(([source]) => source.length)).toEqual([limit - 1, limit, limit, limit, 2]);
  expect(collect.mock.calls.map(([from]) => from)).toEqual(["below", "exact", "multibyte", "astral", "later"]);
  expect(stderr).not.toHaveBeenCalled();
});
test("parse and collector failures warn exactly, retain partial edges, and continue with later files", async () => {
  const ctx = await fixture({ parse: "parse", collect: "collect", later: "later" });
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const parser = { setLanguage: vi.fn(), parse: vi.fn((source: string) => {
    if (source === "parse") throw "string error";
    return { rootNode: node(source) };
  }) };
  const output = await analyzeTreeSitterFiles(["./parse", "./collect", "later"], ctx, "python", "python-analyzer", (from, root, _lookup, edges) => {
    edges.push({ from, to: "target", kind: "test" });
    if (root.text === "collect") throw new Error("collector error");
  }, async () => parser);
  expect(output.edges.map((edge) => edge.from)).toEqual(["collect", "later"]);
  expect(stderr.mock.calls).toEqual([
    ["[audit-code] python-analyzer: parse failed for './parse': string error\n"],
    ["[audit-code] python-analyzer: parse failed for './collect': collector error\n"],
  ]);
});


test("batch preparation runs once after parser admission and before root access", async () => {
  const ctx = await fixture({ a: "A", b: "B" });
  const originalRoot = ctx.root;
  const events: string[] = [];
  Object.defineProperty(ctx, "root", { get() { events.push("root"); return originalRoot; } });
  const parser = { setLanguage: vi.fn(), parse: vi.fn((text: string) => ({ rootNode: node(text) })) };
  const prepare = vi.fn(() => { events.push("prepare"); });
  await analyzeTreeSitterFiles(["a", "b"], ctx, "python", "python-analyzer", vi.fn(),
    async () => { events.push("loader"); return parser; }, prepare);
  expect(events).toEqual(["loader", "prepare", "root"]);
  expect(prepare).toHaveBeenCalledTimes(1);
  prepare.mockClear();
  await analyzeTreeSitterFiles([], blockedContext(), "python", "python-analyzer", vi.fn(), async () => parser, prepare);
  await analyzeTreeSitterFiles(["a"], blockedContext(), "python", "python-analyzer", vi.fn(), async () => undefined, prepare);
  await expect(analyzeTreeSitterFiles(["a"], blockedContext(), "python", "python-analyzer", vi.fn(),
    async () => { throw new Error("loader failed"); }, prepare)).rejects.toThrow("loader failed");
  expect(prepare).not.toHaveBeenCalled();
});
