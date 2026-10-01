// Owner decision 92b0e2dd7cfdc06d (2026-08-31): the tool DETECTS the closing
// actions a repository's shape makes appropriate and PRESENTS them at the
// intent checkpoint; the user chooses; the tool never selects one. These tests
// pin the four seams: the confirm_intent prompt, the refusal of an invalid
// choice, the choice reaching closing_plan (and the plan carrying the detected
// candidates), and the contract pipeline's extracted plan carrying detected
// values instead of a hard-coded ["none"].
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSyncHidden as spawnSync } from "../helpers/spawn.mjs";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import { StateStore } from "../../src/remediate/state/store.js";
import { intakePaths, writeProjectFacts } from "../../src/remediate/intake.js";
import { detectProjectFacts } from "audit-tools/shared";
import { createNextStepHarness } from "./helpers/nextStepHarness.js";
import { intakeSummaryFixture } from "./helpers/intakeSummaryFixture.js";

const harness = createNextStepHarness(".test-closing-action-choice");
const { REPO_DIR, ARTIFACTS_DIR, resetTestRepo, cleanupTestRepo, writeApprovedExecutionPlan } = harness;

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
    JSON.stringify(
      intakeSummaryFixture({
        goals: ["Fix the auth flow."],
        affected_files: [{ path: "src/auth.ts" }],
      }),
    ),
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
    expect(
      existsSync(intakePaths(ARTIFACTS_DIR).projectFacts),
      "the confirm step persists the detected facts for planning, which spawns nothing",
    ).toBe(true);
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
    // The confirm step runs first, as in the real flow: it detects and persists the facts.
    await decideNextStep({ root: REPO_DIR });
    await writeHostCheckpoint({ closing_action: "commit" });
    await writeApprovedExecutionPlan();

    const step = await decideNextStep({ root: REPO_DIR });
    expect(step.step_kind).not.toBe("confirm_intent");

    const state = await new StateStore(ARTIFACTS_DIR).loadState();
    expect(state?.closing_plan?.action, `after step ${step.step_kind}`).toBe("commit");
    expect(state?.plan?.candidate_closing_actions).toEqual(HARNESS_CANDIDATES);
    expect(state?.plan?.project_type).toBe("unknown");
  });

  it("an omitted closing_action is none — nothing is inferred from the candidates", async () => {
    await writeReadyDocumentIntake();
    await decideNextStep({ root: REPO_DIR });
    await writeHostCheckpoint();
    await writeApprovedExecutionPlan();

    const step = await decideNextStep({ root: REPO_DIR });
    expect(step.step_kind).not.toBe("confirm_intent");

    const state = await new StateStore(ARTIFACTS_DIR).loadState();
    expect(state?.closing_plan?.action, `after step ${step.step_kind}`).toBe("none");
  });

  it("approved-plan activation carries detected candidates without selecting an action", async () => {
    await writeReadyDocumentIntake();
    git("remote", "add", "origin", "https://example.invalid/fixture.git");
    await writeProjectFacts(ARTIFACTS_DIR, await detectProjectFacts(REPO_DIR));
    await writeHostCheckpoint(); await writeApprovedExecutionPlan();
    await decideNextStep({ root: REPO_DIR });
    const extracted = (await new StateStore(ARTIFACTS_DIR).loadState())!.plan!;
    expect(extracted.candidate_closing_actions).toEqual(["commit", "push", "open-pr", "tag", "none", "custom"]);
    expect(extracted.project_type).toBe("unknown");
  });
});
