import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { execSyncHidden as execSync } from "../helpers/spawn.mjs";
import { detectProjectFacts } from "../../src/shared/tooling/projectFacts.js";
import { writeProjectFacts } from "../../src/remediate/intake.js";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import {
  runClosePhase,
  runCombinedTestSuite,
  buildVerificationReport,
} from "../../src/remediate/phases/close.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
import { scratchDir } from "../helpers/scratch.js";

const ROOT = scratchDir(".test-pipeline-command-defaults");
const ARTIFACTS = join(ROOT, ".audit-tools", "remediation");

beforeEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(join(ROOT, "src"), { recursive: true });
  await writeFile(
    join(ROOT, "package.json"),
    JSON.stringify({
      name: "defaults-fixture",
      scripts: {
        test: 'node -e "process.exit(1)"',
        e2e: 'node -e "process.exit(0)"',
      },
    }),
  );
  await writeFile(join(ROOT, "src", "real.ts"), "export const real = true;\n");
  await mkdir(ARTIFACTS, { recursive: true });
  execSync("git init", { cwd: ROOT });
  execSync("git config user.email test@test.com", { cwd: ROOT });
  execSync("git config user.name Test", { cwd: ROOT });
  execSync("git add . && git commit -m init", { cwd: ROOT });
});

afterEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

async function writeExtractedPlan(commands: { test_command?: unknown; e2e_command?: unknown } = {}): Promise<void> {
  await writeFile(
    join(ARTIFACTS, "extracted-plan.json"),
    JSON.stringify({
      plan_id: "PLAN-DEFAULTS",
      findings: [
        {
          id: "F-DEFAULT",
          title: "Default command finding",
          category: "General",
          severity: "medium",
          confidence: "high",
          lens: "correctness",
          summary: "A real finding for the pipeline proof.",
          affected_files: [{ path: "src/real.ts" }],
          evidence: ["src/real.ts:1 — cited"],
        },
      ],
      blocks: [
        {
          block_id: "B-DEFAULT",
          items: ["F-DEFAULT"],
          parallel_safe: true,
          touched_files: ["src/real.ts"],
        },
      ],
      // Deliberately omit test_command and e2e_command.
      ...commands,
    }),
  );
  await writeFile(
    join(ARTIFACTS, "intent_checkpoint.json"),
    JSON.stringify({
      schema_version: "intent-checkpoint/v1",
      confirmed_at: new Date().toISOString(),
      scope_summary: "Test scope",
      intent_summary: "Test intent",
      confirmed_by: "host",
    }),
  );
}

describe("project command defaults across intake, planning, and close", () => {
  it("defaults omitted test and e2e commands from persisted facts and runs the failing test at close", async () => {
    const facts = await detectProjectFacts(ROOT);
    await writeProjectFacts(ARTIFACTS, facts);
    await writeExtractedPlan();

    await decideNextStep({ root: ROOT });
    const state = JSON.parse(
      await readFile(join(ARTIFACTS, "state.json"), "utf8"),
    ) as RemediationState;
    expect(state.plan?.test_command).toBe("npm test");
    expect(state.plan?.e2e_command).toBe("npm run e2e");

    state.status = "closing";
    state.closing_plan = { action: "none" };
    state.items = {
      "F-DEFAULT": {
        finding_id: "F-DEFAULT",
        status: "resolved",
        block_id: "B-DEFAULT",
      },
    };
    const closeOptions = { root: ROOT, artifactsDir: ARTIFACTS };
    const combined = await runCombinedTestSuite(state, closeOptions);
    expect(combined).toMatchObject({ ran: true, passed: false });
    const closed = await runClosePhase(state, closeOptions);
    expect(closed.status).toBe("triage");
    expect(closed.items?.["F-DEFAULT"]?.status).toBe("blocked");
    // Close returns to triage immediately after a failed combined suite; the
    // persisted e2e default is exercised by the passing-suite close path below.
  });

  it("refuses a defaulted test command when the manifest drifts before close", async () => {
    const facts = await detectProjectFacts(ROOT);
    await writeProjectFacts(ARTIFACTS, facts);
    await writeExtractedPlan();
    await decideNextStep({ root: ROOT });
    const state = JSON.parse(
      await readFile(join(ARTIFACTS, "state.json"), "utf8"),
    ) as RemediationState;
    await writeFile(
      join(ROOT, "package.json"),
      JSON.stringify({
        name: "defaults-fixture",
        scripts: { e2e: 'node -e "process.exit(0)"' },
      }),
    );
    state.status = "closing";
    state.closing_plan = { action: "none" };
    state.items = {
      "F-DEFAULT": {
        finding_id: "F-DEFAULT",
        status: "resolved",
        block_id: "B-DEFAULT",
      },
    };
    const closed = await runClosePhase(state, {
      root: ROOT,
      artifactsDir: ARTIFACTS,
    });
    expect(closed.status).toBe("triage");
    expect(closed.items?.["F-DEFAULT"]?.status).toBe("blocked");
  });

  it("executes a persisted e2e default through the admission gate", async () => {
    await writeFile(
      join(ROOT, "package.json"),
      JSON.stringify({
        name: "defaults-fixture",
        scripts: {
          test: 'node -e "process.exit(0)"',
          e2e: "node -e \"require('fs').writeFileSync('e2e-ran.marker','yes')\"",
        },
      }),
    );
    const facts = await detectProjectFacts(ROOT);
    await writeProjectFacts(ARTIFACTS, facts);
    await writeExtractedPlan();
    await decideNextStep({ root: ROOT });
    const state = JSON.parse(
      await readFile(join(ARTIFACTS, "state.json"), "utf8"),
    ) as RemediationState;
    state.status = "closing";
    state.closing_plan = { action: "none" };
    state.items = {
      "F-DEFAULT": {
        finding_id: "F-DEFAULT",
        status: "resolved",
        block_id: "B-DEFAULT",
      },
    };
    await runClosePhase(state, { root: ROOT, artifactsDir: ARTIFACTS });
    const outcomes = JSON.parse(
      await readFile(
        join(ROOT, ".audit-tools", "remediation-outcomes.json"),
        "utf8",
      ),
    );
    expect(outcomes.e2e_result).toEqual({ passed: true });
    expect(existsSync(join(ROOT, "e2e-ran.marker"))).toBe(true);
  });

  it("preserves explicit nonblank commands and defaults blank commands", async () => {
    const facts = await detectProjectFacts(ROOT);
    await writeProjectFacts(ARTIFACTS, facts);
    await writeExtractedPlan({ test_command: "node -e \"process.exit(0)\"", e2e_command: "" });
    await decideNextStep({ root: ROOT });
    const state = JSON.parse(await readFile(join(ARTIFACTS, "state.json"), "utf8")) as RemediationState;
    expect(state.plan?.test_command).toBe("node -e \"process.exit(0)\"");
    expect(state.plan?.test_command_source).toBe("explicit");
    expect(state.plan?.e2e_command).toBe("npm run e2e");
    expect(state.plan?.e2e_command_source).toBe("project_facts");
  });

  it("leaves absent discovery roles absent and refuses a drifted e2e default", async () => {
    await writeFile(join(ROOT, "package.json"), JSON.stringify({ name: "defaults-fixture", scripts: { test: "node -e \"process.exit(0)\"" } }));
    const facts = await detectProjectFacts(ROOT);
    await writeProjectFacts(ARTIFACTS, facts);
    await writeExtractedPlan();
    await decideNextStep({ root: ROOT });
    const state = JSON.parse(await readFile(join(ARTIFACTS, "state.json"), "utf8")) as RemediationState;
    expect(state.plan?.e2e_command).toBeUndefined();

    // Recreate e2e in the plan's source manifest, then remove it before close.
    await writeFile(join(ROOT, "package.json"), JSON.stringify({ name: "defaults-fixture", scripts: { test: "node -e \"process.exit(0)\"", e2e: "node -e \"require(\\\"fs\\\").writeFileSync(\\\"e2e-ran.marker\\\",\\\"yes\\\")\"" } }));
    const factsWithE2e = await detectProjectFacts(ROOT);
    await writeProjectFacts(ARTIFACTS, factsWithE2e);
    await rm(join(ARTIFACTS, "state.json"), { force: true });
    await writeExtractedPlan();
    await decideNextStep({ root: ROOT });
    const drifted = JSON.parse(await readFile(join(ARTIFACTS, "state.json"), "utf8")) as RemediationState;
    await writeFile(join(ROOT, "package.json"), JSON.stringify({ name: "defaults-fixture", scripts: { test: "node -e \"process.exit(0)\"" } }));
    drifted.status = "closing";
    drifted.closing_plan = { action: "none" };
    drifted.items = { "F-DEFAULT": { finding_id: "F-DEFAULT", status: "resolved", block_id: "B-DEFAULT" } };
    const closed = await runClosePhase(drifted, { root: ROOT, artifactsDir: ARTIFACTS });
    expect(closed.status).toBe("triage");
    expect(existsSync(join(ROOT, "e2e-ran.marker"))).toBe(false);
  });

  it("reports a refused default command with its refusal reason", async () => {
    const facts = await detectProjectFacts(ROOT);
    await writeProjectFacts(ARTIFACTS, facts);
    await writeExtractedPlan();
    await decideNextStep({ root: ROOT });
    const state = JSON.parse(await readFile(join(ARTIFACTS, "state.json"), "utf8")) as RemediationState;
    await writeFile(join(ROOT, "package.json"), JSON.stringify({ name: "defaults-fixture", scripts: {} }));
    const combined = await runCombinedTestSuite(state, { root: ROOT, artifactsDir: ARTIFACTS });
    const report = buildVerificationReport(state, { root: ROOT, artifactsDir: ARTIFACTS }, {
      contract_version: "remediate-code-closing-result/v1alpha1",
      action: "none",
      status: "skipped",
      commands: [],
    }, combined);
    expect(combined.ran).toBe(false);
    expect(report.findings[0]?.traces.find((trace) => trace.trace_id.endsWith(":combined-tests"))?.evidence.join(" ")).toMatch(/refused/i);
  });
});
