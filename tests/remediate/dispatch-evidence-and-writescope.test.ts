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
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  isWholeSuiteTestCommand,
  normalizeNodeTestCommand,
  writeScopeViolations,
  enforceWriteScope,
  adjudicateWriteScope,
  verifyCommandsForEdits,
  selfContainedVerifyCommands,
  isDistDependentVerifyCommand,
  partitionDistDependentVerifyCommands,
  pathTokensInCommand,
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
      affected_files: [{ path: "src/remediate/steps/dispatch.ts" }],
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

  it("renders the standing worker rules accreted from live-run failures (backlog 2026-07-23)", async () => {
    const prompt = await renderPrompt(makeImplementingState(makeNodeFinding()));
    const rules = sectionOf(prompt, "Standing rules (every node, every run)");
    // (1) no whole-directory sweeps; (2) no driver CLIs against shared state;
    // (3) new id families glossary-registered + amended_files; (4) no
    // dist-dependent per-node verify commands.
    expect(rules).toMatch(/No whole-directory sweeps/);
    expect(rules).toMatch(/Never run `remediate-code` \/ `audit-code` CLI commands/);
    expect(rules).toMatch(/docs\/glossary-ids\.md/);
    expect(rules).toMatch(/amended_files/);
    expect(rules).toMatch(/dist-dependent per-node verify commands/i);
  });
});

describe("implement prompt renderer — build-free per-node verification (CE-001)", () => {
  it("the RUNNABLE per-node verify section is build-free: keeps build-free, drops build/test", async () => {
    const finding = makeNodeFinding({
      // A node that (wrongly) carried build commands: they must be filtered out
      // of the runnable per-node verify directives (residual CE-001).
      targeted_commands: [
        "npm run check",
        "npx vitest run tests/remediate/dispatch-evidence-and-writescope.test.ts",
        "npm run build",
        "npm test",
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
      "npx vitest run tests/remediate/dispatch-evidence-and-writescope.test.ts",
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
    // A node whose declared write scope is the live dispatch engine (the current
    // single-package `src/remediate/steps/dispatch.ts`, matched by
    // isInfraModifyingBlock). It carries no build commands, so the whole prompt
    // must be free of build/test directives (the infra section no longer
    // instructs a worker-side build).
    const finding = makeNodeFinding({
      affected_files: [{ path: "src/remediate/steps/dispatch.ts" }],
    });
    const state = makeImplementingState(finding);
    state.items![finding.id].item_spec!.touched_files = [
      "src/remediate/steps/dispatch.ts",
    ];
    const prompt = await renderPrompt(state);

    expect(prompt).toContain("Infra-modifying block");
    // The infra section must point the worker at a build-free runner, never a
    // build/test directive. Scope the negative to the runnable fenced command
    // block(s) so it does not match the "do NOT run `npm run build`" PROSE.
    const infraSection = sectionOf(prompt, "Infra-modifying block");
    const infraFenced = (infraSection.match(/```\n([\s\S]*?)```/g) || []).join("\n");
    expect(infraFenced).not.toMatch(/npm run build\b/);
    expect(infraFenced).not.toMatch(/\bnpm test\b/);
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
    expect(isBuildFreeVerifyCommand("npm run build --if-present")).toBe(false);
    expect(isBuildFreeVerifyCommand("npm test")).toBe(false);
    expect(isBuildFreeVerifyCommand("npm t")).toBe(false);
    expect(isBuildFreeVerifyCommand("npm test -- tests/remediate/x.test.ts")).toBe(false);
    expect(isBuildFreeVerifyCommand("npm run test")).toBe(false);
    expect(isBuildFreeVerifyCommand("tsc -b")).toBe(false);
    expect(isBuildFreeVerifyCommand("tsc --build")).toBe(false);
    expect(isBuildFreeVerifyCommand("tsc -p tsconfig.json")).toBe(false);
    expect(isBuildFreeVerifyCommand("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isDistDependentVerifyCommand — dist-dependence partition (2026-07-23 dogfood
// false-red family: a build-free worktree has no dist/, so a command whose
// named test files import/spawn dist deterministically false-reds; deferred to
// the central close gate instead).
// ---------------------------------------------------------------------------

describe("isDistDependentVerifyCommand / partitionDistDependentVerifyCommands", () => {
  it("flags a command string that references a dist path directly", () => {
    expect(isDistDependentVerifyCommand("node dist/audit/index.js status")).toBe(true);
    expect(isDistDependentVerifyCommand("node dist\\remediate\\index.js validate")).toBe(true);
  });

  it("does not flag dist-free commands at the string level", () => {
    expect(isDistDependentVerifyCommand("npm run check")).toBe(false);
    expect(isDistDependentVerifyCommand("npx vitest run tests/foo.test.ts")).toBe(false);
    // 'redistribute' must not match the dist token.
    expect(isDistDependentVerifyCommand("node scripts/redistribute.mjs")).toBe(false);
  });

  it("flags a command whose named test FILE imports or spawns dist (content scan)", () => {
    const root = mkdtempSync(join(tmpdir(), "distdep-"));
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(
      join(root, "tests", "spawns-dist.test.mjs"),
      `import { spawnSyncHidden } from "../helpers/spawn.mjs";\n` +
        `const entry = new URL("../../dist/audit/index.js", import.meta.url);\n`,
    );
    writeFileSync(
      join(root, "tests", "joins-dist.test.mjs"),
      `import { join } from "node:path";\nconst entry = join(root, "dist", "audit", "index.js");\n`,
    );
    writeFileSync(
      join(root, "tests", "clean.test.mjs"),
      `import { expect, it } from "vitest";\nit("x", () => expect(1).toBe(1));\n`,
    );
    expect(
      isDistDependentVerifyCommand("npx vitest run tests/spawns-dist.test.mjs", root),
    ).toBe(true);
    expect(
      isDistDependentVerifyCommand("npx vitest run tests/joins-dist.test.mjs", root),
    ).toBe(true);
    expect(isDistDependentVerifyCommand("npx vitest run tests/clean.test.mjs", root)).toBe(false);
    // A named file that does not exist in the tree cannot vouch either way.
    expect(isDistDependentVerifyCommand("npx vitest run tests/absent.test.mjs", root)).toBe(false);

    const partition = partitionDistDependentVerifyCommands(
      [
        "npm run check",
        "npx vitest run tests/spawns-dist.test.mjs",
        "npx vitest run tests/clean.test.mjs",
      ],
      root,
    );
    expect(partition.kept).toEqual(["npm run check", "npx vitest run tests/clean.test.mjs"]);
    expect(partition.deferred).toEqual(["npx vitest run tests/spawns-dist.test.mjs"]);
  });
});

// ---------------------------------------------------------------------------
// isWholeSuiteTestCommand — scope guard against whole-suite/directory verifies
// (the structural deadlock proven 2026-06-30: a per-node verify that runs the
// whole suite fails on a stale test owned by a different node).
// ---------------------------------------------------------------------------

describe("isWholeSuiteTestCommand", () => {
  it("flags whole-directory / whole-suite test runs", () => {
    expect(isWholeSuiteTestCommand("npx vitest run tests/remediate")).toBe(true);
    expect(isWholeSuiteTestCommand("vitest run tests/audit")).toBe(true);
    expect(isWholeSuiteTestCommand("npx vitest run")).toBe(true);
    expect(isWholeSuiteTestCommand("vitest")).toBe(true);
    expect(isWholeSuiteTestCommand("node --test tests/audit/")).toBe(true);
    expect(isWholeSuiteTestCommand("node --import tsx/esm --test tests/shared")).toBe(true);
  });

  it("keeps file-scoped test runs (a concrete .test.<ext> target)", () => {
    expect(isWholeSuiteTestCommand("npx vitest run tests/remediate/foo.test.ts")).toBe(false);
    expect(isWholeSuiteTestCommand("vitest run tests/remediate/foo.test.ts")).toBe(false);
    expect(isWholeSuiteTestCommand("node --test tests/audit/bar.test.mjs")).toBe(false);
    expect(isWholeSuiteTestCommand("node --import tsx/esm --test tests/audit/bar.test.mjs")).toBe(false);
  });

  it("does not flag non-test commands", () => {
    expect(isWholeSuiteTestCommand("npm run check")).toBe(false);
    expect(isWholeSuiteTestCommand("grep -c '/packages/' .gitignore")).toBe(false);
    expect(isWholeSuiteTestCommand("node scripts/whatever.mjs")).toBe(false);
  });

  it("a whole-suite command is build-free but must still be dropped from per-node verify", () => {
    // It passes the build-free gate (so the prior filter let it through)...
    expect(isBuildFreeVerifyCommand("npx vitest run tests/remediate")).toBe(true);
    // ...but the scope guard catches it.
    expect(isWholeSuiteTestCommand("npx vitest run tests/remediate")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// selfContainedVerifyCommands — drop a per-node verify command that references a
// SIBLING node's not-yet-created deliverable (the cross-node deadlock proven
// 2026-07-03: a node's targeted_command was `node scripts/remediate/verify-hosts.mjs`,
// another node's pending output → guaranteed-fail per-node verify).
// ---------------------------------------------------------------------------

describe("pathTokensInCommand", () => {
  it("extracts repo-relative path-like tokens (slash + extension)", () => {
    expect(pathTokensInCommand("node scripts/remediate/verify-hosts.mjs")).toEqual([
      "scripts/remediate/verify-hosts.mjs",
    ]);
    expect(pathTokensInCommand("npx vitest run tests/remediate/foo.test.ts")).toEqual([
      "tests/remediate/foo.test.ts",
    ]);
  });
  it("returns none for commands with no path tokens", () => {
    expect(pathTokensInCommand("npm run check")).toEqual([]);
    expect(pathTokensInCommand("vitest run")).toEqual([]);
  });
});

describe("selfContainedVerifyCommands", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = join(__dirname, `.tmp-selfcontained-${process.pid}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(tmp, "scripts"), { recursive: true });
    await writeFile(join(tmp, "scripts", "present.mjs"), "// present\n");
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("keeps a command referencing only the node's OWN declared path", () => {
    const cmds = selfContainedVerifyCommands(
      ["node scripts/remediate/verify-hosts.mjs"],
      ["scripts/remediate/verify-hosts.mjs"],
      tmp,
    );
    expect(cmds).toEqual(["node scripts/remediate/verify-hosts.mjs"]);
  });

  it("keeps a command whose path already exists in the tree", () => {
    const cmds = selfContainedVerifyCommands(["node scripts/present.mjs"], [], tmp);
    expect(cmds).toEqual(["node scripts/present.mjs"]);
  });

  it("drops a command referencing a sibling's not-yet-created deliverable", () => {
    // Not the node's own path and not present in the tree → cross-node deadlock.
    const cmds = selfContainedVerifyCommands(
      ["node scripts/remediate/verify-hosts.mjs"],
      ["src/remediate/steps/dispatch.ts"],
      tmp,
    );
    expect(cmds).toEqual([]);
  });

  it("keeps a path-free command (e.g. npm run check) unconditionally", () => {
    expect(selfContainedVerifyCommands(["npm run check"], [], tmp)).toEqual(["npm run check"]);
  });
});

// ---------------------------------------------------------------------------
// normalizeNodeTestCommand — inject the tsx loader into bare node --test
// ---------------------------------------------------------------------------

describe("normalizeNodeTestCommand — tsx loader for node:test (.mjs) verify", () => {
  it("injects --import tsx/esm into a bare node --test command", () => {
    expect(normalizeNodeTestCommand("node --test tests/audit/x.test.mjs")).toBe(
      "node --import tsx/esm --test tests/audit/x.test.mjs",
    );
    expect(
      normalizeNodeTestCommand("node --test tests/audit/a.test.mjs tests/audit/b.test.mjs"),
    ).toBe("node --import tsx/esm --test tests/audit/a.test.mjs tests/audit/b.test.mjs");
  });

  it("is idempotent — leaves a command that already carries a loader untouched", () => {
    const already = "node --import tsx/esm --test tests/audit/x.test.mjs";
    expect(normalizeNodeTestCommand(already)).toBe(already);
    const loader = "node --loader tsx/esm --test tests/audit/x.test.mjs";
    expect(normalizeNodeTestCommand(loader)).toBe(loader);
  });

  it("leaves non-node-test commands alone", () => {
    expect(normalizeNodeTestCommand("npm run check")).toBe("npm run check");
    expect(normalizeNodeTestCommand("npx vitest run tests/foo.test.ts")).toBe(
      "npx vitest run tests/foo.test.ts",
    );
    // `node` without `--test` (e.g. a script run) is not a node:test invocation.
    expect(normalizeNodeTestCommand("node scripts/seed.mjs")).toBe("node scripts/seed.mjs");
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

describe("adjudicateWriteScope — git-actual edits, unowned-grant + seam-block (no self-report)", () => {
  const root = "/repo";
  const scopes = [
    { block_id: "A", write_paths: ["src/a.ts"] },
    { block_id: "B", write_paths: ["src/b.ts"] },
  ];

  it("does not block an edit inside the node's own declared scope", () => {
    const edited: GitEditedFiles = { available: true, files: new Set(["src/a.ts"]) };
    expect(adjudicateWriteScope(scopes, "A", edited, root)).toEqual({ blocked: false });
  });

  it("GRANTS an edit to an UNOWNED file no sibling declared (the defect-1 fix): not blocked", () => {
    // src/util.ts is in no block's declared scope → unowned → granted, even though
    // node A's declared scope (src/a.ts) does not list it and the worker reported nothing.
    const edited: GitEditedFiles = { available: true, files: new Set(["src/a.ts", "src/util.ts"]) };
    expect(adjudicateWriteScope(scopes, "A", edited, root)).toEqual({ blocked: false });
  });

  it("BLOCKS (seam conflict) an edit to a file in another block's declared scope", () => {
    // Node A edits src/b.ts, which block B owns → seam conflict, not a silent grant.
    const edited: GitEditedFiles = { available: true, files: new Set(["src/a.ts", "src/b.ts"]) };
    const decision = adjudicateWriteScope(scopes, "A", edited, root);
    expect(decision.blocked).toBe(true);
    expect(decision.reason).toMatch(/seam conflict/i);
    expect(decision.reason).toContain("src/b.ts owned by B");
  });

  it("grants an empty-declared-scope node's real edits (matches the rolling default where scope is derived empty)", () => {
    const emptyScopes = [{ block_id: "A", write_paths: [] }];
    const edited: GitEditedFiles = { available: true, files: new Set(["src/x.ts", "tests/x.test.mjs"]) };
    expect(adjudicateWriteScope(emptyScopes, "A", edited, root)).toEqual({ blocked: false });
  });

  it("normalises absolute declared paths so ownership compares like-for-like", () => {
    const absScopes = [
      { block_id: "A", write_paths: [`${root}/src/a.ts`] },
      { block_id: "B", write_paths: [`${root}/src/b.ts`] },
    ];
    const edited: GitEditedFiles = { available: true, files: new Set(["src/b.ts"]) };
    const decision = adjudicateWriteScope(absScopes, "A", edited, root);
    expect(decision.blocked).toBe(true);
    expect(decision.reason).toContain("owned by B");
  });

  it("fails closed when git could not be probed (no ground truth)", () => {
    const edited: GitEditedFiles = { available: false, reason: "probe_failed", error: "boom" };
    expect(adjudicateWriteScope(scopes, "A", edited, root).blocked).toBe(true);
  });
});

describe("verifyCommandsForEdits — derive per-node verify from touched tests (defect-2 fix)", () => {
  it("always typechecks and that command is build-free", () => {
    const cmds = verifyCommandsForEdits([]);
    expect(cmds).toEqual(["npm run check"]);
    expect(isBuildFreeVerifyCommand(cmds[0])).toBe(true);
  });

  it("runs a touched .mjs vitest file via `vitest run <file>` (no build), not the whole suite", () => {
    const cmds = verifyCommandsForEdits(["src/audit/cli/x.ts", "tests/audit/x.test.mjs"]);
    expect(cmds).toEqual([
      "npm run check",
      "npx vitest run tests/audit/x.test.mjs",
    ]);
    cmds.forEach((c) => expect(isBuildFreeVerifyCommand(c)).toBe(true));
  });

  it("runs a touched .ts vitest file via `vitest run <file>`", () => {
    const cmds = verifyCommandsForEdits(["tests/remediate/y.test.ts"]);
    expect(cmds).toEqual(["npm run check", "npx vitest run tests/remediate/y.test.ts"]);
    cmds.forEach((c) => expect(isBuildFreeVerifyCommand(c)).toBe(true));
  });

  it("groups ALL touched test files (.mjs + .ts) into one vitest run; ignores non-test edits; normalises separators", () => {
    const cmds = verifyCommandsForEdits([
      "tests\\audit\\b.test.mjs",
      "tests/audit/a.test.mjs",
      "src/x.ts",
      "tests/remediate/c.test.ts",
      "docs/readme.md",
    ]);
    expect(cmds).toEqual([
      "npm run check",
      "npx vitest run tests/audit/a.test.mjs tests/audit/b.test.mjs tests/remediate/c.test.ts",
    ]);
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
