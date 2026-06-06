import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runDocumentPhase } from "../src/phases/document.js";
import type { RemediationState } from "../src/state/store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(__dirname, ".test-document");
const REPO_DIR = join(__dirname, ".test-document-repo");

const BASE_OPTIONS = { root: REPO_DIR, artifactsDir: TEST_DIR };

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await rm(REPO_DIR, { recursive: true, force: true });
  await mkdir(TEST_DIR, { recursive: true });
  await mkdir(REPO_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await rm(REPO_DIR, { recursive: true, force: true });
});

function makeState(): RemediationState {
  return {
    status: "planning",
    plan: {
      plan_id: "P1",
      findings: [
        {
          id: "F1",
          title: "Finding",
          category: "correctness",
          severity: "high",
          confidence: "high",
          lens: "correctness",
          summary: "Summary",
          affected_files: [{ path: "src/a.ts" }],
          evidence: ["evidence"],
        },
      ],
      blocks: [{ block_id: "B1", items: ["F1"], parallel_safe: true }],
      project_type: "unknown",
      candidate_closing_actions: ["none"],
    },
    items: {
      F1: { finding_id: "F1", status: "pending", block_id: "B1" },
    },
    closing_plan: { action: "none" },
  };
}

function makeStateWithFinding(id: string): RemediationState {
  return {
    status: "planning",
    plan: {
      plan_id: "P1",
      findings: [
        {
          id,
          title: "Finding",
          category: "correctness",
          severity: "high",
          confidence: "high",
          lens: "correctness",
          summary: "Summary",
          affected_files: [{ path: "src/a.ts" }],
          evidence: ["evidence"],
        },
      ],
      blocks: [{ block_id: "B1", items: [id], parallel_safe: true }],
      project_type: "unknown",
      candidate_closing_actions: ["none"],
    },
    items: {
      [id]: { finding_id: id, status: "pending", block_id: "B1" },
    },
    closing_plan: { action: "none" },
  };
}

function expectIsoTimestamp(value: unknown): void {
  expect(typeof value).toBe("string");
  expect(Date.parse(value as string)).not.toBeNaN();
}

describe("runDocumentPhase clarification resolutions", () => {
  it("applies finding-id keyed object resolutions from clarification_resolution.json", async () => {
    const state = makeState();
    await writeFile(
      join(TEST_DIR, "clarification_resolution.json"),
      JSON.stringify({
        F1: {
          action: "deemed_inappropriate",
          rationale: "Out of scope",
        },
      }),
      "utf8",
    );

    const next = await runDocumentPhase(state, BASE_OPTIONS);

    expect(next.status).toBe("documenting");
    expect(next.items!.F1.status).toBe("deemed_inappropriate");
    expect(next.items!.F1.failure_reason).toBe("Out of scope");
    expectIsoTimestamp(next.items!.F1.started_at);
    expectIsoTimestamp(next.items!.F1.completed_at);
  });

  it("normalizeClarificationResolutions: resolutions wrapper array", async () => {
    const state = makeStateWithFinding("F-1");
    await writeFile(
      join(TEST_DIR, "clarification_resolution.json"),
      JSON.stringify({
        resolutions: [
          { finding_id: "F-1", action: "deemed_inappropriate", rationale: "not relevant" },
        ],
      }),
      "utf8",
    );

    const next = await runDocumentPhase(state, BASE_OPTIONS);

    expect(next.status).toBe("documenting");
    expect(next.items!["F-1"].status).toBe("deemed_inappropriate");
    expect(next.items!["F-1"].failure_reason).toBe("not relevant");
  });

  it("normalizeClarificationResolutions: items wrapper array", async () => {
    const state = makeStateWithFinding("F-2");
    await writeFile(
      join(TEST_DIR, "clarification_resolution.json"),
      JSON.stringify({
        items: [
          { finding_id: "F-2", action: "deemed_inappropriate", rationale: "out of scope" },
        ],
      }),
      "utf8",
    );

    const next = await runDocumentPhase(state, BASE_OPTIONS);

    expect(next.status).toBe("documenting");
    expect(next.items!["F-2"].status).toBe("deemed_inappropriate");
    expect(next.items!["F-2"].failure_reason).toBe("out of scope");
  });
});
