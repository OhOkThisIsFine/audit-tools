// sites-pinned: tests/audit/reviewer-codebase-memory.test.ts
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import {
  hashContent, isFileMissingError, isSha256, resolveWithinRoot,
  runTrackedAsync, stableStringify,
} from "audit-tools/shared";
import { resolveExecutableFile } from "../../shared/tooling/resolveExecutable.js";

const ENGINE = "codebase-memory-mcp";

const PROJECT = "audit-review";
const MANIFEST = "ready.json";
interface SourceFile { path: string; fingerprint: string }
export const ReviewerCbmSchema = z.strictObject({
  key: z.string().refine(isSha256), engine: z.literal(ENGINE), build: z.string().refine(isSha256).optional(), version: z.string().optional(),
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

async function executableBuild(binary: string): Promise<string> {
  const resolved = await realpath(binary).catch(() => { throw new Error("Codebase Memory executable was not found."); });
  const file = await stat(resolved, { bigint: true });
  if (!file.isFile()) throw new Error("Codebase Memory executable is not a regular file.");
  // Invalidate an index when the installed tool changes, even if its label stays "dev".
  // Use file identity rather than reading the executable on every graph query.
  return hashContent(JSON.stringify([resolved, ...[file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs].map(String)]));
}

async function run(binary: string, home: string, operation: string, args: object, timeout: number): Promise<unknown> {
  const result = await runTrackedAsync([binary, "cli", "--json", operation], {
    cwd: home, timeout, maxBuffer: 1024 * 1024, input: JSON.stringify(args) + "\n",
    env: {
      HOME: home, USERPROFILE: home, XDG_CACHE_HOME: join(home, ".cache"),
      XDG_CONFIG_HOME: join(home, ".config"), APPDATA: join(home, "appdata"),
      LOCALAPPDATA: join(home, "localappdata"), TMPDIR: home, TEMP: home, TMP: home,
      ...(process.platform === "win32" && { SystemRoot: process.env.SystemRoot }),
    },
  });
  const failure = new Error("Codebase Memory " + operation + " did not return compatible JSON.");
  if (result.status !== 0 || result.error) {
    const detail = /secure CLI coordination/u.test(result.stderr) ? "host rejected the secure coordination directory"
      : /saved runtime settings/u.test(result.stderr) ? "could not load isolated runtime settings"
      : result.error ? "process could not complete within the runner bounds" : "exit " + result.status;
    throw new Error("Codebase Memory " + operation + " failed: " + detail + ".");
  }
  let raw: unknown;
  try { raw = JSON.parse(result.stdout); } catch { throw failure; }
  const response = z.looseObject({ isError: z.literal(false).optional(), structuredContent: z.unknown() }).safeParse(raw);
  if (!response.success || response.data.structuredContent === undefined) throw failure;
  return response.data.structuredContent;
}

/** Source-only local index. Stage only admitted bytes, never the live workspace,
 * Git metadata, or file links. Remove the staging tree before publishing. */
export async function prepareReviewerCbm(runDir: string, sourceRoot: string, files: readonly SourceFile[]): Promise<ReviewerCbm | undefined> {
  const binary = executable();
  if (!binary) {
    if (process.env.AUDIT_TOOLS_CBM_BIN !== undefined) throw new Error("AUDIT_TOOLS_CBM_BIN must name an absolute native executable.");
    return undefined;
  }
  const build = await executableBuild(binary);
  const identity = { engine: ENGINE, build, files };
  const key = hashContent(stableStringify(identity));
  const meta = ReviewerCbmSchema.parse({ key, engine: ENGINE, build });
  const cache = join(runDir, "review-cbm");
  const final = join(cache, key);
  const ready = async () => ReviewerCbmSchema.parse(JSON.parse(await readFile(join(final, MANIFEST), "utf8"))).key === key;
  try { if (await ready()) return meta; } catch (error) { if (!isFileMissingError(error)) throw error; }
  await mkdir(cache, { recursive: true });
  const scratch = await mkdtemp(join(cache, "build-"));
  const input = join(scratch, "source");
  try {
    if (process.platform === "win32") {
      await Promise.all(["appdata", "localappdata"].map(path => mkdir(join(scratch, path))));
    }
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
    const response = z.looseObject({ status: z.literal("indexed") }).safeParse(await run(binary, scratch, "index_repository", {
      repo_path: input, name: PROJECT, mode: "full", doc_candidates: false,
    }, 60_000));
    if (!response.success) throw new Error("Codebase Memory did not confirm that indexing finished.");
    if (files[0]) {
      await queryPage(binary, scratch, { path: files[0].path, symbol: "__audit_tools_empty_probe__", direction: "outbound", detail: "call-sites", limit: 1 });
    }
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
  has_more: z.boolean().optional(), truncated: z.boolean().optional(), next_cursor: z.string().optional(),
  total: z.number().int().nonnegative().optional(),
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

async function queryPage(binary: string, home: string, q: Query) {
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
  const page = answer.safeParse(await run(binary, home, "query_graph", {
    project: PROJECT, format: "json", query: cypher, max_rows: q.limit, max_output_tokens: 4000,
    ...(q.cursor && { cursor: q.cursor }),
  }, 20_000));
  if (!page.success) throw new Error("Codebase Memory query_graph returned an incompatible page schema.");
  const result = page.data;
  if (result.columns.join(",") !== columns.join(",") || result.rows.some(row => row.length !== columns.length) ||
      result.rows.length > q.limit || (result.has_more ? !result.next_cursor || result.next_cursor === q.cursor : result.truncated)) {
    throw new Error("Codebase Memory query_graph did not return a usable graph page.");
  }
  // Older builds can report the clipped row count as their total. Never treat
  // a page at the requested bound as complete without pagination metadata.
  if (result.has_more === undefined && (q.cursor || result.rows.length === q.limit || result.total !== result.rows.length)) {
    throw new Error("Codebase Memory query_graph cannot continue this page. Use a newer build, narrow the query, or use native file links.");
  }
  return result;
}

export async function queryReviewerCbm(index: string, meta: ReviewerCbm, allowed: ReadonlySet<string>, q: Query) {
  const binary = executable();
  if (!binary) throw new Error("Codebase Memory is not configured on this host. Use native file links or rebuild the indexed graph on this host.");
  const home = cacheDirectory(index, meta.key);
  try {
    await access(join(home, MANIFEST));
  } catch (error) {
    if (!isFileMissingError(error)) throw error;
    throw new Error("The Codebase Memory index manifest is missing. Run next-step on the indexing host to rebuild or use native file links.", { cause: error });
  }
  if (meta.build !== await executableBuild(binary)) {
    throw new Error("The installed Codebase Memory build changed or is on a different host. Run next-step on that host to rebuild or use native file links.");
  }
  const result = await queryPage(binary, home, q);
  const symbols = q.detail === "symbols";
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
