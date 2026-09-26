import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  startProfileSession,
  getCurrentSession,
  markSynchronousPhaseStart,
  markSynchronousPhaseEnd,
  profileSynchronousPhase,
  profileSpawn,
  profileSpawnSync,
  profileNpmCommand,
  profileNodeCommand,
  endProfileSession,
  writeProfileLedger,
  formatProfileSummary,
  _resetProfileState,
} from "../../src/shared/measurement/performanceProfiler.js";

beforeEach(() => {
  _resetProfileState();
});

afterEach(() => {
  _resetProfileState();
});

test("startProfileSession creates a new session with expected structure", () => {
  const session = startProfileSession();
  expect(session.session_id).toMatch(/^perf-\d+-[a-z0-9]+$/);
  expect(session.started_at).toBeDefined();
  expect(session.finished_at).toBeUndefined();
  expect(session.spawns).toEqual([]);
  expect(session.synchronous_phases).toEqual([]);
  expect(session.repeated_commands).toEqual([]);
  expect(session.summary.total_spawns).toBe(0);
  expect(session.summary.total_spawn_duration_ms).toBe(0);
  expect(session.summary.total_synchronous_duration_ms).toBe(0);
  expect(session.summary.deadline_misses).toBe(0);
});

test("getCurrentSession returns existing session or creates new one", () => {
  const session1 = startProfileSession();
  const session2 = getCurrentSession();
  expect(session2).toBe(session1);

  _resetProfileState();
  const session3 = getCurrentSession();
  expect(session3).not.toBe(session1);
  expect(session3.session_id).not.toBe(session1.session_id);
});

test("markSynchronousPhaseStart and markSynchronousPhaseEnd track phases", () => {
  startProfileSession();
  markSynchronousPhaseStart("test-phase");
  const session = getCurrentSession();
  expect(session.synchronous_phases).toHaveLength(0); // Not ended yet

  const phase = markSynchronousPhaseEnd("test-phase");
  expect(phase).not.toBeNull();
  expect(phase?.label).toBe("test-phase");
  expect(typeof phase?.duration_ms).toBe("number");
  expect(phase?.duration_ms).toBeGreaterThanOrEqual(0);
  expect(phase?.exceeds_fold_safety_bound).toBe(false);

  const session2 = getCurrentSession();
  expect(session2.synchronous_phases).toHaveLength(1);
  expect(session2.synchronous_phases[0]).toBe(phase);
  expect(session2.summary.total_synchronous_duration_ms).toBe(phase?.duration_ms);
});

test("markSynchronousPhaseEnd returns null for unknown label", () => {
  startProfileSession();
  const result = markSynchronousPhaseEnd("unknown-phase");
  expect(result).toBeNull();
});

test("markSynchronousPhaseEnd flags phases exceeding 30s fold-safety bound", () => {
  startProfileSession();
  // Simulate a phase that started 31 seconds ago
  markSynchronousPhaseStart("long-phase", performance.now() - 31_000);
  const phase = markSynchronousPhaseEnd("long-phase");
  expect(phase).not.toBeNull();
  expect(phase?.duration_ms).toBeGreaterThanOrEqual(30_000);
  expect(phase?.exceeds_fold_safety_bound).toBe(true);

  const session = getCurrentSession();
  const summary = formatProfileSummary(session);
  expect(summary).toContain("EXCEEDS 30s FOLD-SAFETY BOUND");
});

test("profileSynchronousPhase wraps blocking execution and tracks its phase", () => {
  startProfileSession();

  const syncOutcome = profileSynchronousPhase("sync-computation", () => {
    return 42;
  });
  expect(syncOutcome.result).toBe(42);
  expect(syncOutcome.phase.label).toBe("sync-computation");
  expect(syncOutcome.phase.duration_ms).toBeGreaterThanOrEqual(0);

  const session = getCurrentSession();
  expect(session.synchronous_phases).toHaveLength(1);
});

test("profileSpawn records a spawn through runTrackedAsync with full log attribution", async () => {
  startProfileSession();

  const result = await profileSpawn(
    [
      "node",
      "-e",
      "console.log('child stdout'); console.error('child stderr'); process.exit(0)",
    ],
    { timeout: 5000 },
  );

  expect(result.argv).toContain("node");
  expect(result.exit_code).toBe(0);
  expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  expect(result.occurrence_count).toBe(1);
  expect(result.started_at).toBeDefined();
  expect(result.finished_at).toBeDefined();
  expect(result.deadline_miss).toBeUndefined();
  expect(result.stdout).toContain("child stdout");
  expect(result.stderr).toContain("child stderr");

  const session = getCurrentSession();
  expect(session.spawns).toHaveLength(1);
  expect(session.spawns[0]).toBe(result);
  expect(session.summary.total_spawns).toBe(1);
  expect(session.summary.total_spawn_duration_ms).toBe(result.duration_ms);
  expect(session.summary.slowest_spawn).toBe(result);
});

test("profileSpawn tracks occurrence count for repeated argv", async () => {
  startProfileSession();

  await profileSpawn(["node", "-e", "process.exit(0)"], { timeout: 5000 });
  await profileSpawn(["node", "-e", "process.exit(0)"], { timeout: 5000 });

  const session = getCurrentSession();
  expect(session.spawns).toHaveLength(2);
  expect(session.spawns[0].occurrence_count).toBe(1);
  expect(session.spawns[1].occurrence_count).toBe(2);
  expect(session.repeated_commands).toHaveLength(1);
  expect(session.repeated_commands[0].count).toBe(2);
  expect(session.repeated_commands[0].occurrences).toHaveLength(2);
});

test("profileSpawn detects deadline miss on timeout", async () => {
  startProfileSession();

  const result = await profileSpawn(
    ["node", "-e", "setTimeout(() => {}, 60000)"],
    { timeout: 100 }, // Short timeout
  );

  expect(result.exit_code).toBeNull();
  expect(result.error?.code).toBe("ETIMEDOUT");
  expect(result.deadline_miss).toBeDefined();
  expect(result.deadline_miss?.elapsed_ms).toBeGreaterThan(0);
  expect(result.deadline_miss?.child_exited).toBe(false);
  expect(result.deadline_miss?.survived_grace).toBe(false);

  const session = getCurrentSession();
  expect(session.summary.deadline_misses).toBe(1);
});

test("endProfileSession finalizes the session", () => {
  startProfileSession();
  markSynchronousPhaseStart("phase1");
  markSynchronousPhaseEnd("phase1");

  const session = endProfileSession();
  expect(session).not.toBeNull();
  expect(session?.session_id).toBeDefined();
  expect(session?.finished_at).toBeDefined();

  // After end, getCurrentSession creates a new one
  const newSession = getCurrentSession();
  expect(newSession.session_id).toBeDefined();
  expect(newSession.session_id).not.toBe(session?.session_id);
});

test("writeProfileLedger writes JSON and NDJSON files", async () => {
  const testDir = await mkdtemp(join(tmpdir(), "perf-test-"));
  try {
    startProfileSession();
    markSynchronousPhaseStart("test");
    markSynchronousPhaseEnd("test");
    await profileSpawn(["node", "-e", "process.exit(0)"], { timeout: 5000 });

    const session = endProfileSession();
    if (!session) throw new Error("No session");

    const record = await writeProfileLedger(
      "test-profile",
      session,
      { meta_tag: "v1" },
      { profileDir: testDir },
    );
    expect(record).toBeDefined();
    expect(record.profile).toBe("test-profile");
    expect(record.meta_tag).toBe("v1");

    const latest = JSON.parse(
      readFileSync(join(testDir, "test-profile-latest.json"), "utf8"),
    );
    expect(latest.profile).toBe("test-profile");
    expect(latest.session_id).toBe(session.session_id);
    expect(latest.spawns).toHaveLength(1);
    expect(latest.synchronous_phases).toHaveLength(1);
    expect(latest.meta_tag).toBe("v1");

    const history = readFileSync(
      join(testDir, "test-profile-history.ndjson"),
      "utf8",
    );
    expect(history).toContain("test-profile");
    expect(history).toContain(session.session_id);
    expect(history).toContain("v1");
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
});

test("formatProfileSummary produces readable output", () => {
  startProfileSession();
  markSynchronousPhaseStart("sync-phase");
  markSynchronousPhaseEnd("sync-phase");

  const session = endProfileSession();
  if (!session) throw new Error("No session");

  const summary = formatProfileSummary(session);
  expect(summary).toContain("Performance Profile:");
  expect(summary).toContain("Started:");
  expect(summary).toContain("Finished:");
  expect(summary).toContain("Total spawns:");
  expect(summary).toContain("Total spawn duration:");
  expect(summary).toContain("Total synchronous duration:");
  expect(summary).toContain("Deadline misses:");
  expect(summary).toContain("Synchronous phases:");
});

test("profileSpawnSync records a synchronous spawn with attribution", () => {
  startProfileSession();

  const result = profileSpawnSync(
    [
      "node",
      "-e",
      "console.log('sync out'); console.error('sync err'); process.exit(0)",
    ],
    { timeout: 5000 },
  );

  expect(result.argv).toContain("node");
  expect(result.exit_code).toBe(0);
  expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  expect(result.occurrence_count).toBe(1);
  expect(result.stdout).toContain("sync out");
  expect(result.stderr).toContain("sync err");

  const session = getCurrentSession();
  expect(session.spawns).toHaveLength(1);
});

test("profileNpmCommand and profileNodeCommand are convenience wrappers", async () => {
  startProfileSession();

  const npmResult = await profileNpmCommand(["--version"], { timeout: 10000 });
  // On Windows, argv[0] is cmd.exe wrapper; check argv contains npm.cmd
  if (process.platform === "win32") {
    expect(npmResult.argv[0]).toMatch(/cmd(\.exe)?$/i);
    expect(npmResult.argv.join(" ")).toMatch(/npm(\.cmd)?/);
  } else {
    expect(npmResult.argv[0]).toMatch(/npm$/);
  }
  expect(npmResult.argv.join(" ")).toContain("--version");

  const nodeResult = await profileNodeCommand("-e", ["process.exit(0)"], {
    timeout: 5000,
  });
  expect(nodeResult.argv[0]).toBe(process.execPath);
  expect(nodeResult.exit_code).toBe(0);
});

test("session summary tracks slowest spawn", async () => {
  startProfileSession();

  await profileSpawn(["node", "-e", "process.exit(0)"], { timeout: 5000 });
  await profileSpawn(["node", "-e", "process.exit(0)"], { timeout: 5000 });

  const session = getCurrentSession();
  expect(session.summary.slowest_spawn).toBeDefined();
  expect(session.summary.slowest_spawn?.argv).toContain("node");
});

test("session summary tracks most repeated argv", async () => {
  startProfileSession();

  await profileSpawn(["node", "-e", "process.exit(0)"], { timeout: 5000 });
  await profileSpawn(["node", "-e", "process.exit(0)"], { timeout: 5000 });
  await profileSpawn(["node", "-e", "process.exit(1)"], { timeout: 5000 });

  const session = getCurrentSession();
  expect(session.summary.most_repeated_argv).toBeDefined();
  expect(session.summary.most_repeated_argv).toEqual(session.spawns[0].argv);
});

test("repeated command group tracks total duration", async () => {
  startProfileSession();

  await profileSpawn(["node", "-e", "process.exit(0)"], { timeout: 5000 });
  await profileSpawn(["node", "-e", "process.exit(0)"], { timeout: 5000 });

  const session = getCurrentSession();
  const group = session.repeated_commands[0];
  expect(group.total_duration_ms).toBeGreaterThanOrEqual(0);
  expect(group.total_duration_ms).toBe(
    group.occurrences.reduce((sum, o) => sum + o.duration_ms, 0),
  );
});
