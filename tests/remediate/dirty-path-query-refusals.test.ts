import { afterEach, describe, expect, it, vi } from "vitest";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as tracked from "../../src/shared/tooling/exec.js";
import * as attribution from "../../src/remediate/steps/gateCommands.js";
import { writeFinalGateRedRecord } from "../../src/remediate/steps/finalGate.js";
import { corroborateHostResult, corroborateNoChangeClaim } from "../../src/remediate/steps/dispatch/hostCorroboration.js";
import { executeClosingAction } from "../../src/remediate/phases/close.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
import type { RemediationHostResult } from "../../src/remediate/steps/dispatch/hostContracts.js";
import { fixture, boundState, resultFor, landA, git, COUNTER_TEST, counterRuns, cleanupHostHandoffFixtures } from "./helpers/hostHandoffCorroborationFixture.js";

const requests = vi.hoisted(() => [] as string[][]);
vi.mock("audit-tools/shared", async original => {
  const actual = await original<typeof import("audit-tools/shared")>();
  return { ...actual, runTrackedAsync: vi.fn(async (...args: Parameters<typeof actual.runTrackedAsync>) => {
    const argv = args[0];
    if (argv[0] === "git" && ["add", "rm", "commit", "push"].includes(argv[1] ?? "") || argv[0] === "gh") {
      requests.push([...argv]);
      return { status: 0, stdout: "", stderr: "", argv: [...argv], duration_ms: 0 };
    }
    return actual.runTrackedAsync(...args);
  }) };
});
afterEach(async () => { vi.restoreAllMocks(); requests.length = 0; await cleanupHostHandoffFixtures(); });

const failures = ["nonzero", "null", "error-zero", "throw", "timeout", "overflow", "truncated", "empty-interior"] as const;
function failQuery(match: (argv: string[]) => boolean, failure: typeof failures[number]) {
  const real = tracked.runTrackedAsync;
  return vi.spyOn(tracked, "runTrackedAsync").mockImplementation(async (argv, options) => {
    if (!match(argv)) return real(argv, options);
    expect(options?.maxBuffer).toBe(64 * 1024 * 1024);
    if (failure === "throw") throw new Error("synthetic transport throw");
    const error = failure === "error-zero" || failure === "timeout" || failure === "overflow"
      ? Object.assign(new Error(failure), { code: failure === "timeout" ? "ETIMEDOUT" : "ENOBUFS" }) : undefined;
    return { argv, duration_ms: 0, status: failure === "nonzero" ? 1 : failure === "null" ? null : 0,
      stdout: failure === "truncated" ? "partial.ts" : failure === "empty-interior" ? "own.ts\0\0" : "partial.ts\0",
      stderr: "synthetic failure", ...(error ? { error } : {}) };
  });
}

describe("physical path authority adapters refuse incomplete queries", () => {
  it.each(failures)("landed paths refuse %s before required tests", async failure => {
    const f = await fixture({ requiredTest: COUNTER_TEST });
    const landed = await landA(f);
    failQuery(argv => argv[1] === "diff-tree", failure);
    const result = await corroborateHostResult({ root: f.root, state: boundState(f), workItem: f.item,
      result: resultFor(f, landed) as unknown as RemediationHostResult, verdicts: null, recovery: false });
    expect(result).toMatchObject({ ok: false, code: "landed_commit_invalid", check: "landed_commit" });
    expect(await counterRuns(f.root)).toBe(0);
  });
  it.each(failures.flatMap(failure => ["live", "committed"].map(leg => ({ failure, leg }))))("no-change refuses $leg/$failure", async ({ failure, leg }) => {
    const f = await fixture({ requiredTest: COUNTER_TEST });
    failQuery(argv => leg === "live" ? argv[2] === "status" : argv[1] === "diff", failure);
    const result = await corroborateNoChangeClaim({ root: f.root, workItem: f.item, excusedPaths: new Set(f.state.run_start_dirty) });
    expect(result).toMatchObject({ ok: false, code: "commit_missing", check: "no_change_corroboration" });
    if (!result.ok) expect(result.message).toMatch(/could not completely enumerate/);
  });
  it.for(failures)("whole-index proof refuses %s without requesting any commit", async (failure, context) => {
    const f = await fixture();
    for (const file of ["Foo.ts", "foo.ts"]) await writeFile(join(f.root, file), "content");
    const entries = await readdir(f.root);
    if (!entries.includes("Foo.ts") || !entries.includes("foo.ts")) { context.skip(); return; }
    git(f.root, ["add", "Foo.ts", "foo.ts"]);
    const spy = failQuery(argv => argv[1] === "diff" && argv[2] === "--cached", failure);
    const state: RemediationState = { status: "closing", run_start_dirty: [], run_start_dirty_encoding: "git-z/v1",
      applied_edit_surface: ["Foo.ts", "foo.ts"], closing_plan: { action: "commit", pre_authorized: true,
        closing_action_preview: { action: "commit", files: ["Foo.ts", "foo.ts"], commit_message: "inert" } } };
    const result = await executeClosingAction(state, { root: f.root, artifactsDir: f.artifactsDir });
    expect(result.status).toBe("failed");
    expect(result.commands.some(command => command.stderr?.includes("could not be listed to prove nothing else is staged"))).toBe(true);
    expect(requests.some(argv => ["commit", "push"].includes(argv[1] ?? "") || argv[0] === "gh")).toBe(false);
    const call = spy.mock.calls.find(([argv]) => argv[2] === "--cached");
    expect(call?.[0]).toEqual(["git", "diff", "--cached", "--name-only", "--no-renames", "--ignore-submodules=none", "-z"]);
    expect(call?.[1]).toMatchObject({ timeout: 3_600_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  });
  it("keeps the noncollision commit pathspec", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "own.ts"), "content");
    const state: RemediationState = { status: "closing", run_start_dirty: [], run_start_dirty_encoding: "git-z/v1",
      applied_edit_surface: ["own.ts"], closing_plan: { action: "commit", pre_authorized: true,
        closing_action_preview: { action: "commit", files: ["own.ts"], commit_message: "inert" } } };
    await executeClosingAction(state, { root: f.root, artifactsDir: f.artifactsDir });
    expect(requests.filter(argv => argv[1] === "commit")).toEqual([["git", "commit", "-m", "inert", "--", "own.ts"]]);
  });
  it("preserves unrelated attribution best-effort fallback", async () => {
    const f = await fixture();
    vi.spyOn(attribution, "attributeGateRed").mockRejectedValue(new Error("unrelated diagnostic failure"));
    await expect(writeFinalGateRedRecord(f.artifactsDir, "test", { argv: ["test"], layer: "unit", passed: false, exit_code: 1 },
      { root: f.root, state: boundState(f) })).resolves.toEqual(expect.any(String));
  });
});
