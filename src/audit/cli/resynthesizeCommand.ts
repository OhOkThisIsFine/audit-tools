import { join } from "node:path";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { getFlag, getRootDir } from "./args.js";
import {
  normalizeExistingFindingsReport,
  renderAuditReportMarkdown,
} from "../reporting/synthesis.js";
import {
  AGENT_FEEDBACK_FILENAME,
  parseReflectionsNdjson,
  readOptionalTextFile,
} from "audit-tools/shared";
import type { AuditFindingsReport } from "audit-tools/shared";
import { AUDIT_REPORT_FILENAME } from "../io/artifacts.js";

const AUDIT_TOOLS_DIR = ".audit-tools";
const FINDINGS_FILENAME = "audit-findings.json";

export async function cmdResynthesize(argv: string[]): Promise<void> {
  const root = getRootDir(argv);
  const auditToolsDir = join(root, AUDIT_TOOLS_DIR);
  const defaultInput = join(auditToolsDir, FINDINGS_FILENAME);
  // Use the shared flag parser, which rejects a flag-shaped next token so an
  // invocation like `--input --root foo` falls back to the default instead of
  // mis-resolving the input path to "--root" (COR-bc35a171).
  const inputPath = getFlag(argv, "--input") ?? defaultInput;

  if (!existsSync(inputPath)) {
    console.error(
      `resynthesize: ${FINDINGS_FILENAME} not found at ${inputPath}. ` +
        `Run the full audit first, or supply --input <path>.`,
    );
    process.exitCode = 1;
    return;
  }

  const raw = await readFile(inputPath, "utf8");
  let report: AuditFindingsReport;
  try {
    report = JSON.parse(raw) as AuditFindingsReport;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`resynthesize: could not parse ${inputPath}: ${msg}`);
    process.exitCode = 1;
    return;
  }

  const normalized = normalizeExistingFindingsReport(report);
  // Best-effort: if the working artifacts dir (and its worker-appended
  // feedback) still exists — e.g. an interrupted run being compiled by hand —
  // carry the Process Feedback section into the re-rendered report.
  const feedbackText = await readOptionalTextFile(
    join(auditToolsDir, "audit", AGENT_FEEDBACK_FILENAME),
  );
  const markdown = renderAuditReportMarkdown(normalized, {
    reflections: feedbackText ? parseReflectionsNdjson(feedbackText) : undefined,
  });

  await mkdir(auditToolsDir, { recursive: true });

  const outputFindingsPath = join(auditToolsDir, FINDINGS_FILENAME);
  const outputReportPath = join(auditToolsDir, AUDIT_REPORT_FILENAME);

  await writeFile(outputFindingsPath, JSON.stringify(normalized, null, 2), "utf8");
  await writeFile(outputReportPath, markdown, "utf8");

  console.log(
    JSON.stringify(
      {
        source: inputPath,
        findings_output: outputFindingsPath,
        report_output: outputReportPath,
        finding_count: normalized.summary.finding_count,
        work_block_count: normalized.summary.work_block_count,
        contract_version: normalized.contract_version,
      },
      null,
      2,
    ),
  );
}
