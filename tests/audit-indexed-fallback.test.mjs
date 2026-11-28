import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataUrl = code => "data:text/javascript;base64," + Buffer.from(code).toString("base64");
const cache = dataUrl('export const reviewerCbmCacheDirectory = dir => dir + "/review-cbm";');
const shared = dataUrl(`
  export * from ${JSON.stringify(new URL("../dist/shared/index.js", import.meta.url).href)};
  export const runTrackedAsync = (...args) => globalThis.runSyntheticCbm(...args);
`);
register(dataUrl(`
  export function resolve(specifier, context, next) {
    if (context.parentURL?.endsWith("/cli/reviewerCodebaseMemory.js")) {
      if (specifier === "audit-tools/shared") return { shortCircuit: true, url: ${JSON.stringify(shared)} };
      if (specifier === "../io/reviewerCbmCache.js") return { shortCircuit: true, url: ${JSON.stringify(cache)} };
    }
    return next(specifier, context);
  }
`), import.meta.url);

const { publishAuditEvidenceGraph } = await import("../dist/audit/cli/dispatch/hostHandoff.js");
const { hashContent } = await import("../dist/shared/index.js");

test("unchanged failed indexing reuses fallback but new frozen input or tool permits qualification", async t => {
  const dir = await mkdtemp(join(tmpdir(), "audit-indexed-fallback-"));
  const artifacts = join(dir, "artifacts");
  const source = join(dir, "frozen");
  const otherSource = join(dir, "other-frozen");
  const binary = join(dir, "stand-in.exe");
  const previous = process.env.AUDIT_TOOLS_CBM_BIN;
  t.after(async () => {
    delete globalThis.runSyntheticCbm;
    if (previous === undefined) delete process.env.AUDIT_TOOLS_CBM_BIN;
    else process.env.AUDIT_TOOLS_CBM_BIN = previous;
    await rm(dir, { recursive: true, force: true });
  });
  process.env.AUDIT_TOOLS_CBM_BIN = binary;
  await mkdir(source);
  await mkdir(otherSource);
  const content = "export const sample = 1;\n";
  const files = [{ path: "sample.ts", fingerprint: hashContent(content) }];
  await writeFile(join(source, "sample.ts"), content);
  await writeFile(join(otherSource, "sample.ts"), content);
  let builds = 0;
  let probes = 0;
  let qualified = false;
  globalThis.runSyntheticCbm = async ([tool, , , operation]) => {
    assert.equal(tool, binary);
    if (operation === "index_repository") {
      builds++;
      if (!qualified) return { status: 1, stderr: "", stdout: "" };
      return { status: 0, stdout: JSON.stringify({ structuredContent: { status: "indexed" } }) };
    }
    assert.equal(operation, "query_graph");
    probes++;
    return { status: 0, stdout: JSON.stringify({ structuredContent: {
      columns: ["a.file_path", "b.file_path", "a.qualified_name", "b.qualified_name", "r.line"],
      rows: [], has_more: false,
    } }) };
  };
  const native = { graphs: {} };
  const loadGraph = async result => JSON.parse(await readFile(result.graphIndex, "utf8"));
  // A missing configured tool records preflight fallback, but its later appearance requalifies.
  const missing = await publishAuditEvidenceGraph(artifacts, source, files, undefined, true);
  assert.equal(missing.graphIndexFailed, true);
  assert.equal(missing.graphIndex, undefined);
  assert.equal((await publishAuditEvidenceGraph(artifacts, source, files, undefined, true)).graphIndexFailureReused, true);
  await writeFile(binary, "synthetic executable identity");
  const initial = await publishAuditEvidenceGraph(artifacts, source, files, native);
  const repeated = await publishAuditEvidenceGraph(artifacts, source, files, native);
  assert.equal(initial.graphIndexFailed, true);
  assert.equal(initial.graphIndexFailureReused, false);
  assert.equal(repeated.graphIndexFailureReused, true);
  assert.equal(repeated.graphIndexError, initial.graphIndexError);
  assert.equal(repeated.graphIndex, initial.graphIndex);
  assert.equal((await loadGraph(repeated)).indexed, undefined);
  assert.equal(builds, 1);
  const frozenOnly = await publishAuditEvidenceGraph(artifacts, source, files, undefined, true);
  assert.equal(frozenOnly.graphIndex, undefined);
  assert.equal(frozenOnly.graphIndexFailureReused, true);
  const other = await publishAuditEvidenceGraph(artifacts, otherSource, files, undefined, true);
  assert.equal(other.graphIndexFailureReused, false);
  assert.equal(other.graphIndexFailed, true);
  assert.equal(builds, 2);
  await writeFile(binary, "repaired synthetic executable identity, different size");
  qualified = true;
  const repaired = await publishAuditEvidenceGraph(artifacts, otherSource, files, undefined, true);
  assert.equal(repaired.graphIndexFailed, false);
  assert.equal(repaired.indexedOnly, true);
  assert.deepEqual((await loadGraph(repaired)).indexed, repaired.indexed);
  assert.equal(builds, 3);
  assert.equal(probes, 1);
  assert.equal((await loadGraph(initial)).indexed, undefined);
});
