/**
 * 2026-08-05 minor-friction cluster — the four items two dispatch waves punted
 * on, pinned tool-side:
 *  au-3: every step prompt carries the scope echo line from the persisted
 *        scope_summary.json, so a RESUMED run is no longer blind;
 *  au-4: advanceAudit runs a bounded-interval progress heartbeat naming the
 *        current phase (silent >300s derivations);
 *  au-6: identical staleness records dedupe at the single stderr writer
 *        (28×/~15× duplicate lines in single next-steps).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scopeEchoLine, writeCurrentStep } from "../../src/audit/cli/steps.js";
import { emitStalenessRecord } from "../../src/audit/orchestrator/staleness.js";
import { startAdvanceHeartbeat } from "../../src/audit/orchestrator/advance.js";

const RM_DIRS: string[] = [];
const tempDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  RM_DIRS.push(d);
  return d;
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const d of RM_DIRS.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort temp cleanup
    }
  }
});

describe("au-3: scope echo rides every step prompt from the persisted summary", () => {
  it("renders the scope line into the step prompt when scope_summary.json exists", async () => {
    const artifactsDir = tempDir("scope-");
    writeFileSync(
      join(artifactsDir, "scope_summary.json"),
      JSON.stringify({
        repo_root: "C:/target",
        auditable_file_count: 123,
        git_available: true,
        mis_scope_smells: [],
      }),
    );
    await writeCurrentStep({
      artifactsDir,
      stepKind: "blocked",
      status: "blocked",
      runId: null,
      allowedCommands: [],
      stopCondition: "stop",
      repoRoot: "C:/target",
      artifactPaths: {},
      prompt: "# Step body\n",
    });
    const prompt = readFileSync(join(artifactsDir, "steps", "current-prompt.md"), "utf8");
    expect(prompt).toContain("> Scope: auditing `C:/target` — 123 files, git: yes.");
    expect(prompt.indexOf("Scope: auditing")).toBeLessThan(prompt.indexOf("# Step body"));
  });

  it("no summary file → prompt unchanged", async () => {
    const artifactsDir = tempDir("scope-none-");
    await writeCurrentStep({
      artifactsDir,
      stepKind: "blocked",
      status: "blocked",
      runId: null,
      allowedCommands: [],
      stopCondition: "stop",
      repoRoot: "C:/target",
      artifactPaths: {},
      prompt: "# Step body\n",
    });
    const prompt = readFileSync(join(artifactsDir, "steps", "current-prompt.md"), "utf8");
    expect(prompt).not.toContain("Scope: auditing");
  });

  it("malformed summary degrades to no line", () => {
    const artifactsDir = tempDir("scope-bad-");
    writeFileSync(join(artifactsDir, "scope_summary.json"), "{not json");
    expect(scopeEchoLine(artifactsDir)).toBeNull();
  });
});

describe("au-6: identical staleness records dedupe at the writer", () => {
  it("a repeat of the exact last-emitted set is dropped; a changed set emits", () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);

    const setA = new Set(["au6_artifact_one.json", "au6_artifact_two.json"]);
    emitStalenessRecord(setA);
    emitStalenessRecord(setA);
    emitStalenessRecord(setA);
    const setB = new Set(["au6_artifact_three.json"]);
    emitStalenessRecord(setB);
    emitStalenessRecord(setB);

    const stalenessLines = writes.filter((w) => w.includes('"kind":"staleness"'));
    expect(stalenessLines).toHaveLength(2);
    expect(stalenessLines[0]).toContain("au6_artifact_one.json");
    expect(stalenessLines[1]).toContain("au6_artifact_three.json");
  });
});

describe("au-4: advance heartbeat emits liveness at a bounded interval", () => {
  it("writes a progress_heartbeat line per interval and stops cleanly", () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);

    const heartbeat = startAdvanceHeartbeat(1_000);
    heartbeat.setLabel("unit_manifest");
    vi.advanceTimersByTime(3_100);
    heartbeat.stop();
    vi.advanceTimersByTime(5_000);

    const beats = writes.filter((w) => w.includes('"kind":"progress_heartbeat"'));
    expect(beats).toHaveLength(3);
    expect(beats[0]).toContain('"phase":"unit_manifest"');
    expect(beats[0]).toContain('"elapsed_ms"');
  });
});
