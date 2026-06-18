/**
 * CP-BLOCK-N-dispatch-seam — render-side seam + write-scope enforcement.
 *
 * Covers (OBL-DS-01..07, OBL-DS-15, CE-001):
 *  - the renderer emits the EXACT node id (never a "FINDING-ID" placeholder) and
 *    the one-result-per-node rule;
 *  - the per-node verify commands are BUILD-FREE (npm run check + a build-free
 *    test runner — never `npm run build` / `npm test`);
 *  - upstream/neighbor reconciliation expectations are threaded into the prompt;
 *  - `buildImplementModelHint` reads the node's promoted `model_tier` (not a flat
 *    "standard");
 *  - the write-scope gate enforces declared scope against the ACTUAL git edit set
 *    (fail-closed when git is a repo but the probe fails; never trusts
 *    self-reported amended_files);
 *  - a per-node SKIP disposition is NEVER `verified_complete` (INV-DS-15);
 *  - sibling-red attribution routes an attributable red to triage and defers an
 *    unattributable one to the rolling-scheduler coarse backstop (INV-DS-14).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { StateStore } from "../../src/remediate/state/store.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
import type {
  Finding,
  RemediationBlock,
  RemediationItemState,
} from "../../src/remediate/state/types.js";
import {
  prepareImplementDispatch,
  buildImplementModelHint,
  isBuildFreeVerifyCommand,
  writeScopeViolations,
  enforceWriteScope,
  gitEditedFiles,
  buildNodeDisposition,
  attributeSiblingRed,
  worktreeBranchForBlock,
  type GitEditedFiles,
} from "../../src/remediate/steps/dispatch.js";
import { makeFinding } from "./test-helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(__dirname, ".test-dispatch-evidence");
const REPO_DIR = join(TEST_DIR, "repo");
const ARTIFACTS_DIR = join(REPO_DIR, ".audit-tools/remediation");

/** A node-shaped finding carrying the promoted contract-pipeline overlay fields. */
function makeNodeFinding(overrides: Record<string, unknown> = {}): Finding {
  return {
    ...makeFinding({
      id: "N-dispatch-seam",
      title: "Implement dispatch render/merge seam",
      severity: "high",
      lens: "correctness",
      summary: "Implement the dispatch seam.",
      affected_files: [{ path: "packages/remediate-code/src/steps/dispatch.ts" }],
    }),
    ...overrides,
  } as Finding;
}

function makeImplementingState(finding: Finding): RemediationState {
  const block: RemediationBlock = {
    block_id: `CP-BLOCK-${finding.id}`,
    items: [finding.id],
    parallel_safe: true,
  };
  const item: RemediationItemState = {
    finding_id: finding.id,
    status: "pending",
    block_id: block.block_id,
    item_spec: {
      finding_id: finding.id,
      concrete_change: "do the work",
      tests_to_write: [{ name: "t1", assertions: ["passes"] }],
      not_applicable_steps: [],
    },
  };
  return {
    status: "implementing",
    plan: {
      plan_id: "PLAN-1",
      findings: [finding],
      blocks: [block],
      project_type: "typescript-node",
      candidate_closing_actions: ["none"],
    },
    items: { [finding.id]: item },
    closing_plan: { action: "none" },
  } as unknown as RemediationState;
}

async function saveState(state: RemediationState): Promise<void> {
  await new StateStore(ARTIFACTS_DIR).saveState(state);
}

async function renderPrompt(state: RemediationState): Promise<string> {
  await saveState(state);
  const plan = await prepareImplementDispatch(
    { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR },
    "PLAN-1",
  );
  expect(plan.items).toHaveLength(1);
  return readFile(plan.items[0].prompt_path, "utf8");
}

/**
 * Extract the body of a `## <heading>` section (up to the next `## ` heading or
 * end of prompt). Used to scope build-free assertions to the RUNNABLE per-node
 * verification directives, distinct from the provenance traceability section
 * which faithfully echoes the DAG's recorded (possibly build-prepending) commands.
 */
function sectionOf(prompt: string, heading: string): string {
  const start = prompt.indexOf(`## ${heading}`);
  if (start < 0) return "";
  const rest = prompt.slice(start + `## ${heading}`.length);
  const next = rest.indexOf("\n## ");
  return next < 0 ? rest : rest.slice(0, next);
}

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(ARTIFACTS_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Renderer: exact node id + one-result-per-node + build-free verify
// ---------------------------------------------------------------------------

describe("implement prompt renderer — exact node id + one-result-per-node", () => {
  it("emits the exact node id in the result schema, never a 'FINDING-ID' placeholder", async () => {
    const prompt = await renderPrompt(makeImplementingState(makeNodeFinding()));
    // The output schema's finding_id is the real node id.
    expect(prompt).toContain('"finding_id": "N-dispatch-seam"');
    expect(prompt).not.toContain("FINDING-ID");
  });

  it("states the one-result-per-node rule and forbids obligation/block-id/title substitution", async () => {
    const prompt = await renderPrompt(makeImplementingState(makeNodeFinding()));
    expect(prompt).toMatch(/exactly one .*item_results.* entry per node id/i);
    expect(prompt).toMatch(/Do not substitute a title, an obligation id, or a block id/i);
  });
});

describe("implement prompt renderer — build-free per-node verification (CE-001)", () => {
  it("the RUNNABLE per-node verify section is build-free: keeps build-free, drops build/test", async () => {
    const finding = makeNodeFinding({
      // A node that (wrongly) carried build commands: they must be filtered out
      // of the runnable per-node verify directives (residual CE-001).
      targeted_commands: [
        "npm run check",
        "npx vitest run packages/remediate-code/tests/dispatch-evidence-and-writescope.test.ts",
        "npm run build -w packages/remediate-code",
        "npm test -w packages/remediate-code",
      ],
    });
    const prompt = await renderPrompt(makeImplementingState(finding));
    const verifySection = sectionOf(prompt, "Per-node verification (build-free)");
    // The fenced code block holds the RUNNABLE node-targeted commands.
    const fenced = verifySection.match(/```\n([\s\S]*?)```/);
    const runnableCommands = fenced ? fenced[1] : "";

    expect(verifySection).toContain("npm run check");
    // The build-free node command survives into the runnable directives.
    expect(runnableCommands).toContain(
      "npx vitest run packages/remediate-code/tests/dispatch-evidence-and-writescope.test.ts",
    );
    // The build / build-prepending commands are filtered out of the runnable
    // command block (they may still appear under the provenance-only "Contract
    // Pipeline Traceability" section, which is not a directive).
    expect(runnableCommands).not.toContain("npm run build");
    expect(runnableCommands).not.toMatch(/\bnpm test\b/);
    // And the section's prose explicitly tells the worker not to build.
    expect(verifySection).toMatch(/do NOT run .npm run build. or .npm test./i);
  });

  it("an infra-modifying node's section is also build-free (no npm run build / npm test directive)", async () => {
    // A node whose declared write scope is the live dispatch engine. It carries
    // no build commands, so the whole prompt must be free of the -w build/test
    // forms (the infra section no longer instructs a worker-side build).
    const finding = makeNodeFinding({
      affected_files: [{ path: "packages/remediate-code/src/steps/dispatch.ts" }],
    });
    const state = makeImplementingState(finding);
    state.items![finding.id].item_spec!.touched_files = [
      "packages/remediate-code/src/steps/dispatch.ts",
    ];
    const prompt = await renderPrompt(state);

    expect(prompt).toContain("Infra-modifying block");
    expect(prompt).not.toMatch(/npm run build -w packages\/remediate-code/);
    expect(prompt).not.toMatch(/npm test -w packages\/remediate-code/);
    const infraSection = sectionOf(prompt, "Infra-modifying block");
    expect(infraSection).toContain("npm run check");
  });
});

describe("implement prompt renderer — threaded upstream reconciliation expectations", () => {
  it("threads node.reconciliation_expectations (and preconditions) into the item", async () => {
    const finding = makeNodeFinding({
      reconciliation_expectations: ["OwnershipRegistry.getScope(nodeId): string[]"],
      preconditions: ["src/dispatch/ownershipRegistry.ts exports OwnershipRegistry"],
      expected_changes: "Add the merge tolerance + write-scope gate.",
    });
    const prompt = await renderPrompt(makeImplementingState(finding));
    expect(prompt).toContain("Upstream/neighbor contract provides");
    expect(prompt).toContain("OwnershipRegistry.getScope(nodeId): string[]");
    expect(prompt).toContain(
      "src/dispatch/ownershipRegistry.ts exports OwnershipRegistry",
    );
    expect(prompt).toContain("Expected changes: Add the merge tolerance");
  });
});

// ---------------------------------------------------------------------------
// isBuildFreeVerifyCommand
// ---------------------------------------------------------------------------

describe("isBuildFreeVerifyCommand", () => {
  it("accepts build-free commands", () => {
    expect(isBuildFreeVerifyCommand("npm run check")).toBe(true);
    expect(isBuildFreeVerifyCommand("npx vitest run tests/foo.test.ts")).toBe(true);
    expect(isBuildFreeVerifyCommand("vitest run tests/foo.test.ts")).toBe(true);
    expect(isBuildFreeVerifyCommand("node --test tests/foo.test.mjs")).toBe(true);
    expect(isBuildFreeVerifyCommand("tsc --noEmit -p tsconfig.json")).toBe(true);
  });

  it("rejects build and build-prepending commands", () => {
    expect(isBuildFreeVerifyCommand("npm run build")).toBe(false);
    expect(isBuildFreeVerifyCommand("npm run build -w packages/remediate-code")).toBe(false);
    expect(isBuildFreeVerifyCommand("npm test")).toBe(false);
    expect(isBuildFreeVerifyCommand("npm t")).toBe(false);
    expect(isBuildFreeVerifyCommand("npm test -w packages/remediate-code")).toBe(false);
    expect(isBuildFreeVerifyCommand("npm run test")).toBe(false);
    expect(isBuildFreeVerifyCommand("tsc -b")).toBe(false);
    expect(isBuildFreeVerifyCommand("tsc --build")).toBe(false);
    expect(isBuildFreeVerifyCommand("tsc -p tsconfig.json")).toBe(false);
    expect(isBuildFreeVerifyCommand("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildImplementModelHint — reads node model_tier
// ---------------------------------------------------------------------------

describe("buildImplementModelHint — node model_tier", () => {
  function stateFor(finding: Finding): { state: RemediationState; block: RemediationBlock } {
    const state = makeImplementingState(finding);
    return { state, block: state.plan!.blocks[0] };
  }

  it("uses the node's promoted model_tier verbatim, not a re-derived heuristic", () => {
    // A single low-severity finding would heuristically be "small"/"standard",
    // but the node declared "deep" → that rank wins.
    const finding = makeNodeFinding({ severity: "low", model_tier: "deep" });
    const { state, block } = stateFor(finding);
    const hint = buildImplementModelHint(block, state);
    expect(hint.tier).toBe("deep");
    expect(hint.reasons).toContain("node_model_tier");
  });

  it("honors a 'small' node tier even for an otherwise-standard block", () => {
    const finding = makeNodeFinding({ severity: "medium", model_tier: "small" });
    const { state, block } = stateFor(finding);
    const hint = buildImplementModelHint(block, state);
    expect(hint.tier).toBe("small");
    expect(hint.reasons).toContain("node_model_tier");
  });

  it("falls back to the block heuristic when no node tier is present", () => {
    const finding = makeNodeFinding({ severity: "critical", model_tier: undefined });
    delete (finding as Record<string, unknown>).model_tier;
    const { state, block } = stateFor(finding);
    const hint = buildImplementModelHint(block, state);
    // No flat default: critical severity drives the heuristic to "deep".
    expect(hint.tier).toBe("deep");
    expect(hint.reasons).toContain("critical_severity");
  });
});

// ---------------------------------------------------------------------------
// Write-scope primitives + gate decision
// ---------------------------------------------------------------------------

describe("writeScopeViolations", () => {
  const root = "/repo";
  it("returns nothing when all edits are within declared scope", () => {
    const declared = ["src/a.ts", "src/b.ts"];
    const edited = new Set(["src/a.ts", "src/b.ts"]);
    expect(writeScopeViolations(declared, edited, root)).toEqual([]);
  });

  it("flags an edited file outside the declared scope", () => {
    const declared = ["src/a.ts"];
    const edited = new Set(["src/a.ts", "src/secret.ts"]);
    expect(writeScopeViolations(declared, edited, root)).toEqual(["src/secret.ts"]);
  });

  it("exempts result JSON and the agent-feedback file from the scope check", () => {
    const declared = ["src/a.ts"];
    const edited = new Set([
      "src/a.ts",
      ".audit-tools/remediation/runs/R/implement/implement-B.result.json",
      ".audit-tools/remediation/agent-feedback.jsonl",
    ]);
    expect(writeScopeViolations(declared, edited, root)).toEqual([]);
  });

  it("normalizes absolute and back-slashed declared paths to repo-relative", () => {
    const declared = ["/repo/src/a.ts", "src\\b.ts"];
    const edited = new Set(["src/a.ts", "src/b.ts"]);
    expect(writeScopeViolations(declared, edited, root)).toEqual([]);
  });
});

describe("enforceWriteScope — gate decision (fail-closed; ignores amended_files)", () => {
  const root = "/repo";

  it("does NOT block when there is no git ground truth (not a repo)", () => {
    const edited: GitEditedFiles = { available: false, reason: "not_a_repo", error: "x" };
    expect(enforceWriteScope(["src/a.ts"], edited, root)).toEqual({ blocked: false });
  });

  it("FAILS CLOSED when git is a repo but the probe failed", () => {
    const edited: GitEditedFiles = { available: false, reason: "probe_failed", error: "boom" };
    const decision = enforceWriteScope(["src/a.ts"], edited, root);
    expect(decision.blocked).toBe(true);
    expect(decision.reason).toMatch(/fail/i);
    expect(decision.reason).toMatch(/git probe failed/i);
  });

  it("does not block when actual edits are within declared scope", () => {
    const edited: GitEditedFiles = { available: true, files: new Set(["src/a.ts"]) };
    expect(enforceWriteScope(["src/a.ts"], edited, root)).toEqual({ blocked: false });
  });

  it("blocks when an actual edit is outside declared scope (amended_files never consulted)", () => {
    const edited: GitEditedFiles = {
      available: true,
      files: new Set(["src/a.ts", "src/elsewhere.ts"]),
    };
    const decision = enforceWriteScope(["src/a.ts"], edited, root);
    expect(decision.blocked).toBe(true);
    expect(decision.reason).toContain("src/elsewhere.ts");
    expect(decision.reason).toMatch(/amended_files set is not trusted/i);
  });
});

describe("gitEditedFiles — real repo vs non-repo", () => {
  it("reports not_a_repo for a directory outside any git work tree", async () => {
    // A freshly-created temp dir under the test tree is still inside the
    // audit-tools work tree, so create an isolated dir outside it via os.tmpdir.
    const os = await import("node:os");
    const fs = await import("node:fs/promises");
    const base = await fs.mkdtemp(join(os.tmpdir(), "no-git-"));
    try {
      const result = gitEditedFiles(base);
      // os.tmpdir() is not under a git work tree.
      expect(result.available).toBe(false);
      if (!result.available) expect(result.reason).toBe("not_a_repo");
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  it("returns an available edit set when run inside this git repo", () => {
    // The repo root of audit-tools is a real git work tree.
    const result = gitEditedFiles(process.cwd());
    expect(result.available).toBe(true);
    if (result.available) expect(result.files instanceof Set).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// NodeDisposition (INV-DS-15): a SKIP is never verified_complete
// ---------------------------------------------------------------------------

describe("buildNodeDisposition — skip is never verified_complete (INV-DS-15)", () => {
  function blockState(status: RemediationItemState["status"]): {
    block: RemediationBlock;
    state: RemediationState;
  } {
    const finding = makeNodeFinding({
      preconditions: ["upstream provides X"],
    });
    const state = makeImplementingState(finding);
    state.items![finding.id].status = status;
    return { block: state.plan!.blocks[0], state };
  }

  it("a deemed_inappropriate node is 'skipped', never 'verified_complete'", () => {
    const { block, state } = blockState("deemed_inappropriate");
    const d = buildNodeDisposition(block, state);
    expect(d.disposition).toBe("skipped");
    expect(d.disposition).not.toBe("verified_complete");
  });

  it("an ignored node is 'skipped', never 'verified_complete'", () => {
    const { block, state } = blockState("ignored");
    const d = buildNodeDisposition(block, state);
    expect(d.disposition).toBe("skipped");
  });

  it("a resolved node is verified_complete and records reconciliation expectations", () => {
    const { block, state } = blockState("resolved");
    const d = buildNodeDisposition(block, state);
    expect(d.disposition).toBe("verified_complete");
    expect(d.reconciliation_expectations).toContain("upstream provides X");
  });

  it("a blocked node is 'blocked' with the failure reason", () => {
    const { block, state } = blockState("blocked");
    state.items![block.items[0]].failure_reason = "verification failed";
    const d = buildNodeDisposition(block, state);
    expect(d.disposition).toBe("blocked");
    expect(d.reason).toBe("verification failed");
  });
});

// ---------------------------------------------------------------------------
// Sibling-red attribution (INV-DS-14)
// ---------------------------------------------------------------------------

describe("attributeSiblingRed", () => {
  const root = "/repo";

  it("attributes to the single sibling whose scope owns the implicated file", () => {
    const implicated = ["src/shared.ts"];
    const siblings = [
      { block_id: "B-1", write_paths: ["src/shared.ts"] },
      { block_id: "B-2", write_paths: ["src/other.ts"] },
    ];
    expect(attributeSiblingRed(implicated, siblings, root)).toBe("B-1");
  });

  it("defers (null) when no sibling owns the implicated surface", () => {
    const implicated = ["src/orphan.ts"];
    const siblings = [{ block_id: "B-1", write_paths: ["src/a.ts"] }];
    expect(attributeSiblingRed(implicated, siblings, root)).toBeNull();
  });

  it("defers (null) when more than one sibling could own the implicated surface", () => {
    const implicated = ["src/a.ts", "src/b.ts"];
    const siblings = [
      { block_id: "B-1", write_paths: ["src/a.ts"] },
      { block_id: "B-2", write_paths: ["src/b.ts"] },
    ];
    // Ambiguous → unattributable → rolling-scheduler coarse backstop.
    expect(attributeSiblingRed(implicated, siblings, root)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// worktreeBranchForBlock naming convention
// ---------------------------------------------------------------------------

describe("worktreeBranchForBlock", () => {
  it("mirrors the worktree dir naming: remediate-<blockId>-<runId>", () => {
    expect(worktreeBranchForBlock("CP-BLOCK-N-x", "RUN-9")).toBe(
      "remediate-CP-BLOCK-N-x-RUN-9",
    );
  });
});
