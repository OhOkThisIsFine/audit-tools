import { test, expect } from "vitest";
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
  expect(parseAnalyzerSpec("typescript")).toEqual({ name: "typescript" });
  expect(parseAnalyzerSpec("typescript@5.8.0")).toEqual({
    name: "typescript",
    version: "5.8.0",
  });
  expect(parseAnalyzerSpec("@scope/pkg")).toEqual({ name: "@scope/pkg" });
  expect(parseAnalyzerSpec("@scope/pkg@1.2.3")).toEqual({
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
    expect(resolved.via).toBe("repo");
    expect(resolved.path?.endsWith(join("node_modules", "typescript"))).toBeTruthy();
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
    expect(resolved.via).toBe("cache");
    expect(resolved.path?.includes("typescript@5.8.0")).toBeTruthy();
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
    expect(resolved.via).toBe("cache");
    expect(resolved.path?.includes("tool@2.0.0")).toBeTruthy();
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
    expect(resolved.via).toBe("cache");
    expect(resolved.path?.includes("@scope+pkg@1.2.3")).toBeTruthy();
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
    expect(resolved.via).toBe("cache");
    expect(resolved.path?.includes("@scope+tool@2.0.0")).toBeTruthy();
  });
});

test("absent when neither repo nor cache has the package", async () => {
  await withTempDir(async (base) => {
    const resolved = resolveAnalyzerDep("typescript", join(base, "repo"), {
      cacheRoot: join(base, "cache"),
    });
    expect(resolved.via).toBe("absent");
    expect(resolved.path).toBe(undefined);
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
    expect(resolved.via).toBe("repo");
    expect(resolved.path).toBe(pkgDir);
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
    expect(resolved.via).toBe("repo");
    expect(resolved.path).toBe(pkgDir);
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
    expect(result.ok).toBe(false);
    expect(result.error.includes("explicit version"), `error was: ${result.error}`).toBeTruthy();
  });
});

test("installToCache returns error when npm install exits non-zero (stderr present)", async () => {
  await withTempDir(async (cacheRoot) => {
    const run = makeRun({ status: 1, stderr: "E404 not found" });
    const result = installToCache("typescript@5.8.0", { cacheRoot, run, log: () => {} });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("E404 not found");
  });
});

test("installToCache returns error when npm install exits non-zero (no stderr)", async () => {
  await withTempDir(async (cacheRoot) => {
    const run = makeRun({ status: 1, stderr: "" });
    const result = installToCache("typescript@5.8.0", { cacheRoot, run, log: () => {} });
    expect(result.ok).toBe(false);
    expect(result.error.includes("exited with 1"), `error was: ${result.error}`).toBeTruthy();
  });
});

test("installToCache returns error when package directory is absent after a successful npm run", async () => {
  await withTempDir(async (cacheRoot) => {
    // run succeeds but does NOT create the package directory
    const run = makeRun({ status: 0 });
    const result = installToCache("typescript@5.8.0", { cacheRoot, run, log: () => {} });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("package not present after install");
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
    const result = installToCache("typescript@5.8.0", { cacheRoot, run, log: () => {} });
    expect(result.ok).toBe(true);
    expect(result.path, "path should be present").toBeTruthy();
    expect(result.path.includes("typescript@5.8.0"), `path was: ${result.path}`).toBeTruthy();
    expect(result.path.endsWith(join("node_modules", "typescript")), `path was: ${result.path}`).toBeTruthy();
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
    expect(result.ok).toBe(true);
    expect(result.path, "path should be present").toBeTruthy();
    expect(result.path.endsWith(join("node_modules", "@scope", "pkg")), `path was: ${result.path}`).toBeTruthy();
  });
});

test("installToCache returns error when run() throws synchronously", async () => {
  await withTempDir(async (cacheRoot) => {
    const run = () => { throw new Error("spawn ENOENT"); };
    const result = installToCache("typescript@5.8.0", { cacheRoot, run, log: () => {} });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("spawn ENOENT");
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
    const result1 = installToCache("typescript@5.8.0", { cacheRoot, run, log: () => {} });
    const result2 = installToCache("typescript@5.8.0", { cacheRoot, run, log: () => {} });
    expect(callCount, "run() called once per installToCache call").toBe(2);
    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
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
      expect(result.ok).toBe(true);
      // install-start log must appear before the success log
      const startIdx = logs.findIndex((l) => l.includes("[analyzerDeps]") && l.includes("installing") && l.includes("typescript@5.8.0"));
      const doneIdx = logs.findIndex((l) => l.includes("[analyzerDeps]") && l.includes("installed") && l.includes("typescript@5.8.0"));
      expect(startIdx !== -1, "install-start log not found").toBeTruthy();
      expect(doneIdx !== -1, "install-done log not found").toBeTruthy();
      expect(startIdx < doneIdx, "install-start should precede install-done").toBeTruthy();
      // success log must include resolved path
      expect(logs[doneIdx].includes(result.path), "install-done log should include resolved path").toBeTruthy();
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
      expect(result.ok).toBe(false);
      const errLog = errors.find((l) => l.includes("[analyzerDeps]") && l.includes("typescript@5.8.0") && l.includes("2"));
      expect(errLog !== undefined, "error log for non-zero exit not found").toBeTruthy();
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
      expect(result.ok).toBe(false);
      const errLog = errors.find((l) => l.includes("[analyzerDeps]") && l.includes("typescript@5.8.0") && l.includes("absent"));
      expect(errLog !== undefined, "error log for absent package dir not found").toBeTruthy();
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
      expect(result.ok).toBe(false);
      const errLog = errors.find((l) => l.includes("[analyzerDeps]") && l.includes("spawn ENOENT"));
      expect(errLog !== undefined, "error log for thrown error not found").toBeTruthy();
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
      expect(resolved.via).toBe("cache");
      const log = logs.find((l) => l.includes("[analyzerDeps]") && l.includes("cache") && l.includes(resolved.path));
      expect(log !== undefined, "cache-hit log not found").toBeTruthy();
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
      expect(resolved.via).toBe("repo");
      const log = logs.find((l) => l.includes("[analyzerDeps]") && l.includes("repo") && l.includes(resolved.path));
      expect(log !== undefined, "repo-hit log not found").toBeTruthy();
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
      expect(resolved.via).toBe("absent");
      const log = logs.find((l) => l.includes("[analyzerDeps]") && l.includes("absent"));
      expect(log !== undefined, "absent log not found").toBeTruthy();
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

    expect(result.ok, "cache-write failure must degrade to ok:false").toBe(false);
    expect(result.error && result.error.length > 0, "a failure reason must be recorded").toBeTruthy();
    expect(spawned, "the installer must never spawn once the cache write fails").toBe(0);

    // The audited project tree is never written into — no node_modules appears.
    expect(existsSync(join(projectRoot, "node_modules")), "a cache-write failure must never touch the audited project tree").toBe(false);
    // The blocker file is untouched (the engine never clobbered it to force a dir).
    expect(existsSync(blocker), "the engine must not destroy existing paths").toBe(true);
  });
});
