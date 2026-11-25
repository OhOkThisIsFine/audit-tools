import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { indexQuestionDependencies, projectQuestionReview, reviewAnswerDisposition, type AuditQuestionBinding } from "../../src/audit/cli/dispatch/questionReviewAcceptance.js";
import { adjudicateAuditQuestionResult, consolidateAuditQuestionFindings, ingestAuditQuestionResults, publishAuditQuestionWorkload, readAuditQuestionLedger, readAuditQuestionWorkload, reopenAuditQuestions, submitAuditQuestionResult } from "../../src/audit/cli/dispatch/hostHandoff.js";
import { REVIEW_QUESTION_CONTRACT_VERSION, questionReopenDependencies, type ReviewAcceptedAnswer, type ReviewEvidence, type ReviewSubmission } from "../../src/shared/types/reviewQuestion.js";

const v = REVIEW_QUESTION_CONTRACT_VERSION;
const identity = { schema_version: v, question_id: "resume", revision_id: "r1", snapshot_id: "s1" } as const;
const ref = { path: "src/manual.ts", start_line: 1 };
const source = { kind: "source", key: ref.path, fingerprint: "manual-v1" } as const;
const membership = { kind: "membership", key: "registered-resume", fingerprint: "manual,schedule" } as const;
const makeBinding = (id: string): AuditQuestionBinding => ({
  question: { ...identity, lens: "behavior", inventory_item_ids: ["resume"], expected_outcome: "preserve unfinished work",
    requested_parts: [{ part_id: "manual", expectation: "preserve work" }, { part_id: "scheduled", expectation: "preserve work" }],
    source_dependencies: [membership], evidence_dependencies: [], plan_status: "pending" },
  assignment: { ...identity, assignment_id: id, authorized_scope: { include: ["src"], exclude: ["src/vendor"] },
    suggested_sources: [{ path: "src/scheduled.ts" }], available_evidence_ids: [] },
  sourceFiles: [{ path: ref.path, line_count: 10, fingerprint: source.fingerprint },
    { path: "src/scheduled.ts", line_count: 1, fingerprint: "scheduled-v1" },
    { path: "src/vendor/ignored.ts", line_count: 3, fingerprint: "vendor" }],
  evidence: [], dependencies: [membership],
});
function submission(id: string, outcome: "clean" | "findings"): ReviewSubmission {
  return { ...identity, assignment_id: id, submission_id: `response-${id}`,
    inspected_sources: [ref], evidence_ids: [], limitations: ["Scheduled path not inspected"],
    answer: { outcome, findings: outcome === "findings" ? [{
      schema_version: v, question_id: identity.question_id, revision_id: identity.revision_id,
      finding_id: "fixture-lead", kind: "lead", severity: "low", confidence: "medium",
      claim: "The resumed work needs follow-up", consequence: "The fixture does not establish an actionable defect",
      next_step: "Inspect the remaining transition", source_refs: [ref], evidence_ids: [], observation_ids: ["seen"], verification: [],
    }] : [], parts: [{ part_id: "manual", outcome, observation_ids: ["seen"] }],
      observations: [{ ...identity, observation_id: "seen", part_id: "manual", kind: "source_confirmed",
        statement: `${outcome} on manual path`, source_refs: [ref], evidence_refs: [] }] },
  };
}

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "audit-question-acceptance-"));
  try { await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

describe("question review acceptance", () => {
  it("projects the same current and stale history using one shared frozen-source index", () => {
    const { question } = makeBinding("a");
    const answers: ReviewAcceptedAnswer[] = [{ schema_version: v, accepted_at: "2026-01-01T00:00:00Z",
      submission: submission("a", "clean"), dependency_bindings: [source, membership] }];
    const cases = [source, { ...source, fingerprint: "manual-v2" }];
    for (const frozen of cases) {
      const legacy = projectQuestionReview(question, answers, [frozen, membership]);
      const indexed = projectQuestionReview(question, answers, {
        sourceIndex: indexQuestionDependencies([frozen]), local: [membership],
      });
      expect(indexed).toEqual(legacy);
      expect(indexed.current).toHaveLength(frozen === source ? 1 : 0);
      expect(indexed.stale).toHaveLength(frozen === source ? 0 : 1);
    }
  });

  it.each(["unsupported", "blocked", "conflicted", "adjudicated"] as const)(
    "does not reserve any claim for a %s consolidation",
    async problem => fixture(async root => {
      const params = { root, artifactsDir: join(root, ".audit-tools", "audit"), runId: "question-run" };
      const bad = makeBinding("bad");
      const independent = (id: string) => {
        const binding = makeBinding(id);
        binding.question.question_id = binding.assignment.question_id = `question-${id}`;
        return binding;
      };
      const first = independent("good-one");
      const second = independent("good-two");
      const contrary = makeBinding("contrary");
      const bindings = [bad, first, second, ...(problem === "conflicted" || problem === "adjudicated" ? [contrary] : [])];
      await publishAuditQuestionWorkload({ ...params, sourceRoot: root, bindings });
      const defect = (binding: AuditQuestionBinding, unscoped = false) => {
        const reply = submission(binding.assignment.assignment_id, "findings");
        const question = binding.question;
        reply.question_id = reply.answer.observations[0]!.question_id = question.question_id;
        reply.answer.findings = [{
          schema_version: v, finding_id: "defect", question_id: question.question_id, revision_id: question.revision_id,
          kind: "confirmed_defect", severity: "medium", confidence: "high",
          claim: "Ordinary fixture loses work", consequence: "Pending item not restored",
          next_step: "Restore the pending item", source_refs: unscoped ? [] : [ref],
          evidence_ids: [], observation_ids: ["seen"], verification: [],
        }];
        return reply;
      };
      for (const binding of [bad, first, second]) {
        const reply = defect(binding, binding === bad && problem === "unsupported");
        expect((await submitAuditQuestionResult({
          ...params, assignmentId: reply.assignment_id, source: JSON.stringify(reply),
        })).kind).toBe("accepted");
      }
      if (bindings.includes(contrary)) {
        expect((await submitAuditQuestionResult({
          ...params, assignmentId: "contrary", source: JSON.stringify(submission("contrary", "clean")),
        })).kind).toBe("accepted");
      }
      if (problem === "adjudicated") {
        await adjudicateAuditQuestionResult({ ...params, adjudication: {
          ...identity, adjudication_id: "resolve-bad", reviewer: "fixture reviewer", decision: "resolved",
          rationale: "Independent evidence confirms the ordinary result",
          submission_ids: ["response-bad", "response-contrary"], selected_submission_ids: ["response-contrary"],
        } });
      }
      if (problem === "blocked") {
        bad.question.plan_status = "blocked";
        bad.question.plan_reason = "Fixture now lacks a required review input.";
      }
      const ledger = join(params.artifactsDir, "runs", params.runId, "host-accepted-results-ledger.json");
      const original = await readFile(ledger, "utf8");
      const base = {
        ...params, questions: [bad.question, first.question, second.question], evidence: [],
        dependenciesByQuestion: new Map([bad, first, second].map(({ question }) => [
          question.question_id, [membership, source],
        ])),
      };
      const review = { decision_id: "same-repair", decided_by: "fixture operator", reason: "Same underlying repair" };
      const refFor = (answer: string) => ({ answer_id: `response-${answer}`, finding_id: "defect" });
      await expect(consolidateAuditQuestionFindings({
        ...base, decision: { ...review, sources: [refFor("bad"), refFor("good-one")] },
      })).rejects.toThrow(/current actionable confirmed-defect claims/);
      expect(await readFile(ledger, "utf8")).toBe(original);

      const goodDecision = { ...review, sources: [refFor("good-one"), refFor("good-two")] };
      await expect(consolidateAuditQuestionFindings({ ...base, decision: goodDecision })).resolves.toBe("accepted");
      expect(JSON.parse(await readFile(ledger, "utf8")).consolidations).toEqual([goodDecision]);
    }),
  );


  it("retains an issued part that the reviewer did not answer", () => {
    expect(reviewAnswerDisposition(["manual", "scheduled"], [
      { part_id: "manual", outcome: "clean", observation_ids: ["manual-observed"] },
    ])).toEqual({ answered: ["manual"], open: ["scheduled"] });
  });

  it.each([["a", "b"], ["b", "a"]])("retains contradictory answers across resume in order %s then %s", async (first, second) => {
    await fixture(async (root) => {
      const params = { root, artifactsDir: join(root, ".audit-tools", "audit"), runId: "question-run" };
      const a = makeBinding("a"), b = makeBinding("b");
      const publish = () => publishAuditQuestionWorkload({ ...params, sourceRoot: root, bindings: [a, b] });
      const { workload, workload_path } = await publish();
      const workloadBytes = await readFile(workload_path, "utf8");
      const responses = { a: submission("a", "clean"), b: submission("b", "findings") };
      const submit = (id: string) => submitAuditQuestionResult({ ...params, assignmentId: id,
        source: JSON.stringify(responses[id as keyof typeof responses]) });
      expect((await submit(first)).kind).toBe("accepted");
      const resumed = await ingestAuditQuestionResults(params);
      expect(resumed.answers.map((row) => row.submission.assignment_id)).toEqual([first]);
      await publish();
      expect(await readFile(workload_path, "utf8")).toBe(workloadBytes);
      expect(projectQuestionReview(a.question, resumed.answers, [source, membership]).parts.map((part) => part.state)).toEqual([
        first === "a" ? "clean" : "findings", "open",
      ]);
      const item = workload.work_items.find((row) => row.binding.assignment.assignment_id === second)!;
      const result = join(root, item.result_path);
      await mkdir(dirname(result), { recursive: true });
      await writeFile(result, JSON.stringify(responses[second as keyof typeof responses]));
      expect((await ingestAuditQuestionResults(params)).accepted_count).toBe(1);
      expect((await submit(first)).kind).toBe("replay");
      const loaded = await ingestAuditQuestionResults(params);
      expect(loaded.accepted_count).toBe(0);
      expect(projectQuestionReview(a.question, loaded.answers, [source, membership]).parts.map((part) => part.state)).toEqual(["disputed", "open"]);
      expect(loaded.answers).toHaveLength(2);
      expect(loaded.answers[0]).toEqual(resumed.answers[0]);
      await expect(submitAuditQuestionResult({ ...params, assignmentId: "a", source: JSON.stringify(submission("a", "findings")) })).rejects.toThrow(/Conflicting reuse/);
      const changed = { ...membership, fingerprint: "manual,schedule,restore" };
      expect(projectQuestionReview(a.question, loaded.answers, [source, changed]).stale).toHaveLength(2);
      expect((await readAuditQuestionWorkload(params)).work_items).toHaveLength(2);
      await expect(adjudicateAuditQuestionResult({ ...params, adjudication: { ...identity, adjudication_id: "comparison", reviewer: "independent reviewer", decision: "resolved", rationale: "Rechecked the manual outcome", submission_ids: ["response-a", "response-b"], selected_submission_ids: ["response-a"] } })).resolves.toBe("accepted");
      const resolved = await ingestAuditQuestionResults(params);
      expect(projectQuestionReview(a.question, resolved.answers, [source, membership], resolved.adjudications).parts.map((part) => part.state)).toEqual(["clean", "open"]);
    });
  });

  it("refuses out-of-scope evidence and a late old revision without erasing originals", async () => {
    await fixture(async (root) => {
      const params = { root, artifactsDir: join(root, ".audit-tools", "audit"), runId: "question-run" };
      const a = makeBinding("a");
      await publishAuditQuestionWorkload({ ...params, sourceRoot: root, bindings: [a] });
      const response = submission("a", "clean");
      await expect(submitAuditQuestionResult({ ...params, assignmentId: "a",
        source: JSON.stringify({ ...response, inspected_sources: [{ path: "src/vendor/ignored.ts" }] }) })).rejects.toThrow(/outside this assignment/);
      await submitAuditQuestionResult({ ...params, assignmentId: "a", source: JSON.stringify(response) });
      await publishAuditQuestionWorkload({ ...params, sourceRoot: root, bindings: [makeBinding("b")] });
      await expect(submitAuditQuestionResult({ ...params, assignmentId: "a", source: JSON.stringify(response) })).rejects.toThrow(/not in the current/);
      expect((await ingestAuditQuestionResults(params)).answers.map((row) => row.submission)).toEqual([response]);
    });
  });

  it("reopens only the dependent question when a discovery adds a member", async () => {
    await fixture(async (root) => {
      const params = { root, artifactsDir: join(root, ".audit-tools", "audit"), runId: "question-run" };
      const a = makeBinding("a"), unrelated = makeBinding("b");
      const invariant = { kind: "membership", key: "settings-readers", fingerprint: "stable" } as const;
      unrelated.question.question_id = unrelated.assignment.question_id = "settings";
      unrelated.question.source_dependencies = [invariant];
      unrelated.dependencies = [invariant];
      await publishAuditQuestionWorkload({ ...params, sourceRoot: root, bindings: [a, unrelated] });
      await submitAuditQuestionResult({ ...params, assignmentId: "a", source: JSON.stringify(submission("a", "clean")) });
      const response = submission("b", "clean");
      response.question_id = response.answer.observations[0]!.question_id = "settings";
      await submitAuditQuestionResult({ ...params, assignmentId: "b", source: JSON.stringify(response) });
      const resumed = await ingestAuditQuestionResults(params);
      const changed = { ...membership, fingerprint: "manual,schedule,restore" };
      expect(projectQuestionReview(a.question, resumed.answers, [source, changed]).parts.every((part) => part.state === "open")).toBe(true);
      expect(projectQuestionReview(unrelated.question, resumed.answers, [source, invariant]).parts.map((part) => part.state)).toEqual(["clean", "open"]);
      // A referenced source outside the suggested entrypoints is still a binding.
      expect(projectQuestionReview(unrelated.question, resumed.answers, [{ ...source, fingerprint: "manual-v2" }, invariant]).stale).toHaveLength(1);
    });
  });

  it("requires actual named executed evidence for a runtime observation", async () => {
    await fixture(async (root) => {
      const params = { root, artifactsDir: join(root, ".audit-tools", "audit"), runId: "question-run" };
      const a = makeBinding("a");
      const evidence: ReviewEvidence = { schema_version: v, evidence_id: "fixture", snapshot_id: "s1", kind: "fixture",
        source_refs: [ref], dependencies: [source], status: "observed", description: "Synthetic fixture",
        observations: [{ observation_id: "actual", statement: "Retained work" }] };
      a.assignment.available_evidence_ids = [evidence.evidence_id];
      a.evidence = [evidence];
      const response = submission("a", "clean");
      response.evidence_ids = [evidence.evidence_id];
      const observed = response.answer.observations[0]!;
      observed.kind = "runtime_observed";
      observed.evidence_refs = [{ evidence_id: evidence.evidence_id, observation_id: "actual" }];
      const submit = () => submitAuditQuestionResult({ ...params, assignmentId: "a", source: JSON.stringify(response) });
      await publishAuditQuestionWorkload({ ...params, sourceRoot: root, bindings: [a] });
      await expect(submit()).rejects.toThrow(/unavailable or unissued evidence/);
      const executed = makeBinding("b");
      executed.assignment.available_evidence_ids = [evidence.evidence_id];
      executed.evidence = [{ ...evidence, execution: { tool: "test runner", tool_version: "1", config_fingerprint: "c",
        input_fingerprint: "i", environment_fingerprint: "env", exclusions: [], executed: true } }];
      await publishAuditQuestionWorkload({ ...params, sourceRoot: root, bindings: [executed] });
      const submitted = (observation_id: string) => submitAuditQuestionResult({ ...params, assignmentId: "b",
        source: JSON.stringify({ ...response, assignment_id: "b", answer: { ...response.answer,
          observations: [{ ...observed, evidence_refs: [{ evidence_id: evidence.evidence_id, observation_id }] }] } }) });
      await expect(submitted("missing")).rejects.toThrow(/unavailable or unissued evidence/);
      await expect(submitted("actual")).resolves.toMatchObject({ kind: "accepted" });
    });
  });
});

it("rejects unrelated claim evidence and duplicate local IDs without writing accepted results", async () => {
  await fixture(async root => {
    const params = { root, artifactsDir: join(root, ".audit-tools", "audit"), runId: "claim-run" };
    await publishAuditQuestionWorkload({ ...params, sourceRoot: root, bindings: [makeBinding("a")] });
    const response = submission("a", "findings");
    response.answer.parts.push({ part_id: "scheduled", outcome: "inconclusive", observation_ids: ["other"] });
    response.answer.observations.push({
      ...identity, observation_id: "other", part_id: "scheduled", kind: "source_confirmed",
      statement: "Read a helper but did not verify the schedule.", source_refs: [ref], evidence_refs: [],
    });
    const claim = {
      ...identity, finding_id: "local", kind: "confirmed_defect" as const, severity: "medium" as const, confidence: "high" as const,
      claim: "Schedule leaves work behind", consequence: "Work remains pending", next_step: "Correct the transition",
      source_refs: [ref], evidence_ids: [], observation_ids: ["other"], verification: [],
    };
    const submit = () => submitAuditQuestionResult({ ...params, assignmentId: "a", source: JSON.stringify(response) });
    const { snapshot_id: _, ...wireClaim } = claim;
    response.answer.findings = [wireClaim];
    await expect(submit()).rejects.toThrow("own supported findings-part observation");
    expect((await ingestAuditQuestionResults(params)).answers).toEqual([]);
    wireClaim.observation_ids = ["seen"];
    response.answer.findings = [wireClaim, { ...wireClaim, claim: "Different claim with same local ID" }];
    await expect(submit()).rejects.toThrow("Duplicate local finding ID");
    expect((await ingestAuditQuestionResults(params)).answers).toEqual([]);
    response.answer.findings = [wireClaim];
    await expect(submit()).resolves.toMatchObject({ kind: "accepted" });
  });
});

it("refuses findings parts without a linked claim and accepts a linked lead", async () => {
  await fixture(async root => {
    const params = { root, artifactsDir: join(root, ".audit-tools", "audit"), runId: "claim-link-run" };
    const { workload } = await publishAuditQuestionWorkload({ ...params, sourceRoot: root, bindings: [makeBinding("a")] });
    const valid = submission("a", "findings");
    const missing = structuredClone(valid);
    missing.answer.findings = [];
    const submit = (answer: ReviewSubmission) =>
      submitAuditQuestionResult({ ...params, assignmentId: "a", source: JSON.stringify(answer) });
    await expect(submit(missing)).rejects.toThrow(/Findings part requires a claim.*manual/u);

    const unlinked = structuredClone(valid);
    delete unlinked.answer.findings[0]!.observation_ids;
    const path = join(root, workload.work_items[0]!.result_path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(unlinked));
    expect(await ingestAuditQuestionResults(params)).toMatchObject({
      accepted_count: 0, answers: [],
      issues: [{ assignment_id: "a", reason: expect.stringMatching(/Findings part requires a claim.*manual/u) }],
    });

    await writeFile(path, JSON.stringify(valid));
    expect(await ingestAuditQuestionResults(params)).toMatchObject({
      accepted_count: 1, answers: [{ submission: valid }], issues: [],
    });
  });
});
it("keeps the issued manifest stable when a pending subset is published", async () => fixture(async root => {
  const boundary = { root, artifactsDir: join(root, ".audit-tools", "audit"), runId: "question-run" };
  const a = makeBinding("a"), b = makeBinding("b");
  const first = await publishAuditQuestionWorkload({ ...boundary, sourceRoot: root, bindings: [a, b], inventoryOmissionCount: 3 });
  expect(first.workload.inventory_omission_count).toBe(3);
  expect((await readAuditQuestionWorkload(boundary)).inventory_omission_count).toBe(3);
  const original = await readFile(first.workload_path, "utf8");
  await submitAuditQuestionResult({ ...boundary, assignmentId: "a", source: JSON.stringify(submission("a", "clean")) });
  const second = await publishAuditQuestionWorkload({ ...boundary, sourceRoot: root, bindings: [b] });
  expect(second.workload_path).not.toBe(first.workload_path);
  expect(await readFile(first.workload_path, "utf8")).toBe(original);
  expect(second.workload.work_items[0]).toEqual(first.workload.work_items[1]);
  const destination = join(root, first.workload.work_items[1]!.result_path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify(submission("b", "clean")));
  expect((await ingestAuditQuestionResults(boundary)).accepted_count).toBe(1);
}));

it("reopens only an exact set of current answers and fences old work before republishing", async () => fixture(async root => {
  const boundary = { root, artifactsDir: join(root, ".audit-tools", "audit"), runId: "question-run" };
  const old = makeBinding("old"), unaffected = makeBinding("unaffected");
  unaffected.question.question_id = unaffected.assignment.question_id = "unaffected";
  const original = await publishAuditQuestionWorkload({ ...boundary, sourceRoot: root, bindings: [old, unaffected] });
  const oldReply = submission("old", "findings");
  const unaffectedReply = submission("unaffected", "clean");
  unaffectedReply.question_id = unaffectedReply.answer.observations[0]!.question_id = "unaffected";
  const submit = (reply: ReviewSubmission) => submitAuditQuestionResult({
    ...boundary, assignmentId: reply.assignment_id, source: JSON.stringify(reply),
  });
  await submit(oldReply);
  await submit(unaffectedReply);
  const initial = await readAuditQuestionLedger(boundary);
  const reopen = (reopen_id: string, expected: string, dependencies = [membership, source] as AuditQuestionBinding["dependencies"]) =>
    reopenAuditQuestions({ ...boundary, questions: [old.question, unaffected.question],
      dependenciesByQuestion: new Map([[old.question.question_id, dependencies], [unaffected.question.question_id, [membership, source]]]),
      request: { reopen_id, reason: "Prior worker answered a different question.",
        questions: [{ ...identity, expected_submission_ids: [expected] }].map(({ schema_version: _version, ...target }) => target) },
    });
  await expect(reopen("bad-id", "response-no-such-answer")).rejects.toThrow(/exactly the current/);
  expect(await readAuditQuestionLedger(boundary)).toEqual(initial);
  await expect(reopen("one", oldReply.submission_id)).resolves.toBe("accepted");
  const after = await readAuditQuestionLedger(boundary);
  expect(after.answers).toEqual(initial.answers);
  expect(after.reopens).toHaveLength(1);
  const epoch = questionReopenDependencies(after.reopens).get(old.question.question_id)!;
  expect(projectQuestionReview(old.question, after.answers, [membership, source, epoch]).current).toEqual([]);
  expect(projectQuestionReview(unaffected.question, after.answers, [membership, source]).current)
    .toEqual([initial.answers[1]]);
  await expect(submit(oldReply)).rejects.toThrow(/not in the current issued/);
  const oldFile = join(root, original.workload.work_items[0]!.result_path);
  await mkdir(dirname(oldFile), { recursive: true });
  await writeFile(oldFile, JSON.stringify({ ...oldReply, submission_id: "late-staged" }));
  expect((await ingestAuditQuestionResults(boundary)).accepted_count).toBe(0);
  const fresh = makeBinding("new");
  fresh.dependencies = [...fresh.dependencies, epoch];
  await publishAuditQuestionWorkload({ ...boundary, sourceRoot: root, bindings: [fresh] });
  const newReply = submission("new", "clean");
  await submit(newReply);
  await expect(reopen("one", oldReply.submission_id, [membership, source, epoch])).resolves.toBe("replay");
  await expect(reopen("one", newReply.submission_id, [membership, source, epoch])).rejects.toThrow(/Conflicting reopen ID/);
  await expect(reopen("two", oldReply.submission_id, [membership, source, epoch])).rejects.toThrow(/exactly the current/);
  await expect(reopen("two", newReply.submission_id, [membership, source, epoch])).resolves.toBe("accepted");
  const last = await readAuditQuestionLedger(boundary);
  expect(last.reopens.map(event => event.reopen_id)).toEqual(["one", "two"]);
  expect(last.answers.map(record => record.submission)).toEqual([oldReply, unaffectedReply, newReply]);
  await expect(submit(newReply)).rejects.toThrow(/not in the current issued/);
}));
