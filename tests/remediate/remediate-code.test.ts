import { describe, it, expect } from "vitest";
import { spawnSyncHidden as spawnSync } from "../helpers/spawn.mjs";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

// The wrapper's OWN build-attempt signal, imported rather than re-typed. A
// second copy of the literal here would desync silently the day production
// renames it — the exact class this file's regression tests exist to catch.
// (Importing is side-effect-free: the wrapper guards `main()` on
// `import.meta.url === pathToFileURL(process.argv[1] ?? "").href` —
// remediate-code.mjs, the `if` immediately above its `main().catch(...)`.)
import { BUILD_ATTEMPT_MARKER } from "../../remediate-code.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WRAPPER = join(__dirname, "..", "..", "remediate-code.mjs");

async function importWrapperModule() {
  const tmpDir = mkdtempSync(join(tmpdir(), "remediate-import-"));
  try {
    const dst = join(tmpDir, "remediate-code.mjs");
    const source = readFileSync(WRAPPER, "utf8").replace(/^#!.*\r?\n/u, "");
    writeFileSync(dst, source, "utf8");
    return await import(/* @vite-ignore */ pathToFileURL(dst).href);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("remediate-code.mjs dist-not-found guard", () => {
  it("exits 1 with error message when dist/index.js is absent", () => {
    // Copy the wrapper to a temp directory that has no dist/ subtree.
    // Because the script derives __dirname from import.meta.url, running it
    // from the temp location makes it look for dist/index.js there — which
    // does not exist.
    const tmpDir = mkdtempSync(join(tmpdir(), "remediate-test-"));
    try {
      const dst = join(tmpDir, "remediate-code.mjs");
      writeFileSync(dst, readFileSync(WRAPPER, "utf8"), "utf8");

      const result = spawnSync(process.execPath, [dst], {
        cwd: tmpDir,
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/dist\/remediate\/index\.js not found/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── shouldBuildDist guards (COR-ea8a389a) ──────────────────────────────────

describe("shouldBuildDist: sourceRoot absent (published-install path)", () => {
  it("returns false (no build attempted) even when tsconfig and dist are absent", () => {
    // Neither src/, tsconfig.json, nor dist/index.js exist → published install.
    // shouldBuildDist() must return false; ensureBuilt skips build;
    // main() then exits 1 with the dist-not-found guard (no build stderr).
    const tmpDir = mkdtempSync(join(tmpdir(), "remediate-wrapper-fixture-"));
    try {
      const dst = join(tmpDir, "remediate-code.mjs");
      writeFileSync(dst, readFileSync(WRAPPER, "utf8"), "utf8");

      const result = spawnSync(process.execPath, [dst], {
        cwd: tmpDir,
        encoding: "utf8",
      });

      // Should exit 1 from dist-not-found guard, not from a failed build
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/dist\/remediate\/index\.js not found/);
      // No build was attempted — shouldBuildDist returned false, so ensureBuilt
      // never reached its build branch. The guard's own advisory says "Run: npm
      // run build", so any text search for "build" matches here too; the ONLY
      // sound discriminator is the wrapper's attempt marker, and its absence is
      // what "no build was attempted" means.
      expect(result.stderr).not.toContain(BUILD_ATTEMPT_MARKER);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("shouldBuildDist: sourceRoot exists, tsconfigPath absent, dist absent", () => {
  it("returns true so ensureBuilt attempts npm run build, which fails loudly", () => {
    // src/ exists, tsconfig.json absent, dist/index.js absent →
    // shouldBuildDist() must return true; ensureBuilt runs npm run build;
    // build fails (no tsconfig) and surfaces an error + exits non-zero.
    const tmpDir = mkdtempSync(join(tmpdir(), "remediate-wrapper-fixture-"));
    try {
      const dst = join(tmpDir, "remediate-code.mjs");
      writeFileSync(dst, readFileSync(WRAPPER, "utf8"), "utf8");
      // Create src/ but no tsconfig.json and no dist/
      mkdirSync(join(tmpDir, "src"), { recursive: true });

      const result = spawnSync(process.execPath, [dst], {
        cwd: tmpDir,
        encoding: "utf8",
      });

      // Should exit non-zero (build failure)
      expect(result.status).not.toBe(0);
      // Build was ATTEMPTED — asserted on the wrapper's own marker. The former
      // /npm run build|auto-build dist|build/i matched none of the real output
      // (npm's ENOENT text contains no "build"); it passed only because the
      // fixture directory used to be named "remediate-build-test-…", so the
      // regex was matching the temp path inside npm's error message.
      const combined = (result.stdout ?? "") + (result.stderr ?? "");
      expect(combined).toContain(BUILD_ATTEMPT_MARKER);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("shouldBuildDist: sourceRoot exists, tsconfigPath absent, dist present", () => {
  it("returns false so ensureBuilt skips build and main proceeds to existing dist", () => {
    // src/ exists, tsconfig.json absent, dist/index.js exists →
    // shouldBuildDist() must return false; ensureBuilt skips build;
    // main() loads dist/index.js (which will exit non-zero with unknown command,
    // but we only need to confirm no build was attempted).
    const tmpDir = mkdtempSync(join(tmpdir(), "remediate-wrapper-fixture-"));
    try {
      const dst = join(tmpDir, "remediate-code.mjs");
      writeFileSync(dst, readFileSync(WRAPPER, "utf8"), "utf8");
      mkdirSync(join(tmpDir, "src"), { recursive: true });
      mkdirSync(join(tmpDir, "dist", "remediate"), { recursive: true });
      // Write a minimal dist/index.js that exits 0
      writeFileSync(join(tmpDir, "dist", "remediate", "index.js"), "process.exit(0);", "utf8");

      const result = spawnSync(process.execPath, [dst], {
        cwd: tmpDir,
        encoding: "utf8",
      });

      // dist was loaded and exited cleanly — no build attempted
      expect(result.status).toBe(0);
      const combined = (result.stdout ?? "") + (result.stderr ?? "");
      expect(combined).not.toMatch(/auto-build dist/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("shouldBuildDist: tsconfigPath absent, dist present but STALE (CE-003)", () => {
  it("rebuilds a dist older than src/ instead of collapsing to an existence-only check", () => {
    // src/ exists, tsconfig.json absent, dist present but OLDER than src/ →
    // shouldBuildDist() must return true so ensureBuilt attempts a build (which
    // fails loudly here because there is no tsconfig). The pre-CE-003 code
    // returned `!existsSync(distEntry)` on the tsconfig-absent branch, so a
    // stale-but-present dist was silently used.
    const tmpDir = mkdtempSync(join(tmpdir(), "remediate-wrapper-fixture-"));
    try {
      const dst = join(tmpDir, "remediate-code.mjs");
      writeFileSync(dst, readFileSync(WRAPPER, "utf8"), "utf8");
      const srcDir = join(tmpDir, "src");
      mkdirSync(srcDir, { recursive: true });
      const srcFile = join(srcDir, "index.ts");
      writeFileSync(srcFile, "export const value = 1;\n", "utf8");
      mkdirSync(join(tmpDir, "dist", "remediate"), { recursive: true });
      const distFile = join(tmpDir, "dist", "remediate", "index.js");
      writeFileSync(distFile, "process.exit(0);", "utf8");

      // Age the dist BEFORE src so dist is stale (older than src/).
      const old = new Date("2026-01-01T00:00:00.000Z");
      const recent = new Date("2026-06-01T00:00:00.000Z");
      utimesSync(distFile, old, old);
      utimesSync(srcFile, recent, recent);
      utimesSync(srcDir, recent, recent);

      const result = spawnSync(process.execPath, [dst], {
        cwd: tmpDir,
        encoding: "utf8",
      });

      // A build was ATTEMPTED (and fails loudly with no tsconfig) → non-zero
      // exit AND the wrapper's own attempt marker. The marker is what proves the
      // stale dist triggered a rebuild: a non-zero exit alone is also what the
      // no-build guard produces, so the exit code cannot discriminate.
      expect(result.status).not.toBe(0);
      const combined = (result.stdout ?? "") + (result.stderr ?? "");
      expect(combined).toContain(BUILD_ATTEMPT_MARKER);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("ensureBuilt: a failed/signaled build halts before dist forwarding (CE-002)", () => {
  it("returns false and applies the exit action when the build is signaled", async () => {
    const { ensureBuilt } = await importWrapperModule();
    const applied: any[] = [];
    const proceed = ensureBuilt({
      shouldBuild: () => true,
      runBuild: () => ({ status: null, signal: "SIGTERM" }),
      applyExit: (action: unknown) => applied.push(action),
    });
    // The signal build must NOT let the caller proceed to dist forwarding, and a
    // terminating exit action must have been applied (never a silent continue).
    // The action's exact shape is platform-specific (re-raised signal on POSIX,
    // exit code 1 on win32) — assert only that SOME action with a type was
    // applied, deterministically (no either-or set-membership; INV-remediate-tests-04).
    expect(proceed).toBe(false);
    expect(applied).toHaveLength(1);
    expect(applied[0].type).toBeDefined();
  });

  it("returns false and applies the exit action when the build exits non-zero", async () => {
    const { ensureBuilt } = await importWrapperModule();
    const applied: any[] = [];
    const proceed = ensureBuilt({
      shouldBuild: () => true,
      runBuild: () => ({ status: 2, signal: null }),
      applyExit: (action: unknown) => applied.push(action),
    });
    expect(proceed).toBe(false);
    expect(applied[0]).toMatchObject({ type: "exit", code: 2 });
  });

  it("returns true and does not run a build when the dist is already fresh", async () => {
    const { ensureBuilt } = await importWrapperModule();
    let ran = false;
    const proceed = ensureBuilt({
      shouldBuild: () => false,
      runBuild: () => {
        ran = true;
        return { status: 0, signal: null };
      },
      applyExit: () => {
        throw new Error("applyExit must not be called on the no-build path");
      },
    });
    expect(proceed).toBe(true);
    expect(ran).toBe(false);
  });

  it("returns true after a successful build so the caller proceeds", async () => {
    const { ensureBuilt } = await importWrapperModule();
    const proceed = ensureBuilt({
      shouldBuild: () => true,
      runBuild: () => ({ status: 0, signal: null }),
      applyExit: () => {
        throw new Error("applyExit must not be called on a successful build");
      },
    });
    expect(proceed).toBe(true);
  });
});

describe("remediate-code.mjs child signal handling", () => {
  it("maps child signals to host-specific wrapper actions", async () => {
    const { getWrapperExitAction } = await importWrapperModule();

    expect(
      getWrapperExitAction({ signal: "SIGTERM", status: null }, "linux"),
    ).toEqual({ type: "signal", signal: "SIGTERM" });
    expect(
      getWrapperExitAction({ signal: "SIGTERM", status: null }, "win32"),
    ).toEqual({ type: "exit", code: 1 });
    expect(getWrapperExitAction({ signal: null, status: 7 }, "linux")).toEqual({
      type: "exit",
      code: 7,
    });
  });

  it("applies signal actions by re-raising the child signal", async () => {
    const { applyWrapperExitAction } = await importWrapperModule();
    const calls: any[] = [];

    applyWrapperExitAction(
      { type: "signal", signal: "SIGTERM" },
      {
        kill: (pid: number, signal: string) => {
          calls.push({ type: "kill", pid, signal });
          return true;
        },
        exit: (code?: number) => {
          calls.push({ type: "exit", code });
          throw new Error("exit should not be called before fallback");
        },
        setExitFallback: (callback: () => void, ms: number) => {
          calls.push({ type: "fallback", callback, ms });
          return undefined as any;
        },
      },
    );

    expect(calls[0]).toMatchObject({ type: "kill", signal: "SIGTERM" });
    expect(calls[1]).toMatchObject({ type: "fallback", ms: 1000 });
  });

  it("falls back to exit(1) when kill throws during signal re-raise", async () => {
    const { applyWrapperExitAction } = await importWrapperModule();
    const calls: any[] = [];

    applyWrapperExitAction(
      { type: "signal", signal: "SIGTERM" },
      {
        kill: () => {
          throw new Error("EPERM");
        },
        exit: (code?: number) => {
          calls.push({ type: "exit", code });
        },
        setExitFallback: () => {
          calls.push({ type: "fallback" });
          return undefined as any;
        },
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ type: "exit", code: 1 });
    expect(calls.some((c) => c.type === "fallback")).toBe(false);
  });
});
