// Owner decision 92b0e2dd7cfdc06d (2026-08-31): the tool DETECTS the closing
// actions a repository's shape makes appropriate and PRESENTS them at the
// intent checkpoint; the user chooses; the tool never selects one. These tests
// pin the four seams: the confirm_intent prompt, the refusal of an invalid
// choice, the choice reaching closing_plan (and the plan carrying the detected
// candidates), and the contract pipeline's extracted plan carrying detected
// values instead of a hard-coded ["none"].
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSyncHidden as spawnSync } from "../helpers/spawn.mjs";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import { promoteImplementationDagToExtractedPlan } from "../../src/remediate/steps/contractPipeline.js";
import { StateStore } from "../../src/remediate/state/store.js";
import { intakePaths } from "../../src/remediate/intake.js";
import { createNextStepHarness } from "./helpers/nextStepHarness.js";

const harness = createNextStepHarness(".test-closing-action-choice");
const { REPO_DIR, ARTIFACTS_DIR, resetTestRepo, cleanupTestRepo, writeCompleteContractPipelineDag } = harness;

function git(...args: string[]): void {
  const result = spawnSync("git", args, { cwd: REPO_DIR, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

async function writeReadyDocumentIntake(): Promise<void> {
  const intakeDir = join(ARTIFACTS_DIR, "intake");
  await mkdir(intakeDir, { recursive: true });
  const inputPath = join(REPO_DIR, "brief.md");
  await writeFile(inputPath, "# Remediation Brief\n\nFix the auth flow.\n", "utf8");
  await writeFile(
    join(intakeDir, "source-manifest.json"),
    JSON.stringify({
      schema_version: "remediate-code-intake-source-manifest/v1alpha1",
      created_from: "input",
      sources: [{ type: "document", path: inputPath }],
    }),
    "utf8",
  );
  await writeFile(
    join(intakeDir, "intake-summary.json"),
    JSON.stringify({
      schema_version: "remediate-code-intake-summary/v1alpha1",
      ready: true,
      source_type: "documents",
      goals: ["Fix the auth flow."],
      non_goals: [],
      constraints: [],
      affected_files: [{ path: "src/auth.ts" }],
      open_questions: [],
    }),
    "utf8",
  );
  await writeFile(join(intakeDir, "remediation-brief.md"), "# Remediation Brief\n\nFix the auth flow.\n", "utf8");
}

/**
 * An extracted plan that carries NO project facts, so detection must fill them.
 * The finding cites a real file so grounding keeps it (a finding whose every
 * cited path is phantom is dropped, and a plan with no findings is destroyed).
 */
async function writeExtractedPlanWithoutFacts(): Promise<void> {
  await mkdir(join(REPO_DIR, "src"), { recursive: true });
  await writeFile(join(REPO_DIR, "src", "auth.ts"), "export const auth = 1;\n", "utf8");
  // Grounding enumerates TRACKED files (git ls-files): an untracked citation is
  // a phantom path, and a plan whose only finding grounds to nothing is destroyed.
  git("add", "src/auth.ts");
  git("commit", "--no-gpg-sign", "-q", "-m", "fixture: cited file");
  await writeFile(
    intakePaths(ARTIFACTS_DIR).extractedPlan,
    JSON.stringify({
      plan_id: "P1",
      findings: [
        {
          id: "F-001",
          title: "Fix auth",
          category: "correctness",
          severity: "high",
          confidence: "high",
          lens: "correctness",
          summary: "s",
          affected_files: [{ path: "src/auth.ts" }],
          // The finding filter drops a finding with no evidence (findingFilter.ts).
          evidence: ["src/auth.ts:1 export const auth = 1;"],
        },
      ],
      blocks: [{ block_id: "B-001", items: ["F-001"], parallel_safe: true, touched_files: ["src/auth.ts"] }],
    }),
    "utf8",
  );
}

async function writeHostCheckpoint(extra: Record<string, unknown> = {}): Promise<void> {
  await writeFile(
    join(ARTIFACTS_DIR, "intent_checkpoint.json"),
    JSON.stringify({
      schema_version: "intent-checkpoint/v1",
      confirmed_at: new Date().toISOString(),
      confirmed_by: "host",
      scope_summary: "Test scope",
      intent_summary: "Test intent",
      ...extra,
    }),
    "utf8",
  );
}

// The harness repo is a git repository with no remote and no manifest, so the
// appropriate candidates are exactly these, in vocabulary order.
const HARNESS_CANDIDATES = ["commit", "tag", "none", "custom"];

describe("closing action: detected candidates, user choice", () => {
  beforeEach(async () => {
    await resetTestRepo();
  });
  afterEach(async () => {
    await cleanupTestRepo();
  });

  it("confirm_intent presents the detected candidates with their facts and never selects one", async () => {
    await writeReadyDocumentIntake();

    const step = await decideNextStep({ root: REPO_DIR });
    expect(step.step_kind).toBe("confirm_intent");
    const prompt = await readFile(step.prompt_path, "utf8");

    expect(prompt).toContain("## Closing Action — you choose");
    expect(prompt).toContain("The tool never selects one");
    for (const action of HARNESS_CANDIDATES) {
      expect(prompt, `candidate ${action} is offered`).toMatch(new RegExp(`^- \`${action}\` — `, "m"));
    }
    for (const action of ["push", "open-pr", "publish"]) {
      expect(prompt, `${action} is not offered without a remote or a manifest`).not.toMatch(
        new RegExp(`^- \`${action}\` — `, "m"),
      );
    }
    expect(prompt).toContain("the root is a git working tree");
    expect(prompt).toContain('"closing_action"');
    expect(prompt).not.toContain("Suggested Closing Action");
  });

  it("a confirmed checkpoint whose closing_action is outside the vocabulary is refused by name", async () => {
    await writeReadyDocumentIntake();
    await writeHostCheckpoint({ closing_action: "deploy" });

    const step = await decideNextStep({ root: REPO_DIR });
    expect(step.step_kind).toBe("confirm_intent");
    const prompt = await readFile(step.prompt_path, "utf8");
    expect(prompt).toContain("Refused");
    expect(prompt).toContain('"deploy"');
  });

  it("the host's choice reaches closing_plan, and detection fills the plan's candidates", async () => {
    await writeReadyDocumentIntake();
    await writeExtractedPlanWithoutFacts();
    await writeHostCheckpoint({ closing_action: "commit" });

    const step = await decideNextStep({ root: REPO_DIR });
    expect(step.step_kind).not.toBe("confirm_intent");

    const state = await new StateStore(ARTIFACTS_DIR).loadState();
    expect(state?.closing_plan?.action, `after step ${step.step_kind}`).toBe("commit");
    expect(state?.plan?.candidate_closing_actions).toEqual(HARNESS_CANDIDATES);
    expect(state?.plan?.project_type).toBe("unknown");
  });

  it("an omitted closing_action is none — nothing is inferred from the candidates", async () => {
    await writeReadyDocumentIntake();
    await writeExtractedPlanWithoutFacts();
    await writeHostCheckpoint();

    const step = await decideNextStep({ root: REPO_DIR });
    expect(step.step_kind).not.toBe("confirm_intent");

    const state = await new StateStore(ARTIFACTS_DIR).loadState();
    expect(state?.closing_plan?.action, `after step ${step.step_kind}`).toBe("none");
  });

  it("the contract pipeline's extracted plan carries detected candidates, not a hard-coded none", async () => {
    await writeCompleteContractPipelineDag();
    git("remote", "add", "origin", "https://example.invalid/fixture.git");

    await promoteImplementationDagToExtractedPlan(ARTIFACTS_DIR, REPO_DIR);

    const extracted = JSON.parse(await readFile(intakePaths(ARTIFACTS_DIR).extractedPlan, "utf8"));
    expect(extracted.candidate_closing_actions).toEqual([
      "commit", "push", "open-pr", "tag", "none", "custom",
    ]);
    expect(extracted.project_type).toBe("unknown");
  });
});
