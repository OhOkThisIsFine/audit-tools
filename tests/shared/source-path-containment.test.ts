import { afterEach, beforeEach, expect, test, vi, type TestContext } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { resolveContainedSourcePath } from "../../src/shared/io/sourcePath.js";
import { checkCitations } from "../../src/shared/validation/citationGrounding.js";
import { groundFinding } from "../../src/shared/validation/findingGrounding.js";
import type { Finding } from "../../src/shared/types/finding.js";

let base: string;
let root: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "source-containment-")));
  root = join(base, "repo");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "safe.ts"), "first\nneedle\n");
  writeFileSync(join(base, "outside.ts"), "needle\n");
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

// Probe only the privilege-dependent Windows capability. Other errors fail the
// test, as do any fixture errors after a successful probe. POSIX always exercises
// real file symlinks; directory-link/junction cases never use this gate.
function requireNativeFileSymlinks(ctx: TestContext): void {
  if (process.platform !== "win32") return;
  const probe = join(base, "file-symlink-capability");
  let unavailable = false;
  try {
    symlinkSync(join(root, "src", "safe.ts"), probe, "file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    unavailable = true;
  } finally {
    rmSync(probe, { force: true });
  }
  // Mark pending only after cleanup succeeds, so cleanup failures still fail.
  if (unavailable)
    ctx.skip(true, "Native Windows file-symlink capability unavailable (EPERM); file-link containment is unverified on this host");
}

function finding(path: string): Finding {
  return {
    id: "F-1", title: "test", category: "test", severity: "medium",
    confidence: "high", lens: "security", summary: "test", evidence: [],
    affected_files: [{ path, quoted_text: "needle", line_start: 99, line_end: 100 }],
  };
}
function citation(path: string, corpus: ReadonlySet<string> = new Set<string>()) {
  const readSource = vi.fn(() => "first\nneedle\n");
  const result = checkCitations({ root, corpus, readSource,
    citations: [{ owner_id: "test", ref: path, quote: "needle" }] });
  return { check: result.checks[0]!, readSource };
}
async function rejected(path: string, corpus: ReadonlySet<string> = new Set<string>()) {
  expect(resolveContainedSourcePath(root, path)).toBeUndefined();
  const { check, readSource } = citation(path, corpus);
  expect(check.verdict).toBe("unknown_path");
  expect(readSource).not.toHaveBeenCalled();
  const readFinding = vi.fn(async () => "needle");
  const f = finding(path);
  expect((await groundFinding(root, f, readFinding)).status).toBe("ungrounded");
  expect(readFinding).not.toHaveBeenCalled();
  expect(f.affected_files![0]!.line_start).toBeUndefined();
  expect(f.affected_files![0]!.line_end).toBeUndefined();
  expect(f.grounding?.reason).toMatch(/could not be read/);
}

test("both public entrypoints reject traversal, outside absolutes, missing files and directories before reading", async () => {
  for (const path of ["../outside.ts", join(base, "outside.ts"), "missing.ts", "src", ".", ".."])
    await rejected(path);
});

test("both public entrypoints reject parent directory-link escapes without basename rehabilitation", async () => {
  symlinkSync(base, join(root, "parent"), process.platform === "win32" ? "junction" : "dir");
  writeFileSync(join(root, "src", "escape.ts"), "needle");
  writeFileSync(join(root, "src", "broken.ts"), "needle");
  await rejected("parent/outside.ts", new Set(["src/escape.ts", "src/broken.ts"]));
});

test("native file links: final escapes and broken links reject without basename rehabilitation", async (ctx) => {
  requireNativeFileSymlinks(ctx);
  symlinkSync(join(base, "outside.ts"), join(root, "escape.ts"), "file");
  symlinkSync(join(base, "absent.ts"), join(root, "broken.ts"), "file");
  writeFileSync(join(root, "src", "escape.ts"), "needle");
  writeFileSync(join(root, "src", "broken.ts"), "needle");
  for (const path of ["escape.ts", "broken.ts"])
    await rejected(path, new Set(["src/escape.ts", "src/broken.ts"]));
});

async function retainedIdentity(path: string) {
  const { check } = citation(path);
  expect(check.verdict).toBe("ok");
  expect(check.resolved_path).toBe(path === join(root, "src", "safe.ts") ? "src/safe.ts" : path);
  const f = finding(path);
  expect((await groundFinding(root, f)).status).toBe("grounded");
  expect(f.affected_files![0]).toMatchObject({ line_start: 2, line_end: 2 });
}

test("internal directory links and in-root absolutes retain rooted citation identity and valid content", async () => {
  symlinkSync(join(root, "src"), join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
  for (const path of ["src/safe.ts", "alias/safe.ts", join(root, "src", "safe.ts")])
    await retainedIdentity(path);
});

test("native file links: internal links retain rooted citation identity and valid content", async (ctx) => {
  requireNativeFileSymlinks(ctx);
  symlinkSync(join(root, "src", "safe.ts"), join(root, "inside.ts"), "file");
  await retainedIdentity("inside.ts");
});

test("basename uniqueness and case-preserving corpus policy remain intact, and fallback is contained", () => {
  expect(citation("SAFE.ts", new Set(["src/safe.ts"])).check.resolved_path).toBe("src/safe.ts");
  mkdirSync(join(root, "other"));
  writeFileSync(join(root, "other", "safe.ts"), "needle");
  const ambiguous = citation("safe.ts", new Set(["src/safe.ts", "other/safe.ts"]));
  expect(ambiguous.check.verdict).toBe("unknown_path");
  expect(ambiguous.readSource).not.toHaveBeenCalled();
  for (const corpus of [new Set(["../outside.ts"]), new Set([join(base, "outside.ts")])]) {
    const result = citation("outside.ts", corpus);
    expect(result.check.verdict).toBe("unknown_path");
    expect(result.readSource).not.toHaveBeenCalled();
  }
});

test("a lexical escape cannot be rehabilitated by a safe basename", async () => {
  await rejected("../safe.ts", new Set(["src/safe.ts"]));
});

test("native path rules preserve ..prefixed files and POSIX literal backslashes", async () => {
  writeFileSync(join(root, "..cache.ts"), "needle");
  expect(citation("..cache.ts").check.verdict).toBe("ok");
  if (sep === "/") {
    writeFileSync(join(root, "literal\\name.ts"), "needle");
    expect(citation("literal\\name.ts").check.resolved_path).toBe("literal\\name.ts");
    for (const path of ["C:\\outside.ts", "C:/outside.ts", "\\\\server\\share\\outside.ts", "C:outside.ts"])
      await rejected(path, new Set(["src/safe.ts"]));
  } else {
    const otherDrive = root[0]!.toUpperCase() === "Z" ? "Y" : "Z";
    await rejected(`${otherDrive}:\\outside.ts`);
    await rejected("\\\\unavailable-server\\share\\outside.ts");
  }
});

test("valid content keeps quote, line, delivered-evidence and read-failure verdicts distinct", () => {
  const check = (ref: string, quote: string, delivered = [{ source_path: "src/safe.ts", line_runs: [{ start: 2, end: 2 }], prefix_width: 0 }]) =>
    checkCitations({root, corpus: new Set<string>(), citations: [{owner_id: "test", ref, quote}], delivered}).checks[0]!.verdict;
  expect(check(`${join(root, "src", "safe.ts")}:2`, "needle")).toBe("ok");
  expect(check("src/safe.ts:3", "needle")).toBe("line_out_of_range");
  expect(check("src/safe.ts:1", "first")).toBe("outside_delivered_evidence");
  expect(check("src/safe.ts:2", "absent")).toBe("quote_not_found");
  const result = checkCitations({ root, corpus: new Set<string>(), citations: [{ owner_id: "test", ref: "src/safe.ts:2" }], readSource: () => { throw Error("unreadable"); } });
  expect(result.checks[0]!.detail).toBe("file could not be read on disk");
});

test("one admitted location still grounds a mixed finding without retaining rejected lines", async () => {
  const f = finding("../outside.ts");
  f.affected_files!.push({ path: "src/safe.ts", quoted_text: "needle" });
  expect((await groundFinding(root, f)).status).toBe("grounded");
  expect(f.affected_files![0]!.line_start).toBeUndefined();
  expect(f.affected_files![1]!.line_start).toBe(2);
});


test("native file links: a parent outside root is refused even when its final link returns inside", async (ctx) => {
  requireNativeFileSymlinks(ctx);
  symlinkSync(join(root, "src", "safe.ts"), join(base, "return.ts"), "file");
  symlinkSync(base, join(root, "outside-parent"), process.platform === "win32" ? "junction" : "dir");
  await rejected("outside-parent/return.ts");
});

test("a symlink spelling of the trusted root supports relative citations", async () => {
  const alias = join(base, "root-alias");
  symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
  root = alias;
  expect(citation("src/safe.ts").check.resolved_path).toBe("src/safe.ts");
  expect((await groundFinding(root, finding("src/safe.ts"))).status).toBe("grounded");
});

test("internal alias identity matches delivered evidence and path-only directories fail", () => {
  symlinkSync(join(root, "src"), join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
  const result = checkCitations({ root, corpus: new Set<string>(),
    citations: [{ owner_id: "alias", ref: "alias/safe.ts:2", quote: "needle" },
      { owner_id: "directory", ref: "src" }],
    delivered: [{ source_path: "alias/safe.ts", line_runs: [{ start: 2, end: 2 }], prefix_width: 0 }],
  });
  expect(result.checks.find(c => c.owner_id === "alias")!.verdict).toBe("ok");
  expect(result.checks.find(c => c.owner_id === "directory")!.verdict).toBe("unknown_path");
});
