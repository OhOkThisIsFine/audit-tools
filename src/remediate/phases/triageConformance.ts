// sites-pinned: tests/remediate/phase-triage.test.ts, tests/remediate/host-handoff-corroboration-obligations.test.ts
import { join, relative } from "node:path";
import { z } from "zod";
import { readFile, readdir, lstat, readlink } from "node:fs/promises";
import { hashContent } from "../../shared/hash.js";
import { stableStringify } from "../../shared/stableStringify.js";
import { headCommit } from "../../shared/git.js";
import { AUDIT_TOOLS_DIRNAME, compareCodeUnits, contentSha256, readOptionalJsonFile, writeJsonFile, parseCommandString, resolveWithinRoot, runTrackedAsync, uniqueSorted, TRACKED_CHILD_DEADLINE_MS } from "audit-tools/shared";
import type { RemediationState } from "../state/store.js";
import { worktreeContentId } from "../steps/gateCommands.js";
import { checkConformanceSubject, conformanceIssue, conformanceObligationsMatch, conformanceReviewPaths, conformanceSubjectsDir, parseConformanceResponse, type ConformanceReviewCheck, type ConformanceReviewIssue } from "../steps/dispatch/contractConformanceReview.js";
import { readSubmissionDocument } from "../../shared/submission/submissionClassifier.js";


/** Historical evidence only; admission continues to use the run's live request and state. */
export async function archiveConformanceSubjects(artifactsDir: string, outputDir: string, assertOwnership?: () => Promise<void>): Promise<void> {
  const sourceDir = conformanceSubjectsDir(artifactsDir);
  let names: string[];
  try { names = await readdir(sourceDir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of names.sort()) {
    if (!/^[a-f0-9]{64}(?:\.review)?\.json$/.test(name)) throw new Error(`Unexpected conformance subject filename: ${name}`);
    const document = JSON.parse(await readFile(join(sourceDir, name), "utf8")) as unknown;
    await assertOwnership?.();
    await writeJsonFile(join(outputDir, "remediation-conformance", name), document);
  }
}
const ObservationSchema = z.object({
  schema_version: z.literal("triage-verification/v1"), producer: z.literal("triage_required_tests"),
  context: z.unknown(), verification: z.array(z.object({ command: z.string().min(1), outcome: z.literal("passed"), exit_code: z.literal(0) }).strict()).min(1),
}).strict();

/** The full nonignored tree plus declared files, including ignored deliverables. */
export async function triageEvidenceContext(root: string, state: RemediationState, itemId: string): Promise<unknown | null> {
  const unit = state.plan?.units.find(entry => entry.id === itemId);
  if (!unit || !state.plan) return null;
  const tree = await worktreeContentId(root);
  const head = await headCommit(root);
  if (!tree || !head) return null;
  const files: Record<string, string> = {};
  const visit = async (relative: string): Promise<void> => {
    const normalized = relative.replaceAll("\\", "/").replace(/^\.\//u, "");
    if (normalized === ".git" || normalized.startsWith(".git/") || normalized === AUDIT_TOOLS_DIRNAME || normalized.startsWith(AUDIT_TOOLS_DIRNAME + "/")) return;
    const stats = await lstat(join(root, relative));
    if (stats.isSymbolicLink()) files[relative] = contentSha256({ symlink: await readlink(join(root, relative)), target_hash: hashContent(await readFile(join(root, relative))) });
    else if (stats.isDirectory()) {
      files[relative] = "directory";
      for (const child of (await readdir(join(root, relative))).sort()) await visit(join(relative, child));
    } else files[relative] = hashContent(await readFile(join(root, relative)));
  };
  try { for (const path of uniqueSorted([...unit.allowed_files, ...unit.read_paths])) await visit(path); }
  catch { return null; }
  // Explicit test scripts can live in ignored scratch; bind their bytes too.
  for (const command of unit.required_tests) for (const argument of parseCommandString(command).slice(1)) {
    if (argument.startsWith("-")) continue;
    const path = resolveWithinRoot(root, argument);
    if (!path) continue;
    const rel = relative(root, path);
    try {
      const stats = await lstat(path);
      if (stats.isFile() || stats.isSymbolicLink()) files[`test:${rel}`] = hashContent(await readFile(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
    }
  }
  return {
    repository_root: root, run_id: state.plan.plan_id, work_item_id: itemId,
    verified_head: head, verified_worktree: tree, declared_file_hashes: files,
    requirements: state.plan.requirements.filter(requirement => unit.requirement_ids.includes(requirement.id)),
    unit, review_revision_sha256: state.plan.review_revision_sha256,
    accepted_counterexamples: (state.plan.review_counterexamples ?? []).filter(example => unit.addresses_counterexample_ids.includes(example.id)),
  };
}

export async function readTriageObservation(artifactsDir: string, runId: string, itemId: string, context: unknown): Promise<unknown | null> {
  const document = await readSubmissionDocument(conformanceReviewPaths(artifactsDir, runId, itemId).observation);
  const parsed = ObservationSchema.safeParse(document.kind === "value" ? document.value : null);
  if (!parsed.success || stableStringify(parsed.data.context) !== stableStringify(context)) return null;
  const commands = (context as { unit: { required_tests: string[] } }).unit.required_tests;
  return stableStringify(parsed.data.verification.map(entry => entry.command)) === stableStringify(commands) ? parsed.data : null;
}

export async function checkTriageConformance(root: string, artifactsDir: string, state: RemediationState, itemId: string, context: unknown | null): Promise<ConformanceReviewCheck> {
  const unit = state.plan!.units.find(entry => entry.id === itemId)!;
  const observation = context ? await readTriageObservation(artifactsDir, state.plan!.plan_id, itemId, context) : null;
  const checked = await checkConformanceSubject({ artifactsDir, runId: state.plan!.plan_id, itemId,
    obligationIds: unit.requirement_ids, content: { context, observation },
    evidenceInstruction: "This is a tool-owned observation, not a host implementation result. Inspect the current working tree identified by verified_worktree and declared_file_hashes, including the required tests and contract. HEAD alone does not identify the reviewed uncommitted source. Explain why the observed tests and source satisfy every obligation. The full tree identity omits ignored files and run scratch; declared deliverables are also hashed explicitly.",
  });
  if (!observation || stableStringify(await triageEvidenceContext(root, state, itemId)) !== stableStringify(context)) {
    const paths = conformanceReviewPaths(artifactsDir, state.plan!.plan_id, itemId);
    return conformanceIssue(paths, itemId, "conformance_review_required", "The working-tree verification context is unavailable or changed. Keep this unit blocked; resume against stable readable source before obtaining conformance review.");
  }
  return checked;
}

export async function writeTriageObservation(artifactsDir: string, runId: string, itemId: string, context: unknown, commands: readonly string[]): Promise<void> {
  await writeJsonFile(conformanceReviewPaths(artifactsDir, runId, itemId).observation, { schema_version: "triage-verification/v1", producer: "triage_required_tests", context,
    verification: commands.map(command => ({ command, outcome: "passed", exit_code: 0 })),
  });
}

const fullCommit = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const diffFlags = ["--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "--no-color", "--no-relative"];
type ScopeChange = { path: string; before: string; after: string };
type ScopeTransition = ScopeChange & { work_item_id: string; landed_commit: string; integrated_commit: string };

function closeoutScope(root: string, artifactsDir: string, state: RemediationState, head: string) {
  const git = (...args: string[]) => runTrackedAsync(["git", "--no-replace-objects", ...args], { cwd: root, encoding: "utf8", timeout: TRACKED_CHILD_DEADLINE_MS });
  const ancestry = async (before: string, after: string) => (await git("merge-base", "--is-ancestor", before, after)).status;
  const changes = async (before: string, after: string, scoped: string[] = []): Promise<ScopeChange[] | undefined> => {
    const raw = await git("diff", ...diffFlags, "--raw", "-z", "--no-renames", "--no-abbrev", before, after, "--", ...scoped);
    const fields = raw.stdout.split("\0");
    if (raw.status !== 0 || fields.pop() !== "" || fields.length % 2 !== 0) return;
    const parsed: ScopeChange[] = [];
    for (let i = 0; i < fields.length; i += 2) {
      const header = /^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([a-f0-9]{40}|[a-f0-9]{64}) [ADMT]$/u.exec(fields[i]!);
      const path = fields[i + 1]!;
      if (!header || !path) return;
      parsed.push({ path, before: header[1] + ":" + header[3], after: header[2] + ":" + header[4] });
    }
    return parsed;
  };

  return async (landed: string, grants: readonly string[]): Promise<ScopeTransition[] | undefined> => {
    const scoped = grants.map(path => ":(literal)" + path);
    if (!fullCommit.test(landed) || !scoped.length || await ancestry(landed, head) !== 0) return;
    // Cleanliness is independent of provenance: a reviewed commit never
    // excuses a staged, unstaged or untracked change in the original grant.
    if ((await git("diff", ...diffFlags, "--quiet", head, "--", ...scoped)).status !== 0 ||
        (await git("diff", ...diffFlags, "--quiet", "--cached", head, "--", ...scoped)).status !== 0) return;
    const untracked = await git("ls-files", "--others", "--exclude-standard", "-z", "--", ...scoped);
    if (untracked.status !== 0 || untracked.stdout !== "") return;
    if (landed === head) return [];

    // Walk the actual integration edges. Comparing only landed...HEAD
    // can hide A→B on the first parent when a merge installs a reviewed
    // branch's A→C blob over B, changing a preimage the reviewer did not see.
    const history = await git("log", "--format=%H %P", "--first-parent", "--reverse",
      "--ancestry-path=" + landed, landed + ".." + head);
    if (history.status !== 0 || !history.stdout.trim()) return;
    const edges = history.stdout.trim().split(/\r?\n/u).map(row => row.trim().split(" "));
    const plan = state.plan!;
    const proof: ScopeTransition[] = [];
    let previous = landed;
    for (const [position, [integrated, first, ...others]] of edges.entries()) {
      if (!integrated || !first || ![integrated, first, ...others].every(id => fullCommit.test(id))) return;
      if (first !== previous) {
        // For an off-mainline landing, begin at its first containing merge
        // only if that merge preserved the exact scoped landing image.
        if (position !== 0 || others.length !== 1 || await ancestry(landed, first) !== 1 ||
            await ancestry(landed, others[0]!) !== 0 || (await changes(landed, integrated, scoped))?.length !== 0) return;
        previous = integrated;
        continue;
      }
      previous = integrated;
      const applied = await changes(first, integrated, scoped);
      if (!applied) return;
      if (!applied.length) continue;
      // A content-changing merge must introduce one exact reviewed writer,
      // not an octopus or an unreviewed aggregate from a topic branch.
      const second = others[0];
      if (others.length > 1 || (second && await ancestry(second, first) !== 1)) return;
      const writer = second ?? integrated;
      if (await ancestry(landed, writer) !== 0 || await ancestry(writer, head) !== 0) return;
      const candidates = plan.units.filter(unit => state.items?.[unit.id]?.host_landed_commit === writer);
      const unit = candidates[0];
      if (candidates.length !== 1 || !unit) return;
      const item = state.items?.[unit.id];
      const receipt = item?.conformance_review;
      if (item?.status !== "resolved" ||
          receipt?.review.mode !== "independent" || !/^[a-f0-9]{64}$/u.test(receipt.binding) ||
          !item.host_landed_files?.length) return;
      const subjectPath = join(conformanceSubjectsDir(artifactsDir), receipt.binding);
      const archived = await readOptionalJsonFile<{ binding: string; content: Record<string, unknown> }>(subjectPath + ".json");
      const content = archived?.content;
      const result = content?.result as { landed_commit?: unknown } | undefined;
      if (!archived || !content || archived.binding !== receipt.binding || contentSha256(content) !== receipt.binding ||
          content.repository_root !== root || content.run_id !== plan.plan_id || content.work_item_id !== unit.id ||
          result?.landed_commit !== writer || stableStringify(content.unit) !== stableStringify(unit) ||
          stableStringify(content.obligation_ids) !== stableStringify(unit.requirement_ids) ||
          stableStringify(content.requirements) !== stableStringify(plan.requirements.filter(req => unit.requirement_ids.includes(req.id))) ||
          stableStringify(content.accepted_counterexamples) !== stableStringify((plan.review_counterexamples ?? []).filter(example => unit.addresses_counterexample_ids.includes(example.id)))) return;
      const response = parseConformanceResponse(await readOptionalJsonFile<unknown>(subjectPath + ".review.json"), receipt.binding);
      if (!response || response.declaration.mode !== "independent" || response.verdict !== "pass" ||
          !conformanceObligationsMatch(response, unit.requirement_ids) || response.obligations.some(row => row.verdict !== "satisfied")) return;
      const parent = await git("rev-list", "--parents", "-n", "1", writer);
      const [commit, base, extra] = parent.stdout.trim().split(" ");
      if (parent.status !== 0 || commit !== writer || !base || extra || !fullCommit.test(base)) return;
      const actual = await changes(base, writer);
      if (!actual || stableStringify(uniqueSorted(actual.map(change => change.path))) !== stableStringify(uniqueSorted(item.host_landed_files)) ||
          actual.some(({ path }) => !unit.allowed_files.some(grant => grant.endsWith("/") ? path.startsWith(grant) : grant === path))) return;
      const writerPaths = new Map(actual.map(change => [change.path, change]));
      for (const change of applied.sort((a, b) => compareCodeUnits(a.path, b.path))) {
        const reviewed = writerPaths.get(change.path);
        if (reviewed?.before !== change.before || reviewed.after !== change.after) return;
        proof.push({ ...change, work_item_id: unit.id, landed_commit: writer, integrated_commit: integrated });
      }
    }
    return previous === head ? proof : undefined;
  };
}

/** A context-only replan may keep immutable work, but not its old review verdict. */
export async function refreshReplannedHostConformance(root: string, artifactsDir: string, state: RemediationState, assertOwnership?: () => Promise<void>): Promise<ConformanceReviewIssue[]> {
  const plan = state.plan;
  if (!state.conformance_review?.enabled || !plan || !plan.review_revision_sha256) return [];
  const issues: ConformanceReviewIssue[] = [];
  const head = await headCommit(root);
  const scope = head && closeoutScope(root, artifactsDir, state, head);
  for (const unit of plan.units) {
    const item = state.items?.[unit.id];
    const receipt = item?.conformance_review;
    if (item?.status !== "resolved" || !item.host_landed_commit || !receipt || receipt.review.mode !== "independent") continue;
    const paths = conformanceReviewPaths(artifactsDir, plan.plan_id, unit.id);
    const archived = await readOptionalJsonFile<{ binding: string; content: Record<string, unknown> }>(
      join(conformanceSubjectsDir(artifactsDir), receipt.binding + ".json"),
    );
    if (!archived?.content || typeof archived.content !== "object" ||
        archived.binding !== receipt.binding || contentSha256(archived.content) !== receipt.binding) continue;
    const prior = archived.content;
    if ("observation" in prior) continue;
    const requirements = plan.requirements.filter(entry => unit.requirement_ids.includes(entry.id));
    const examples = (plan.review_counterexamples ?? []).filter(entry => unit.addresses_counterexample_ids.includes(entry.id));
    const landed = item.host_landed_commit;
    const result = prior.result as { landed_commit?: unknown } | undefined;
    const reject = (message: string) => issues.push({
      code: "conformance_review_insufficient", work_item_id: unit.id,
      result_path: paths.response, review_request_path: paths.request, message,
    });
    if (prior.repository_root !== root || prior.run_id !== plan.plan_id || prior.work_item_id !== unit.id ||
        stableStringify(prior.unit) !== stableStringify(unit) || stableStringify(prior.requirements) !== stableStringify(requirements) ||
        stableStringify(prior.accepted_counterexamples) !== stableStringify(examples) ||
        stableStringify(prior.obligation_ids) !== stableStringify(unit.requirement_ids) || result?.landed_commit !== landed ||
        !scope) {
      reject("The prior conformance receipt cannot be refreshed: its contract or landed scope differs. Reconcile this unit against the current approved plan before closing.");
      continue;
    }
    const transitions = await scope(landed, unit.allowed_files);
    if (!transitions) {
      reject("The prior conformance receipt cannot be refreshed: its landed scope is dirty or contains unexplained changes. Reconcile it before closing.");
      continue;
    }
    if (prior.review_revision_sha256 === plan.review_revision_sha256 &&
        (prior.refreshed_head === undefined ? transitions.length === 0 : prior.refreshed_head === head &&
          stableStringify(prior.scope_transitions ?? []) === stableStringify(transitions))) continue;
    const refreshed = await checkConformanceSubject({
      artifactsDir, runId: plan.plan_id, itemId: unit.id, obligationIds: unit.requirement_ids,
      assertOwnership,
      content: { ...prior, review_revision_sha256: plan.review_revision_sha256, refreshed_head: head,
        ...(transitions.length || prior.scope_transitions !== undefined ? { scope_transitions: transitions } : {}) },
      evidenceInstruction: transitions.length
        ? "Verify the obligations at refreshed HEAD, including changed read context, each scoped path transition and its cited independently conformed writer. Prior receipts do not authorize this changed candidate."
        : "This was an already landed implementation. Verify the cited commit and obligations against the approved plan and the refreshed HEAD. Review any changed read context: the prior receipt is not current approval.",
    });
    if (!refreshed.ok) issues.push(refreshed.issue);
    else if (refreshed.receipt && stableStringify(await scope(landed, unit.allowed_files)) === stableStringify(transitions) && await headCommit(root) === head) {
      await assertOwnership?.();
      item.conformance_review = refreshed.receipt;
    } else reject("The candidate changed while refreshing conformance. Re-run next-step on stable source.");
  }
  return issues;
}

/** Successful terminal units must retain the receipt for their current review subject. */
export async function assertSuccessfulConformance(root: string, artifactsDir: string, state: RemediationState): Promise<void> {
  if (!state.conformance_review?.enabled || !state.plan) return;
  for (const unit of state.plan.units) {
    const item = state.items?.[unit.id];
    if (!item || (item.status !== "resolved" && item.status !== "resolved_no_change")) continue;
    const fail = (): never => { throw new Error(`conformance_review_required: ${unit.id} lacks a current independently reviewed success receipt.`); };
    const receipt = item.conformance_review;
    if (!receipt || receipt.review.mode !== "independent") fail();
    const paths = conformanceReviewPaths(artifactsDir, state.plan.plan_id, unit.id);
    const request = await readOptionalJsonFile<{ binding: string; content: Record<string, unknown> }>(paths.request);
    if (!request || request.binding !== receipt!.binding || contentSha256(request.content) !== receipt!.binding) fail();
    const content = request!.content;
    if ("observation" in content) {
      const context = await triageEvidenceContext(root, state, unit.id);
      const observation = context && await readTriageObservation(artifactsDir, state.plan.plan_id, unit.id, context);
      if (!observation || contentSha256({ context, observation }) !== receipt!.binding) fail();
    } else {
      const requirements = state.plan.requirements.filter(requirement => unit.requirement_ids.includes(requirement.id));
      const examples = (state.plan.review_counterexamples ?? []).filter(example => unit.addresses_counterexample_ids.includes(example.id));
      if (content.run_id !== state.plan.plan_id || content.work_item_id !== unit.id || content.review_revision_sha256 !== state.plan.review_revision_sha256 ||
        stableStringify(content.unit) !== stableStringify(unit) || stableStringify(content.requirements) !== stableStringify(requirements) ||
        stableStringify(content.accepted_counterexamples) !== stableStringify(examples)) fail();
      if (item.host_landed_commit) {
        const head = await headCommit(root);
        const proof = head && await closeoutScope(root, artifactsDir, state, head)(item.host_landed_commit, unit.allowed_files);
        if (!proof || (content.refreshed_head === undefined ? proof.length !== 0 : content.refreshed_head !== head ||
            stableStringify(content.scope_transitions ?? []) !== stableStringify(proof)) || await headCommit(root) !== head) fail();
      } else if (content.refreshed_head !== undefined && content.refreshed_head !== await headCommit(root)) fail();
    }
  }
}

/** Refresh stale mutable-tree successes, or abandon them after an explicit halt; retain historical receipts. */
export async function reopenStaleTriageSuccesses(root: string, artifactsDir: string, state: RemediationState): Promise<boolean> {
  if (!state.conformance_review?.enabled || !state.plan) return false;
  let reopened = false;
  for (const unit of state.plan.units) {
    const item = state.items?.[unit.id];
    if (item?.status !== "resolved_no_change" || !item.conformance_review) continue;
    const request = await readOptionalJsonFile<{ binding: string; content: Record<string, unknown> }>(conformanceReviewPaths(artifactsDir, state.plan.plan_id, unit.id).request);
    if (!request || !("observation" in request.content)) continue;
    const context = await triageEvidenceContext(root, state, unit.id);
    const observation = context && await readTriageObservation(artifactsDir, state.plan.plan_id, unit.id, context);
    if (!observation || contentSha256({ context, observation }) !== item.conformance_review.binding) {
      if (state.closing_context === "user_halted") {
        item.status = "abandoned";
        item.failure_reason = "The owner halted this run after the reviewed tool-owned success observation became stale. Historical conformance evidence is retained; current success is not claimed.";
        item.completed_at = new Date().toISOString();
      } else {
        item.status = "blocked";
        item.failure_reason = "The working tree changed since this tool-owned success observation was reviewed. Reverify and obtain a current bound review.";
        delete item.completed_at;
      }
      reopened = true;
    }
  }
  if (reopened && state.closing_context !== "user_halted") state.status = "triage";
  return reopened;
}
