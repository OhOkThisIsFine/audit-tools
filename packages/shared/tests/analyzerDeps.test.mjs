import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { resolveAnalyzerDep, parseAnalyzerSpec } = await import(
  "../src/tooling/analyzerDeps.ts"
);

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "audit-tools-analyzer-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function installPackage(rootDir, name, contents = { name }) {
  const pkgDir = join(rootDir, ...name.split("/"));
  await mkdir(pkgDir, { recursive: true });
  await writeFile(join(pkgDir, "package.json"), JSON.stringify(contents), "utf8");
  return pkgDir;
}

test("parseAnalyzerSpec splits name, name@version, and scoped specs", () => {
  assert.deepEqual(parseAnalyzerSpec("typescript"), { name: "typescript" });
  assert.deepEqual(parseAnalyzerSpec("typescript@5.8.0"), {
    name: "typescript",
    version: "5.8.0",
  });
  assert.deepEqual(parseAnalyzerSpec("@scope/pkg"), { name: "@scope/pkg" });
  assert.deepEqual(parseAnalyzerSpec("@scope/pkg@1.2.3"), {
    name: "@scope/pkg",
    version: "1.2.3",
  });
});

test("resolution order: repo node_modules wins", async () => {
  await withTempDir(async (repoRoot) => {
    await installPackage(join(repoRoot, "node_modules"), "typescript");
    const resolved = resolveAnalyzerDep("typescript", repoRoot, {
      cacheRoot: join(repoRoot, "no-cache"),
    });
    assert.equal(resolved.via, "repo");
    assert.ok(resolved.path?.endsWith(join("node_modules", "typescript")));
  });
});

test("resolution order: version-keyed cache when repo lacks it", async () => {
  await withTempDir(async (base) => {
    const repoRoot = join(base, "repo");
    await mkdir(repoRoot, { recursive: true });
    const cacheRoot = join(base, "cache");
    await installPackage(
      join(cacheRoot, "typescript@5.8.0", "node_modules"),
      "typescript",
    );
    const resolved = resolveAnalyzerDep("typescript@5.8.0", repoRoot, { cacheRoot });
    assert.equal(resolved.via, "cache");
    assert.ok(resolved.path?.includes("typescript@5.8.0"));
  });
});

test("resolution order: newest cached version chosen when unpinned", async () => {
  await withTempDir(async (base) => {
    const repoRoot = join(base, "repo");
    await mkdir(repoRoot, { recursive: true });
    const cacheRoot = join(base, "cache");
    await installPackage(join(cacheRoot, "tool@1.0.0", "node_modules"), "tool");
    await installPackage(join(cacheRoot, "tool@2.0.0", "node_modules"), "tool");
    const resolved = resolveAnalyzerDep("tool", repoRoot, { cacheRoot });
    assert.equal(resolved.via, "cache");
    assert.ok(resolved.path?.includes("tool@2.0.0"));
  });
});

test("absent when neither repo nor cache has the package", async () => {
  await withTempDir(async (base) => {
    const resolved = resolveAnalyzerDep("typescript", join(base, "repo"), {
      cacheRoot: join(base, "cache"),
    });
    assert.equal(resolved.via, "absent");
    assert.equal(resolved.path, undefined);
  });
});
