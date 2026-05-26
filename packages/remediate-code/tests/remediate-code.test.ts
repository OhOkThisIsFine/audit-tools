import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
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
});
