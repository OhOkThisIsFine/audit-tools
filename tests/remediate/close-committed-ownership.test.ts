import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSyncHidden as execFileSync } from "../helpers/spawn.mjs";
import { scratchDir } from "../helpers/scratch.js";
import { runClosePhase } from "../../src/remediate/phases/close.js";
import { makeState } from "./test-helpers.js";
import { canonicalPlanFixture, canonicalUnitFixture, writeApprovedPlanFixture } from "./helpers/canonicalPlanFixture.js";

const root = scratchDir("close-committed-ownership");
const artifactsDir = join(root, ".audit-tools", "remediation");
const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const source = "src/a.ts";

beforeEach(async () => {
  await mkdir(artifactsDir, { recursive: true });
  await mkdir(join(root, "src"));
  git("init"); git("config", "core.autocrlf", "false");
  git("config", "user.name", "Test"); git("config", "user.email", "test@example.com");
  await writeFile(join(root, ".gitignore"), ".audit-tools/*\n!.audit-tools/remediation-report.md\n!.audit-tools/remediation-outcomes.json\n");
  await writeFile(join(root, source), "baseline A\n");
  git("add", "."); git("commit", "-m", "baseline A");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function preparedState() {
  const unit = canonicalUnitFixture("U1");
  const state = makeState({ status: "closing", run_start_dirty: [], applied_edit_surface: [source],
    closing_plan: { action: "commit", pre_authorized: true },
    plan: canonicalPlanFixture({ units: [unit], requirements: [{ id: "REQ-U1", description: "Fix A", source_finding_ids: [], change_kind: "structural", assertions: [], inapplicable_reason: "This fixture isolates closing ownership" }], candidate_closing_actions: ["commit"] }),
    items: { U1: { unit_id: "U1", status: "resolved" } },
  });
  await writeApprovedPlanFixture(artifactsDir, state, root);
  return state;
}

describe("authorized close respects accepted commit ownership", () => {
  it.each([false, true])("leaves owner restoration of reviewed bytes untouched (staged=%s) while committing deliverables", async (staged) => {
    const state = await preparedState();
    await writeFile(join(root, source), "accepted remediation B\n");
    git("add", source); git("commit", "-m", "accepted remediation B");
    const accepted = git("rev-parse", "HEAD");
    Object.assign(state.items!.U1, { host_landed_commit: accepted, host_landed_files: [source] });
    // Restoring reviewed A is legitimate owner dirt; the context guard sees
    // its original premises, so this reaches the real default close staging.
    await writeFile(join(root, source), "baseline A\n");
    if (staged) git("add", source);
    await writeFile(join(root, ".audit-tools", "remediation-report.md"), "promoted run deliverable\n");

    const next = await runClosePhase(state, { root, artifactsDir, skipFinalGate: true });
    expect(next.status).toBe("complete");
    expect(git("show", `HEAD:${source}`)).toBe("accepted remediation B");
    expect(await readFile(join(root, source), "utf8")).toBe("baseline A\n");
    expect(git("diff", "--cached", "--name-only")).toBe(staged ? source : "");
    if (staged) expect(git("show", `:${source}`)).toBe("baseline A");
    else expect(git("diff", "--name-only")).toContain(source);
    const report = JSON.parse(await readFile(join(root, ".audit-tools", "remediation-outcomes.json"), "utf8"));
    expect(report.closing_result.leftover_files).toContain(source);
    expect(git("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD")).toBe(".audit-tools/remediation-report.md");
  });

  it("preserves an uncorroborated hand-applied manifest surface", async () => {
    await writeFile(join(root, source), "hand-applied run edit\n");
    const state = await preparedState();
    await runClosePhase(state, { root, artifactsDir, skipFinalGate: true });
    expect(git("show", `HEAD:${source}`)).toBe("hand-applied run edit");
    expect(git("diff", "--name-only")).toBe("");
  });

  it("retains two accepted sequential same-path units while leaving later owner dirt", async () => {
    const state = await preparedState();
    const unit = canonicalUnitFixture("U2", { dependencies: ["U1"] });
    state.plan!.units.push(unit);
    state.plan!.requirements.push({ id: "REQ-U2", description: "Follow-up A", source_finding_ids: [], change_kind: "structural", assertions: [], inapplicable_reason: "This fixture isolates closing ownership" });
    state.items!.U2 = { unit_id: "U2", status: "resolved" };
    await writeApprovedPlanFixture(artifactsDir, state, root);
    for (const id of ["U1", "U2"]) {
      await writeFile(join(root, source), `accepted ${id}\n`);
      git("add", source); git("commit", "-m", `accepted ${id}`);
      Object.assign(state.items![id], { host_landed_commit: git("rev-parse", "HEAD"), host_landed_files: [source] });
    }
    const accepted = git("rev-parse", "HEAD");
    await writeFile(join(root, source), "baseline A\n");
    const next = await runClosePhase(state, { root, artifactsDir, skipFinalGate: true });
    expect(next.status).toBe("complete");
    expect(next.items!.U1.host_landed_commit).not.toBe(next.items!.U2.host_landed_commit);
    expect(git("rev-parse", "HEAD")).toBe(accepted);
    expect(git("show", `HEAD:${source}`)).toBe("accepted U2");
    expect(await readFile(join(root, source), "utf8")).toBe("baseline A\n");
  });

  it("keeps arbitrary later owner edits behind the existing reviewed-context guard", async () => {
    const state = await preparedState();
    await writeFile(join(root, source), "accepted B\n");
    git("add", source); git("commit", "-m", "accepted B");
    const accepted = git("rev-parse", "HEAD");
    Object.assign(state.items!.U1, { host_landed_commit: accepted, host_landed_files: [source] });
    await writeFile(join(root, source), "arbitrary owner C\n");
    await expect(runClosePhase(state, { root, artifactsDir, skipFinalGate: true })).rejects.toThrow(/Reviewed repository context changed/);
    expect(git("rev-parse", "HEAD")).toBe(accepted);
    expect(git("diff", "--cached", "--name-only")).toBe("");
  });

  it("rechecks ownership when an owner edit arrives after the final authority probe", async () => {
    const state = await preparedState();
    await writeFile(join(root, source), "accepted B\n");
    git("add", source); git("commit", "-m", "accepted B");
    const accepted = git("rev-parse", "HEAD");
    Object.assign(state.items!.U1, { host_landed_commit: accepted, host_landed_files: [source] });
    state.closing_plan!.pre_authorized = false;
    const preview = await runClosePhase(state, { root, artifactsDir, skipFinalGate: true });
    expect(preview.closing_plan!.closing_action_preview!.files).toEqual([]);
    state.closing_plan!.pre_authorized = true;
    const log = vi.spyOn(console, "log").mockImplementation((message) => {
      if (message === "Executing closing action: commit") writeFileSync(join(root, source), "late owner C\n");
    });
    try { await runClosePhase(state, { root, artifactsDir, skipFinalGate: true }); }
    finally { log.mockRestore(); }
    expect(git("rev-parse", "HEAD")).toBe(accepted);
    expect(await readFile(join(root, source), "utf8")).toBe("late owner C\n");
    expect(git("diff", "--cached", "--name-only")).toBe("");
  });

  it("preserves an owner deletion of an accepted new file and unrelated staged work", async () => {
    git("rm", source); git("commit", "-m", "baseline A has no source file");
    const state = await preparedState();
    // Original and current reviewed context both observe an absent file, so
    // authority remains valid without renewing or weakening its approval.
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, source), "accepted newly created B\n");
    git("add", source); git("commit", "-m", "accepted new source file B");
    Object.assign(state.items!.U1, { host_landed_commit: git("rev-parse", "HEAD"), host_landed_files: [source] });
    await rm(join(root, source));
    await writeFile(join(root, "owner-note.txt"), "unrelated staged owner work\n");
    git("add", "owner-note.txt");
    await writeFile(join(root, ".audit-tools", "remediation-report.md"), "promoted run deliverable\n");

    const next = await runClosePhase(state, { root, artifactsDir, skipFinalGate: true });
    expect(next.status).toBe("complete");
    expect(git("ls-tree", "--name-only", "HEAD", "--", source)).toBe(source);
    expect(git("show", `HEAD:${source}`)).toBe("accepted newly created B");
    await expect(readFile(join(root, source))).rejects.toThrow(/ENOENT/);
    expect(git("diff", "--cached", "--name-only")).toBe("owner-note.txt");
    expect(git("show", ":owner-note.txt")).toBe("unrelated staged owner work");
    expect(git("diff", "--name-only")).toContain(source);
    expect(git("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD")).toBe(".audit-tools/remediation-report.md");
    const report = JSON.parse(await readFile(join(root, ".audit-tools", "remediation-outcomes.json"), "utf8"));
    expect(report.closing_result.leftover_files).toEqual(["owner-note.txt", source]);
  });
});
