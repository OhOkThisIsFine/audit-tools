import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { resolveAnalyzerDep, parseAnalyzerSpec, installToCache } = await import("../../src/shared/tooling/analyzerDeps.ts");

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

test("resolution order: version-keyed cache for scoped+versioned package", async () => {
  await withTempDir(async (base) => {
    const repoRoot = join(base, "repo");
    await mkdir(repoRoot, { recursive: true });
    const cacheRoot = join(base, "cache");
    await installPackage(
      join(cacheRoot, "@scope+pkg@1.2.3", "node_modules"),
      "@scope/pkg",
    );
    const resolved = resolveAnalyzerDep("@scope/pkg@1.2.3", repoRoot, { cacheRoot });
    assert.equal(resolved.via, "cache");
    assert.ok(resolved.path?.includes("@scope+pkg@1.2.3"));
  });
});

test("resolution order: newest cached version chosen when scoped package is unpinned", async () => {
  await withTempDir(async (base) => {
    const repoRoot = join(base, "repo");
    await mkdir(repoRoot, { recursive: true });
    const cacheRoot = join(base, "cache");
    await installPackage(join(cacheRoot, "@scope+tool@1.0.0", "node_modules"), "@scope/tool");
    await installPackage(join(cacheRoot, "@scope+tool@2.0.0", "node_modules"), "@scope/tool");
    const resolved = resolveAnalyzerDep("@scope/tool", repoRoot, { cacheRoot });
    assert.equal(resolved.via, "cache");
    assert.ok(resolved.path?.includes("@scope+tool@2.0.0"));
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

// ── resolveAnalyzerDep uses packageDirIn for repo lookup ─────────────────────

test("resolveAnalyzerDep returns via='repo' when package.json exists under repo node_modules", async () => {
  await withTempDir(async (base) => {
    const repoRoot = join(base, "repo");
    const pkgDir = join(repoRoot, "node_modules", "typescript");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, "package.json"), JSON.stringify({ name: "typescript" }), "utf8");

    const resolved = resolveAnalyzerDep("typescript", repoRoot, {
      cacheRoot: join(base, "no-cache"),
    });
    assert.equal(resolved.via, "repo");
    assert.equal(resolved.path, pkgDir);
  });
});

test("resolveAnalyzerDep returns via='repo' for a scoped package (@scope/pkg) resolved via packageDirIn", async () => {
  await withTempDir(async (base) => {
    const repoRoot = join(base, "repo");
    const pkgDir = join(repoRoot, "node_modules", "@scope", "pkg");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, "package.json"), JSON.stringify({ name: "@scope/pkg" }), "utf8");

    const resolved = resolveAnalyzerDep("@scope/pkg", repoRoot, {
      cacheRoot: join(base, "no-cache"),
    });
    assert.equal(resolved.via, "repo");
    assert.equal(resolved.path, pkgDir);
  });
});

// ── installToCache unit tests ─────────────────────────────────────────────────

/** Minimal RunTrackedResult stub factory. */
function makeRun(overrides = {}) {
  return (_argv, _cwd) => ({
    status: 0,
    stdout: "",
    stderr: "",
    argv: _argv,
    ...overrides,
  });
}

test("installToCache returns error when no version is provided", async () => {
  await withTempDir(async (cacheRoot) => {
    const result = installToCache("typescript", { cacheRoot });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes("explicit version"), `error was: ${result.error}`);
  });
});

test("installToCache returns error when npm install exits non-zero (stderr present)", async () => {
  await withTempDir(async (cacheRoot) => {
    const run = makeRun({ status: 1, stderr: "E404 not found" });
    const result = installToCache("typescript@5.8.0", { cacheRoot, run });
    assert.equal(result.ok, false);
    assert.equal(result.error, "E404 not found");
  });
});

test("installToCache returns error when npm install exits non-zero (no stderr)", async () => {
  await withTempDir(async (cacheRoot) => {
    const run = makeRun({ status: 1, stderr: "" });
    const result = installToCache("typescript@5.8.0", { cacheRoot, run });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes("exited with 1"), `error was: ${result.error}`);
  });
});

test("installToCache returns error when package directory is absent after a successful npm run", async () => {
  await withTempDir(async (cacheRoot) => {
    // run succeeds but does NOT create the package directory
    const run = makeRun({ status: 0 });
    const result = installToCache("typescript@5.8.0", { cacheRoot, run });
    assert.equal(result.ok, false);
    assert.equal(result.error, "package not present after install");
  });
});

test("installToCache returns ok:true and the package path on success", async () => {
  await withTempDir(async (cacheRoot) => {
    const run = (_argv, cwd) => {
      // Simulate npm install: create node_modules/typescript/package.json
      const pkgDir = join(cwd, "node_modules", "typescript");
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "typescript" }));
      return { status: 0, stdout: "", stderr: "", argv: _argv };
    };
    const result = installToCache("typescript@5.8.0", { cacheRoot, run });
    assert.equal(result.ok, true);
    assert.ok(result.path, "path should be present");
    assert.ok(result.path.includes("typescript@5.8.0"), `path was: ${result.path}`);
    assert.ok(result.path.endsWith(join("node_modules", "typescript")), `path was: ${result.path}`);
  });
});

test("installToCache returns ok:true for a scoped package (@scope/pkg@version)", async () => {
  await withTempDir(async (cacheRoot) => {
    const run = (_argv, cwd) => {
      // Simulate npm install: create node_modules/@scope/pkg/package.json
      const pkgDir = join(cwd, "node_modules", "@scope", "pkg");
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@scope/pkg" }));
      return { status: 0, stdout: "", stderr: "", argv: _argv };
    };
    const result = installToCache("@scope/pkg@1.0.0", { cacheRoot, run });
    assert.equal(result.ok, true);
    assert.ok(result.path, "path should be present");
    assert.ok(
      result.path.endsWith(join("node_modules", "@scope", "pkg")),
      `path was: ${result.path}`,
    );
  });
});

test("installToCache returns error when run() throws synchronously", async () => {
  await withTempDir(async (cacheRoot) => {
    const run = () => { throw new Error("spawn ENOENT"); };
    const result = installToCache("typescript@5.8.0", { cacheRoot, run });
    assert.equal(result.ok, false);
    assert.equal(result.error, "spawn ENOENT");
  });
});

test("installToCache creates and reuses a package.json manifest in the install directory", async () => {
  await withTempDir(async (cacheRoot) => {
    let callCount = 0;
    const run = (_argv, cwd) => {
      callCount++;
      const pkgDir = join(cwd, "node_modules", "typescript");
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "typescript" }));
      return { status: 0, stdout: "", stderr: "", argv: _argv };
    };
    const result1 = installToCache("typescript@5.8.0", { cacheRoot, run });
    const result2 = installToCache("typescript@5.8.0", { cacheRoot, run });
    assert.equal(callCount, 2, "run() called once per installToCache call");
    assert.equal(result1.ok, true);
    assert.equal(result2.ok, true);
  });
});

// ── observability logging ─────────────────────────────────────────────────────

test("installToCache logs on successful install", async () => {
  await withTempDir(async (cacheRoot) => {
    const logs = [];
    const origError = console.error;
    console.error = (...args) => logs.push(args.map(String).join(" "));
    try {
      const run = (_argv, cwd) => {
        const pkgDir = join(cwd, "node_modules", "typescript");
        mkdirSync(pkgDir, { recursive: true });
        writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "typescript" }));
        return { status: 0, stdout: "", stderr: "", argv: _argv };
      };
      const result = installToCache("typescript@5.8.0", { cacheRoot, run });
      assert.equal(result.ok, true);
      // install-start log must appear before the success log
      const startIdx = logs.findIndex((l) => l.includes("[analyzerDeps]") && l.includes("installing") && l.includes("typescript@5.8.0"));
      const doneIdx = logs.findIndex((l) => l.includes("[analyzerDeps]") && l.includes("installed") && l.includes("typescript@5.8.0"));
      assert.ok(startIdx !== -1, "install-start log not found");
      assert.ok(doneIdx !== -1, "install-done log not found");
      assert.ok(startIdx < doneIdx, "install-start should precede install-done");
      // success log must include resolved path
      assert.ok(logs[doneIdx].includes(result.path), "install-done log should include resolved path");
    } finally {
      console.error = origError;
    }
  });
});

test("installToCache logs on npm non-zero exit", async () => {
  await withTempDir(async (cacheRoot) => {
    const errors = [];
    const origError = console.error;
    console.error = (...args) => errors.push(args.map(String).join(" "));
    try {
      const run = makeRun({ status: 2, stderr: "ENOMEM" });
      const result = installToCache("typescript@5.8.0", { cacheRoot, run });
      assert.equal(result.ok, false);
      const errLog = errors.find((l) => l.includes("[analyzerDeps]") && l.includes("typescript@5.8.0") && l.includes("2"));
      assert.ok(errLog !== undefined, "error log for non-zero exit not found");
    } finally {
      console.error = origError;
    }
  });
});

test("installToCache logs when package directory is absent after install", async () => {
  await withTempDir(async (cacheRoot) => {
    const errors = [];
    const origError = console.error;
    console.error = (...args) => errors.push(args.map(String).join(" "));
    try {
      const run = makeRun({ status: 0 }); // exits 0 but creates no package dir
      const result = installToCache("typescript@5.8.0", { cacheRoot, run });
      assert.equal(result.ok, false);
      const errLog = errors.find((l) => l.includes("[analyzerDeps]") && l.includes("typescript@5.8.0") && l.includes("absent"));
      assert.ok(errLog !== undefined, "error log for absent package dir not found");
    } finally {
      console.error = origError;
    }
  });
});

test("installToCache logs when run() throws", async () => {
  await withTempDir(async (cacheRoot) => {
    const errors = [];
    const origError = console.error;
    console.error = (...args) => errors.push(args.map(String).join(" "));
    try {
      const run = () => { throw new Error("spawn ENOENT"); };
      const result = installToCache("typescript@5.8.0", { cacheRoot, run });
      assert.equal(result.ok, false);
      const errLog = errors.find((l) => l.includes("[analyzerDeps]") && l.includes("spawn ENOENT"));
      assert.ok(errLog !== undefined, "error log for thrown error not found");
    } finally {
      console.error = origError;
    }
  });
});

test("resolveAnalyzerDep logs cache-hit resolution path", async () => {
  await withTempDir(async (base) => {
    const logs = [];
    const origError = console.error;
    console.error = (...args) => logs.push(args.map(String).join(" "));
    try {
      const repoRoot = join(base, "repo");
      await mkdir(repoRoot, { recursive: true });
      const cacheRoot = join(base, "cache");
      await installPackage(join(cacheRoot, "typescript@5.8.0", "node_modules"), "typescript");
      const resolved = resolveAnalyzerDep("typescript@5.8.0", repoRoot, { cacheRoot });
      assert.equal(resolved.via, "cache");
      const log = logs.find((l) => l.includes("[analyzerDeps]") && l.includes("cache") && l.includes(resolved.path));
      assert.ok(log !== undefined, "cache-hit log not found");
    } finally {
      console.error = origError;
    }
  });
});

test("resolveAnalyzerDep logs repo resolution path", async () => {
  await withTempDir(async (base) => {
    const logs = [];
    const origError = console.error;
    console.error = (...args) => logs.push(args.map(String).join(" "));
    try {
      const repoRoot = join(base, "repo");
      await installPackage(join(repoRoot, "node_modules"), "typescript");
      const resolved = resolveAnalyzerDep("typescript", repoRoot, {
        cacheRoot: join(base, "no-cache"),
      });
      assert.equal(resolved.via, "repo");
      const log = logs.find((l) => l.includes("[analyzerDeps]") && l.includes("repo") && l.includes(resolved.path));
      assert.ok(log !== undefined, "repo-hit log not found");
    } finally {
      console.error = origError;
    }
  });
});

test("resolveAnalyzerDep logs absent when not found", async () => {
  await withTempDir(async (base) => {
    const logs = [];
    const origError = console.error;
    console.error = (...args) => logs.push(args.map(String).join(" "));
    try {
      const resolved = resolveAnalyzerDep("typescript", join(base, "repo"), {
        cacheRoot: join(base, "cache"),
      });
      assert.equal(resolved.via, "absent");
      const log = logs.find((l) => l.includes("[analyzerDeps]") && l.includes("absent"));
      assert.ok(log !== undefined, "absent log not found");
    } finally {
      console.error = origError;
    }
  });
});

// F5 fail-10 (OBL-f5-analyzer-acquisition-engine-fail-10): a version-keyed cache
// WRITE failure (disk full / permission denied) degrades to absent for that tool
// — installToCache returns ok:false without throwing, never spawns the installer
// after the write fails, and never touches the audited project tree. The write
// failure is induced cross-platform by making the cache root's parent a regular
// FILE, so the engine's mkdirSync(installDir, …) raises a filesystem error
// (ENOTDIR/EEXIST) exactly as a disk/permission failure would.
test("F5 fail-10: a cache-write failure degrades to ok:false, never throws, never spawns, never touches the project tree", async () => {
  await withTempDir(async (base) => {
    // A regular file occupies the path where the cache root must be a directory:
    // mkdirSync(<file>/typescript@5.8.0, {recursive}) fails (the parent is a file).
    const blocker = join(base, "blocker");
    await writeFile(blocker, "not a directory", "utf8");
    const cacheRoot = blocker; // writing under a file → deterministic FS error

    // The audited project tree — must remain untouched by a cache-side failure.
    const projectRoot = join(base, "audited-project");
    await mkdir(projectRoot, { recursive: true });

    let spawned = 0;
    const run = () => {
      spawned += 1;
      return { status: 0, stdout: "", stderr: "", argv: [] };
    };

    // Must not throw — the whole point of fail-10 is graceful degradation.
    const result = installToCache("typescript@5.8.0", { cacheRoot, run, log: () => {} });

    assert.equal(result.ok, false, "cache-write failure must degrade to ok:false");
    assert.ok(result.error && result.error.length > 0, "a failure reason must be recorded");
    assert.equal(spawned, 0, "the installer must never spawn once the cache write fails");

    // The audited project tree is never written into — no node_modules appears.
    assert.equal(
      existsSync(join(projectRoot, "node_modules")),
      false,
      "a cache-write failure must never touch the audited project tree",
    );
    // The blocker file is untouched (the engine never clobbered it to force a dir).
    assert.equal(existsSync(blocker), true, "the engine must not destroy existing paths");
  });
});
