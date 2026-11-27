import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cp, mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RemediationState } from "../../src/remediate/state/store.js";
import { REMEDIATION_STATE_CONTRACT_VERSION, StateStore } from "../../src/remediate/state/store.js";
import { admitRemediationDirtyBaseline, RemediationDirtyBaselineError } from "../../src/remediate/state/dirtyBaseline.js";
import { attributeGateRed } from "../../src/remediate/steps/gateCommands.js";
import { writeFinalGateRedRecord, finalGateRecordPath } from "../../src/remediate/steps/finalGate.js";
import { runCloseAcceptance } from "../../src/remediate/phases/closeAcceptance.js";
import { executeClosingAction, runClosePhase, collectStagingFiles } from "../../src/remediate/phases/close.js";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import { precomputeRecoveryTestVerdicts, prepareRemediationHostHandoff, ingestRemediationHostResults } from "../../src/remediate/steps/dispatch/hostHandoff.js";
import { corroborateHostResult, corroborateNoChangeClaim } from "../../src/remediate/steps/dispatch/hostCorroboration.js";
import { canonicalPlanFixture } from "./helpers/canonicalPlanFixture.js";
import { cleanupHostHandoffFixtures, fixture, boundState, git, resultFor, decisionFor, writeResult, COUNTER_TEST, counterRuns, recoveryOptions } from "./helpers/hostHandoffCorroborationFixture.js";
import type { CurrentRemediationHostState, RemediationHostResult, RemediationHostWorkItem } from "../../src/remediate/steps/dispatch/hostContracts.js";
import { DirtyPathDiscoveryError } from "audit-tools/shared";

// The closing command seam is inert, including every unsafe unscoped commit.
// Git queries in the production shared path reader still use the real runner.
const closingCommands = vi.hoisted(() => [] as string[][]);
vi.mock("audit-tools/shared", async (original) => {
  const actual = await original<typeof import("audit-tools/shared")>();
  return {
    ...actual,
    runTrackedAsync: vi.fn(async (...args: Parameters<typeof actual.runTrackedAsync>) => {
      const argv = args[0];
      if ((argv[0] === "git" && ["add", "rm", "commit", "push", "tag"].includes(argv[1] ?? "")) || argv[0] === "gh" || argv[0] === "npm") {
        closingCommands.push([...argv]);
        return { status: 0, stdout: "", stderr: "", argv: [...argv], duration_ms: 0 };
      }
      return actual.runTrackedAsync(...args);
    }),
  };
});
const roots: string[] = [];
async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "dirty-baseline-authority-"));
  roots.push(root);
  return root;
}
const marked = { run_start_dirty: [] as string[], run_start_dirty_encoding: "git-z/v1" as const };
afterEach(async () => {
  closingCommands.length = 0;
  vi.restoreAllMocks();
  await cleanupHostHandoffFixtures();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const invalidBaselines = [
  {}, { run_start_dirty: [] }, { run_start_dirty: ["old.ts"] },
  { run_start_dirty_encoding: "git-z/v1" },
  { run_start_dirty: [1], run_start_dirty_encoding: "git-z/v1" },
  { run_start_dirty: [], run_start_dirty_encoding: "unknown" },
];

describe("historical dirty baseline admission", () => {
  it("preserves the original array and every exact spelling", () => {
    const paths = [" z ", "line\nname", "back\\slash", "é", " z "];
    expect(admitRemediationDirtyBaseline({ ...marked, run_start_dirty: paths })).toBe(paths);
    expect(admitRemediationDirtyBaseline(marked)).toBe(marked.run_start_dirty);
  });
  it.each(invalidBaselines)("refuses unsupported authority %j without repair", value => {
    expect(() => admitRemediationDirtyBaseline(value)).toThrow(RemediationDirtyBaselineError);
  });
  it("keeps legacy diagnostic reads legal but rejects bad markers and malformed arrays", async () => {
    const root = await temporaryRoot();
    const store = new StateStore(root);
    await writeFile(join(root, "state.json"), JSON.stringify({ status: "complete" }));
    expect(await store.loadState()).toEqual({ status: "complete" });
    for (const value of invalidBaselines.slice(3)) {
      await writeFile(join(root, "state.json"), JSON.stringify({ status: "complete", ...value }));
      await expect(store.loadState()).rejects.toThrow(/schema validation/);
    }
  });
  it.each([{ paths: [] }, { paths: [" pre-existing.ts "] }])("admits a marked baseline for the no-action close: %j", async ({ paths }) => {
    const state: RemediationState = { status: "closing", run_start_dirty: paths, run_start_dirty_encoding: "git-z/v1", closing_plan: { action: "none" } };
    await expect(executeClosingAction(state, { root: "/unused", artifactsDir: "/unused" })).resolves.toMatchObject({ action: "none", status: "skipped" });
  });
  it.each(invalidBaselines)("refuses all direct closing actions before any command %j", async baseline => {
    for (const action of ["none", "commit", "push", "open-pr", "publish", "tag", "custom"] as const) {
      const state = { status: "closing", closing_plan: { action, pre_authorized: true, custom_command: ["npm", "publish"] }, ...baseline } as RemediationState;
      await expect(executeClosingAction(state, { root: "/unused", artifactsDir: "/unused" })).rejects.toThrow(RemediationDirtyBaselineError);
      await expect(runClosePhase(state, { root: "/unused", artifactsDir: "/unused" })).rejects.toThrow(RemediationDirtyBaselineError);
    }
    expect(closingCommands).toEqual([]);
  });
  it.each(invalidBaselines)("refuses gate authority even with landed surface and no failing command %j", async baseline => {
    const root = await temporaryRoot();
    const state = { status: "complete", applied_edit_surface: ["own.ts"], ...baseline } as RemediationState;
    await expect(attributeGateRed({ root, state, output: "" })).rejects.toThrow(RemediationDirtyBaselineError);
    await expect(writeFinalGateRedRecord(root, "test", undefined, { root, state })).rejects.toThrow(RemediationDirtyBaselineError);
    const runCombined = vi.fn();
    await expect(runCloseAcceptance({ state, options: { root, artifactsDir: root, skipFinalGate: true }, runCombined })).rejects.toThrow(RemediationDirtyBaselineError);
    expect(runCombined).not.toHaveBeenCalled();
    expect(existsSync(finalGateRecordPath(root))).toBe(false);
  });
  it("propagates discovery refusal through both attribution boundaries without a replacement record", async () => {
    const root = await temporaryRoot();
    await expect(attributeGateRed({ root, state: marked, output: "FAIL own.ts" })).rejects.toThrow(DirtyPathDiscoveryError);
    const before = await import("node:fs/promises").then(fs => fs.readdir(root));
    await expect(writeFinalGateRedRecord(root, "test", { argv: ["test"], passed: false, exit_code: 1, layer: "unit", stdout_tail: "FAIL own.ts" }, { root, state: marked })).rejects.toThrow(DirtyPathDiscoveryError);
    expect(await import("node:fs/promises").then(fs => fs.readdir(root))).toEqual(before);
    await expect(writeFinalGateRedRecord(root, "diagnostic", undefined)).resolves.toEqual(expect.any(String));
  });
});

describe("locked resume admission", () => {
  it.each([
    { verificationCommand: "node -e 0" }, { guidanceText: "new guidance" }, { planOnly: true }, {},
  ])("refuses a legacy run before reconciliation or saves: %j", async options => {
    const root = await temporaryRoot();
    const artifactsDir = join(root, ".audit-tools", "remediation");
    await mkdir(artifactsDir, { recursive: true });
    const state: RemediationState = { status: "pending", plan: canonicalPlanFixture(), items: {} };
    const bytes = JSON.stringify(state);
    await writeFile(join(artifactsDir, "state.json"), bytes);
    const reconcile = vi.spyOn(StateStore.prototype, "reconcileDecisionApplications");
    const save = vi.spyOn(StateStore.prototype, "saveState");
    await expect(decideNextStep({ root, artifactsDir, ...options })).rejects.toThrow(RemediationDirtyBaselineError);
    expect(reconcile).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(await readFile(join(artifactsDir, "state.json"), "utf8")).toBe(bytes);
  });
  it("uses the locked fresh state rather than a marked diagnostic entry read", async () => {
    const root = await temporaryRoot();
    const artifactsDir = join(root, ".audit-tools", "remediation");
    await mkdir(artifactsDir, { recursive: true });
    vi.spyOn(StateStore.prototype, "loadState")
      .mockResolvedValueOnce({ status: "pending", ...marked })
      .mockResolvedValueOnce({ status: "pending" });
    const reconcile = vi.spyOn(StateStore.prototype, "reconcileDecisionApplications");
    await expect(decideNextStep({ root, artifactsDir })).rejects.toThrow(RemediationDirtyBaselineError);
    expect(reconcile).not.toHaveBeenCalled();
  });
  it("allows bare legacy complete presentation without changing state or reconciling cleanup", async () => {
    const root = await temporaryRoot();
    const artifactsDir = join(root, ".audit-tools", "remediation");
    await mkdir(artifactsDir, { recursive: true });
    const bytes = JSON.stringify({ status: "complete", step_count: 9 });
    await writeFile(join(artifactsDir, "state.json"), bytes);
    const reconcile = vi.spyOn(StateStore.prototype, "reconcileDecisionApplications");
    const save = vi.spyOn(StateStore.prototype, "saveState");
    expect((await decideNextStep({ root, artifactsDir })).step_kind).toBe("present_report");
    expect(reconcile).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(await readFile(join(artifactsDir, "state.json"), "utf8")).toBe(bytes);
  });
  it.each([{ forceReplan: true }, { verificationCommand: "node -e 0" }, { planOnly: true }, { guidanceText: "" }, { input: [] }, { severity: [] }, { findingIds: [] }, { finalizeClosing: true }, { guidanceFileSupplied: true }])("complete with authority input still refuses %j", async options => {
    const root = await temporaryRoot();
    const artifactsDir = join(root, ".audit-tools", "remediation");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(join(artifactsDir, "state.json"), JSON.stringify({ status: "complete" }));
    await expect(decideNextStep({ root, artifactsDir, ...options })).rejects.toThrow(RemediationDirtyBaselineError);
  });
});

// The production readers see a real nested Git repository and a tracked gitlink.
// Seed child history once; copy it into isolated working trees instead of
// invoking Git's submodule clone machinery before every corroboration case.
let childSeed: Promise<{ root: string; commit: string }> | undefined;
let childSeedRoot: string | undefined;
afterAll(async () => {
  if (childSeedRoot) await rm(childSeedRoot, { recursive: true, force: true });
});

async function seedChild() {
  const root = await mkdtemp(join(tmpdir(), "dirty-baseline-child-seed-"));
  childSeedRoot = root;
  git(root, ["init"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  await writeFile(join(root, "tracked.ts"), "before\n");
  git(root, ["add", "tracked.ts"]);
  git(root, ["commit", "-m", "child baseline"]);
  return { root, commit: git(root, ["rev-parse", "HEAD"]) };
}

async function addSubmodule(root: string): Promise<void> {
  const child = await (childSeed ??= seedChild());
  await cp(child.root, join(root, "sub"), { recursive: true });
  await writeFile(join(root, ".gitmodules"), '[submodule "sub"]\n\tpath = sub\n\turl = ./sub\n');
  git(root, ["add", ".gitmodules"]);
  git(root, ["update-index", "--add", "--cacheinfo", "160000," + child.commit + ",sub"]);
  git(root, ["commit", "-m", "add child"]);
  git(root, ["config", "submodule.sub.ignore", "all"]);
}

describe("host authority and superproject visibility", () => {
  it.each(invalidBaselines)("refuses direct current-shape host entry points %j", async baseline => {
    // These entry points must refuse before an approved plan, handoff or Git
    // repository is needed; a full handoff fixture obscures that boundary.
    const root = await temporaryRoot();
    const state = { contract_version: REMEDIATION_STATE_CONTRACT_VERSION,
      status: "implementing", plan: canonicalPlanFixture(), items: {}, ...baseline } as CurrentRemediationHostState;
    const params = { root, artifactsDir: join(root, ".audit-tools"), runId: "no-admitted-baseline", state };
    const commit = "1".repeat(40);
    await expect(prepareRemediationHostHandoff({ ...params, baselineCommit: commit })).rejects.toThrow(RemediationDirtyBaselineError);
    await expect(precomputeRecoveryTestVerdicts(params)).rejects.toThrow(RemediationDirtyBaselineError);
    await expect(ingestRemediationHostResults(params)).rejects.toThrow(RemediationDirtyBaselineError);
    await expect(corroborateHostResult({ root, state, workItem: { baseline_commit: commit } as RemediationHostWorkItem,
      result: { landed_commit: commit } as RemediationHostResult, verdicts: null, recovery: false })).rejects.toThrow(RemediationDirtyBaselineError);
    expect(await readdir(root)).toEqual([]);
  });
  it.each(["tracked", "untracked", "committed", "index cancellation"])("refuses a false no-change claim despite ignore=all: %s", async mode => {
    const f = await fixture({ requiredTest: COUNTER_TEST, allowedFiles: ["src/a.ts", "sub/tracked.ts"], beforePrepare: addSubmodule });
    if (mode === "untracked") await writeFile(join(f.root, "sub", "new.ts"), "new\n");
    else if (mode === "index cancellation") {
      const path = join(f.root, "src", "a.ts");
      const old = await readFile(path, "utf8");
      await writeFile(path, "staged\n"); git(f.root, ["add", "src/a.ts"]); await writeFile(path, old);
    } else {
      await writeFile(join(f.root, "sub", "tracked.ts"), "after\n");
      if (mode === "committed") {
        git(join(f.root, "sub"), ["commit", "-am", "child change"]);
        git(f.root, ["add", "sub"]); git(f.root, ["commit", "-m", "land gitlink"]);
      }
    }
    if (mode === "tracked") {
      // Keep one end-to-end refusal to pin wiring into normal ingestion.
      await writeResult(f, decisionFor(f, { status: "resolved_no_change", evidence: ["Claimed no change"] }));
      const result = await ingestRemediationHostResults({ root: f.root, artifactsDir: f.artifactsDir, runId: f.runId, state: boundState(f) });
      expect(result).toMatchObject({ accepted_count: 0, issues: expect.arrayContaining([
        expect.objectContaining({ code: "changed_files_mismatch", check: "no_change_corroboration" }),
      ]) });
      expect(existsSync(join(f.root, ".counter"))).toBe(false);
    } else {
      // The other cases exercise distinct Git queries, not different intake.
      await expect(corroborateNoChangeClaim({ root: f.root, workItem: f.item,
        excusedPaths: new Set(f.state.run_start_dirty) })).resolves.toMatchObject({
        ok: false, code: "changed_files_mismatch", check: "no_change_corroboration",
      });
    }
  });
  it("characterizes the retained already-excused gitlink ambiguity without claiming descendant protection", async () => {
    const f = await fixture({ requiredTest: COUNTER_TEST, beforePrepare: addSubmodule, runStartDirty: ["sub"] });
    await writeFile(join(f.root, "sub", "tracked.ts"), "later child edit\n");
    expect(await corroborateNoChangeClaim({ root: f.root, workItem: f.item, excusedPaths: new Set(f.state.run_start_dirty) })).toEqual({ ok: true });
  });
  // Exercise all three Git/authority outcomes at their shared boundary. The two
  // public lanes need witnesses for their distinct wiring, not a cross-product.
  it.each([
    { mode: "scope", lane: "direct" }, { mode: "overlap", lane: "direct" }, { mode: "accepted", lane: "direct" },
    { mode: "scope", lane: "normal" }, { mode: "overlap", lane: "recovery" },
  ])("sees committed gitlinks before landed-result tests: $mode/$lane", async ({ mode, lane }) => {
    const f = await fixture({ requiredTest: COUNTER_TEST, beforePrepare: addSubmodule, allowedFiles: mode === "scope" ? ["src/a.ts"] : ["src/a.ts", "sub"], runStartDirty: mode === "overlap" ? ["sub"] : [] });
    await writeFile(join(f.root, "sub", "tracked.ts"), "after\n");
    git(join(f.root, "sub"), ["commit", "-am", "child change"]);
    await writeFile(join(f.root, "src", "a.ts"), "export const value = 2;\n");
    git(f.root, ["add", "sub", "src/a.ts"]); git(f.root, ["commit", "-m", "land changes"]);
    const landed = git(f.root, ["rev-parse", "HEAD"]);
    if (lane !== "direct") {
      await writeResult(f, resultFor(f, landed));
      const recovery = lane === "recovery" ? await recoveryOptions(f) : undefined;
      const ingested = await ingestRemediationHostResults({ root: f.root, artifactsDir: f.artifactsDir, runId: f.runId, state: boundState(f), ...(recovery ? { recovery } : {}) });
      expect(ingested).not.toBe("unsupported_retired_state");
      if (ingested === "unsupported_retired_state") return;
      expect(ingested.accepted_count).toBe(mode === "accepted" ? 1 : 0);
      if (mode !== "accepted") {
        expect(ingested.issues.some(issue => issue.code === (mode === "scope" ? "changed_files_mismatch" : "run_start_dirty_overlap"))).toBe(true);
        expect(ingested.state.items[f.item.id]?.status).toBe("pending");
      }
      expect(await counterRuns(f.root)).toBe(lane === "recovery" || mode === "accepted" ? 1 : 0);
      return;
    }
    const result = await corroborateHostResult({ root: f.root, state: boundState(f), workItem: f.item, result: resultFor(f, landed) as unknown as RemediationHostResult, verdicts: null, recovery: false });
    if (mode === "accepted") {
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.changedFiles).toEqual(["src/a.ts", "sub"]);
      expect(await counterRuns(f.root)).toBe(1);
    } else {
      expect(result).toMatchObject({ ok: false, code: mode === "scope" ? "changed_files_mismatch" : "run_start_dirty_overlap" });
      expect(existsSync(join(f.root, ".counter"))).toBe(false);
    }
  });
});

describe("closing selection and inert whole-index proof", () => {
  it("retains exact native spelling despite quoted Git display", async () => {
    const root = await temporaryRoot(); git(root, ["init"]);
    const names = [
      "plain.ts", "unicode-é.ts",
      ...(process.platform === "win32"
        ? ["space name.ts", "single'quote.ts"]
        : ['quote".ts', "line\nname.ts"]),
    ];
    for (const name of names) await writeFile(join(root, name), "content\n");

    const displayed = git(root, [
      "-c", "core.quotepath=true", "status",
      "--porcelain=v1", "--untracked-files=all",
    ]);
    expect(displayed).toContain('?? "unicode-\\303\\251.ts"');

    const selected = await collectStagingFiles(root, names);
    expect(selected.files).toEqual([...names].sort());
    expect(selected.leftover).toEqual([]);
  });
  it.skipIf(process.platform === "win32")("characterizes the existing whitespace/backslash manifest alias limitation", async () => {
    const root = await temporaryRoot(); git(root, ["init"]);
    const names = [" space.ts ", "back\\slash.ts"];
    for (const name of names) await writeFile(join(root, name), "content");
    // Discovery is lossless, but the pre-existing selector still aliases these
    // manifest keys. This is a retained limitation, not pathspec hardening.
    expect((await collectStagingFiles(root, ["space.ts", "back/slash.ts"])).files).toEqual(names);
  });
  it.for([false, true])("whole-index collision admits only the exact own set, foreign=%s", async (foreign, context) => {
    const root = await temporaryRoot();
    for (const name of ["Foo.ts", "foo.ts"]) await writeFile(join(root, name), "content\n");
    const entries = await readdir(root);
    if (!entries.includes("Foo.ts") || !entries.includes("foo.ts")) { context.skip(); return; }
    git(root, ["init"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "Test"]);
    git(root, ["commit", "--allow-empty", "-m", "baseline"]);
    if (foreign) await addSubmodule(root);
    git(root, ["add", "Foo.ts", "foo.ts"]);
    if (foreign) {
      await writeFile(join(root, "sub", "tracked.ts"), "after\n");
      git(join(root, "sub"), ["commit", "-am", "child change"]);
      git(root, ["add", "sub"]);
    }
    const state: RemediationState = { status: "closing", ...marked, applied_edit_surface: ["Foo.ts", "foo.ts"], closing_plan: { action: "commit", pre_authorized: true, closing_action_preview: { action: "commit", files: ["Foo.ts", "foo.ts"], commit_message: "inert" } } };
    const result = await executeClosingAction(state, { root, artifactsDir: join(root, ".audit-tools") });
    const commits = closingCommands.filter(argv => argv[1] === "commit");
    if (foreign) {
      expect(result.status).toBe("failed");
      expect(result.commands.some(command => command.stderr?.includes("outside this run: sub"))).toBe(true);
      expect(commits).toEqual([]);
    } else expect(commits).toEqual([["git", "commit", "-m", "inert"]]);
  });
});

describe("landed root and rename query contracts", () => {
  it("enumerates an authorized recovery landing that is a root commit", async () => {
    const f = await fixture({ requiredTest: COUNTER_TEST });
    const oldBranch = git(f.root, ["symbolic-ref", "--short", "HEAD"]);
    git(f.root, ["checkout", "--orphan", "independent-root"]);
    git(f.root, ["rm", "--cached", "-r", "."]);
    await writeFile(join(f.root, "src", "a.ts"), "export const value = 2;\n");
    git(f.root, ["add", "src/a.ts"]);
    git(f.root, ["commit", "-m", "root landing"]);
    git(f.root, ["branch", "-D", oldBranch]);
    const landed = git(f.root, ["rev-parse", "HEAD"]);
    expect(git(f.root, ["rev-list", "--parents", "-n", "1", landed])).toBe(landed);
    const result = await corroborateHostResult({ root: f.root, state: boundState(f), workItem: f.item,
      result: resultFor(f, landed) as unknown as RemediationHostResult, verdicts: null, recovery: true });
    expect(result).toMatchObject({ ok: true, usedRecovery: true, changedFiles: ["src/a.ts"] });
    expect(await counterRuns(f.root)).toBe(1);
  });

  it.each(["scope", "overlap", "accepted"])("retains both rename endpoints under configured detection: %s", async mode => {
    const f = await fixture({ requiredTest: COUNTER_TEST,
      allowedFiles: mode === "scope" ? ["src/renamed.ts"] : ["src/a.ts", "src/renamed.ts"],
      runStartDirty: mode === "overlap" ? ["src/a.ts"] : [],
      beforePrepare: root => { git(root, ["config", "diff.renames", "true"]); },
    });
    git(f.root, ["mv", "src/a.ts", "src/renamed.ts"]);
    git(f.root, ["commit", "-m", "rename source"]);
    const landed = git(f.root, ["rev-parse", "HEAD"]);
    const result = await corroborateHostResult({ root: f.root, state: boundState(f), workItem: f.item,
      result: resultFor(f, landed) as unknown as RemediationHostResult, verdicts: null, recovery: false });
    if (mode === "accepted") {
      expect(result).toMatchObject({ ok: true, changedFiles: ["src/a.ts", "src/renamed.ts"] });
      expect(await counterRuns(f.root)).toBe(1);
    } else {
      expect(result).toMatchObject({ ok: false, code: mode === "scope" ? "changed_files_mismatch" : "run_start_dirty_overlap" });
      expect(await counterRuns(f.root)).toBe(0);
    }
  });
});
