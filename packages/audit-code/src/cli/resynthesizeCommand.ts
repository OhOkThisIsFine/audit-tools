import { join } from "node:path";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { getRootDir } from "./args.js";
import {
  normalizeExistingFindingsReport,
  renderAuditReportMarkdown,
} from "../reporting/synthesis.js";
import type { AuditFindingsReport } from "@audit-tools/shared";

const AUDIT_TOOLS_DIR = ".audit-tools";
const FINDINGS_FILENAME = "audit-findings.json";
const REPORT_FILENAME = "audit-report.md";

function getFlagValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
}

export async function cmdResynthesize(argv: string[]): Promise<void> {
  const root = getRootDir(argv);
  const auditToolsDir = join(root, AUDIT_TOOLS_DIR);
  const defaultInput = join(auditToolsDir, FINDINGS_FILENAME);
  const inputPath = getFlagValue(argv, "--input") ?? defaultInput;

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
  const markdown = renderAuditReportMarkdown(normalized);

  await mkdir(auditToolsDir, { recursive: true });

  const outputFindingsPath = join(auditToolsDir, FINDINGS_FILENAME);
  const outputReportPath = join(auditToolsDir, REPORT_FILENAME);

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
