/**
 * Regression test for MNT-fe5e6061: analyzerDeps accepts an injectable logger.
 *
 * Verifies that both resolveAnalyzerDep and installToCache accept an optional
 * `log` function and route all observability output through it, so callers can
 * redirect or suppress output without intercepting console.error globally.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { resolveAnalyzerDep, installToCache } = await import(
  "../src/tooling/analyzerDeps.ts"
);

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "mnt-fe5e6061-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── resolveAnalyzerDep injectable log ─────────────────────────────────────────

test("MNT-fe5e6061: resolveAnalyzerDep routes repo-hit log through injected log function", async () => {
  await withTempDir(async (base) => {
    const repoRoot = join(base, "repo");
    const pkgDir = join(repoRoot, "node_modules", "typescript");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, "package.json"), JSON.stringify({ name: "typescript" }), "utf8");

    const captured = [];
    const log = (...args) => captured.push(args.map(String).join(" "));

    // Inject a no-op console.error guard to ensure output goes through log only
    const origError = console.error;
    const consoleCapture = [];
    console.error = (...args) => consoleCapture.push(args.map(String).join(" "));
    try {
      const resolved = resolveAnalyzerDep("typescript", repoRoot, {
        cacheRoot: join(base, "no-cache"),
        log,
      });
      assert.strictEqual(resolved.via, "repo");
      // injected log must have received the repo-hit message
      assert.ok(
        captured.some((l) => l.includes("[analyzerDeps]") && l.includes("repo")),
        `expected repo-hit in injected log; got: ${JSON.stringify(captured)}`,
      );
      // console.error must NOT have received any analyzerDeps messages
      assert.ok(
        !consoleCapture.some((l) => l.includes("[analyzerDeps]")),
        `console.error should not receive analyzerDeps output when log is injected; got: ${JSON.stringify(consoleCapture)}`,
      );
    } finally {
      console.error = origError;
    }
  });
});

test("MNT-fe5e6061: resolveAnalyzerDep routes absent log through injected log function", async () => {
  await withTempDir(async (base) => {
    const captured = [];
    const log = (...args) => captured.push(args.map(String).join(" "));

    const origError = console.error;
    const consoleCapture = [];
    console.error = (...args) => consoleCapture.push(args.map(String).join(" "));
    try {
      const resolved = resolveAnalyzerDep("nonexistent-pkg", join(base, "repo"), {
        cacheRoot: join(base, "cache"),
        log,
      });
      assert.strictEqual(resolved.via, "absent");
      assert.ok(
        captured.some((l) => l.includes("[analyzerDeps]") && l.includes("absent")),
        `expected absent log in injected log; got: ${JSON.stringify(captured)}`,
      );
      assert.ok(
        !consoleCapture.some((l) => l.includes("[analyzerDeps]")),
        `console.error should not receive analyzerDeps output when log is injected`,
      );
    } finally {
      console.error = origError;
    }
  });
});

// ── installToCache injectable log ─────────────────────────────────────────────

test("MNT-fe5e6061: installToCache routes install log through injected log function", async () => {
  await withTempDir(async (cacheRoot) => {
    const captured = [];
    const log = (...args) => captured.push(args.map(String).join(" "));

    const run = (_argv, cwd) => {
      const pkgDir = join(cwd, "node_modules", "typescript");
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "typescript" }));
      return { status: 0, stdout: "", stderr: "", argv: _argv };
    };

    const origError = console.error;
    const consoleCapture = [];
    console.error = (...args) => consoleCapture.push(args.map(String).join(" "));
    try {
      const result = installToCache("typescript@5.8.0", { cacheRoot, run, log });
      assert.strictEqual(result.ok, true);
      assert.ok(
        captured.some((l) => l.includes("[analyzerDeps]") && l.includes("installing")),
        `expected install-start in injected log; got: ${JSON.stringify(captured)}`,
      );
      assert.ok(
        captured.some((l) => l.includes("[analyzerDeps]") && l.includes("installed")),
        `expected install-done in injected log; got: ${JSON.stringify(captured)}`,
      );
      assert.ok(
        !consoleCapture.some((l) => l.includes("[analyzerDeps]")),
        `console.error should not receive analyzerDeps output when log is injected`,
      );
    } finally {
      console.error = origError;
    }
  });
});

test("MNT-fe5e6061: installToCache routes failure log through injected log function", async () => {
  await withTempDir(async (cacheRoot) => {
    const captured = [];
    const log = (...args) => captured.push(args.map(String).join(" "));

    const run = () => ({ status: 1, stdout: "", stderr: "E404 not found", argv: [] });

    const origError = console.error;
    const consoleCapture = [];
    console.error = (...args) => consoleCapture.push(args.map(String).join(" "));
    try {
      const result = installToCache("typescript@5.8.0", { cacheRoot, run, log });
      assert.strictEqual(result.ok, false);
      assert.ok(
        captured.some((l) => l.includes("[analyzerDeps]") && l.includes("failed")),
        `expected failure log in injected log; got: ${JSON.stringify(captured)}`,
      );
      assert.ok(
        !consoleCapture.some((l) => l.includes("[analyzerDeps]")),
        `console.error should not receive analyzerDeps output when log is injected`,
      );
    } finally {
      console.error = origError;
    }
  });
});

// ── Default behavior (no log option) still uses console.error ─────────────────

test("MNT-fe5e6061: resolveAnalyzerDep still logs to console.error when no log option given", async () => {
  await withTempDir(async (base) => {
    const captured = [];
    const origError = console.error;
    console.error = (...args) => captured.push(args.map(String).join(" "));
    try {
      resolveAnalyzerDep("nonexistent-pkg", join(base, "repo"), {
        cacheRoot: join(base, "cache"),
        // no log option — should default to console.error
      });
      assert.ok(
        captured.some((l) => l.includes("[analyzerDeps]")),
        `expected console.error to receive analyzerDeps output when no log is injected; got: ${JSON.stringify(captured)}`,
      );
    } finally {
      console.error = origError;
    }
  });
});
