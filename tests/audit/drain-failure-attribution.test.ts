/**
 * A fold failure must name the obligation that ACTUALLY threw.
 *
 * Pre-CX-02, `executeAndRecord` wrapped a nested drain (`runAuditStep` →
 * `advanceAudit`), so it recovered the failing identity from the error chain —
 * its own pre-drain `decideNextStep` selection named only the drain's FIRST
 * obligation, and ANY later fold failure was once attributed to an executor
 * that had already SUCCEEDED (a real `synthesis_executor` blowup was recorded
 * against `runtime_validation_executor` and sent the investigation to the
 * wrong file first).
 *
 * Under the ONE drain the attribution is DISPATCH-LOCAL: each obligation
 * execution dispatches exactly one step, whose own selection is the failing
 * identity, and the fold's commit-on-throw persists it in the single core
 * commit. This test drives the REAL fold — real engine, real lock hold, real
 * commit — over a real (tiny) repository, replacing only the LEAF WORK of the
 * fold's later obligation with a runner that throws.
 */
import { test, expect } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EXECUTOR_RUNNERS } from "../../src/audit/orchestrator/executorRunners.js";
import { runDeterministicForNextStep } from "../../src/audit/cli/nextStepHelpers.js";

/** The fold's first dispatch on an empty bundle — must NOT be blamed. */
const FIRST_EXECUTOR = "intake_executor";
/** The later dispatch made to fail here. */
const FAILING_EXECUTOR = "auto_fix_executor";
const FAILING_OBLIGATION = "auto_fixes_applied";

test("a fold failure names the obligation that threw, not the fold's first", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "drain-attribution-"));
  const root = join(workspace, "repo");
  const artifactsDir = join(workspace, "artifacts");
  const original = EXECUTOR_RUNNERS[FAILING_EXECUTOR];
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(artifactsDir, "steps"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
    await writeFile(
      join(root, "package.json"),
      '{"name":"drain-attribution-fixture","version":"1.0.0"}\n',
      "utf8",
    );

    EXECUTOR_RUNNERS[FAILING_EXECUTOR] = async () => {
      throw new Error("synthetic auto-fix failure");
    };

    let caught: unknown;
    try {
      await runDeterministicForNextStep({
        root,
        artifactsDir,
        selfCliPath: "audit-code",
        timeoutMs: 30_000,
        narrativeEnabled: false,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught, "the fold must fail").toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain(FAILING_EXECUTOR);
    expect(message).toContain(FAILING_OBLIGATION);
    expect(
      message,
      "the fold's FIRST (already-succeeded) executor must not be blamed",
    ).not.toContain(FIRST_EXECUTOR);
    expect(message).toContain("synthetic auto-fix failure");

    // The filesystem marker a watching host reads must agree. Attribution is
    // dispatch-local now, so the marker's own selection IS the failing one —
    // there is no separate "drain entry point" to reconstruct.
    const marker = JSON.parse(
      await readFile(
        join(artifactsDir, "steps", "deterministic-progress.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(marker.last_executor).toBe(FAILING_EXECUTOR);
    expect(marker.last_obligation).toBe(FAILING_OBLIGATION);
    expect(marker.selected_executor).toBe(FAILING_EXECUTOR);
    expect(marker.selected_obligation).toBe(FAILING_OBLIGATION);

    // The persisted audit_state records the same failing identity — written by
    // the fold's commit-on-throw (the single core commit covers the throw
    // path; the deleted second lock acquisition would deadlock under one hold).
    const state = JSON.parse(
      await readFile(join(artifactsDir, "audit_state.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(state.last_executor).toBe(FAILING_EXECUTOR);
    expect(state.last_obligation).toBe(FAILING_OBLIGATION);

    // Commit-on-throw persisted the CARRIED bundle: the first dispatch's
    // successful work (the repo manifest) survives the later throw.
    const manifest = JSON.parse(
      await readFile(join(artifactsDir, "repo_manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(Array.isArray(manifest.files)).toBe(true);
  } finally {
    EXECUTOR_RUNNERS[FAILING_EXECUTOR] = original!;
    await rm(workspace, { recursive: true, force: true });
  }
}, 120_000);
