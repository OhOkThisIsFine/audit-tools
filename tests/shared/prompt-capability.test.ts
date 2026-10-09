import { describe, it, expect } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderPlanAuthorPrompt, renderPlanReviewPrompt } from "../../src/remediate/steps/contractPipelinePrompts.js";
import { planPromptSource, planPromptCanonical, planPromptHistory } from "./planPromptFixture.js";
import {
  LANE_RESULT_FALLBACK_SENTENCE,
  LANE_RESULTS_HEADING,
  materializeFanoutLanes,
  renderLaneResultsFooter,
} from "../../src/audit/cli/fanoutLanes.js";
// A lane prompt is a prompt BODY, so every absolute path inside it is written in
// the forward-slashed host-facing form — the same form `writeStepContract` uses
// for the step contract beside it (owner review 2026-09-17, prompts 13 and 14).
// `lane.resultPath` is the native path, so a test must normalize before matching.
import { toPromptPathToken } from "../../src/shared/tooling/exec.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

// The recognizers live in the shared helper so the guard-form-reach test can
// drive the REAL matchers over each declared sample (P51).
import { resultsPathDriftLines } from "../helpers/recognizers.js";

/** OS-agnostic reporting for src-scan violations. */
function slashed(candidate: string): string {
  return String(candidate).replace(/\\/g, "/");
}


async function collectTypeScriptSources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

describe("canonical planning prompt capabilities", () => {
  it("author writes only a submission and reads the canonical source", () => {
    const prompt = renderPlanAuthorPrompt({ root: "/repo", source: planPromptSource, history: planPromptHistory,
      sourcePath: "/run/source.json", planPath: "/run/plan.json", outputPath: "/run/plan.input.json" });
    expect(prompt).toContain("Read /run/source.json");
    expect(prompt).toContain("Write ONLY /run/plan.input.json");
    expect(prompt).toContain("Inspect actual source");
    expect(prompt).not.toContain("obligation_ledger.json");
  });
  for (const role of ["critique", "critic", "judge"] as const) it(`${role} reads accepted records and may check actual source`, () => {
    const prompt = renderPlanReviewPrompt({ role, root: "/repo", sourcePath: "/run/source.json", planPath: "/run/plan.json",
      canonical: planPromptCanonical, history: planPromptHistory, priorReviewPaths: ["/run/prior.json"], requirement: "independent" });
    for (const path of ["/run/source.json", "/run/plan.json", "/run/prior.json"]) expect(prompt).toContain(path);
    expect(prompt).toContain("may inspect");
    expect(prompt).toContain("Do not edit repository source or the canonical plan");
    expect(prompt).toContain("independent context");
  });
});

// ── 4. Lane capability: the write imperative is satisfiable ───────────────────

describe("every fan-out lane prompt states a bound path AND a read-only alternative", () => {
  it("materializeFanoutLanes appends the footer, with each lane's own bound path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "c2-lane-capability-"));
    try {
      const fanout = await materializeFanoutLanes({
        artifactsDir: dir,
        sourceRoot: dir,
        runId: "c2-capability-scope",
        lanes: [
          {
            id: "lane_alpha",
            label: "Alpha",
            fileCount: 0,
            riskScore: 0,
            promptFilename: "alpha-prompt.md",
            promptText: "# Alpha\n\nDo the alpha work.",
          },
          {
            id: "lane_beta",
            label: "Beta",
            fileCount: 0,
            riskScore: 0,
            promptFilename: "beta-prompt.md",
            promptText: "# Beta\n\nDo the beta work.",
            expected: false,
          },
        ],
      });

      expect(fanout.lanes).toHaveLength(2);
      for (const lane of fanout.lanes) {
        const text = (await readFile(lane.promptPath, "utf8")).replace(/\r\n/g, "\n");
        expect(
          text,
          `${lane.id} must state its own tool-bound result path`,
        ).toContain(toPromptPathToken(lane.resultPath));
        expect(text).toContain(LANE_RESULTS_HEADING);
        expect(
          text,
          `${lane.id} must offer the read-only executor a sanctioned way to deliver`,
        ).toContain(LANE_RESULT_FALLBACK_SENTENCE);
        expect(
          text.endsWith(renderLaneResultsFooter(lane.resultPath)),
          `${lane.id} must carry the footer verbatim, at the end`,
        ).toBe(true);
        // The write instruction is NOT replaced by the alternative: the bound
        // path is what the tool's submission reader consumes.
        expect(text).toMatch(/Write your submission/);
      }
      // Another lane's bound path never leaks into this lane's prompt.
      const alpha = await readFile(fanout.lanes[0]!.promptPath, "utf8");
      expect(alpha).not.toContain(toPromptPathToken(fanout.lanes[1]!.resultPath));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // The footer's own path is normalized where the footer is built, so the test
  // above cannot see the SECOND half of the path-form fix: a path the CALLER
  // wrote into the prompt body. The synthesis-narrative prompt is exactly that
  // case — its overflow line names the findings report — and a lane that reads
  // one path form in its prompt body and another in the step contract beside it
  // cannot tell whether the two name one file (owner review 2026-09-17, prompts
  // 13 and 14: fix the class, with a contract test).
  it("materializeFanoutLanes forward-slashes an absolute path written into the prompt BODY", async () => {
    const dir = await mkdtemp(join(tmpdir(), "c2-lane-body-paths-"));
    try {
      const windowsPath = String.raw`C:\Code\audit-tools\.audit-tools\audit\audit-findings.json`;
      const uncPath = String.raw`\\build01\share\.audit-tools\audit\audit-findings.json`;
      const fanout = await materializeFanoutLanes({
        artifactsDir: dir,
        sourceRoot: dir,
        runId: "c2-body-path-scope",
        lanes: [
          {
            id: "lane_body",
            label: "Body",
            fileCount: 0,
            riskScore: 0,
            promptFilename: "body-prompt.md",
            promptText: [
              "# Body",
              "",
              `Read the complete report at ${windowsPath} when a theme needs it.`,
              `The mirror lives at ${uncPath}.`,
              "",
              "Match an id with /^F-\\d+$/ — a regex is not a path.",
            ].join("\n"),
          },
        ],
      });

      const text = (await readFile(fanout.lanes[0]!.promptPath, "utf8")).replace(
        /\r\n/g,
        "\n",
      );
      expect(
        text,
        "a drive-letter path the caller wrote into the body is forward-slashed",
      ).toContain("C:/Code/audit-tools/.audit-tools/audit/audit-findings.json");
      expect(
        text,
        "a UNC path is normalized the same way",
      ).toContain("//build01/share/.audit-tools/audit/audit-findings.json");
      expect(text, "no backslashed form survives").not.toContain(windowsPath);
      expect(
        text,
        "the normalizer is anchored on a path root, so a regex in the body is untouched",
      ).toContain(String.raw`/^F-\d+$/`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("no source file outside the lane chokepoint renders its own results-path section", async () => {
    const sources = await collectTypeScriptSources(join(repoRoot, "src"));
    expect(sources.length, "the src/ scan must actually reach files").toBeGreaterThan(50);
    const chokepoint = join(repoRoot, "src", "audit", "cli", "fanoutLanes.ts");

    const violations: string[] = [];
    for (const file of sources) {
      if (file === chokepoint) continue;
      // A second "## Results path" section is a second place the bound path
      // and its alternative can drift out of agreement; "…provided below"
      // promises a section this renderer does not emit — the dangling
      // reference that left every conceptual lane pathless.
      for (const hit of resultsPathDriftLines(await readFile(file, "utf8"))) {
        violations.push(`${slashed(file.slice(repoRoot.length))}:${hit.line}: ${hit.text}`);
      }
    }
    expect(
      violations,
      "the results-path section is minted once, at the lane chokepoint that owns the bound path",
    ).toEqual([]);
  });
});
