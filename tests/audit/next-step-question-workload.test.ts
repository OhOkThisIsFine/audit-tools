import { expect, test } from "vitest";
import { issueReviewFixture } from "./helpers/issued-review-fixture.js";
import { submitQuestions } from "./helpers/question-completion-harness.js";
import { submitWorkItemResult } from "../../src/audit/cli/submitCommand.js";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { ADVANCE_PAST_DESIGN_REVIEW_TERMINAL_KINDS, withTempRepo } from "./helpers/next-step-harness.js";
import { runWrapper } from "./helpers/run-wrapper.mjs";
import { captureConsole } from "./helpers/captureConsole.mjs";
import { runCli } from "../../src/audit/cli.js";
import { callNextStep } from "./helpers/completion-harness.js";
import { walkStepsUntilTerminal } from "./helpers/step-driver.js";
import { packageVersion } from "./helpers/wrapper-harness.js";
import { QuestionAuditFindingsReportSchema } from "../../src/shared/types/questionReviewReport.js";
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

test("wrapper packets, batch preparation and graph reads stay bound to their issued workload", async () => {
  await withTempRepo(async (root) => {
    const neighbor = "src/neighbor/isolated.ts";
    const artifactsDir = join(root, "custom audit artifacts");
    const artifactArgs = ["--artifacts-dir", artifactsDir];
    const { workload_path, routing_path, runId } = await issueReviewFixture(root, artifactsDir);
    const workload: unknown = JSON.parse(await readFile(workload_path, "utf8"));
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
    const routing = JSON.parse(await readFile(routing_path, "utf8"));
    expect(routing).toEqual({
      run_id: runId,
      workload_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      prepare_review_argv_prefix: ["prepare-review", "--root", root.split(sep).join("/"),
        "--artifacts-dir", artifactsDir.split(sep).join("/"), "--workload-sha256", routing.workload_sha256],
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
    const readPacket = async (item: WorkItem, handle: { prompt_path: string; read_paths: { graph_sha256: string } }) => {
      const assignment_id = item.binding.assignment.assignment_id;
      expect(handle).toEqual({ run_id: runId, assignment_id, workload_sha256: routing.workload_sha256,
        prompt_path: expect.any(String), read_paths: {
          source_root: expect.any(String), source_index: expect.any(String), submission_schema: expect.any(String),
          graph_index: expect.any(String), graph_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        } });
      const prompt = await readFile(handle.prompt_path, "utf8");
      expect(prompt).not.toContain(workload_path);
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
    const receipt = join(artifactsDir.split(sep).join("/"), ".fold-receipt.json");
    await writeFile(receipt, "{}");
    await expect(rejectPrepare(first.binding.assignment.assignment_id)).rejects.toThrow(/incomplete fold receipt/);
    await unlink(receipt);
    const selected = await readPacket(first, JSON.parse((await prepare(first.binding.assignment.assignment_id)).stdout));
    const other = workItems[1]!;
    const firstId = first.binding.assignment.assignment_id;
    const otherId = other.binding.assignment.assignment_id;
    const prepareBatch = (ids: string) =>
      runWrapper([...routing.prepare_review_argv_prefix, "--work-items", ids], { cwd: dirname(root) });
    const prepareBatchInProcess = (ids: string, digest = routing.workload_sha256) =>
      runCommand([...routing.prepare_review_argv_prefix.slice(0, -1), digest, "--work-items", ids], { cwd: root });
    const batch = JSON.parse((await prepareBatch(otherId + ",unissued," + firstId)).stdout);
    const second = await readPacket(other, batch.outcomes[0].packet);
    expect(batch).toEqual({ run_id: runId, workload_sha256: routing.workload_sha256, outcomes: [
      { status: "ready", packet: second.handle },
      { status: "refused", assignment_id: "unissued", message: "Review assignment is not in the current issued workload" },
      { status: "ready", packet: selected.handle },
    ] });
    await expect(prepareBatchInProcess(firstId + "," + firstId)).rejects.toThrow(/distinct review assignment IDs/);
    await expect(prepareBatchInProcess(firstId, "0".repeat(64))).rejects.toThrow(/fingerprint is not current/);
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
    // An already-issued workload from the previous layout still binds the
    // same digest, with the graph and optional index cache rooted in its run.
    const legacyGraph = join(artifactsDir.split(sep).join("/"), "runs", runId, "review-graph-index", selected.packet.graph_sha256 + ".json");
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
    {
      const { question, assignment } = first.binding;
      const response: ReviewSubmission = {
        schema_version: REVIEW_QUESTION_CONTRACT_VERSION,
        submission_id: `standalone-${assignment.assignment_id}`,
        assignment_id: assignment.assignment_id, question_id: question.question_id,
        snapshot_id: question.snapshot_id, revision_id: question.revision_id,
        inspected_sources: [
          ...assignment.suggested_sources.slice(0, 1),
          { path: neighbor },
        ], evidence_ids: [],
        limitations: ["Synthetic review did not establish the requested behavior."],
        answer: { outcome: "inconclusive", findings: [], observations: [], parts: question.requested_parts.map(part => ({
          part_id: part.part_id, outcome: "inconclusive", observation_ids: [],
        })) },
      };
      const file = resolve(root, first.result_path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(response));
      const readLedger = () => existsSync(ledgerFile) ? readFile(ledgerFile) : undefined;
      const ledgerBeforeRefusal = await readLedger();
      await writeFile(file, JSON.stringify({ ...response, answer: {
        ...response.answer, parts: [{ part_id: "not-an-assigned-part", outcome: "inconclusive", observation_ids: [] }],
      } }));
      await expect(runCommand(["submit", ...artifactArgs, "--work-item", assignment.assignment_id, "--from", file], { cwd: root }))
        .rejects.toThrow(/Unknown or duplicate requested part/);
      expect(await readLedger()).toEqual(ledgerBeforeRefusal);
      await writeFile(file, JSON.stringify(response));
      const accepted = await runWrapper(["submit", "--root", root, ...artifactArgs, "--work-item", assignment.assignment_id, "--from", file], { cwd: dirname(root) });
      expect(JSON.parse(accepted.stdout)).toMatchObject({ disposition: "accepted", submission_id: response.submission_id });
      await expect(rejectPrepare(assignment.assignment_id)).rejects.toThrow(/already has an accepted answer/);
      const partiallyAccepted = JSON.parse((await prepareBatch(firstId + "," + otherId)).stdout);
      expect(partiallyAccepted.outcomes).toEqual([
        { status: "refused", assignment_id: firstId, message: "Review assignment already has an accepted answer." },
        { status: "ready", packet: second.handle },
      ]);
    }
  });
});

type WorkItem = { binding: { question: ReviewQuestion; assignment: ReviewAssignment }; result_path: string };

test("interrupted workload and step publication resume the same frozen snapshot", async () => {
  await withTempRepo(async (root) => {
    const initial = await prepareWorkload(root);
    expect(initial.step_kind).toBe("dispatch_review");
    const handoff = await readFile(initial.prompt_path, "utf8");
    expect(handoff).toContain("Read only the routing metadata");
    expect(handoff).toContain("The command returns a prompt_path, not the prompt.");
    expect(handoff).toContain("With delegation, pass that file directly to the reviewer harness");
    expect(handoff).toContain("If the host truly cannot delegate, prepare exactly one pending assignment");
    expect(handoff).toContain("run the continuation once to ingest it, then stop for fresh context");
    expect(handoff).toContain("or substitute self-review for any step that requires independence");
    expect(handoff).toContain("retain the exact query, its returned status or stderr, and the frozen source identity");
    expect(handoff).not.toContain(initial.artifact_paths.host_workload);
    expect(handoff).toMatch(/Read only the routing metadata at:/u);
    expect(handoff).toMatch(/next-step/u);
    expect(handoff).not.toMatch(/merge-and-ingest|\bprovider\b|\bmodel(?:_id)?\b|\broute\b|\bquota\b/iu);
    expect(initial.run_id).toBeTruthy();
    expect(initial.artifact_paths.host_workload).toMatch(/host-workload\.json$/u);
    expect(initial.artifact_paths.review_routing).toMatch(/review-routing\.json$/u);
    expect(initial.artifact_paths.host_result_map).toBeUndefined();
    expect(initial.step_kind).toBe("dispatch_review");
    expect(initial.allowed_commands).toHaveLength(1);
    expect(initial.allowed_commands[0]).toMatch(/next-step/u);
    expect(initial.artifact_paths.dispatch_plan).toBeUndefined();
    expect(initial.artifact_paths.dispatch_quota).toBeUndefined();
    const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));
    const artifacts = initial.artifacts_dir;
    const currentStep = await readJson(join(artifacts, "steps", "current-step.json"));
    expect(currentStep.step_kind).toBe("dispatch_review");
    expect(currentStep.artifact_paths.host_workload).toBe(initial.artifact_paths.host_workload);
    await expect(runCommand(["next-step", "--guidance", "Do a different audit"], { cwd: root }))
      .rejects.toThrow(/active question review cannot change guidance/u);
    const snapshot = join(artifacts, "run-snapshot.json");
    const frozenBytes = await readFile(snapshot, "utf8");
    const workload = await readJson(initial.artifact_paths.host_workload) as {
      run_id: string; source_root: string; source_files: unknown[]; work_items: WorkItem[];
    };
    expect(initial.progress?.pending_tasks).toBe(workload.work_items.length);
    expect(workload.run_id).toBe(initial.run_id);
    const resultDir = join(root, ".audit-tools", "audit", "runs", workload.run_id, "host-results");
    const destinations = new Set(workload.work_items.map(item => resolve(root, item.result_path)));
    expect(destinations.size).toBe(workload.work_items.length);
    for (const { binding: { assignment, question }, result_path } of workload.work_items) {
      expect(handoff).not.toContain(question.question_id);
      expect(assignment).toMatchObject({ question_id: question.question_id, revision_id: question.revision_id, snapshot_id: question.snapshot_id });
      expect(assignment.assignment_id).toMatch(/^review-/u);
      expect(dirname(resolve(root, result_path))).toBe(resultDir);
    }
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
    const ledgerFile = join(artifacts, "runs", initial.run_id, "host-accepted-results-ledger.json");
    const readLedger = () => existsSync(ledgerFile) ? readFile(ledgerFile) : undefined;
    const ledgerBeforeRefusal = await readLedger();
    await expect(runCommand(["force-synthesis"], { cwd: root })).rejects.toThrow(/report-ready state/);
    expect(await readLedger()).toEqual(ledgerBeforeRefusal);
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
    await expect(interrupt("current-step.json")).rejects.toThrow(/synthetic publication interruption: current-step.json/);
    const advanced = await readJson(currentPointer);
    expect(advanced.sha256).not.toBe(oldSha);
    await expect(runCommand([...routing.prepare_review_argv_prefix,
      "--work-item", pending!.binding.assignment.assignment_id], { cwd: root })).rejects.toThrow(/fingerprint is not current/);

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

    for (const submission of await submitQuestions(root, resumedWorkload.work_items)) {
      const accepted = await submitWorkItemResult({
        root, artifactsDir: artifacts, workItemId: submission.assignment_id, source: JSON.stringify(submission),
      });
      expect(accepted.disposition).toBe("accepted");
    }
    const ledgerBefore = await readFile(ledgerFile);
    const { stdout } = await runCommand(["synthesize"], { cwd: root });
    expect(JSON.parse(stdout)).toMatchObject({ selected_executor: "synthesis_executor" });
    const report = QuestionAuditFindingsReportSchema.parse(JSON.parse(await readFile(join(artifacts, "audit-findings.json"), "utf8")));
    expect(report.question_review.questions).toHaveLength(workload.work_items.length);
    expect(report.question_review.completion).toBe("incomplete");
    expect(report.question_review.accepted.some(({ submission }) => submission.submission_id === answer.submission_id)).toBe(true);
    expect(await readFile(ledgerFile)).toEqual(ledgerBefore);
    const next = await runCommand(["next-step"], { cwd: root });
    expect(JSON.parse(next.stdout).step_kind).toBe("synthesis_narrative");
  });
});
