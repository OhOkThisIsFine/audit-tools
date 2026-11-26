// sites-pinned: tests/audit/score-audit-command.test.ts
import { join } from "node:path";
import {
  readJsonFile,
  writeJsonFile,
  writeTextFile,
  FindingSchema,
  type Finding,
} from "audit-tools/shared";
import {
  scoreAudit,
  hallucinationRegressed,
  renderScorecardMarkdown,
  CorpusLabelsSchema,
  type CorpusLabels,
  type Scorecard,
} from "../reporting/scoreAudit.js";
import { getArtifactsDir, getFlag } from "./args.js";

/**
 * `score-audit` — emit the deterministic finding-quality scorecard for a fresh
 * audit against a corpus's human-applied labels (A-2).
 *
 * Resolution:
 *   --findings <path>   audit-findings.json (default: <artifacts>/audit-findings.json)
 *   --labels <path>     corpus/<run-id>.labels.json (REQUIRED)
 *   --baseline <path>   a prior scorecard.json to gate against (optional)
 *   --out <path>        where to write scorecard.json (default: <artifacts>/score-audit.json)
 *
 * The exit code is wired SOLELY to a hallucination-rate REGRESSION vs --baseline
 * (track-don't-gate: precision/recall are printed but never gate). With no
 * baseline a valid input emits the scorecard without gating on its metrics.
 */
export async function cmdScoreAudit(argv: string[]): Promise<void> {
  const artifactsDir = getArtifactsDir(argv);
  const findingsPath =
    getFlag(argv, "--findings") ?? join(artifactsDir, "audit-findings.json");
  const labelsPath = getFlag(argv, "--labels");
  const baselinePath = getFlag(argv, "--baseline");
  const outPath = getFlag(argv, "--out") ?? join(artifactsDir, "score-audit.json");

  if (!labelsPath) {
    console.error(
      "score-audit requires --labels <corpus/<run-id>.labels.json> (human-applied finding labels)",
    );
    process.exitCode = 1;
    return;
  }

  let findings: Finding[];
  try {
    const document = await readJsonFile<{ findings?: unknown } | null>(findingsPath);
    if (!document || !Array.isArray(document.findings)) {
      throw new Error("Expected a findings array. Use an empty array for a zero-findings report.");
    }
    findings = document.findings.map((finding, index) => {
      const parsed = FindingSchema.safeParse(finding);
      if (!parsed.success) throw new Error(`Invalid finding at index ${index}: ${parsed.error.issues[0]?.message}`);
      return parsed.data;
    });
  } catch (error) {
    console.error(
      `Could not read findings at ${findingsPath}: ${(error as Error).message}`,
    );
    process.exitCode = 1;
    return;
  }

  let labels: CorpusLabels;
  try {
    const parsed = CorpusLabelsSchema.safeParse(await readJsonFile<unknown>(labelsPath));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(`Invalid corpus labels at ${issue.path.join(".") || "document"}: ${issue.message}`);
    }
    labels = parsed.data;
  } catch (error) {
    console.error(
      `Could not read labels at ${labelsPath}: ${(error as Error).message}`,
    );
    process.exitCode = 1;
    return;
  }

  let baseline: Scorecard | null = null;
  if (baselinePath) {
    try {
      baseline = await readJsonFile<Scorecard>(baselinePath);
    } catch (error) {
      console.error(
        `Could not read baseline scorecard at ${baselinePath}: ${(error as Error).message}`,
      );
      process.exitCode = 1;
      return;
    }
  }

  const scorecard = scoreAudit(findings, labels);
  await writeJsonFile(outPath, scorecard);
  const summary = renderScorecardMarkdown(scorecard);
  // Sibling markdown path, derived safely (COR-27f0f33c): for a non-".json"
  // --out the extension replace would be a no-op, making summaryPath === outPath
  // and silently overwriting the just-written JSON scorecard with markdown.
  const summaryPath = /\.json$/.test(outPath)
    ? outPath.replace(/\.json$/, ".md")
    : `${outPath}.md`;
  await writeTextFile(summaryPath, summary);

  process.stdout.write(summary);
  console.error(`Scorecard written to ${outPath} (summary: ${summaryPath})`);

  // The ONLY gate: a hallucination-rate regression against the baseline.
  if (hallucinationRegressed(scorecard, baseline)) {
    console.error(
      `✗ hallucination-rate regression: ${fmt(scorecard.hallucination_rate)} > ` +
        `baseline ${fmt(baseline?.hallucination_rate ?? 0)}`,
    );
    process.exitCode = 1;
    return;
  }
  if (baseline) {
    console.error(
      `✓ hallucination rate ${fmt(scorecard.hallucination_rate)} within baseline ` +
        `${fmt(baseline.hallucination_rate ?? 0)}`,
    );
  }
}

function fmt(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}
