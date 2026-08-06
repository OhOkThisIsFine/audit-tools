import { test, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { program } from "../../src/remediate/index.js";

// Terminal-exit backstop (backlog: abnormal-exit no-step-contract), remediate
// draw: a fatal next-step exit must overwrite current-step.json with a blocked
// step naming the cause — a consumer must never read the PREVIOUS step as a
// live instruction after a crash. The trigger (a missing --guidance-file) is
// one arbitrary member of the covered class: the backstop wraps the whole
// action body, so any throw exercises the same path.
test("a fatal remediate next-step exit overwrites the stale step with a blocked step naming the cause", async () => {
  const dir = mkdtempSync(join(tmpdir(), "remediate-blocked-backstop-"));
  try {
    const root = join(dir, "repo");
    const artifactsDir = join(root, ".audit-tools", "remediation");
    const stepsDir = join(artifactsDir, "steps");
    mkdirSync(stepsDir, { recursive: true });
    // Seed a stale prior step — the defect was that this survived a fatal exit.
    writeFileSync(
      join(stepsDir, "current-step.json"),
      JSON.stringify({ step_kind: "dispatch_implement", status: "ready" }, null, 2),
    );

    const missingGuidance = join(root, "no-such-guidance.md");
    await expect(
      program.parseAsync([
        "node",
        "remediate-code",
        "next-step",
        "--root",
        root,
        "--guidance-file",
        missingGuidance,
      ]),
    ).rejects.toThrow(/no-such-guidance\.md/);

    const step = JSON.parse(
      readFileSync(join(stepsDir, "current-step.json"), "utf8"),
    );
    expect(step.step_kind).toBe("blocked");
    expect(step.status).toBe("blocked");
    // The step JSON names the cause on its own (headless consumers never read
    // the prompt file).
    expect(step.progress.summary).toContain("no-such-guidance.md");

    const prompt = readFileSync(join(stepsDir, "current-prompt.md"), "utf8");
    expect(prompt).toContain("# remediate-code blocked");
    expect(prompt).toContain("no-such-guidance.md");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
