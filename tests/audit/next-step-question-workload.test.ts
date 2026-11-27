import { expect, test } from "vitest";
import { DEFAULT_ACQUIRED_ANALYZER_IDS } from "../helpers/analyzerConsentFixture.js";
import { prepareFixtureRun } from "../helpers/functionalPreflightFixture.js";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ADVANCE_PAST_DESIGN_REVIEW_TERMINAL_KINDS, withTempRepo } from "./helpers/next-step-harness.js";
import { runWrapper } from "./helpers/run-wrapper.mjs";
import { captureConsole } from "./helpers/captureConsole.mjs";
import { runCli } from "../../src/audit/cli.js";
import { callNextStep } from "./helpers/completion-harness.js";
import { walkStepsUntilTerminal } from "./helpers/step-driver.js";
import { submitWorkItemResult } from "../../src/audit/cli/submitCommand.js";
import { packageVersion } from "./helpers/wrapper-harness.js";
import { runBounded } from "../helpers/spawn.mjs";
import { validateSuppliedInput } from "../../src/remediate/steps/intakeResolver.js";
import { QuestionAuditFindingsReportSchema } from "../../src/shared/types/questionReviewReport.js";
import { hashArtifactValue } from "../../src/shared/artifactFreshness.js";
import { REVIEW_QUESTION_CONTRACT_VERSION, type ReviewAssignment, type ReviewQuestion, type ReviewSubmission } from "../../src/shared/types/reviewQuestion.js";

/** Same argv validation, dispatch and persisted artifacts, without a fresh Node process. */
async function runCommand(argv: string[], { cwd }: { cwd: string }) {
  const result = await captureConsole(() => runCli(["node", "audit-code", ...argv, ...(argv.includes("--root") ? [] : ["--root", cwd])]));
  if (result.code !== 0) throw new Error(result.stderr.trim());
  return result;
}

function prepareWorkload(root: string, artifactsDir = join(root, ".audit-tools", "audit")) {
  return walkStepsUntilTerminal({
    transport: () => callNextStep(root, artifactsDir),
    terminalKinds: ADVANCE_PAST_DESIGN_REVIEW_TERMINAL_KINDS,
    label: "prepare question workload",
  });
}

test("snapshot-bound questions feed standalone synthesis only after accepted answers", async () => {
  await withTempRepo(async (root) => {
    const neighbor = "src/neighbor/isolated.ts";
    await mkdir(dirname(join(root, neighbor)), { recursive: true });
    await writeFile(join(root, "src/neighbor/helper.ts"), "export const value = 1;\n");
    await writeFile(join(root, neighbor), "import { value } from './helper.js';\nexport const unrelated = value;\n");
    const artifactsDir = join(root, "custom audit artifacts");
    const artifactArgs = ["--artifacts-dir", artifactsDir];
    await prepareFixtureRun(root, { artifactsDir, declinedAnalyzerIds: DEFAULT_ACQUIRED_ANALYZER_IDS, preflight: true });
    const step = await prepareWorkload(root, artifactsDir);
    const handoff = await readFile(step.prompt_path, "utf8");
    expect(handoff).toContain("Read only the routing metadata");
    expect(handoff).toContain("The command returns a prompt_path, not the prompt.");
    expect(handoff).toContain("With delegation, pass that file directly to the reviewer harness");
    expect(handoff).toContain("If the host truly cannot delegate, prepare exactly one pending assignment");
    expect(handoff).toContain("run the continuation once to ingest it, then stop for fresh context");
    expect(handoff).toContain("or substitute self-review for any step that requires independence");
    expect(handoff).toContain("retain the exact query, its returned status or stderr, and the frozen source identity");
    expect(handoff).not.toContain(step.artifact_paths.host_workload);
    expect(step.step_kind).toBe("dispatch_review");
    expect(step.allowed_commands).toHaveLength(1);
    expect(step.allowed_commands[0]).toMatch(/next-step/u);
    expect(step.artifact_paths.dispatch_plan).toBeUndefined();
    expect(step.artifact_paths.dispatch_quota).toBeUndefined();
    const workload: unknown = JSON.parse(await readFile(step.artifact_paths.host_workload, "utf8"));
    expect(workload).toMatchObject({
      contract_version: "audit-tools/question-review/v1",
      work_items: expect.arrayContaining([
        expect.objectContaining({
          binding: expect.objectContaining({
            question: expect.objectContaining({ question_id: expect.any(String), snapshot_id: expect.any(String) }),
            assignment: expect.objectContaining({ assignment_id: expect.any(String), authorized_scope: expect.anything() }),
          }),
        }),
      ]),
    });
    const { work_items: workItems, source_files: sourceFiles } =
      workload as { work_items: WorkItem[]; source_files: { path: string }[] };
    const routing = JSON.parse(await readFile(step.artifact_paths.review_routing, "utf8"));
    expect(routing).toEqual({
      run_id: step.run_id,
      workload_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      prepare_review_argv_prefix: ["prepare-review", "--root", step.repo_root,
        "--artifacts-dir", step.artifacts_dir, "--workload-sha256", routing.workload_sha256],
      assignments: workItems.map(({ binding }) => ({ assignment_id: binding.assignment.assignment_id })),
    });
    const prepareArgsFor = (assignmentId: string, digest: string = routing.workload_sha256) =>
      [...routing.prepare_review_argv_prefix.slice(0, -1), digest, "--work-item", assignmentId];
    // The wrapper's release-bound invocation becomes part of successful
    // packet bytes. Keep real launches for those byte comparisons, not for
    // pure validation failures that cannot write a packet.
    const prepare = (assignmentId: string) =>
      runWrapper(prepareArgsFor(assignmentId), { cwd: root });
    const rejectPrepare = (assignmentId: string, digest?: string) =>
      runCommand(prepareArgsFor(assignmentId, digest), { cwd: root });
    const loadPacket = async (item: WorkItem) => {
      const assignment_id = item.binding.assignment.assignment_id;
      const { stdout } = await prepare(assignment_id);
      const handle = JSON.parse(stdout);
      expect(handle).toEqual({ run_id: step.run_id, assignment_id, workload_sha256: routing.workload_sha256,
        prompt_path: expect.any(String), read_paths: {
          source_root: expect.any(String), source_index: expect.any(String), submission_schema: expect.any(String),
          graph_index: expect.any(String), graph_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        } });
      const prompt = await readFile(handle.prompt_path, "utf8");
      expect(handoff).not.toContain(item.binding.question.question_id);
      expect(prompt).not.toContain(step.artifact_paths.host_workload);
      expect(prompt).toContain("Answer only the bound question");
      expect(prompt).toMatch(/audit-code\.mjs["']? --expect-version=\S+ review-graph --graph-index /u);
      expect(prompt).toContain("--expect-version=" + packageVersion + " review-graph");
      expect(prompt).toContain("--graph-sha256 " + handle.read_paths.graph_sha256 + " --path REPO_RELATIVE_PATH");
      expect(prompt).not.toContain("audit-code review-graph");
      expect(prompt).toContain("limitations field is an array of strings");
      expect(prompt).toContain("report it as a design_opportunity, not a confirmed_defect or an unsupported lead");
      expect(prompt).toContain("compare keeping it with the viable options (simplify, replace, or delete)");
      const packet = JSON.parse(prompt.slice(prompt.indexOf("\n\n{") + 2));
      expect(packet.binding).toEqual(item.binding);
      expect(packet.result_path).toBe(item.result_path);
      const normalized = (path: string) => path.split(sep).join("/").replace(/^[a-z](?=:)/u, letter => letter.toUpperCase());
      expect(prompt).toContain("artifacts_dir: " + normalized(artifactsDir));
      expect(prompt).toContain("bound file " + "`" + normalized(resolve(root, item.result_path)) + "`");
      expect(packet.evidence).toEqual((workload as { evidence: { evidence_id: string }[] }).evidence
        .filter(({ evidence_id }) => item.binding.assignment.available_evidence_ids.includes(evidence_id)));
      expect(packet.source_files).toBeUndefined();
      expect(packet).toMatchObject(handle.read_paths);
      expect(await readFile(packet.submission_schema, "utf8")).toContain("submission_id");
      return { handle, packet };
    };
    const first = workItems[0]!;
    const receipt = join(step.artifacts_dir, ".fold-receipt.json");
    await writeFile(receipt, "{}");
    await expect(rejectPrepare(first.binding.assignment.assignment_id)).rejects.toThrow(/incomplete fold receipt/);
    await unlink(receipt);
    const selected = await loadPacket(first);
    const other = workItems[1]!;
    const second = await loadPacket(other);
    const firstId = first.binding.assignment.assignment_id;
    const otherId = other.binding.assignment.assignment_id;
    const prepareBatch = (ids: string) =>
      runWrapper([...routing.prepare_review_argv_prefix, "--work-items", ids], { cwd: dirname(root) });
    const rejectPrepareBatch = (ids: string, digest = routing.workload_sha256) =>
      runCommand([...routing.prepare_review_argv_prefix.slice(0, -1), digest, "--work-items", ids], { cwd: root });
    const batch = JSON.parse((await prepareBatch(otherId + ",unissued," + firstId)).stdout);
    expect(batch).toEqual({ run_id: step.run_id, workload_sha256: routing.workload_sha256, outcomes: [
      { status: "ready", packet: second.handle },
      { status: "refused", assignment_id: "unissued", message: "Review assignment is not in the current issued workload" },
      { status: "ready", packet: selected.handle },
    ] });
    await expect(rejectPrepareBatch(firstId + "," + firstId)).rejects.toThrow(/distinct review assignment IDs/);
    await expect(rejectPrepareBatch(firstId, "0".repeat(64))).rejects.toThrow(/fingerprint is not current/);
    expect(second.handle.prompt_path).not.toBe(selected.handle.prompt_path);
    expect(second.packet.source_index).toBe(selected.packet.source_index);
    expect(second.packet.graph_index).toBe(selected.packet.graph_index);
    expect(second.packet.graph_sha256).toBe(selected.packet.graph_sha256);
    expect(selected.packet.edges).toBeUndefined();
    const graph = await runWrapper(["--expect-version=" + packageVersion, "review-graph", "--graph-index", selected.packet.graph_index,
      "--graph-sha256", selected.packet.graph_sha256, "--path", neighbor], { cwd: selected.packet.source_root });
    expect(JSON.parse(graph.stdout)).toMatchObject({ path: neighbor, edges: expect.arrayContaining([
      expect.objectContaining({ relation: "imports", from: neighbor, to: "src/neighbor/helper.ts" }),
    ]) });
    expect(JSON.parse(await readFile(selected.packet.source_index, "utf8")))
      .toEqual({ source_root: selected.packet.source_root, source_files: sourceFiles });
    expect(JSON.parse((await prepare(first.binding.assignment.assignment_id)).stdout)).toEqual(selected.handle);
    // An already-issued workload from the previous layout still binds the
    // same digest, with the graph and optional index cache rooted in its run.
    const legacyGraph = join(step.artifacts_dir, "runs", step.run_id, "review-graph-index", selected.packet.graph_sha256 + ".json");
    await mkdir(dirname(legacyGraph), { recursive: true });
    await rename(selected.packet.graph_index, legacyGraph);
    try {
      const legacy = JSON.parse((await runCommand([...routing.prepare_review_argv_prefix,
        "--work-item", first.binding.assignment.assignment_id], { cwd: root })).stdout).read_paths;
      expect(resolve(legacy.graph_index)).toBe(resolve(legacyGraph));
      expect(legacy.graph_sha256).toBe(selected.packet.graph_sha256);
      const queried = await runCommand(["review-graph", "--graph-index", legacy.graph_index,
        "--graph-sha256", legacy.graph_sha256, "--path", neighbor], { cwd: root });
      expect(JSON.parse(queried.stdout)).toEqual(JSON.parse(graph.stdout));
    } finally {
      await rename(legacyGraph, selected.packet.graph_index);
    }
    const prepareArgs = [...routing.prepare_review_argv_prefix, "--work-item", first.binding.assignment.assignment_id];
    for (const invalid of ["{ malformed", JSON.stringify(["audit-code", "--expect-version=old"])]) {
      const fallback = await runWrapper(prepareArgs, { cwd: root, env: { AUDIT_CODE_INVOCATION: invalid } });
      expect(fallback.stderr).toContain("Invalid AUDIT_CODE_INVOCATION");
      expect(JSON.parse(fallback.stdout)).toEqual(selected.handle);
    }
    const windowsLauncher = String.raw`C:\Program Files\Dev Tools\audit-code.cmd`;
    const overridden = await runWrapper(prepareArgs, { cwd: root,
      env: { AUDIT_CODE_INVOCATION: JSON.stringify([windowsLauncher]) } });
    const windowsPrompt = await readFile(JSON.parse(overridden.stdout).prompt_path, "utf8");
    expect(windowsPrompt).toContain((process.platform === "win32" ? "& " : "")
      + "'C:/Program Files/Dev Tools/audit-code.cmd' --expect-version=" + packageVersion + " review-graph");
    await expect(rejectPrepare("unissued")).rejects.toThrow(/not in the current issued workload/);
    await expect(rejectPrepare(first.binding.assignment.assignment_id, "0".repeat(64))).rejects.toThrow(/fingerprint is not current/);
    expect(sourceFiles).toContainEqual(expect.objectContaining({ path: neighbor }));
    const contextualRead = workItems.find(item =>
      !item.binding.assignment.suggested_sources.some(({ path }) => path === neighbor));
    expect(contextualRead).toBeDefined();
    const ledgerFile = join(artifactsDir, "runs", (workload as { run_id: string }).run_id, "host-accepted-results-ledger.json");
    for (const [index, item] of workItems.entries()) {
      const { question, assignment } = item.binding;
      const response: ReviewSubmission = {
        schema_version: REVIEW_QUESTION_CONTRACT_VERSION,
        submission_id: `standalone-${assignment.assignment_id}`,
        assignment_id: assignment.assignment_id, question_id: question.question_id,
        snapshot_id: question.snapshot_id, revision_id: question.revision_id,
        inspected_sources: [
          ...assignment.suggested_sources.slice(0, 1),
          ...(item === contextualRead ? [{ path: neighbor }] : []),
        ], evidence_ids: [],
        limitations: ["Synthetic review did not establish the requested behavior."],
        answer: { outcome: "inconclusive", findings: [], observations: [], parts: question.requested_parts.map(part => ({
          part_id: part.part_id, outcome: "inconclusive", observation_ids: [],
        })) },
      };
      const file = resolve(root, item.result_path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(response));
      if (index === 0) {
        const readLedger = () => existsSync(ledgerFile) ? readFile(ledgerFile) : undefined;
        const ledgerBeforeRefusal = await readLedger();
        await expect(runCommand(["force-synthesis", ...artifactArgs], { cwd: root })).rejects.toThrow(/report-ready state/);
        expect(await readLedger()).toEqual(ledgerBeforeRefusal);
        await writeFile(file, JSON.stringify({ ...response, answer: {
          ...response.answer, parts: [{ part_id: "not-an-assigned-part", outcome: "inconclusive", observation_ids: [] }],
        } }));
        await expect(runCommand(["submit", ...artifactArgs, "--work-item", assignment.assignment_id, "--from", file], { cwd: root }))
          .rejects.toThrow(/Unknown or duplicate requested part/);
        expect(await readLedger()).toEqual(ledgerBeforeRefusal);
        await writeFile(file, JSON.stringify(response));
      }
      if (index === 0) {
        const accepted = await runWrapper(["submit", "--root", root, ...artifactArgs, "--work-item", assignment.assignment_id, "--from", file], { cwd: dirname(root) });
        expect(JSON.parse(accepted.stdout)).toMatchObject({ disposition: "accepted", submission_id: response.submission_id });
        await expect(rejectPrepare(assignment.assignment_id)).rejects.toThrow(/already has an accepted answer/);
        const partiallyAccepted = JSON.parse((await prepareBatch(firstId + "," + otherId)).stdout);
        expect(partiallyAccepted.outcomes).toEqual([
          { status: "refused", assignment_id: firstId, message: "Review assignment already has an accepted answer." },
          { status: "ready", packet: second.handle },
        ]);
      } else {
        // Later answers only fill the real durable ledger for synthesis; CLI argv,
        // stdout and rejection have already been exercised above.
        const accepted = await submitWorkItemResult({
          root, artifactsDir: step.artifacts_dir, workItemId: assignment.assignment_id, source: JSON.stringify(response),
        });
        expect(accepted).toMatchObject({ disposition: "accepted", submission_id: response.submission_id });
      }
    }
    const ledgerBefore = await readFile(ledgerFile, "utf8");
    const { stdout } = await runCommand(["synthesize", ...artifactArgs], { cwd: root });
    expect(JSON.parse(stdout)).toMatchObject({ selected_executor: "synthesis_executor" });
    const working = join(artifactsDir, "audit-findings.json");
    const report = QuestionAuditFindingsReportSchema.parse(JSON.parse(await readFile(working, "utf8")));
    expect(report.question_review.questions).toHaveLength(workItems.length);
    expect(report.question_review.completion).toBe("incomplete");
    expect(await readFile(ledgerFile, "utf8")).toBe(ledgerBefore);
    const next = await runCommand(["next-step", ...artifactArgs], { cwd: root });
    expect(JSON.parse(next.stdout).step_kind).toBe("synthesis_narrative");
  });
});

type WorkItem = { binding: { question: ReviewQuestion; assignment: ReviewAssignment }; result_path: string };

test("next-step and submission handlers resume durable answers and hands off an honestly incomplete question report", async () => {
  await withTempRepo(async (root) => {
    await writeFile(join(root, "src", "resume.ts"), "export function resumePending(): string { return 'pending'; }\n");
    const next = () => runCommand(["next-step"], { cwd: root }).then(({ stdout }) => JSON.parse(stdout));
    const workloadFor = async (step: Awaited<ReturnType<typeof next>>) => {
      expect(step.step_kind).toBe("dispatch_review");
      return JSON.parse(await readFile(step.artifact_paths.host_workload, "utf8")) as { run_id: string; work_items: WorkItem[] };
    };
    const initialStep = await prepareWorkload(root);
    const initial = await workloadFor(initialStep);
    const initialRouting = JSON.parse(await readFile(initialStep.artifact_paths.review_routing, "utf8"));
    expect(initial.work_items.length).toBeGreaterThan(1);
    const first = initial.work_items[0]!;
    const responseFor = (item: WorkItem): ReviewSubmission => {
      const { question, assignment } = item.binding;
      return { schema_version: REVIEW_QUESTION_CONTRACT_VERSION, submission_id: `fixture-${assignment.assignment_id}`,
        assignment_id: assignment.assignment_id, question_id: question.question_id, revision_id: question.revision_id,
        snapshot_id: question.snapshot_id, inspected_sources: assignment.suggested_sources.slice(0, 1), evidence_ids: [],
        limitations: ["Synthetic fixture could not establish the requested behavior."],
        answer: { outcome: "inconclusive", findings: [], observations: [], parts: [
          { part_id: question.requested_parts[0]!.part_id, outcome: "inconclusive", observation_ids: [], reason: "No observation for this case." },
        ] } };
    };
    const put = async (item: WorkItem, result = responseFor(item)) => {
      const file = resolve(root, item.result_path);
      expect(file.startsWith(join(root, ".audit-tools"))).toBe(true);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(result));
      return result;
    };
    const second = initial.work_items[1]!;
    const privatePath = "synthetic-private-path-never-print.txt";
    const badSource = responseFor(second);
    badSource.inspected_sources = [{ path: privatePath, start_line: 1 }];
    await put(first, { ...responseFor(first), revision_id: "stale-revision-never-print" });
    await put(second, badSource);
    const { stdout, stderr } = await runWrapper(["next-step"], { cwd: root });
    const rejected = JSON.parse(stdout);
    expect(rejected).toMatchObject({
      step_kind: "dispatch_review",
      progress: { summary: expect.stringContaining("Could not accept 2 saved question results"), pending_tasks: initial.work_items.length },
    });
    const repair = await workloadFor(rejected);
    expect(repair.work_items.map(({ binding }) => binding.assignment.assignment_id))
      .toEqual(initial.work_items.map(({ binding }) => binding.assignment.assignment_id));
    const prompt = await readFile(rejected.artifact_paths.current_prompt, "utf8");
    expect(prompt).toContain(first.binding.assignment.assignment_id + "`" + ": Bound answer rejected: Binding mismatch.");
    expect(prompt).toContain(second.binding.assignment.assignment_id + "`" + ": Bound answer rejected: Source is outside the assignment.");
    expect(prompt).toContain("its bound result_path");
    expect(stdout + stderr + prompt).not.toContain(privatePath);
    expect(stdout + stderr + prompt).not.toContain("stale-revision-never-print");
    await put(second, { ...responseFor(second), limitations: [["invalid-secret-array"] as unknown as string] });
    const schemaRejection = await next();
    const schemaPrompt = await readFile(schemaRejection.artifact_paths.current_prompt, "utf8");
    expect(schemaPrompt).toContain("Answer schema mismatch at limitations.0: expected string.");
    expect(schemaPrompt).not.toContain("invalid-secret-array");
    await unlink(resolve(root, second.result_path));
    const firstAnswer = await put(first);
    const resumed = await workloadFor(await next());
    expect(resumed.run_id).toBe(initial.run_id);
    await expect(runCommand(["prepare-review", "--work-item", second.binding.assignment.assignment_id,
      "--workload-sha256", initialRouting.workload_sha256], { cwd: root })).rejects.toThrow(/fingerprint is not current/);
    expect(resumed.work_items.some(({ binding }) => binding.assignment.assignment_id === firstAnswer.assignment_id)).toBe(false);
    const base = join(root, ".audit-tools", "audit");
    const ledgerPath = join(base, "runs", resumed.run_id, "host-accepted-results-ledger.json");
    const accepted = async () => (JSON.parse(await readFile(ledgerPath, "utf8")) as { answers: { submission: ReviewSubmission }[] }).answers.map(({ submission }) => submission);
    expect(await accepted()).toEqual([firstAnswer]);
    const repeated = await workloadFor(await next());
    expect(repeated.run_id).toBe(resumed.run_id);
    expect(await accepted()).toEqual([firstAnswer]);
    const lateGuidance = join(base, "intake", "conversation-start.md");
    const beforeLateGuidance = await readFile(lateGuidance, "utf8").catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    expect(beforeLateGuidance).toBeNull();
    await expect(runCommand(["next-step", "--guidance", "First guidance after dispatch"], { cwd: root }))
      .rejects.toThrow(/active question review cannot change guidance/u);
    await expect(readFile(lateGuidance, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const request = join(base, "reopen.json");
    const decision = {
      reopen_id: "fix-misassigned-answer", reason: "The first answer was bound to the wrong review question.",
      questions: [{ question_id: firstAnswer.question_id, revision_id: firstAnswer.revision_id,
        snapshot_id: firstAnswer.snapshot_id, expected_submission_ids: [firstAnswer.submission_id] }],
    };
    // Reconstruct the pre-upgrade producer record as F1 would have stamped it:
    // only the recorded tooling value differs, not the frozen project or evidence.
    const toolingFile = join(base, "tooling_manifest.json");
    const metadataFile = join(base, "artifact_metadata.json");
    const liveTooling = JSON.parse(await readFile(toolingFile, "utf8"));
    const priorTooling = { ...liveTooling, implementation_hash: "f".repeat(64) };
    const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
    metadata.artifacts["tooling_manifest.json"].content_hash = hashArtifactValue("tooling_manifest.json", priorTooling);
    const historicalBytes = JSON.stringify(priorTooling);
    await writeFile(toolingFile, historicalBytes);
    await writeFile(metadataFile, JSON.stringify(metadata));
    const reopen = () => runCommand(["reopen-questions", "--from", request], { cwd: root }).then(({ stdout }) => JSON.parse(stdout));
    await writeFile(request, JSON.stringify(decision));
    await expect(reopen()).rejects.toThrow(/review plan is missing or stale/u);
    expect(await accepted()).toEqual([firstAnswer]);
    const tooling_transition = {
      prior_implementation_hash: priorTooling.implementation_hash, current_implementation_hash: liveTooling.implementation_hash,
      reason: "Only the question-review host changed; retain the verified frozen inputs.",
    };
    await writeFile(request, JSON.stringify({ ...decision, tooling_transition: {
      ...tooling_transition, current_implementation_hash: "e".repeat(64),
    } }));
    await expect(reopen()).rejects.toThrow(/exact historical and current implementation/u);
    expect(await accepted()).toEqual([firstAnswer]);
    await writeFile(request, JSON.stringify({ ...decision, tooling_transition }));
    expect(await reopen()).toMatchObject({ disposition: "accepted" });
    expect(await reopen()).toMatchObject({ disposition: "replay" });
    expect(await accepted()).toEqual([firstAnswer]);
    const remediate = fileURLToPath(new URL("../../remediate-code.mjs", import.meta.url));
    const { CLAUDECODE: _cc, ...env } = process.env;
    const nextRemediation = () => runBounded(process.execPath, [remediate, "next-step"], { cwd: root, env })
      .then(({ stdout }) => JSON.parse(stdout));
    const obsoleteWorking = join(base, "audit-findings.json");
    await writeFile(obsoleteWorking, JSON.stringify({ contract_version: "audit-tools/audit-findings/v2" }));
    await expect(nextRemediation()).rejects.toThrow(/working audit report predates reopened review answers/u);
    await unlink(obsoleteWorking);
    const staged = join(base, "submission-staging");
    await mkdir(staged, { recursive: true });
    const oldUpstreamSubmission = join(staged, "critical_flow_fallback.json");
    const oldUpstreamBytes = JSON.stringify({ stale: "left by a previous acquisition fold" });
    await writeFile(oldUpstreamSubmission, oldUpstreamBytes);
    const redispatched = await workloadFor(await next());
    expect(await readFile(oldUpstreamSubmission, "utf8")).toBe(oldUpstreamBytes);
    expect(await readFile(toolingFile, "utf8")).toBe(historicalBytes);
    const snapshotPath = join(base, "run-snapshot.json");
    const preservedSnapshot = await readFile(snapshotPath, "utf8");
    const preservedMetadata = await readFile(metadataFile, "utf8");
    await expect(runCommand(["intake"], { cwd: root })).rejects.toThrow(/not standalone analysis/u);
    await expect(runCommand(["next-step", "--since", "HEAD"], { cwd: root }))
      .rejects.toThrow(/cannot change source scope or formatting consent/u);
    expect(await readFile(snapshotPath, "utf8")).toBe(preservedSnapshot);
    expect(await readFile(metadataFile, "utf8")).toBe(preservedMetadata);
    const guidancePath = join(base, "intake", "conversation-start.md");
    const readGuidance = () => readFile(guidancePath, "utf8").catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    const originalGuidance = await readGuidance();
    const alternativeGuidance = join(base, "different-guidance.md");
    await writeFile(alternativeGuidance, "Do a different audit.\n");
    await expect(runCommand(["next-step", "--guidance", "A different task"], { cwd: root }))
      .rejects.toThrow(/cannot change guidance/u);
    await expect(runCommand(["next-step", "--guidance-file", alternativeGuidance], { cwd: root }))
      .rejects.toThrow(/cannot change guidance/u);
    expect(await readGuidance()).toBe(originalGuidance);
    await mkdir(dirname(guidancePath), { recursive: true });
    try {
      await writeFile(guidancePath, "An out-of-band intent edit.\n");
      await expect(next()).rejects.toThrow(/qualified review tooling inputs changed/u);
    } finally {
      if (originalGuidance !== null) await writeFile(guidancePath, originalGuidance);
      else await unlink(guidancePath);
    }
    const snapshotRoot = JSON.parse(preservedSnapshot).source_root as string;
    const frozenFile = join(snapshotRoot, "src", "resume.ts");
    const frozenBytes = await readFile(frozenFile);
    try {
      await writeFile(frozenFile, "export const differentFrozenSource = true;\n");
      await expect(next()).rejects.toThrow(/Qualified question review.*frozen source changed/u);
    } finally {
      await writeFile(frozenFile, frozenBytes);
    }
    const beforeEvidenceChange = await readFile(join(base, "external_analyzer_results.json")).catch(() => undefined);
    const evidencePath = join(base, "external_analyzer_results.json");
    try {
      await writeFile(evidencePath, JSON.stringify([{ unexpected: "different analysis" }]));
      await expect(next()).rejects.toThrow(/qualified review tooling inputs changed/u);
    } finally {
      if (beforeEvidenceChange !== undefined) await writeFile(evidencePath, beforeEvidenceChange);
      else await unlink(evidencePath);
    }
    const docs = join(base, "docs_digest.json");
    const docsBytes = await readFile(docs);
    try {
      await unlink(docs);
      await expect(next()).rejects.toThrow(/non-report inputs|cannot derive upstream obligation/u);
    } finally {
      await writeFile(docs, docsBytes);
    }
    expect(await readFile(metadataFile, "utf8")).toBe(preservedMetadata);
    const afterNegativeCases = await workloadFor(await next());
    expect(afterNegativeCases.work_items).toEqual(redispatched.work_items);
    const replacement = redispatched.work_items.find(item => item.binding.question.question_id === firstAnswer.question_id)!;
    expect(replacement.binding.assignment.assignment_id).not.toBe(firstAnswer.assignment_id);
    expect(replacement.result_path).not.toBe(first.result_path);
    const untouched = redispatched.work_items.find(item => item.binding.question.question_id === repeated.work_items[0]!.binding.question.question_id);
    expect(untouched).toEqual(repeated.work_items[0]);
    const replacementAnswer = await put(replacement);
    const submitted = await runCommand(["submit", "--work-item", replacementAnswer.assignment_id,
      "--from", resolve(root, replacement.result_path)], { cwd: root });
    expect(JSON.parse(submitted.stdout)).toMatchObject({ disposition: "accepted", submission_id: replacementAnswer.submission_id });
    const secondAnswer = await put(repeated.work_items[0]!);
    for (const item of redispatched.work_items.filter(item => item !== replacement && item !== untouched)) await put(item);
    const trail: string[] = [];
    const assertNoLegacyFollowup = () => {
      expect(existsSync(join(base, "audit_tasks.json"))).toBe(false);
      expect(existsSync(join(base, "runtime_validation_tasks.json"))).toBe(false);
    };
    assertNoLegacyFollowup();
    let complete = false;
    for (let i = 0; i < 8; i++) {
      const step = await next();
      trail.push(`${step.step_kind}:${step.status}`);
      // Real next-step must synthesize the bound inconclusive answers, not
      // secretly schedule retired audit-task followups during terminal folds.
      assertNoLegacyFollowup();
      expect(step.step_kind).not.toBe("dispatch_review");
      if (step.step_kind === "synthesis_narrative") {
        const target = step.artifact_paths.synthesis_narrative_results;
        expect(typeof target).toBe("string");
        // Simulate interruption after the narrative result was staged. This
        // qualified fold may recover narrative, but not the older upstream lane.
        await writeFile(join(staged, "synthesis_narrative.json"), JSON.stringify({ themes: [], top_risks: [] }));
      } else if (step.step_kind === "present_report") {
        if (step.status === "complete") { complete = true; break; }
        const friction = step.artifact_paths.friction_record;
        if (step.status === "ready" && typeof friction === "string") {
          const record = JSON.parse(await readFile(friction, "utf8").catch(() => "{}"));
          record.category_attestations = ["ambiguous_direction", "tool_should_decide", "inefficient_feeding"].map(category => ({ category, note: "Synthetic fixture." }));
          await mkdir(dirname(friction), { recursive: true });
          await writeFile(friction, JSON.stringify(record));
        }
      }
    }
    expect(complete, trail.join(" -> ")).toBe(true);
    const reportPath = join(base, "audit-findings.json");
    const reportBytes = await readFile(reportPath, "utf8");
    const report = QuestionAuditFindingsReportSchema.parse(JSON.parse(reportBytes));
    expect(report.question_review.completion).toBe("incomplete");
    expect(report.question_review.accepted.map(({ submission }) => submission)).toEqual(expect.arrayContaining([firstAnswer, secondAnswer]));
    const row = report.question_review.questions.find(({ question_id }) => question_id === firstAnswer.question_id);
    expect(row).toMatchObject({ state: "inconclusive", accepted_answer_ids: [replacementAnswer.submission_id] });
    expect(report.question_review.reopens?.map(event => event.reopen_id)).toEqual(["fix-misassigned-answer"]);
    await expect(reopen()).rejects.toThrow(/finished|immutable/u);
    expect(await readFile(reportPath, "utf8")).toBe(reportBytes);
    expect(row?.parts.some(part => part.state === "clean")).toBe(false);
    expect(report.findings).toEqual([]);
    expect(validateSuppliedInput(reportPath, reportBytes)).toEqual({ ok: true });
    const discover = await nextRemediation();
    expect(discover).toMatchObject({ step_kind: "confirm_auto_discovered_input" });
    const ack = discover.artifact_paths.confirm_auto_discovered_input_ack;
    expect(typeof ack).toBe("string");
    await writeFile(ack, JSON.stringify({ status: "confirmed" }));
    const intake = await nextRemediation();
    expect(intake).toMatchObject({ step_kind: "synthesize_intake" });
    const manifest = JSON.parse(await readFile(join(root, ".audit-tools", "remediation", "intake", "source-manifest.json"), "utf8"));
    const source = manifest.sources.find((item: { type: string }) => item.type === "structured_audit");
    expect(typeof source?.path).toBe("string");
    const intakeReport = QuestionAuditFindingsReportSchema.parse(JSON.parse(await readFile(source.path, "utf8")));
    expect(intakeReport.question_review.accepted.map(({ submission }) => submission.submission_id)).toContain(firstAnswer.submission_id);
  });
});

test("interrupted workload and step publication resume the same frozen snapshot", async () => {
  await withTempRepo(async (root) => {
    const initial = await prepareWorkload(root);
    expect(initial.step_kind).toBe("dispatch_review");
    const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));
    const artifacts = initial.artifacts_dir;
    const snapshot = join(artifacts, "run-snapshot.json");
    const frozenBytes = await readFile(snapshot, "utf8");
    const workload = await readJson(initial.artifact_paths.host_workload) as {
      source_root: string; source_files: unknown[]; work_items: WorkItem[];
    };
    const [answered, pending] = workload.work_items;
    expect(answered).toBeDefined();
    expect(pending).toBeDefined();
    const routing = await readJson(initial.artifact_paths.review_routing);
    const oldSha: string = routing.workload_sha256;
    const currentPointer = join(artifacts, "runs", initial.run_id, "question-workload-current.json");
    const prepareOld = () => runWrapper(
      [...routing.prepare_review_argv_prefix, "--work-item", pending!.binding.assignment.assignment_id], { cwd: root });
    const oldPacket = JSON.parse((await prepareOld()).stdout);
    const { assignment, question } = answered!.binding;
    const answer: ReviewSubmission = {
      schema_version: REVIEW_QUESTION_CONTRACT_VERSION,
      submission_id: "fixture-interrupted-pointer",
      assignment_id: assignment.assignment_id,
      question_id: question.question_id,
      revision_id: question.revision_id,
      snapshot_id: question.snapshot_id,
      inspected_sources: assignment.suggested_sources.slice(0, 1),
      evidence_ids: [],
      limitations: ["Synthetic interruption fixture."],
      answer: { outcome: "inconclusive", findings: [], observations: [], parts: question.requested_parts.map(({ part_id }) => ({
        part_id, outcome: "inconclusive", observation_ids: [], reason: "No observation in this fixture.",
      })) },
    };
    const answerPath = resolve(root, answered!.result_path);
    await mkdir(dirname(answerPath), { recursive: true });
    await writeFile(answerPath, JSON.stringify(answer));
    const preload = join(artifacts, "fault-before-publish.mjs");
    await writeFile(preload, [
      'import fs from "node:fs/promises";',
      'import { syncBuiltinESMExports } from "node:module";',
      'import { basename, relative, sep } from "node:path";',
      'const rename = fs.rename;',
      'fs.rename = async (from, to) => {',
      '  const path = relative(process.env.DOT_FAULT_ARTIFACTS, String(to));',
      '  const target = basename(path);',
      '  if (!path.startsWith("..") && target === process.env.DOT_FAULT_TARGET &&',
      '      (target !== "current-step.json" || path.split(sep)[0] === "steps")) {',
      '    throw Object.assign(new Error("synthetic publication interruption: " + target), { code: "EIO" });',
      '  }',
      '  return rename(from, to);',
      '};',
      'syncBuiltinESMExports();',
    ].join("\n"));
    const interrupt = (target: string) => runWrapper(["next-step"], { cwd: root, env: {
      NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
      DOT_FAULT_ARTIFACTS: artifacts,
      DOT_FAULT_TARGET: target,
    } });
    await expect(interrupt("question-workload-current.json")).rejects.toThrow(/synthetic publication interruption: question-workload-current.json/);
    expect(await readJson(currentPointer)).toEqual({ sha256: oldSha });
    expect(JSON.parse((await prepareOld()).stdout)).toEqual(oldPacket);

    await expect(interrupt("current-step.json")).rejects.toThrow(/synthetic publication interruption: current-step.json/);
    const advanced = await readJson(currentPointer);
    expect(advanced.sha256).not.toBe(oldSha);
    await expect(prepareOld()).rejects.toThrow(/fingerprint is not current/);

    const resumed = JSON.parse((await runWrapper(["next-step"], { cwd: root })).stdout);
    expect(resumed.step_kind).toBe("dispatch_review");
    expect(resumed.run_id).toBe(initial.run_id);
    const resumedRouting = await readJson(resumed.artifact_paths.review_routing);
    expect(resumedRouting.workload_sha256).toBe(advanced.sha256);
    expect(resumedRouting.assignments.map(({ assignment_id }: { assignment_id: string }) => assignment_id))
      .toEqual(routing.assignments.slice(1).map(({ assignment_id }: { assignment_id: string }) => assignment_id));
    const resumedWorkload = await readJson(resumed.artifact_paths.host_workload);
    expect(resumedWorkload.source_root).toBe(workload.source_root);
    expect(resumedWorkload.source_files).toEqual(workload.source_files);
    expect(await readFile(snapshot, "utf8")).toBe(frozenBytes);
    const currentPacket = JSON.parse((await runWrapper(
      [...resumedRouting.prepare_review_argv_prefix, "--work-item", pending!.binding.assignment.assignment_id], { cwd: root })).stdout);
    expect(await readFile(currentPacket.prompt_path, "utf8")).toBe(await readFile(oldPacket.prompt_path, "utf8"));
  });
});
