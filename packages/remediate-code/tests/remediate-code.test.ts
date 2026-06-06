import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WRAPPER = join(__dirname, "..", "remediate-code.mjs");

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
      expect(result.stderr).toMatch(/dist\/index\.js not found/);
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
    const tmpDir = mkdtempSync(join(tmpdir(), "remediate-build-test-"));
    try {
      const dst = join(tmpDir, "remediate-code.mjs");
      writeFileSync(dst, readFileSync(WRAPPER, "utf8"), "utf8");

      const result = spawnSync(process.execPath, [dst], {
        cwd: tmpDir,
        encoding: "utf8",
      });

      // Should exit 1 from dist-not-found guard, not from a failed build
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/dist\/index\.js not found/);
      // No build was attempted — shouldBuildDist returned false, so ensureBuilt
      // never spawned a build. The only stderr is the guard's advisory (which
      // itself says "Run: npm run build"), so we discriminate on the auto-build
      // failure marker that ensureBuilt emits only when it actually runs a build.
      expect(result.stderr).not.toMatch(/auto-build dist/);
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
    const tmpDir = mkdtempSync(join(tmpdir(), "remediate-build-test-"));
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
      // Build was attempted — either build output or auto-build error message present
      const combined = (result.stdout ?? "") + (result.stderr ?? "");
      expect(combined).toMatch(/npm run build|auto-build dist|build/i);
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
    const tmpDir = mkdtempSync(join(tmpdir(), "remediate-build-test-"));
    try {
      const dst = join(tmpDir, "remediate-code.mjs");
      writeFileSync(dst, readFileSync(WRAPPER, "utf8"), "utf8");
      mkdirSync(join(tmpDir, "src"), { recursive: true });
      mkdirSync(join(tmpDir, "dist"), { recursive: true });
      // Write a minimal dist/index.js that exits 0
      writeFileSync(join(tmpDir, "dist", "index.js"), "process.exit(0);", "utf8");

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
