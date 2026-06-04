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
  });
});
