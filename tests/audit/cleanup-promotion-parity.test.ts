// The stale-dir cleanup rule asks "has the completion transition nothing left
// to do for this dir?" and must answer it with promotion's OWN archive walk —
// never with a second enumeration of the archive set, which would drift from
// the delete gate (INV 1 / REL-4802dc9e) the moment promotion archived one more
// artifact. This pins that parity mechanically: the predicate flips only when
// the real promotion has run, and flips back when any archived copy goes
// missing or changes.
import { test, expect } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  auditFindingsPath,
  auditReportPath,
  promotedAuditFindingsPath,
  promotedAuditReportPath,
} from "audit-tools/shared";
import { withTempDir } from "./helpers/withTempDir.mjs";

const { isWorkingDirFullyPromoted, promoteFinalAuditReport } = await import(
  "../../src/audit/io/artifacts.js"
);

const RENDER = "# Audit report\n\n## Work blocks\n\n- Done\n";
const FINDINGS = JSON.stringify({ schema_version: "audit-findings/v1alpha1", work_blocks: [] }) + "\n";

test("isWorkingDirFullyPromoted follows promoteFinalAuditReport's own archive walk", async () => {
  await withTempDir("audit-cleanup-parity-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(join(artifactsDir, "audit_state.json"), JSON.stringify({ status: "complete" }));
    await writeFile(auditReportPath(artifactsDir), RENDER);
    await writeFile(auditFindingsPath(artifactsDir), FINDINGS);
    await writeFile(join(artifactsDir, "agent-feedback.jsonl"), '{"kind":"note"}\n');

    expect(await isWorkingDirFullyPromoted(artifactsDir), "nothing promoted yet").toBe(false);

    // Promote for real, but keep the working dir so the predicate can be asked again.
    const result = await promoteFinalAuditReport(
      { artifactsDir },
      { remove: async () => {}, warn: () => {} },
    );
    expect(result.promoted && result.cleaned, "the fixture must promote cleanly").toBe(true);
    expect(await isWorkingDirFullyPromoted(artifactsDir), "after promotion nothing is left to archive").toBe(true);

    // The verify-only walk reads the SAME destinations promotion wrote: losing
    // any one of them, or changing its bytes, is work left for promotion again.
    await rm(promotedAuditFindingsPath(artifactsDir));
    expect(await isWorkingDirFullyPromoted(artifactsDir), "a missing archived findings copy is work left").toBe(false);
    await writeFile(promotedAuditFindingsPath(artifactsDir), FINDINGS);
    expect(await isWorkingDirFullyPromoted(artifactsDir)).toBe(true);

    await writeFile(promotedAuditReportPath(artifactsDir), "# a different report\n");
    expect(await isWorkingDirFullyPromoted(artifactsDir), "a differing promoted render is not this run's").toBe(false);
    await writeFile(promotedAuditReportPath(artifactsDir), RENDER);
    expect(await isWorkingDirFullyPromoted(artifactsDir)).toBe(true);

    // A missing IN-PLACE render is never "already promoted" for a dir that still
    // exists: with nothing to compare, the safe answer is "work left".
    const render = await readFile(auditReportPath(artifactsDir));
    await rm(auditReportPath(artifactsDir));
    expect(await isWorkingDirFullyPromoted(artifactsDir), "no in-place render means no identity to prove").toBe(false);
    await writeFile(auditReportPath(artifactsDir), render);
    expect(await isWorkingDirFullyPromoted(artifactsDir)).toBe(true);
  });
});
