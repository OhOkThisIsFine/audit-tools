/**
 * Tests for intake-sources-and-digest (N-intake-digest):
 *   - scanConversationSources: auto-registers conversation-start.md + intake/*.md
 *     as type:'conversation' sources; registration-only (never writes bodies);
 *     content-hash keyed idempotency (INV-ID-04, INV-ID-07)
 *   - buildFindingsDigest + buildFindingEnumeration: bounded digest + complete
 *     enumeration for enumerable (structured_audit) sources (INV-ID-08)
 *   - writeIntakeDigestArtifacts: writes digest + enumeration for structured_audit;
 *     writes is_enumerable:false marker for document sources
 *   - computeContentHash: deterministic SHA-256 prefix
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuditFindingsReport } from "audit-tools/shared";
import {
  computeContentHash,
  scanConversationSources,
  buildFindingsDigest,
  buildFindingEnumeration,
  writeIntakeDigestArtifacts,
  intakePaths,
  FINDINGS_DIGEST_SCHEMA_VERSION,
  FINDING_ENUMERATION_SCHEMA_VERSION,
  type FindingsDigest,
  type FindingEnumeration,
  type NonEnumerableMarker,
  type ConversationSourceRecord,
} from "../../src/remediate/intake.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(__dirname, ".test-intake-sources-and-digest");

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

// ── scanConversationSources ───────────────────────────────────────────────────

describe("scanConversationSources", () => {
  it("returns empty when intake dir has no .md files", async () => {
    const intakeDir = join(TEST_DIR, "intake-empty");
    await mkdir(intakeDir, { recursive: true });

    const result = await scanConversationSources(intakeDir, []);
    expect(result.sources).toHaveLength(0);
    expect(result.records).toHaveLength(0);
  });

  it("registers conversation-start.md as type:conversation with label conversation-start", async () => {
    const intakeDir = join(TEST_DIR, "intake-conv");
    await mkdir(intakeDir, { recursive: true });
    await writeFile(join(intakeDir, "conversation-start.md"), "Fix the perf issue.", "utf8");

    const result = await scanConversationSources(intakeDir, []);
    expect(result.sources).toHaveLength(1);
    const src = result.sources[0];
    expect(src.type).toBe("conversation");
    expect(src.path).toBe(join(intakeDir, "conversation-start.md"));
    expect(src.label).toBe("conversation-start");
    expect(result.records).toHaveLength(1);
  });

  it("registers other *.md files in intake dir with type:conversation", async () => {
    const intakeDir = join(TEST_DIR, "intake-extra-md");
    await mkdir(intakeDir, { recursive: true });
    await writeFile(join(intakeDir, "extra-notes.md"), "Extra context.", "utf8");

    const result = await scanConversationSources(intakeDir, []);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].type).toBe("conversation");
    expect(result.sources[0].path).toContain("extra-notes.md");
  });

  it("skips remediation-brief.md (not a source file)", async () => {
    const intakeDir = join(TEST_DIR, "intake-brief-skip");
    await mkdir(intakeDir, { recursive: true });
    await writeFile(join(intakeDir, "remediation-brief.md"), "# Brief content", "utf8");

    const result = await scanConversationSources(intakeDir, []);
    expect(result.sources).toHaveLength(0);
  });

  it("skips already-registered sources with unchanged content (INV-ID-04 idempotency)", async () => {
    const intakeDir = join(TEST_DIR, "intake-idempotent");
    await mkdir(intakeDir, { recursive: true });
    const content = "Fix the perf issue.";
    await writeFile(join(intakeDir, "conversation-start.md"), content, "utf8");
    const hash = computeContentHash(content);

    const existing: ConversationSourceRecord[] = [
      { path: join(intakeDir, "conversation-start.md"), content_hash: hash },
    ];
    const result = await scanConversationSources(intakeDir, existing);
    // Same content → same hash → no new sources
    expect(result.sources).toHaveLength(0);
    expect(result.records).toHaveLength(0);
  });

  it("re-registers a source when content has changed (INV-ID-04 content-keyed)", async () => {
    const intakeDir = join(TEST_DIR, "intake-changed");
    await mkdir(intakeDir, { recursive: true });
    const newContent = "Updated perf issue description.";
    await writeFile(join(intakeDir, "conversation-start.md"), newContent, "utf8");

    // Existing record has a DIFFERENT hash (stale).
    const existing: ConversationSourceRecord[] = [
      { path: join(intakeDir, "conversation-start.md"), content_hash: "stale0000000000" },
    ];
    const result = await scanConversationSources(intakeDir, existing);
    expect(result.sources).toHaveLength(1);
    expect(result.records[0].content_hash).toBe(computeContentHash(newContent));
  });

  it("never writes the .md file bodies (INV-ID-07 — registration-only)", async () => {
    // If conversation-start.md does NOT exist, scanConversationSources must not
    // create or write it.
    const intakeDir = join(TEST_DIR, "intake-no-write");
    await mkdir(intakeDir, { recursive: true });
    // Do NOT create conversation-start.md

    const { existsSync } = await import("node:fs");
    const before = existsSync(join(intakeDir, "conversation-start.md"));
    await scanConversationSources(intakeDir, []);
    const after = existsSync(join(intakeDir, "conversation-start.md"));

    expect(before).toBe(false);
    expect(after).toBe(false);
  });

  it("handles non-existent intake dir gracefully (returns empty)", async () => {
    const intakeDir = join(TEST_DIR, "intake-does-not-exist");
    // Do NOT create the dir
    const result = await scanConversationSources(intakeDir, []);
    expect(result.sources).toHaveLength(0);
    expect(result.records).toHaveLength(0);
  });
});

// ── buildFindingsDigest ───────────────────────────────────────────────────────

function makeReport(findingCount: number, overrides: Partial<AuditFindingsReport> = {}): AuditFindingsReport {
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

  return {
    contract_version: "audit-tools/audit-findings/v1alpha1",
    summary: {
      finding_count: findingCount,
      work_block_count: 0,
      severity_breakdown: {},
      audited_file_count: 1,
      excluded_file_count: 0,
      runtime_validation_status_breakdown: {},
    },
    findings,
    work_blocks: [],
    ...overrides,
  };
}

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
    const report = makeReport(2, {
      work_blocks: [
        {
          id: "WB-001",
          finding_ids: ["F-001", "F-002"],
          unit_ids: [],
          owned_files: [],
          max_severity: "high",
          rationale: "r",
          depends_on: [],
        },
      ],
    });
    const digest = buildFindingsDigest(report);
    expect(digest.work_block_map["WB-001"]).toEqual(["F-001", "F-002"]);
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

// ── writeIntakeDigestArtifacts ────────────────────────────────────────────────

describe("writeIntakeDigestArtifacts", () => {
  it("writes findings-digest.json and finding-enumeration.json for structured_audit (INV-ID-08)", async () => {
    const artifactsDir = join(TEST_DIR, "artifacts-enumerable");
    await mkdir(join(artifactsDir, "intake"), { recursive: true });
    const paths = intakePaths(artifactsDir);

    const report = makeReport(3);
    await writeIntakeDigestArtifacts(paths, report);

    const { readFile } = await import("node:fs/promises");
    const digestRaw = await readFile(paths.findingsDigest, "utf8");
    const enumerationRaw = await readFile(paths.findingEnumeration, "utf8");

    const digest = JSON.parse(digestRaw) as FindingsDigest;
    expect(digest.schema_version).toBe(FINDINGS_DIGEST_SCHEMA_VERSION);
    expect(digest.total_count).toBe(3);

    const enumeration = JSON.parse(enumerationRaw) as FindingEnumeration;
    expect(enumeration.schema_version).toBe(FINDING_ENUMERATION_SCHEMA_VERSION);
    expect(enumeration.findings).toHaveLength(3);
  });

  it("writes is_enumerable:false marker for document (non-enumerable) source (INV-ID-08)", async () => {
    const artifactsDir = join(TEST_DIR, "artifacts-non-enumerable");
    await mkdir(join(artifactsDir, "intake"), { recursive: true });
    const paths = intakePaths(artifactsDir);

    await writeIntakeDigestArtifacts(paths, null);

    const { readFile } = await import("node:fs/promises");
    const digestRaw = await readFile(paths.findingsDigest, "utf8");
    const enumerationRaw = await readFile(paths.findingEnumeration, "utf8");

    const digestMarker = JSON.parse(digestRaw) as NonEnumerableMarker;
    const enumMarker = JSON.parse(enumerationRaw) as NonEnumerableMarker;

    expect(digestMarker.is_enumerable).toBe(false);
    expect(enumMarker.is_enumerable).toBe(false);
  });

  it("findings-digest.json for zero-finding report has total_count:0 and empty top_findings", async () => {
    const artifactsDir = join(TEST_DIR, "artifacts-zero");
    await mkdir(join(artifactsDir, "intake"), { recursive: true });
    const paths = intakePaths(artifactsDir);

    await writeIntakeDigestArtifacts(paths, makeReport(0));

    const { readFile } = await import("node:fs/promises");
    const digest = JSON.parse(await readFile(paths.findingsDigest, "utf8")) as FindingsDigest;
    expect(digest.total_count).toBe(0);
    expect(digest.top_findings).toHaveLength(0);
    expect(digest.omitted_count).toBe(0);
  });
});
