// Unit tests for the unified pre-planning filter pass (review-gate convergence,
// chunk A). Verifies it runs the canonical chain (no-evidence → dedup →
// phantom-grounding → checkpoint) and reports dispositions in the exact shape
// buildCoverageLedger consumes.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { Finding, IntentCheckpoint } from "audit-tools/shared";
import { runFindingFilterPass } from "../../src/remediate/findingFilter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let ROOT: string;

beforeEach(async () => {
  ROOT = join(__dirname, `.test-finding-filter-${randomUUID()}`);
  await mkdir(join(ROOT, "src"), { recursive: true });
  await writeFile(join(ROOT, "src", "a.ts"), "// a\n", "utf8");
  await writeFile(join(ROOT, "src", "b.ts"), "// b\n", "utf8");
});

afterEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

function mkFinding(over: Partial<Finding> & { id: string }): Finding {
  return {
    id: over.id,
    title: over.title ?? over.id,
    category: over.category ?? "General",
    severity: over.severity ?? "medium",
    confidence: over.confidence ?? "high",
    lens: over.lens ?? "correctness",
    summary: over.summary ?? "s",
    affected_files: over.affected_files ?? [{ path: "src/a.ts" }],
    evidence: over.evidence ?? ["src/a.ts:1 evidence"],
  } as Finding;
}

describe("runFindingFilterPass", () => {
  it("drops no-evidence findings, folds cross-lens duplicates, drops all-phantom findings", async () => {
    const findings: Finding[] = [
      // Same path + same category + same title, different lens → one folds into
      // the other (cross-lens-dedup fuzzy layer: title-sim 1.0, file-overlap 1.0).
      mkFinding({ id: "F-SEC", title: "Unvalidated input in handler", lens: "security", affected_files: [{ path: "src/a.ts" }], evidence: ["src/a.ts:1 e"] }),
      mkFinding({ id: "F-COR", title: "Unvalidated input in handler", lens: "correctness", affected_files: [{ path: "src/a.ts" }], evidence: ["src/a.ts:2 e"] }),
      // No evidence → dropped before dedup.
      mkFinding({ id: "F-NOEV", lens: "tests", affected_files: [{ path: "src/b.ts" }], evidence: [] }),
      // Only a phantom path → dropped at grounding.
      mkFinding({ id: "F-GHOST", lens: "security", affected_files: [{ path: "src/ghost.ts" }], evidence: ["src/ghost.ts:1 e"] }),
    ];

    const result = await runFindingFilterPass(findings, { root: ROOT });

    expect(result.droppedNoEvidence).toEqual(["F-NOEV"]);
    expect([...result.droppedPhantomPaths.keys()]).toEqual(["F-GHOST"]);
    // F-SEC and F-COR collapse to a single survivor; F-NOEV and F-GHOST are gone.
    const survivorIds = result.survivors.map((f) => f.id);
    expect(survivorIds).toHaveLength(1);
    expect(["F-SEC", "F-COR"]).toContain(survivorIds[0]);
    // The folded id maps to the survivor.
    expect(result.mergeMap.size).toBe(1);
    const [absorbed, survivor] = [...result.mergeMap.entries()][0];
    expect(["F-SEC", "F-COR"]).toContain(absorbed);
    expect(survivorIds[0]).toBe(survivor);
  });

  it("applies the intent checkpoint (drops by severity filter)", async () => {
    const findings: Finding[] = [
      mkFinding({ id: "F-HIGH", severity: "high", affected_files: [{ path: "src/a.ts" }], evidence: ["src/a.ts:1 e"] }),
      mkFinding({ id: "F-LOW", severity: "low", affected_files: [{ path: "src/b.ts" }], evidence: ["src/b.ts:1 e"] }),
    ];
    const checkpoint: IntentCheckpoint = {
      schema_version: "intent-checkpoint/v1",
      confirmed_at: "2026-01-01T00:00:00.000Z",
      confirmed_by: "host",
      scope_summary: "s",
      intent_summary: "i",
      filters: { severity: ["high", "critical"] },
    } as IntentCheckpoint;

    const result = await runFindingFilterPass(findings, { root: ROOT, checkpoint });

    expect(result.droppedByCheckpoint).toEqual(["F-LOW"]);
    expect(result.survivors.map((f) => f.id)).toEqual(["F-HIGH"]);
  });

  it("an absent/empty checkpoint keeps every grounded finding", async () => {
    const findings: Finding[] = [
      mkFinding({ id: "F-1", lens: "security", affected_files: [{ path: "src/a.ts" }], evidence: ["src/a.ts:1 e"] }),
      mkFinding({ id: "F-2", lens: "performance", affected_files: [{ path: "src/b.ts" }], evidence: ["src/b.ts:1 e"] }),
    ];

    const result = await runFindingFilterPass(findings, { root: ROOT });

    expect(result.droppedByCheckpoint).toEqual([]);
    expect(result.survivors.map((f) => f.id).sort()).toEqual(["F-1", "F-2"]);
  });
});
