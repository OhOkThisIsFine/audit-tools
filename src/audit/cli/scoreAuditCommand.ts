import { join } from "node:path";
import {
  readJsonFile,
  writeJsonFile,
  writeTextFile,
  type Finding,
} from "audit-tools/shared";
import {
  scoreAudit,
  hallucinationRegressed,
  renderScorecardMarkdown,
  type CorpusLabels,
  type Scorecard,
} from "../reporting/scoreAudit.js";
import { getArtifactsDir, getFlag } from "./args.js";

interface FindingsContainer {
  findings?: Finding[];
}

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
 * baseline the run only emits the scorecard and always exits 0.
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

  let findingsDoc: FindingsContainer;
  try {
    findingsDoc = await readJsonFile<FindingsContainer>(findingsPath);
  } catch (error) {
    console.error(
      `Could not read findings at ${findingsPath}: ${(error as Error).message}`,
    );
    process.exitCode = 1;
    return;
  }
  const findings = Array.isArray(findingsDoc.findings) ? findingsDoc.findings : [];

  let labels: CorpusLabels;
  try {
    labels = await readJsonFile<CorpusLabels>(labelsPath);
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
  const summaryPath = outPath.replace(/\.json$/, ".md");
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
