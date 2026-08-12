/**
 * Tests for intake-sources-and-digest (N-intake-digest):
 *   - buildFindingsDigest + buildFindingEnumeration: bounded digest + complete
 *     enumeration for enumerable (structured_audit) sources (INV-ID-08)
 *   - computeContentHash: deterministic SHA-256 prefix
 *   - readIntakeArtifacts / validateIntakeSummary: CP-NODE-2 invariants[11]
 *     read-time schema validation for the host-authored intake-summary.json
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAuditFindingsDeliverable,
  type AuditFindingsReport,
} from "audit-tools/shared";
import {
  computeContentHash,
  buildFindingsDigest,
  buildFindingEnumeration,
  buildDocumentSourceManifest,
  readIntakeArtifacts,
  validateIntakeSummary,
  intakePaths,
  INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION,
  INTAKE_SUMMARY_SCHEMA_VERSION,
  FINDINGS_DIGEST_SCHEMA_VERSION,
  FINDING_ENUMERATION_SCHEMA_VERSION,
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

// ── computeContentHash ────────────────────────────────────────────────────────

describe("computeContentHash", () => {
  it("returns a 16-char hex string", () => {
    const h = computeContentHash("hello world");
    expect(typeof h).toBe("string");
    expect(h).toHaveLength(16);
    expect(/^[0-9a-f]+$/.test(h)).toBe(true);
  });

  it("is deterministic for the same content", () => {
    expect(computeContentHash("abc")).toBe(computeContentHash("abc"));
  });

  it("differs for different content", () => {
    expect(computeContentHash("abc")).not.toBe(computeContentHash("xyz"));
  });
});

// ── buildFindingsDigest ───────────────────────────────────────────────────────

function makeReport(findingCount: number): AuditFindingsReport {
  const severities = ["critical", "high", "medium", "low", "info"] as const;
  const lenses = ["correctness", "security", "reliability"] as const;
  const findings = Array.from({ length: findingCount }, (_, i) => ({
    id: `F-${String(i + 1).padStart(3, "0")}`,
    title: `Finding ${i + 1}`,
    category: "correctness",
    severity: severities[i % severities.length],
    confidence: "high" as const,
    lens: lenses[i % lenses.length],
    summary: `Summary for finding ${i + 1}`,
    affected_files: [{ path: `src/module-${i % 3}/file.ts` }],
  }));

  return buildAuditFindingsDeliverable(findings);
}

// ── buildDocumentSourceManifest — first-wins union dedup (B4 / CP-NODE-4) ──────

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

describe("buildFindingsDigest", () => {
  it("returns correct schema_version", () => {
    const digest = buildFindingsDigest(makeReport(0));
    expect(digest.schema_version).toBe(FINDINGS_DIGEST_SCHEMA_VERSION);
  });

  it("total_count matches finding count", () => {
    const digest = buildFindingsDigest(makeReport(5));
    expect(digest.total_count).toBe(5);
  });

  it("severity_counts sums correctly", () => {
    const report = makeReport(5);
    const digest = buildFindingsDigest(report);
    const total = Object.values(digest.severity_counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(5);
  });

  it("lens_counts sums correctly", () => {
    const report = makeReport(6);
    const digest = buildFindingsDigest(report);
    const total = Object.values(digest.lens_counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(6);
  });

  it("package_counts are derived from first path segment", () => {
    const report = makeReport(3);
    const digest = buildFindingsDigest(report);
    // All findings have paths like src/module-*/file.ts → first segment is "src"
    expect(digest.package_counts["src"]).toBeGreaterThan(0);
  });

  it("top_findings is bounded to top-N (20)", () => {
    const digest = buildFindingsDigest(makeReport(25));
    expect(digest.top_findings.length).toBeLessThanOrEqual(20);
  });

  it("omitted_count is zero when count ≤ 20", () => {
    const digest = buildFindingsDigest(makeReport(10));
    expect(digest.omitted_count).toBe(0);
  });

  it("omitted_count is correct when count > 20", () => {
    const digest = buildFindingsDigest(makeReport(25));
    expect(digest.omitted_count).toBe(5);
  });

  it("top_findings are sorted by severity (critical first)", () => {
    const report = makeReport(5);
    const digest = buildFindingsDigest(report);
    // makeReport(5) cycles severities critical,high,medium,low,info, so exactly
    // one critical finding exists and the severity sort puts it first.
    expect(digest.top_findings[0].severity).toBe("critical");
  });

  it("work_block_map reflects report work_blocks", () => {
    const report = makeReport(2);
    const digest = buildFindingsDigest(report);
    expect(digest.work_block_map).toEqual({
      "block-1": ["F-001"],
      "block-2": ["F-002"],
    });
  });

  it("handles empty findings array", () => {
    const digest = buildFindingsDigest(makeReport(0));
    expect(digest.total_count).toBe(0);
    expect(digest.top_findings).toHaveLength(0);
    expect(digest.omitted_count).toBe(0);
  });
});

// ── buildFindingEnumeration ───────────────────────────────────────────────────

describe("buildFindingEnumeration", () => {
  it("returns correct schema_version", () => {
    const enm = buildFindingEnumeration(makeReport(0));
    expect(enm.schema_version).toBe(FINDING_ENUMERATION_SCHEMA_VERSION);
  });

  it("total_count matches report finding count", () => {
    const enm = buildFindingEnumeration(makeReport(7));
    expect(enm.total_count).toBe(7);
  });

  it("findings array contains all entries (no omission)", () => {
    const enm = buildFindingEnumeration(makeReport(25));
    expect(enm.findings).toHaveLength(25);
  });

  it("each entry has required fields: id, title, severity, lens, summary", () => {
    const enm = buildFindingEnumeration(makeReport(3));
    for (const entry of enm.findings) {
      expect(typeof entry.id).toBe("string");
      expect(typeof entry.title).toBe("string");
      expect(typeof entry.severity).toBe("string");
      expect(typeof entry.lens).toBe("string");
      expect(typeof entry.summary).toBe("string");
    }
  });

  it("finding ids round-trip correctly", () => {
    const report = makeReport(3);
    const enm = buildFindingEnumeration(report);
    const ids = enm.findings.map((f) => f.id);
    expect(ids).toEqual(["F-001", "F-002", "F-003"]);
  });
});

// ---------------------------------------------------------------------------
// readIntakeArtifacts / validateIntakeSummary — CP-NODE-2 invariants[11]:
// intake-summary.json is validated at READ TIME, not trusted as a bare cast.
// ---------------------------------------------------------------------------

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
