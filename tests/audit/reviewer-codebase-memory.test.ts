import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { hashContent, runTrackedAsync } from "audit-tools/shared";
import { prepareReviewerCbm, queryReviewerCbm } from "../../src/audit/cli/reviewerCodebaseMemory.js";
import { buildReviewerGraph, queryReviewerGraph } from "../../src/audit/cli/reviewGraphCommand.js";

vi.mock("audit-tools/shared", async importOriginal => {
  const original = await importOriginal<typeof import("audit-tools/shared")>();
  return { ...original, runTrackedAsync: vi.fn() };
});
const runner = vi.mocked(runTrackedAsync);
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  runner.mockReset();
  await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
const success = (result: unknown) => ({
  status: 0, stdout: JSON.stringify({ isError: false, structuredContent: result }), stderr: "", argv: [], duration_ms: 1,
});
const columns = ["a.file_path", "b.file_path", "a.qualified_name", "b.qualified_name", "r.line"];
const emptyPage = { columns, rows: [], total: 0 };
const argsOf = (options: { input?: string | Buffer } | undefined) => JSON.parse(String(options?.input));
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "review-cbm-test-"));
  roots.push(root);
  const frozen = join(root, "frozen"), run = join(root, "run"), index = join(run, "review-graph-index", "fixture.json");
  await mkdir(frozen);
  await writeFile(join(frozen, "a.ts"), "export const a = 1;\n");
  await writeFile(join(frozen, "excluded.ts"), "not admitted");
  const files = [{ path: "a.ts", fingerprint: hashContent("export const a = 1;\n") }];
  const bin = join(root, "codebase-memory-mcp.exe");
  await writeFile(bin, "synthetic tool");
  vi.stubEnv("AUDIT_TOOLS_CBM_BIN", bin);
  return { frozen, files, run, index, bin };
}

test("indexes only admitted verified bytes, removes staging, and reuses the one finished index", async () => {
  const f = await setup();
  runner.mockImplementation(async (argv, options) => {
    expect(argv).not.toContain("--version");
    if (argv.includes("query_graph")) return success(emptyPage);
    expect(argv).toContain("index_repository");
    const input = argsOf(options).repo_path;
    expect(basename(input)).toBe("source");
    expect(await readdir(input)).toEqual(["a.ts"]);
    expect(await readFile(join(input, "a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(options?.env?.HOME).not.toBe(process.env.HOME);
    return success({ status: "indexed" });
  });
  const meta = await prepareReviewerCbm(f.run, f.frozen, f.files);
  expect(meta).toMatchObject({ engine: "codebase-memory-mcp", build: expect.stringMatching(/^[a-f0-9]{64}$/u) });
  const root = join(f.run, "review-cbm", meta!.key);
  await expect(stat(join(root, "source"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await prepareReviewerCbm(f.run, f.frozen, f.files)).toEqual(meta);
  expect(runner).toHaveBeenCalledTimes(2);
  await writeFile(f.bin, "different build, same label");
  await expect(queryReviewerCbm(f.index, meta!, new Set(["a.ts"]), {
    path: "a.ts", detail: "symbols", direction: "both", limit: 1,
  })).rejects.toThrow(/build changed/);
  expect((await prepareReviewerCbm(f.run, f.frozen, f.files))?.key).not.toBe(meta?.key);
  await writeFile(join(f.frozen, "a.ts"), "changed");
  await expect(prepareReviewerCbm(join(f.run, "other"), f.frozen, f.files)).rejects.toThrow(/changed before/);
  expect(await readdir(join(f.run, "other", "review-cbm"))).toEqual([]);
});

test("only exact scoped requests are sent, pages do not leak graph rows, and the fallback stays available", async () => {
  const f = await setup();
  runner.mockImplementation(async (argv, options) => {
    if (argv.includes("index_repository")) return success({ status: "indexed" });
    const q = argsOf(options).query as string;
    if (q.includes("__audit_tools_empty_probe__")) return success(emptyPage);
    if (q.includes(":CALLS")) {
      expect(q).toContain('b.file_path = "a.ts"');
      expect(q).toContain('b.name = "run"');
      return success({ columns: ["a.file_path","b.file_path","a.qualified_name","b.qualified_name","r.line"],
        has_more: true, next_cursor: "resume-query", truncated: true,
        rows: [["outside.ts","a.ts","work.bad","work.run","19"],["a.ts","a.ts","work.ok","work.run","5"],["a.ts","a.ts","work.ok","work.other","8"]] });
    }
    expect(q).toContain('a.file_path = "a.ts"');
    return success({ columns: ["a.name","a.qualified_name","a.file_path","a.start_line","a.end_line"],
      has_more: false, truncated: false, rows: [["run","work.run","a.ts","3","7"],["outside","work.outside","outside.ts","1","2"]] });
  });
  const meta = await prepareReviewerCbm(f.run, f.frozen, f.files);
  const allowed = new Set(["a.ts"]);
  const calls = await queryReviewerCbm(f.index, meta!, allowed, {
    path: "a.ts", detail: "call-sites", direction: "inbound", symbol: "run", limit: 20,
  });
  expect(calls).toMatchObject({ entries: [{ from: "a.ts", to: "a.ts", caller: "work.ok", callee: "work.run", line: 5 }], next_cursor: "resume-query" });
  const symbols = await queryReviewerCbm(f.index, meta!, allowed, {
    path: "a.ts", detail: "symbols", direction: "both", limit: 20,
  });
  expect(symbols.entries).toEqual([{ name: "run", symbol: "work.run", path: "a.ts", start_line: 3, end_line: 7 }]);
  const nativeOnly = buildReviewerGraph({ graphs: {} }, ["a.ts"]);
  await mkdir(join(f.run, "review-graph-index"), { recursive: true });
  await writeFile(f.index, nativeOnly);
  expect(await queryReviewerGraph(f.index, hashContent(nativeOnly), { path: "a.ts", detail: "symbols" }))
    .toMatchObject({ status: "unavailable" });
  expect(await queryReviewerGraph(f.index, hashContent(nativeOnly), { path: "a.ts" }))
    .toEqual({ path: "a.ts", total: 0, edges: [] });
});

test("refuses incompatible graph output before advertising indexed lookup, and can retry after repair", async () => {
  const f = await setup();
  runner.mockImplementation(async argv => argv.includes("index_repository") ? success({ status: "indexed" })
    : success({ incompatible: true }));
  await expect(prepareReviewerCbm(f.run, f.frozen, f.files)).rejects.toThrow(/incompatible page schema/);
  expect(await readdir(join(f.run, "review-cbm"))).toEqual([]);
  runner.mockImplementation(async argv => argv.includes("index_repository") ? success({ status: "indexed" })
    : success(emptyPage));
  const meta = await prepareReviewerCbm(f.run, f.frozen, f.files);
  runner.mockResolvedValue(success({ columns, rows: [["a.ts", "a.ts", "f", "g", "5"]], total: 1 }));
  await expect(queryReviewerCbm(f.index, meta!, new Set(["a.ts"]), {
    path: "a.ts", detail: "call-sites", direction: "outbound", limit: 1,
  })).rejects.toThrow(/cannot continue this page/);
});
