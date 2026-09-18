/**
 * Tests for intake sources (N-intake-digest):
 *   - buildDocumentSourceManifest: idempotent source registration
 *   - readIntakeArtifacts / validateIntakeSummary: CP-NODE-2 invariants[11]
 *     read-time schema validation for the host-authored intake-summary.json
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDocumentSourceManifest,
  readIntakeArtifacts,
  renderRemediationBrief,
  validateIntakeSummary,
  writeRemediationBrief,
  intakePaths,
  INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION,
} from "../../src/remediate/intake.js";
import { intakeSummaryFixture } from "./helpers/intakeSummaryFixture.js";
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
  const WELL_FORMED_SUMMARY = intakeSummaryFixture({
    goals: ["Fix the bug"],
    affected_files: [{ path: "src/a.ts" }],
  });

  async function writeSummaryFile(artifactsDir: string, content: unknown) {
    const paths = intakePaths(artifactsDir);
    await mkdir(paths.dir, { recursive: true });
    await writeFile(paths.summary, JSON.stringify(content), "utf8");
    return paths;
  }

  // A refused summary is ABSENT, with the refusal carried beside it: the
  // resolver re-issues synthesize_intake with the reason, so the host rewrites
  // the one file the step asked for (prompt 17c) — never a thrown load error.
  it("REFUSES a summary whose `ready` is a truthy STRING instead of a boolean", async () => {
    await writeSummaryFile(TEST_DIR, { ...WELL_FORMED_SUMMARY, ready: "yes" });
    const intake = await readIntakeArtifacts(TEST_DIR);
    expect(intake.summary).toBeUndefined();
    expect(intake.summaryRefusal).toMatch(/`ready`/);
  });

  it("REFUSES a summary whose `goals` is not an array", async () => {
    await writeSummaryFile(TEST_DIR, {
      ...WELL_FORMED_SUMMARY,
      goals: "Fix the bug",
    });
    const intake = await readIntakeArtifacts(TEST_DIR);
    expect(intake.summary).toBeUndefined();
    expect(intake.summaryRefusal).toMatch(/`goals`/);
  });

  it("REFUSES a v1alpha1 summary, naming each missing v1alpha2 field", async () => {
    const { source_summary, acceptance_criteria, scope_summary, intent_summary, filters, ...v1 } =
      WELL_FORMED_SUMMARY;
    void [source_summary, acceptance_criteria, scope_summary, intent_summary, filters];
    await writeSummaryFile(TEST_DIR, {
      ...v1,
      schema_version: "remediate-code-intake-summary/v1alpha1",
    });
    const intake = await readIntakeArtifacts(TEST_DIR);
    expect(intake.summary).toBeUndefined();
    for (const field of [
      "schema_version",
      "source_summary",
      "acceptance_criteria",
      "scope_summary",
      "intent_summary",
      "filters",
    ]) {
      expect(intake.summaryRefusal).toContain(`\`${field}\``);
    }
  });

  it("REFUSES a summary that is not valid JSON, without throwing", async () => {
    const paths = intakePaths(TEST_DIR);
    await mkdir(paths.dir, { recursive: true });
    await writeFile(paths.summary, "{ not json", "utf8");
    const intake = await readIntakeArtifacts(TEST_DIR);
    expect(intake.summary).toBeUndefined();
    expect(intake.summaryRefusal).toMatch(/not valid JSON/);
  });

  it("a well-formed summary passes through unchanged", async () => {
    await writeSummaryFile(TEST_DIR, WELL_FORMED_SUMMARY);
    const intake = await readIntakeArtifacts(TEST_DIR);
    expect(intake.summary).toEqual(WELL_FORMED_SUMMARY);
    expect(intake.summaryRefusal).toBeUndefined();
  });

  it("a missing summary file is undefined — absence is not a validation refusal", async () => {
    const intake = await readIntakeArtifacts(TEST_DIR);
    expect(intake.summary).toBeUndefined();
    expect(intake.summaryRefusal).toBeUndefined();
  });

  it("validateIntakeSummary directly: refuses a non-boolean ready and accepts a well-formed summary", () => {
    expect(validateIntakeSummary({ ...WELL_FORMED_SUMMARY, ready: "yes" })).toEqual({
      refusal: expect.stringContaining("`ready`"),
    });
    expect(validateIntakeSummary(WELL_FORMED_SUMMARY)).toEqual({ summary: WELL_FORMED_SUMMARY });
  });
});

// Prompt 17c: the brief is the tool's render of the summary — the host no
// longer writes a second file that restates it.
describe("renderRemediationBrief / writeRemediationBrief", () => {
  const SUMMARY = intakeSummaryFixture({
    source_summary: "The refactor plan asks to split the router.",
    goals: ["Split the router"],
    affected_files: [{ path: "src/router.ts", reason: "the router" }],
    acceptance_criteria: ["Each route module has one owner"],
    open_questions: [{ id: "Q-001", question: "Include the CLI?", blocking: true }],
  });

  it("renders every summary section, with `- None` for an empty list", () => {
    const brief = renderRemediationBrief(SUMMARY);
    expect(brief.startsWith("# Remediation Brief\n")).toBe(true);
    expect(brief).toContain("## Source Summary\n\nThe refactor plan asks to split the router.");
    expect(brief).toContain(`## Scope\n\n${SUMMARY.scope_summary}`);
    expect(brief).toContain(`## Intent\n\n${SUMMARY.intent_summary}`);
    expect(brief).toContain("## Goals\n\n- Split the router");
    expect(brief).toContain("## Non-Goals\n\n- None");
    expect(brief).toContain("## Affected Files\n\n- `src/router.ts` — the router");
    expect(brief).toContain("## Acceptance Criteria\n\n- Each route module has one owner");
    expect(brief).toContain("## Open Questions\n\n- **Q-001** (blocking): Include the CLI?");
  });

  it("writes the render to the brief path, and rewrites it only on a change", async () => {
    const paths = intakePaths(TEST_DIR);
    await writeRemediationBrief(TEST_DIR, SUMMARY);
    expect(await readFile(paths.brief, "utf8")).toBe(renderRemediationBrief(SUMMARY));
    const before = (await stat(paths.brief)).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    await writeRemediationBrief(TEST_DIR, SUMMARY);
    expect((await stat(paths.brief)).mtimeMs).toBe(before);
    const changed = { ...SUMMARY, goals: ["Split the router", "Keep the API"] };
    await writeRemediationBrief(TEST_DIR, changed);
    expect(await readFile(paths.brief, "utf8")).toContain("- Keep the API");
  });
});
