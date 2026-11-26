// sites-pinned: tests/audit/reviewer-codebase-memory.test.ts
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import {
  hashContent, isFileMissingError, isSha256, resolveWithinRoot,
  runTrackedAsync, stableStringify,
} from "audit-tools/shared";
import { resolveExecutableFile } from "../../shared/tooling/resolveExecutable.js";

const ENGINE = "codebase-memory-mcp";
const VERSION = "0.12.1";
const PROJECT = "audit-review";
const MANIFEST = "ready.json";
interface SourceFile { path: string; fingerprint: string }
export const ReviewerCbmSchema = z.strictObject({
  key: z.string().refine(isSha256), engine: z.literal(ENGINE), version: z.literal(VERSION),
});
export type ReviewerCbm = z.infer<typeof ReviewerCbmSchema>;
const cacheDirectory = (graphIndex: string, key: string) => join(dirname(graphIndex), "..", "review-cbm", key);

function executable(): string | null {
  const configured = process.env.AUDIT_TOOLS_CBM_BIN;
  if (configured !== undefined) {
    return isAbsolute(configured) && (process.platform !== "win32" || /\.exe$/iu.test(configured)) ? configured : null;
  }
  // PATH discovery is deterministic and never searches the reviewed workspace.
  return resolveExecutableFile(process.platform === "win32" ? ENGINE + ".exe" : ENGINE, { cwd: dirname(process.execPath) });
}

async function run(binary: string, home: string, args: string[], timeout: number): Promise<string> {
  const result = await runTrackedAsync([binary, ...args], {
    cwd: home, timeout, maxBuffer: 1024 * 1024,
    env: {
      HOME: home, USERPROFILE: home, XDG_CACHE_HOME: join(home, ".cache"),
      XDG_CONFIG_HOME: join(home, ".config"), APPDATA: join(home, "appdata"),
      LOCALAPPDATA: join(home, "localappdata"),
      ...(process.platform === "win32" && { SystemRoot: process.env.SystemRoot }),
    },
  });
  if (result.status !== 0 || result.error) throw new Error("Codebase Memory could not complete the local graph operation.");
  return result.stdout;
}

async function verifyVersion(binary: string, home: string) {
  if ((await run(binary, home, ["--version"], 5000)).trim() !== ENGINE + " " + VERSION) {
    throw new Error("Codebase Memory " + VERSION + " is required by this graph adapter.");
  }
}

/** Source-only local index. Stage only admitted bytes, never the live workspace,
 * Git metadata, or file links. Remove the staging tree before publishing. */
export async function prepareReviewerCbm(runDir: string, sourceRoot: string, files: readonly SourceFile[]): Promise<ReviewerCbm | undefined> {
  const binary = executable();
  if (!binary) return undefined;
  const identity = { engine: ENGINE, version: VERSION, files };
  const key = hashContent(stableStringify(identity));
  const meta = ReviewerCbmSchema.parse({ key, engine: ENGINE, version: VERSION });
  const cache = join(runDir, "review-cbm");
  const final = join(cache, key);
  const ready = async () => ReviewerCbmSchema.parse(JSON.parse(await readFile(join(final, MANIFEST), "utf8"))).key === key;
  try { if (await ready()) return meta; } catch (error) { if (!isFileMissingError(error)) throw error; }
  await mkdir(cache, { recursive: true });
  const scratch = await mkdtemp(join(cache, "build-"));
  const input = join(scratch, "source");
  try {
    await verifyVersion(binary, scratch);
    await mkdir(input);
    const root = await realpath(sourceRoot);
    for (const file of files) {
      if (file.path.includes("\\") || file.path.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) {
        throw new Error("Unusable path in admitted source index.");
      }
      const source = resolveWithinRoot(root, file.path, { allowRoot: false });
      const target = resolveWithinRoot(input, file.path, { allowRoot: false });
      if (!source || !target || await realpath(source) !== source || !(await lstat(source)).isFile()) {
        throw new Error("Cannot index an aliased or missing admitted source path.");
      }
      const content = await readFile(source);
      if (hashContent(content) !== file.fingerprint) throw new Error("Admitted source changed before graph indexing.");
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, { flag: "wx" });
    }
    const response = z.looseObject({ status: z.literal("indexed") }).parse(JSON.parse(await run(binary, scratch, [
      "cli", "--quiet", "index_repository", "--repo-path", input, "--name", PROJECT, "--mode", "full",
      "--doc-candidates", "false",
    ], 60_000)));
    if (response.status !== "indexed") throw new Error("Codebase Memory index did not finish.");
    await rm(input, { recursive: true, force: true });
    await writeFile(join(scratch, MANIFEST), JSON.stringify(meta) + "\n", { flag: "wx" });
    try { await rename(scratch, final); }
    catch (error) { if (!(await ready().catch(() => false))) throw error; }
    return meta;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

type Query = { path: string; symbol?: string; direction: "inbound" | "outbound" | "both";
  detail: "symbols" | "call-sites"; limit: number; cursor?: string };
const answer = z.looseObject({
  columns: z.array(z.string()), rows: z.array(z.array(z.string())),
  has_more: z.boolean(), truncated: z.boolean(), next_cursor: z.string().optional(),
});

// Double-quoted literals use JSON escapes; no caller-provided query fragments.
const literal = (value: string) => JSON.stringify(value);
const selector = (node: "a" | "b", q: Query) =>
  "(" + node + ".file_path = " + literal(q.path)
  + (q.symbol ? " AND (" + node + ".qualified_name = " + literal(q.symbol) + " OR " + node + ".name = " + literal(q.symbol) + ")" : "")
  + ")";
const location = (value: string | undefined) => {
  const line = Number(value);
  return Number.isSafeInteger(line) && line > 0 ? line : undefined;
};

export async function queryReviewerCbm(index: string, meta: ReviewerCbm, allowed: ReadonlySet<string>, q: Query) {
  const binary = executable();
  if (!binary) throw new Error("Codebase Memory is not configured on this host.");
  const home = cacheDirectory(index, meta.key);
  await access(join(home, MANIFEST));
  await verifyVersion(binary, home);
  const symbols = q.detail === "symbols";
  const columns = symbols
    ? ["a.name", "a.qualified_name", "a.file_path", "a.start_line", "a.end_line"]
    : ["a.file_path", "b.file_path", "a.qualified_name", "b.qualified_name", "r.line"];
  const filters = symbols ? [selector("a", q)] : [
    ...(q.direction !== "inbound" ? [selector("a", q)] : []),
    ...(q.direction !== "outbound" ? [selector("b", q)] : []),
  ];
  const cypher = (symbols ? "MATCH (a)" : "MATCH (a)-[r:CALLS]->(b)") + " WHERE "
    + filters.join(" OR ") + " RETURN " + columns.join(",");
  const result = answer.parse(JSON.parse(await run(binary, home, [
    "cli", "--quiet", "query_graph", "--project", PROJECT, "--format", "json", "--query", cypher,
    "--max-rows", String(q.limit), "--max-output-tokens", "4000", ...(q.cursor ? ["--cursor", q.cursor] : []),
  ], 20_000)));
  if (result.columns.join(",") !== columns.join(",") || result.rows.some(row => row.length !== columns.length) ||
      result.rows.length > q.limit || (result.has_more ? !result.next_cursor || result.next_cursor === q.cursor : result.truncated)) {
    throw new Error("Codebase Memory did not return a usable graph page.");
  }
  const entries = result.rows.flatMap<
    { name: string; symbol: string; path: string; start_line?: number; end_line?: number } |
    { from: string; to: string; caller: string; callee: string; line?: number }
  >(row => {
    const [a, b, c, d, e] = row as [string, string, string, string, string];
    if (symbols) return c === q.path && allowed.has(c) && (!q.symbol || a === q.symbol || b === q.symbol)
      ? [{ name: a, symbol: b, path: c, start_line: location(d), end_line: location(e) }] : [];
    const hit = (q.direction !== "inbound" && a === q.path) || (q.direction !== "outbound" && b === q.path);
    const symbolMatches = (value: string) => !q.symbol || value === q.symbol || value.endsWith("." + q.symbol);
    const selected = (q.direction !== "inbound" && a === q.path && symbolMatches(c)) ||
      (q.direction !== "outbound" && b === q.path && symbolMatches(d));
    return hit && selected && allowed.has(a) && allowed.has(b)
      ? [{ from: a, to: b, caller: c, callee: d, line: location(e) }] : [];
  });
  return { path: q.path, detail: q.detail, engine: meta.engine, entries,
    coverage: "Indexed observations only; verify against frozen source. A missing row does not prove no symbol or call site exists.",
    ...(result.has_more && { next_cursor: result.next_cursor }) };
}
