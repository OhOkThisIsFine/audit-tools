import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addLoadOnlyObservation,
  emptyLoadFlakeRecord,
  markInvestigationRequested,
  observeAndClaimLoadFlake,
  observationFor,
  readLoadFlakeRecord,
} from "../../scripts/shared/load-flake-record.mjs";
import { createIsolatedSnapshot } from "../../scripts/shared/dispatch-load-flake-investigation.mjs";
import { execFileSyncHidden } from "../helpers/spawn.mjs";

const ENVIRONMENT = "win32-cpu16-w16";
const FILE = "tests/audit/heavy.test.ts";

describe("tool-owned load-flake observations", () => {
  it("does not let rerunning the same red on unchanged content manufacture a recurrence", () => {
    const first = addLoadOnlyObservation({
      record: emptyLoadFlakeRecord(),
      environment: ENVIRONMENT,
      file: FILE,
      tree: "tree-a",
      observedAt: "2026-09-07T00:00:00.000Z",
    });
    const duplicate = addLoadOnlyObservation({
      record: first.record,
      environment: ENVIRONMENT,
      file: FILE,
      tree: "tree-a",
      observedAt: "2026-09-07T01:00:00.000Z",
    });

    expect(first.added).toBe(true);
    expect(first.repeated).toBe(false);
    expect(duplicate.added).toBe(false);
    expect(duplicate.repeated).toBe(false);
    expect(duplicate.observation.count).toBe(1);
    expect(duplicate.observation.last_observed_at).toBe("2026-09-07T00:00:00.000Z");
  });

  it("classifies the second distinct-tree observation as repeated", () => {
    const first = addLoadOnlyObservation({
      record: emptyLoadFlakeRecord(),
      environment: ENVIRONMENT,
      file: FILE,
      tree: "tree-a",
      observedAt: "2026-09-07T00:00:00.000Z",
    });
    const second = addLoadOnlyObservation({
      record: first.record,
      environment: ENVIRONMENT,
      file: FILE,
      tree: "tree-b",
      observedAt: "2026-09-08T00:00:00.000Z",
    });

    expect(second.added).toBe(true);
    expect(second.repeated).toBe(true);
    expect(second.observation.count).toBe(2);
    expect(second.observation.observed_trees).toEqual(["tree-a", "tree-b"]);
  });

  it("records the separate repair-investigation track without changing the evidence count", () => {
    const observed = addLoadOnlyObservation({
      record: emptyLoadFlakeRecord(),
      environment: ENVIRONMENT,
      file: FILE,
      tree: "tree-a",
      observedAt: "2026-09-07T00:00:00.000Z",
    });
    const marked = markInvestigationRequested({
      record: observed.record,
      environment: ENVIRONMENT,
      file: FILE,
      requestedAt: "2026-09-07T02:00:00.000Z",
      reportPath: "C:/tmp/report.md",
    });

    expect(observationFor(marked, ENVIRONMENT, FILE)).toMatchObject({
      count: 1,
      investigation_requested_at: "2026-09-07T02:00:00.000Z",
      investigation_report: "C:/tmp/report.md",
    });
  });

  it("serializes a repeated observation so concurrent callers start one investigation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-tools-load-flake-record-"));
    const path = join(dir, "record.json");
    let starts = 0;
    try {
      await observeAndClaimLoadFlake({
        path,
        environment: ENVIRONMENT,
        file: FILE,
        tree: "tree-a",
        observedAt: "2026-09-07T00:00:00.000Z",
        startInvestigation: async () => ({ started: false }),
      });
      await Promise.all([
        observeAndClaimLoadFlake({
          path,
          environment: ENVIRONMENT,
          file: FILE,
          tree: "tree-b",
          observedAt: "2026-09-08T00:00:00.000Z",
          startInvestigation: async () => {
            starts += 1;
            return {
              started: true,
              requestedAt: "2026-09-08T00:00:01.000Z",
              reportPath: "C:/tmp/report.md",
            };
          },
        }),
        observeAndClaimLoadFlake({
          path,
          environment: ENVIRONMENT,
          file: FILE,
          tree: "tree-c",
          observedAt: "2026-09-09T00:00:00.000Z",
          startInvestigation: async () => {
            starts += 1;
            return {
              started: true,
              requestedAt: "2026-09-09T00:00:01.000Z",
              reportPath: "C:/tmp/duplicate.md",
            };
          },
        }),
      ]);

      expect(starts).toBe(1);
      const final = observationFor(readLoadFlakeRecord(path), ENVIRONMENT, FILE);
      expect(final?.count).toBe(3);
      expect([
        ["2026-09-08T00:00:01.000Z", "C:/tmp/report.md"],
        ["2026-09-09T00:00:01.000Z", "C:/tmp/duplicate.md"],
      ]).toContainEqual([final?.investigation_requested_at, final?.investigation_report]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a failed investigation claim retryable on the same observed tree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-tools-load-flake-retry-"));
    const path = join(dir, "record.json");
    try {
      for (const tree of ["tree-a", "tree-b"]) {
        await observeAndClaimLoadFlake({
          path,
          environment: ENVIRONMENT,
          file: FILE,
          tree,
          observedAt: "2026-09-07T00:00:00.000Z",
          startInvestigation: async () => ({ started: false, error: new Error("spawn failed") }),
        });
      }
      const retry = await observeAndClaimLoadFlake({
        path,
        environment: ENVIRONMENT,
        file: FILE,
        tree: "tree-b",
        observedAt: "2026-09-07T01:00:00.000Z",
        startInvestigation: async () => ({
          started: true,
          requestedAt: "2026-09-07T01:00:01.000Z",
          reportPath: "C:/tmp/retry.md",
        }),
      });

      expect(retry.folded.added).toBe(false);
      expect(retry.investigation.started).toBe(true);
      expect(observationFor(readLoadFlakeRecord(path), ENVIRONMENT, FILE)?.count).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exports the observed tree to a disposable snapshot with no git metadata", () => {
    const repo = mkdtempSync(join(tmpdir(), "audit-tools-load-flake-source-"));
    let snapshot: string | null = null;
    try {
      execFileSyncHidden("git", ["init", "--quiet"], { cwd: repo });
      writeFileSync(join(repo, "sample.txt"), "observed content\n", "utf8");
      execFileSyncHidden("git", ["add", "sample.txt"], { cwd: repo });
      const tree = String(
        execFileSyncHidden("git", ["write-tree"], { cwd: repo, encoding: "utf8" }),
      ).trim();

      const createdSnapshot = createIsolatedSnapshot(repo, tree);
      snapshot = createdSnapshot;
      expect(readFileSync(join(createdSnapshot, "sample.txt"), "utf8")).toMatch(/^observed content\r?\n$/);
      expect(() => readFileSync(join(createdSnapshot, ".git"), "utf8")).toThrow();
    } finally {
      if (snapshot) rmSync(snapshot, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
