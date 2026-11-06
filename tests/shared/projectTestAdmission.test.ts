/**
 * projectTestAdmission.test.ts — the project-test admission gate (CP-NODE-4
 * obligation 3 / seam_adjustments[2]): admission logic anchored to
 * discoverProjectCommands, plus a real happy-path spawn. Timeout/SIGTERM/
 * SIGKILL/truncation behavior is exercised deterministically (mocked
 * child_process + fake timers) in projectTestAdmission-spawn-control.test.ts.
 */
import { test, expect } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isAdmittedProjectTestCommand,
  runAdmittedProjectTestCommand,
} from "../../src/shared/tooling/projectTestAdmission.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "audit-tools-testadmit-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── isAdmittedProjectTestCommand: anchored to discovery, never a static table ──

test("admits the exact npm-test vector discovery emits for a Node project", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } }),
      "utf8",
    );
    expect(isAdmittedProjectTestCommand(["npm", "test"], dir)).toBe(true);
  });
});

test("admits the exact go-test vector discovery emits for a Go project", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "go.mod"), "module example.com/x\n", "utf8");
    expect(isAdmittedProjectTestCommand(["go", "test", "./..."], dir)).toBe(true);
  });
});

test("admits the exact pytest vector discovery emits for a Python project", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "pyproject.toml"), "[project]\nname='x'\n", "utf8");
    expect(isAdmittedProjectTestCommand(["python", "-m", "pytest"], dir)).toBe(true);
  });
});

test("refuses a command discovery did NOT emit — extra flags on an otherwise-correct vector", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } }),
      "utf8",
    );
    // Superficially similar, but discovery only ever emits exactly ["npm","test"].
    expect(isAdmittedProjectTestCommand(["npm", "test", "--", "--coverage"], dir)).toBe(false);
    expect(isAdmittedProjectTestCommand(["npm", "run", "test"], dir)).toBe(false);
  });
});

test("refuses a command belonging to a DIFFERENT project shape (Go vector against a Node project)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } }),
      "utf8",
    );
    expect(isAdmittedProjectTestCommand(["go", "test", "./..."], dir)).toBe(false);
  });
});

test("refuses anything at all when discovery emits no test command", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "package.json"), JSON.stringify({}), "utf8");
    expect(isAdmittedProjectTestCommand(["npm", "test"], dir)).toBe(false);
    expect(isAdmittedProjectTestCommand([], dir)).toBe(false);
  });
});

// ── runAdmittedProjectTestCommand: refusal path never spawns ───────────────

test("runAdmittedProjectTestCommand resolves admitted:false with a refusal_reason and does not spawn, for a non-matching command", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } }),
      "utf8",
    );
    const outcome = await runAdmittedProjectTestCommand(["rm", "-rf", "/"], dir);
    expect(outcome.admitted).toBe(false);
    expect(typeof outcome.refusal_reason === "string" && outcome.refusal_reason.length > 0).toBeTruthy();
    expect(outcome.exit_code).toBe(null);
    expect(outcome.timed_out).toBe(false);
    expect(outcome.truncated).toBe(false);
    expect(outcome.output).toBe("");
  });
});

// ── runAdmittedProjectTestCommand: real happy-path spawn ───────────────────

test("runAdmittedProjectTestCommand actually runs an admitted command and reports its exit code", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "node -e \"console.log('ran'); process.exit(0)\"" } }),
      "utf8",
    );
    const outcome = await runAdmittedProjectTestCommand(["npm", "test"], dir);
    expect(outcome.admitted).toBe(true);
    expect(outcome.spawn_error).toBe(undefined);
    expect(outcome.timed_out).toBe(false);
    expect(outcome.exit_code, `expected exit 0, got ${outcome.exit_code}: ${outcome.output}`).toBe(0);
    expect(outcome.output).toMatch(/ran/);
  });
});

test("runAdmittedProjectTestCommand reports a non-zero exit code for a failing admitted suite", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "node -e \"process.exit(1)\"" } }),
      "utf8",
    );
    const outcome = await runAdmittedProjectTestCommand(["npm", "test"], dir);
    expect(outcome.admitted).toBe(true);
    expect(outcome.exit_code).toBe(1);
  });
});

// Every fixture process self-exits after eight seconds, including on the red
// baseline: no machine-wide cleanup and no indefinitely orphaned descendants.
test("timeout stops an admitted npm child and grandchild before returning", async () => {
  await withTempDir(async (dir) => {
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node child.cjs" } }));
    await writeFile(join(dir, "grandchild.cjs"), `
      const fs = require('node:fs');
      process.on('SIGTERM', () => {});
      setInterval(() => fs.appendFileSync('heartbeat', '.'), 25);
      setTimeout(() => process.exit(0), 8000);
    `);
    await writeFile(join(dir, "child.cjs"), `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      setInterval(() => fs.appendFileSync('child-heartbeat', '.'), 25);
      process.on('SIGTERM', () => {});
      spawn(process.execPath, ['grandchild.cjs'], { stdio: 'inherit' });
      setTimeout(() => process.exit(0), 8000);
    `);
    const heartbeatNames = ["child-heartbeat", "heartbeat"];
    // A missing heartbeat file is zero writes: that process never started.
    const heartbeats = () => Promise.all(heartbeatNames.map(async (name) =>
      (await readFile(join(dir, name), "utf8").catch(() => "")).length));
    // The deadline runs from the spawn of `npm`, so it also covers npm's and
    // node's start-up, which has no fixed upper bound under load. An attempt
    // whose deadline fired before BOTH processes wrote proves nothing about
    // stopping them; the next attempt adds the measured elapsed time to the
    // deadline. The first deadline is only a first probe: the result does
    // not depend on it.
    let timeoutMs = 1500;
    let started = Date.now();
    let cleanupObserved = false;
    try {
      for (;;) {
        await Promise.all(heartbeatNames.map((name) => rm(join(dir, name), { force: true })));
        started = Date.now();
        const outcome = await runAdmittedProjectTestCommand(["npm", "test"], dir,
          { timeoutMs, sigkillGraceMs: 250 });
        const elapsed = Date.now() - started;
        expect(outcome.timed_out).toBe(true);
        expect(elapsed, "the runner returns soon after its deadline").toBeLessThan(timeoutMs + 3500);
        const before = await heartbeats();
        if (before.some((count) => count === 0)) {
          timeoutMs += elapsed;
          continue;
        }
        await delay(200);
        const after = await heartbeats();
        expect(after, "child and grandchild must stop writing before the next gate can start").toEqual(before);
        cleanupObserved = true;
        break;
      }
    } finally {
      // A deliberately failing baseline must let its fixture children self-exit
      // before the containing fixture directory is removed.
      if (!cleanupObserved) await delay(Math.max(0, 9500 - (Date.now() - started)));
    }
  });
  // No per-test cap: the loop above lengthens its own deadline by each attempt's
  // measured start-up, so a fixed cap re-imposes the bound it removes. A 15s cap
  // here failed twice under full-suite load on 2026-11-06 and passed alone; the
  // global testTimeout bounds a run that never converges.
});
