// sites-pinned: tests/remediate/execution-unit-runtime.test.ts, tests/remediate/wave-simplification.test.ts
import { join } from "node:path";
import { WaveSimplificationResponseSchema, type WaveSimplification } from "../state/types.js";
import { commandLeavesDeclaredShape, contentSha256, headCommit, readGitPathList, readOptionalJsonFile, runTrackedAsync, TRACKED_CHILD_DEADLINE_MS } from "audit-tools/shared";
import type { RemediationState } from "../state/store.js";
import { runRequiredTest } from "./dispatch/requiredTests.js";

export function waveResponsePath(artifactsDir: string, wave: WaveSimplification): string {
  return join(artifactsDir, "wave-simplification-" + wave.receipt + ".json");
}

async function gitLines(root: string, args: string[]): Promise<string[] | undefined> {
  const result = await runTrackedAsync(["git", ...args], { cwd: root, encoding: "utf8", timeout: TRACKED_CHILD_DEADLINE_MS });
  return result.status === 0 && !result.error ? result.stdout.trim().split(/\r?\n/).filter(Boolean) : undefined;
}

async function diffPaths(root: string, base: string, head: string, paths: string[] = []): Promise<string[] | undefined> {
  const listed = await readGitPathList(root, ["diff", "--name-only", "--no-renames", "--ignore-submodules=none", "-z", base, head, "--", ...paths.map(path => ":(literal)" + path)]);
  return listed.ok ? listed.paths : undefined;
}

/** Bind after the last accepted result, before persisting the same state that
 * retires the workload. An incomplete/crashed ingest cannot lose this debt. */
export async function bindWaveSimplification(root: string, state: RemediationState): Promise<void> {
  const handoff = state.host_handoff;
  if (!handoff || !state.plan) return;
  const unitIds = handoff.work_item_ids.filter(id => state.items?.[id]?.host_landed_commit);
  const landed = [...new Set(unitIds.map(id => state.items![id]!.host_landed_commit!))].sort();
  if (landed.length < 2) return; // zero/single landed changes are not a parallel integration
  const baseline = handoff.baseline_commit;
  const integrated = await headCommit(root);
  if (!integrated) throw new Error("Cannot identify the landed remediation wave's HEAD.");
  const range = baseline + ".." + integrated;
  const actualCommits = await gitLines(root, ["rev-list", "--no-merges", range, "--"]);
  const files = await diffPaths(root, baseline, integrated);
  const owned = new Set(unitIds.flatMap(id => state.items![id]!.host_landed_files ?? []));
  let problem = !actualCommits ? "Could not enumerate the integration commits."
    : actualCommits.length !== landed.length || actualCommits.some(id => !landed.includes(id))
      ? "The integration range contains unrelated commits; its combined diff was not reviewed."
      : !files ? "Could not enumerate the combined diff paths."
        : files.some(path => !owned.has(path)) ? "The combined diff has paths outside the accepted landed items: " +
          files.filter(path => !owned.has(path)).slice(0, 10).join(", ") : undefined;
  if (!problem) {
    const merges = await gitLines(root, ["rev-list", "--merges", range, "--"]);
    if (!merges) problem = "Could not verify merge commits in the integration range.";
    else if (merges.length > 0) {
      for (const id of unitIds) {
        const item = state.items![id]!;
        const paths = item.host_landed_files ?? [];
        if (paths.length === 0) continue;
        const divergence = await diffPaths(root, item.host_landed_commit!, integrated, paths);
        if (!divergence || divergence.length > 0) {
          problem = "Could not verify that merged bytes, file modes and deletions match the accepted landed paths for " + id + ".";
          break;
        }
      }
    }
  }
  if (!problem && files?.length === 0) return;
  const body = {
    revision: state.plan.review_revision_sha256, workload: handoff.workload_sha256,
    baseline, integrated, unit_ids: unitIds.sort(), landed, files: (problem ? [] : files ?? []).sort(),
    test_grants: unitIds.map(id => ({
      files: [...state.items![id]!.host_landed_files ?? []].sort(),
      commands: [...state.plan!.units.find(unit => unit.id === id)?.required_tests ?? []].sort(),
    })),
    ...(problem ? { problem } : {}),
  };
  const receipt = contentSha256(body);
  if (!state.wave_simplifications?.some(wave => wave.receipt === receipt)) {
    (state.wave_simplifications ??= []).push({ ...body, receipt });
  }
}

export function pendingWaveSimplification(state: RemediationState | null | undefined): WaveSimplification | undefined {
  return state?.wave_simplifications?.find(wave => wave.response === undefined);
}

export function waveWritablePaths(wave: WaveSimplification, state: RemediationState): string[] {
  if (wave.problem || state.conformance_review?.enabled) return [];
  return wave.files.filter(file => {
    const grants = wave.test_grants.filter(grant => grant.files.includes(file));
    return grants.length > 0 && grants.every(grant => grant.commands.length > 0);
  });
}

/** Reads an external review decision but accepts actions only against tool-
 * minted provenance. Neither an unavailable review nor a no-op mints a commit. */
export async function completeWaveSimplification(params: {
  root: string; artifactsDir: string; state: RemediationState; wave: WaveSimplification;
}): Promise<string | undefined> {
  const { root, artifactsDir, state, wave } = params;
  const { receipt, response: _response, applied_files: _files, ...body } = wave;
  if (receipt !== contentSha256(body) || wave.revision !== state.plan?.review_revision_sha256) {
    return "The wave receipt is not bound to this reviewed plan. Restore the bound state before continuing.";
  }
  let raw: unknown;
  try { raw = await readOptionalJsonFile<unknown>(waveResponsePath(artifactsDir, wave)); }
  catch { return "The returned wave review could not be read as JSON; correct the response file."; }
  if (raw === undefined) return "No wave review response has been returned yet.";
  const parsed = WaveSimplificationResponseSchema.safeParse(raw);
  if (!parsed.success || parsed.data.receipt !== receipt) return "The response is invalid or belongs to a different wave.";
  const result = parsed.data;
  const current = await headCommit(root);
  if (wave.problem && result.disposition !== "unavailable") return wave.problem;
  const waveFilesAreClean = async () => !wave.files.length ||
    (await gitLines(root, ["status", "--porcelain", "--untracked-files=all", "--", ...wave.files.map(path => ":(literal)" + path)]))?.length === 0;
  if (!(await waveFilesAreClean())) return "The wave's files have uncommitted or unverified edits; review the committed range only.";
  if (result.disposition === "applied") {
    if (state.conformance_review?.enabled) return "Independent conformance applies. Record a follow-up and put changes through the reviewed plan instead.";
    const writable = waveWritablePaths(wave, state);
    const [tip] = await gitLines(root, ["rev-list", "--parents", "-n", "1", "HEAD", "--"]) ?? [];
    if (current !== result.commit || tip !== result.commit + " " + wave.integrated) return "Apply one coordinator commit directly on the bound integration HEAD.";
    const changed = await diffPaths(root, wave.integrated, result.commit);
    if (!changed?.length || changed.some(path => !wave.files.includes(path))) return "The simplification commit is empty or extends outside the wave's verified files.";
    if (changed.some(path => !writable.includes(path))) return "An affected unit has no bound approved focused tests. Record a follow-up instead of applying an unverified commit.";
    const commands = [...new Set(wave.test_grants
      .filter(grant => grant.files.some(path => changed.includes(path))).flatMap(grant => grant.commands))].sort();
    for (const command of commands) {
      if (commandLeavesDeclaredShape(command)) return "A bound focused test is not a single eligible command.";
      const failure = await runRequiredTest(root, command);
      if (failure) return "The simplification did not pass its required focused test: " + command;
    }
    if ((await headCommit(root)) !== result.commit || !(await waveFilesAreClean())) return "The verified tree changed during focused tests; the simplification was not accepted.";
    wave.applied_files = changed;
  } else if (current !== wave.integrated) {
    return "HEAD is no longer the bound integration commit; do not attest a different diff.";
  }
  wave.response = result;
  return undefined;
}
