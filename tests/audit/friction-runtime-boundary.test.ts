import { test, expect } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cmdNextStep } from "../../src/audit/cli/nextStepCommand.js";
import { buildAuditReportModel, buildAuditFindingsReport } from "../../src/audit/reporting/synthesis.js";
import { captureFrictionEvent } from "audit-tools/shared";
import { withTempRepo } from "./helpers/next-step-harness.js";

test("external audit presents its current report and archives pending diagnostics without a development friction walk", async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools", "audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(join(artifactsDir, "audit_state.json"), JSON.stringify({ status: "complete", obligations: [] }));
    const currentReport = "# Audit Report\n\nCurrent run findings\n";
    await writeFile(join(artifactsDir, "audit-report.md"), currentReport);
    await writeFile(join(artifactsDir, "audit-findings.json"), JSON.stringify(buildAuditFindingsReport(buildAuditReportModel({results:[]}), null)));
    await writeFile(join(root, ".audit-tools", "audit-report.md"), "# Prior run\n");
    await captureFrictionEvent(artifactsDir, "run", { id: "pending-event", note: "A diagnostic still awaiting development review" }, "audit-code");

    await cmdNextStep(["--root", root, "--artifacts-dir", artifactsDir]);
    const step = JSON.parse(await readFile(join(artifactsDir, "steps", "current-step.json"), "utf8"));
    expect(step.step_kind).toBe("present_report");
    expect(step.status).toBe("complete");
    expect(step.artifact_paths.friction_record).toBeUndefined();
    expect(await readFile(step.prompt_path, "utf8")).not.toMatch(/complete friction triage/i);
    expect(await readFile(join(root, ".audit-tools", "audit-report.md"), "utf8")).toBe(currentReport);
    const archived = JSON.parse(await readFile(join(root, ".audit-tools", "audit-friction-run.json"), "utf8"));
    expect(archived.frictions.some((f: { id: string }) => f.id === "pending-event")).toBe(true);
    expect(archived.category_attestations ?? []).toEqual([]);
    // The working dir is kept until the next run rolls it over; the record is already archived.
    expect(existsSync(join(artifactsDir, "friction"))).toBe(true);
  });
});
