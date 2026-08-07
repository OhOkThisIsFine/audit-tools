/**
 * projectTestAdmission.test.ts — the project-test admission gate (CP-NODE-4
 * obligation 3 / seam_adjustments[2]): admission logic anchored to
 * discoverProjectCommands, plus a real happy-path spawn. Timeout/SIGTERM/
 * SIGKILL/truncation behavior is exercised deterministically (mocked
 * child_process + fake timers) in projectTestAdmission-spawn-control.test.ts.
 */
import { test, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
