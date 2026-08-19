/**
 * Tests for intake sources (N-intake-digest):
 *   - buildDocumentSourceManifest: idempotent source registration
 *   - readIntakeArtifacts / validateIntakeSummary: CP-NODE-2 invariants[11]
 *     read-time schema validation for the host-authored intake-summary.json
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDocumentSourceManifest,
  readIntakeArtifacts,
  validateIntakeSummary,
  intakePaths,
  INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION,
  INTAKE_SUMMARY_SCHEMA_VERSION,
} from "../../src/remediate/intake.js";
import { resolve } from "node:path";
import { scratchDir } from "../helpers/scratch.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = scratchDir(".test-intake-sources-and-digest");

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("buildDocumentSourceManifest", () => {
  it("maps each path to an order-stable input-NN document source", () => {
    const manifest = buildDocumentSourceManifest(["a.md", "b.md"], "input");
    expect(manifest.schema_version).toBe(INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION);
    expect(manifest.created_from).toBe("input");
    expect(manifest.sources).toEqual([
      { type: "document", path: "a.md", label: "input-01" },
      { type: "document", path: "b.md", label: "input-02" },
    ]);
  });

  it("first-wins dedups paths that resolve to the same absolute path", () => {
    // `report.md` and `./report.md` are the same file; the second collapses,
    // and the labels stay order-stable + gap-free (input-01, input-02).
    const manifest = buildDocumentSourceManifest(
      ["report.md", "other.md", "./report.md"],
      "input",
    );
    expect(manifest.sources.map((s) => s.path)).toEqual([
      "report.md",
      "other.md",
    ]);
    expect(manifest.sources.map((s) => s.label)).toEqual([
      "input-01",
      "input-02",
    ]);
  });

  it("keeps the FIRST spelling of a duplicated resolved path", () => {
    const manifest = buildDocumentSourceManifest(
      [resolve("report.md"), "report.md"],
      "input",
    );
    expect(manifest.sources).toHaveLength(1);
    expect(manifest.sources[0].path).toBe(resolve("report.md"));
    expect(manifest.sources[0].label).toBe("input-01");
  });

  it("distinct files stay distinct", () => {
    const manifest = buildDocumentSourceManifest(
      ["a.md", "b.md", "c.md"],
      "default_candidates",
    );
    expect(manifest.sources).toHaveLength(3);
    expect(manifest.created_from).toBe("default_candidates");
  });
});

describe("readIntakeArtifacts — CP-NODE-2 invariants[11]: intake-summary.json schema validation", () => {
  const WELL_FORMED_SUMMARY = {
    schema_version: INTAKE_SUMMARY_SCHEMA_VERSION,
    ready: true,
    source_type: "documents",
    goals: ["Fix the bug"],
    non_goals: [],
    constraints: [],
    affected_files: [{ path: "src/a.ts" }],
    open_questions: [],
  };

  async function writeSummaryFile(artifactsDir: string, content: unknown) {
    const paths = intakePaths(artifactsDir);
    await mkdir(paths.dir, { recursive: true });
    await writeFile(paths.summary, JSON.stringify(content), "utf8");
    return paths;
  }

  it("REFUSES a summary whose `ready` is a truthy STRING instead of a boolean", async () => {
    await writeSummaryFile(TEST_DIR, { ...WELL_FORMED_SUMMARY, ready: "yes" });
    await expect(readIntakeArtifacts(TEST_DIR)).rejects.toThrow(/ready/);
  });

  it("REFUSES a summary whose `goals` is not an array", async () => {
    await writeSummaryFile(TEST_DIR, {
      ...WELL_FORMED_SUMMARY,
      goals: "Fix the bug",
    });
    await expect(readIntakeArtifacts(TEST_DIR)).rejects.toThrow(/goals/);
  });

  it("the refusal error names the file path (legible, not opaque)", async () => {
    const paths = await writeSummaryFile(TEST_DIR, {
      ...WELL_FORMED_SUMMARY,
      ready: "yes",
    });
    let caught: unknown;
    try {
      await readIntakeArtifacts(TEST_DIR);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(paths.summary);
  });

  it("a well-formed summary passes through unchanged", async () => {
    await writeSummaryFile(TEST_DIR, WELL_FORMED_SUMMARY);
    const intake = await readIntakeArtifacts(TEST_DIR);
    expect(intake.summary).toEqual(WELL_FORMED_SUMMARY);
  });

  it("a missing summary file is undefined — absence is not a validation refusal", async () => {
    const intake = await readIntakeArtifacts(TEST_DIR);
    expect(intake.summary).toBeUndefined();
  });

  it("validateIntakeSummary directly: rejects a non-boolean ready and accepts a well-formed summary", () => {
    expect(() =>
      validateIntakeSummary({ ...WELL_FORMED_SUMMARY, ready: "yes" }, "intake-summary.json"),
    ).toThrow();
    expect(validateIntakeSummary(WELL_FORMED_SUMMARY, "intake-summary.json")).toEqual(
      WELL_FORMED_SUMMARY,
    );
  });
});
