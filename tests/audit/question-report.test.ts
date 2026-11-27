import { expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildQuestionAuditFindingsReport } from "../../src/audit/reporting/questionReport.js";
import { normalizeExistingFindingsReport, renderAuditReportMarkdown } from "../../src/audit/reporting/synthesis.js";
import { QuestionAuditFindingsReportSchema } from "../../src/shared/types/questionReviewReport.js";
import type { ReviewAcceptedAnswer, ReviewFindingClaim } from "../../src/shared/types/reviewQuestion.js";
import {
  runQuestionSynthesisExecutor, runQuestionSynthesisNarrativeExecutor,
} from "../../src/audit/orchestrator/synthesisExecutors.js";
import { renderSynthesisNarrativePrompt } from "../../src/audit/reporting/synthesisNarrativePrompt.js";
import { buildTerminalStep } from "../../src/audit/cli/nextStepHelpers.js";
import { renderPresentReportPrompt } from "../../src/audit/cli/prompts.js";
import { loadArtifactBundle, promoteFinalAuditReport, writeCoreArtifacts } from "../../src/audit/io/artifacts.js";
import { markRunEnded, rollOverFinishedRun } from "../../src/audit/io/rollover.js";
import { ensureQuestionReviewRunIdUnlocked } from "../../src/audit/cli/questionReviewSession.js";
import { auditArtifactsDir, promotedAuditFindingsPath, promotedAuditReportPath } from "audit-tools/shared";

const schema_version = "audit-tools/question-review/v1" as const;
const binding = { question_id: "resume", revision_id: "r1", snapshot_id: "s1" };
const src = { path: "src/resume.ts", start_line: 1 };
const sourceDependency = { kind: "source" as const, key: src.path, fingerprint: "source-r1" };
const dependenciesByQuestion = new Map([[binding.question_id, [sourceDependency]]]);
const plan = {
  schema_version, snapshot_id: "s1", omissions: [],
  inventory: [{
    inventory_item_id: "resume-operation", kind: "operation" as const, title: "Resume",
    contract_refs: [src], source_refs: [src], scope: "in_scope" as const,
  }],
  lens_decisions: [{ lens: "behavior" as const, decision: "selected" as const, reason: "Resume behavior" }],
  questions: [{
    ...binding, schema_version, lens: "behavior" as const, inventory_item_ids: ["resume-operation"],
    expected_outcome: "Both paths restore pending state.",
    requested_parts: [
      { part_id: "manual", expectation: "Manual resume restores state." },
      { part_id: "scheduled", expectation: "Scheduled resume restores state." },
    ],
    source_dependencies: [], evidence_dependencies: [], plan_status: "active" as const,
  }],
};
const accepted: ReviewAcceptedAnswer[] = [{
  schema_version, accepted_at: "2026-11-21T00:00:00Z", dependency_bindings: [sourceDependency],
  submission: {
    ...binding, schema_version, submission_id: "answer-1", assignment_id: "assignment-1",
    inspected_sources: [src], evidence_ids: [], limitations: ["Scheduled path not reached."],
    answer: {
      outcome: "clean" as const, findings: [],
      observations: [{
        ...binding, schema_version, observation_id: "manual-check", part_id: "manual",
        kind: "source_confirmed" as const, statement: "Manual resume restores saved state.",
        source_refs: [src], evidence_refs: [],
      }],
      parts: [{ part_id: "manual", outcome: "clean" as const, observation_ids: ["manual-check"] }],
    },
  },
}];

test("does not promote a supported clean part into clean coverage of an unanswered part after reload", () => {
  const inputs = { plan, accepted, evidence: [], auditRead: null, dependenciesByQuestion };
  const built = buildQuestionAuditFindingsReport(inputs);
  const report = QuestionAuditFindingsReportSchema.parse(JSON.parse(JSON.stringify(built)));
  expect(report).toMatchObject({
    question_review: {
      completion: "incomplete",
      questions: [{
        question_id: "resume", state: "inconclusive",
        parts: [{ part_id: "manual", state: "clean" }, { part_id: "scheduled", state: "unreviewed" }],
      }],
    },
  });
  expect(normalizeExistingFindingsReport(report)).toEqual(report);
  const markdown = renderAuditReportMarkdown(report);
  expect(markdown).toContain("reported inspection is not independently observed");
  expect(markdown).toContain("scheduled: **unreviewed**");
  expect(markdown).toContain("Evidence needed for scheduled: Collect evidence for the expectation: Scheduled resume restores state.");
  expect(markdown).toContain("Accepted answer answer-1 (recorded, not a resolution)");
  expect(renderAuditReportMarkdown(report)).not.toContain("completed audit");
});

test("renders question history in input order and inventory only when no question refers to it", () => {
  const first = accepted[0]!;
  const report = buildQuestionAuditFindingsReport({ plan, accepted, evidence: [], auditRead: null, dependenciesByQuestion });
  const review = report.question_review;
  const resume = review.questions[0]!;
  const other = { ...resume, question_id: "other", inventory_item_ids: ["shared"], accepted_answer_ids: ["other-answer"] };
  const rename = (question_id: string, submission_id: string) =>
    ({ ...first, submission: { ...first.submission, question_id, submission_id } });
  const decision = {
    ...binding, schema_version, reviewer: "reviewer", decision: "resolved" as const,
    submission_ids: [first.submission.submission_id], selected_submission_ids: [first.submission.submission_id],
    rationale: "Recorded history.",
  };
  // Render the supplied report, not a new projection that could dedupe or sort the history.
  const markdown = renderAuditReportMarkdown({ ...report, question_review: {
    ...review, questions: [{ ...resume, inventory_item_ids: [...resume.inventory_item_ids, "shared"] }, other],
    inventory: [...review.inventory,
      { ...review.inventory[0]!, inventory_item_id: "shared", title: "Shared" },
      { ...review.inventory[0]!, inventory_item_id: "unassigned", title: "Unassigned" }],
    accepted: [rename("resume", "z-history"), rename("other", "other-answer"), first, first],
    adjudications: [
      { ...decision, adjudication_id: "z-decision" },
      { ...decision, question_id: "other", adjudication_id: "other-decision" },
      { ...decision, adjudication_id: "a-decision" },
    ],
  } });
  expect(markdown.split("\n").filter(line => /^- (Accepted answer|Historical answer|Recorded decision|Unassigned|Shared)/u.test(line)))
    .toEqual([
      "- Historical answer z-history",
      "- Accepted answer answer-1 (recorded, not a resolution)",
      "- Accepted answer answer-1 (recorded, not a resolution)",
      "- Recorded decision z-decision (resolved, reviewer): Recorded history.",
      "- Recorded decision a-decision (resolved, reviewer): Recorded history.",
      "- Accepted answer other-answer (recorded, not a resolution)",
      "- Recorded decision other-decision (resolved, reviewer): Recorded history.",
      "- Unassigned: in scope, no question planned.",
    ]);
});

function finding(id: string, kind: ReviewFindingClaim["kind"] = "confirmed_defect"): ReviewFindingClaim {
  return {
    schema_version, finding_id: id, question_id: binding.question_id, revision_id: binding.revision_id,
    kind, severity: "medium", confidence: "high", claim: "Resume does not restore state",
    consequence: "The selected work does not continue.", next_step: "Repair the reset rule.",
    source_refs: [src], evidence_ids: [], observation_ids: ["manual-check"],
    verification: [{ kind: "assertion", obligation_id: `verify-${id}`, expected: "Restores state", source_refs: [src] }],
  };
}

function answer(id: string, findings: ReviewFindingClaim[]): ReviewAcceptedAnswer {
  const seed = accepted[0]!;
  return {
    ...seed,
    submission: {
      ...seed.submission, submission_id: id, assignment_id: `assignment-${id}`,
      answer: {
        ...seed.submission.answer, outcome: "findings", findings,
        parts: [{ part_id: "manual", outcome: "findings", observation_ids: ["manual-check"] }],
      },
    },
  };
}

test("consolidates only recorded same-repair claims and retains their separate obligations", () => {
  const a = answer("a", [finding("a-finding"), finding("nearby"), finding("optional", "design_opportunity")]);
  const b = answer("b", [finding("b-finding")]);
  const inputs = { plan, accepted: [a, b, a], evidence: [], auditRead: null, dependenciesByQuestion, consolidations: [{
    decision_id: "merge-1", decided_by: "independent-reviewer", reason: "Same branch and same repair.",
    sources: [{ answer_id: "a", finding_id: "a-finding" }, { answer_id: "b", finding_id: "b-finding" }],
  }] };
  const original = structuredClone(inputs);
  const report = QuestionAuditFindingsReportSchema.parse(buildQuestionAuditFindingsReport(inputs));
  expect(inputs).toEqual(original);
  expect(report.question_review.accepted).toHaveLength(2);
  expect(report.question_review.completion).toBe("incomplete");
  expect(report.question_review.questions[0]?.parts.map(row => row.state)).toEqual(["findings", "unreviewed"]);
  expect(report.question_review.findings).toHaveLength(3);
  expect(report.findings).toHaveLength(2);
  expect(report.findings.find(row => row.question_review_sources?.length === 2)
    ?.question_review_sources?.flatMap(source => source.verification.map(v => v.obligation_id)).sort())
    .toEqual(["verify-a-finding", "verify-b-finding"]);
  expect(renderAuditReportMarkdown(report)).toContain("Supported design opportunities");
  expect(QuestionAuditFindingsReportSchema.safeParse({
    ...report, question_review: { ...report.question_review, consolidations: [] },
  }).success).toBe(false);
});

test("indexes cross-question groups and keeps the complete accepted and decision history", () => {
  const otherBinding = { ...binding, question_id: "other" };
  const other = answer("a-other", [{ ...finding("other-defect"), ...otherBinding }]);
  Object.assign(other.submission, otherBinding);
  other.submission.answer.observations = other.submission.answer.observations.map(observation => ({ ...observation, ...otherBinding }));
  const primary = answer("z-primary", [finding("primary-defect"), finding("separate-defect")]);
  const refuting = accepted[0]!;
  const orphan = answer("orphan", []);
  orphan.submission.question_id = "absent-from-plan";
  const resolved = {
    ...binding, schema_version, adjudication_id: "z-resolved", reviewer: "reviewer",
    decision: "resolved" as const, submission_ids: [refuting.submission.submission_id, primary.submission.submission_id],
    selected_submission_ids: [primary.submission.submission_id], rationale: "Accept the supported primary findings.",
  };
  const decisions = [
    { ...resolved, adjudication_id: "other-history", question_id: otherBinding.question_id },
    { ...resolved, adjudication_id: "a-disputed", decision: "disputed" as const, selected_submission_ids: [] },
    resolved,
  ];
  const report = buildQuestionAuditFindingsReport({
    plan: { ...plan, questions: [
      plan.questions[0]!, { ...plan.questions[0]!, ...otherBinding, lens: "architecture" },
    ] },
    accepted: [primary, refuting, orphan, other, primary], evidence: [], auditRead: null,
    dependenciesByQuestion: new Map([...dependenciesByQuestion, [otherBinding.question_id, [sourceDependency]]]),
    adjudications: decisions,
    consolidations: [{
      decision_id: "cross-question-repair", decided_by: "reviewer", reason: "Both findings stem from one defect.",
      sources: [
        { answer_id: primary.submission.submission_id, finding_id: "primary-defect" },
        { answer_id: other.submission.submission_id, finding_id: "other-defect" },
      ],
    }],
  });
  const groups = report.question_review.findings;
  expect(groups).toHaveLength(2);
  const shared = groups.find(row => row.sources.length === 2)!;
  expect(shared.question_ids).toEqual(["other", "resume"]);
  expect(report.question_review.questions.map(row => row.finding_ids)).toEqual([
    groups.map(row => row.canonical_finding_id), [shared.canonical_finding_id],
  ]);
  expect(report.findings.find(row => row.question_review_sources?.length === 2)?.lens).toBe("architecture");
  expect(report.question_review.accepted).toEqual([other, refuting, orphan, primary]);
  expect(report.question_review.adjudications).toEqual(decisions);
});

test("an old consolidation stays in history without suppressing a current independent defect", () => {
  const a = answer("a", [finding("old")]);
  a.dependency_bindings = [{ ...sourceDependency, fingerprint: "obsolete" }];
  const b = answer("b", [finding("current")]);
  const consolidations = [{
    decision_id: "former-repair", decided_by: "reviewer", reason: "Same repair on the prior snapshot.",
    sources: [{ answer_id: "a", finding_id: "old" }, { answer_id: "b", finding_id: "current" }],
  }];
  const report = QuestionAuditFindingsReportSchema.parse(buildQuestionAuditFindingsReport({
    plan, accepted: [a, b], evidence: [], auditRead: null, dependenciesByQuestion, consolidations,
  }));
  expect(report.question_review.consolidations).toEqual(consolidations);
  expect(report.question_review.accepted).toHaveLength(2);
  expect(report.findings.map(row => row.question_review_sources?.map(source => source.finding_id))).toEqual([["current"]]);
});


test("import refuses actionable edits that disagree with confirmed source claims", () => {
  const report = QuestionAuditFindingsReportSchema.parse(buildQuestionAuditFindingsReport({
    plan, accepted: [answer("a", [finding("defect")])], evidence: [], auditRead: null, dependenciesByQuestion,
  }));
  const row = report.findings[0]!;
  for (const change of [
    { affected_files: [{ path: "src/unreviewed.ts" }] },
    { affected_files: [{ path: "src/resume.ts", line_start: 8 }] },
    { title: "Different defect" },
    { summary: "Unsupported remedy diagnosis" },
    { severity: "critical" },
    { confidence: "low" },
    { category: "maintenance" },
    { lens: "security" },
    { evidence: ["unissued-evidence"] },
    { targeted_commands: ["unreviewed command"] },
  ]) {
    expect(QuestionAuditFindingsReportSchema.safeParse({
      ...report, findings: [{ ...row, ...change }],
    }).success).toBe(false);
  }
  const changed = structuredClone(report);
  changed.question_review.questions[0]!.parts[0]!.accepted_answer_ids = [];
  expect(QuestionAuditFindingsReportSchema.safeParse(changed).success).toBe(false);
});


test("holds incompatible independent answers until an attributable decision, without erasing evidence", () => {
  const refuting = accepted[0]!;
  const supporting = answer("support", [finding("supported")]);
  const common = { plan, accepted: [refuting, supporting], evidence: [], auditRead: null, dependenciesByQuestion };
  const open = QuestionAuditFindingsReportSchema.parse(buildQuestionAuditFindingsReport(common));
  expect(open.findings).toEqual([]);
  expect(open.question_review.questions[0]?.conflicts).toEqual([{ part_id: "manual", answer_ids: ["answer-1", "support"] }]);
  expect(renderAuditReportMarkdown(open)).toContain("Unresolved disagreement");
  const decided = QuestionAuditFindingsReportSchema.parse(buildQuestionAuditFindingsReport({
    ...common,
    adjudications: [{
      ...binding, schema_version, adjudication_id: "decision-1", reviewer: "reviewer",
      decision: "resolved", submission_ids: ["answer-1", "support"], selected_submission_ids: ["support"],
      rationale: "The supported boundary condition resolves the specific disagreement.",
    }],
  }));
  expect(decided.findings).toHaveLength(1);
  expect(decided.question_review.accepted).toHaveLength(2);
  expect(decided.question_review.completion).toBe("incomplete");
  expect(renderAuditReportMarkdown(decided)).toContain("Recorded decision decision-1");
});

test("reports changed membership as stale while unchanged read dependencies can carry across snapshots", () => {
  const dependency = { kind: "membership" as const, key: "resume-entrypoints", fingerprint: "previous-set" };
  const historical = [{ ...accepted[0]!, dependency_bindings: [dependency, sourceDependency] }];
  const currentPlan = {
    ...plan, snapshot_id: "s2",
    questions: plan.questions.map(q => ({ ...q, snapshot_id: "s2", source_dependencies: [dependency] })),
  };
  const build = (fingerprint: string, sourceFingerprint = "source-r1") => buildQuestionAuditFindingsReport({
    plan: {
      ...currentPlan, questions: currentPlan.questions.map(q => ({
        ...q, source_dependencies: [{ ...dependency, fingerprint }],
      })),
    },
    accepted: historical, evidence: [], auditRead: null,
    dependenciesByQuestion: new Map([[binding.question_id, [
      { ...dependency, fingerprint }, { ...sourceDependency, fingerprint: sourceFingerprint },
    ]]]),
  });
  expect(build("previous-set").question_review.questions[0]?.parts[0]?.state).toBe("clean");
  expect(build("added-entrypoint").question_review.questions[0]?.parts[0]?.state).toBe("stale");
  expect(build("added-entrypoint").question_review.accepted).toEqual(historical);
  // The source was discovered by the reviewer, not declared by the planner.
  expect(build("previous-set", "source-r2").question_review.questions[0]?.parts[0]?.state).toBe("stale");
});

test("unobserved runtime context gives no affirmative scope credit", () => {
  const submission = structuredClone(accepted[0]!);
  submission.submission.answer.observations[0] = {
    ...submission.submission.answer.observations[0]!,
    kind: "runtime_observed", evidence_refs: [{ evidence_id: "suite", observation_id: "manual-case" }],
  };
  const report = buildQuestionAuditFindingsReport({
    plan, accepted: [submission], auditRead: null, dependenciesByQuestion, evidence: [{
      schema_version, evidence_id: "suite", snapshot_id: "s1", kind: "command", status: "not_run",
      description: "Planned only", dependencies: [], source_refs: [],
    }],
  });
  expect(report.question_review.questions[0]?.parts[0]?.state).toBe("inconclusive");
  const markdown = renderAuditReportMarkdown(report);
  expect(markdown).toContain("suite: not_run");
  expect(markdown).toContain("Evidence needed for manual: suite/manual-case was not run. Capture the named observation");
});

test("question executors regenerate both outputs and keep deterministic ownership across narrative reload", () => {
  const input = { auditRead: null, questionReview: {
    accepted: [answer("source", [finding("defect")])], evidence: [], dependenciesByQuestion,
  } };
  expect(() => runQuestionSynthesisExecutor({}, input)).toThrow("current review_plan");
  const first = runQuestionSynthesisExecutor({ review_plan: plan }, input);
  const persisted = QuestionAuditFindingsReportSchema.parse(JSON.parse(JSON.stringify(first.updated.audit_findings)));
  expect(first.artifacts_written).toEqual(["audit-findings.json", "audit-report.md"]);
  expect(first.updated.audit_report).toContain("Coverage: **incomplete**");
  expect(renderSynthesisNarrativePrompt(persisted, "/audit-findings.json")).toContain("Question coverage: incomplete");
  expect(renderPresentReportPrompt("/audit-report.md")).toContain("state unresolved coverage");
  const restored = { review_plan: plan, audit_findings: persisted };
  const enriched = runQuestionSynthesisNarrativeExecutor(restored, {
    executive_summary: "One tested path has a confirmed defect. Scheduled resume was not reviewed.",
    themes: [{
      theme_id: "theme", title: "Resume", root_cause: "Marker loss", finding_ids: [persisted.findings[0]!.id],
      suggested_fix_pattern: "Preserve the marker",
    }],
    top_risks: ["Manual resume loses pending state"],
  }, input);
  const report = QuestionAuditFindingsReportSchema.parse(enriched.updated.audit_findings);
  expect(report.question_review).toEqual(persisted.question_review);
  expect(report.findings).toEqual(persisted.findings);
  expect(report.coherence_trace).toEqual(persisted.coherence_trace);
  expect(enriched.updated.audit_report).toContain("Narrative (does not change coverage or findings)");
  expect(enriched.updated.audit_report).toContain("scheduled: **unreviewed**");
  expect(() => runQuestionSynthesisNarrativeExecutor(restored, { themes: [], executive_summary: "Stale" }, {
    ...input, questionReview: { ...input.questionReview, accepted: [] },
  })).toThrow("stale question evidence");
});

test("fold writes and rollover retain accepted question provenance in the promoted report", async () => {
  const root = await mkdtemp(join(tmpdir(), "question-report-promotion-"));
  try {
    const artifactsDir = auditArtifactsDir(root);
    const run_id = await ensureQuestionReviewRunIdUnlocked(artifactsDir);
    const ledger = join(artifactsDir, "runs", run_id);
    await mkdir(ledger, { recursive: true });
    const answers = [answer("file-evidence", [finding("defect")])];
    const ledgerPath = join(ledger, "host-accepted-results-ledger.json");
    const ledgerBytes = JSON.stringify({
      contract_version: schema_version, run_id, answers, adjudications: [],
    });
    await writeFile(ledgerPath, ledgerBytes);
    const written = runQuestionSynthesisExecutor({ review_plan: plan }, {
      auditRead: null, questionReview: { accepted: answers, evidence: [], dependenciesByQuestion },
    });
    await writeCoreArtifacts(artifactsDir, written.updated, { prune: true });
    expect(await readFile(ledgerPath, "utf8")).toBe(ledgerBytes);
    const reloaded = await loadArtifactBundle(artifactsDir);
    expect(QuestionAuditFindingsReportSchema.parse(reloaded.audit_findings).question_review).toEqual(
      QuestionAuditFindingsReportSchema.parse(written.updated.audit_findings).question_review,
    );
    expect(JSON.parse(await readFile(join(artifactsDir, "review_plan.json"), "utf8"))).toEqual(plan);
    expect(await promoteFinalAuditReport({ artifactsDir })).toMatchObject({ promoted: true, archived: true });
    await markRunEnded(artifactsDir);
    expect(await rollOverFinishedRun(artifactsDir)).toBe(true);
    await expect(readFile(ledgerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const archived = QuestionAuditFindingsReportSchema.parse(JSON.parse(
      await readFile(promotedAuditFindingsPath(artifactsDir), "utf8"),
    ));
    expect(archived.question_review.accepted).toEqual(answers);
    expect(archived.question_review.questions[0]?.parts[1]?.state).toBe("unreviewed");
    expect(archived.findings[0]?.question_review_sources).toEqual(answers[0]?.submission.answer.findings);
    expect(await readFile(promotedAuditReportPath(artifactsDir), "utf8")).toContain("Coverage: **incomplete**");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rollover does not delete the only current question ledger behind an old promoted report", async () => {
  const root = await mkdtemp(join(tmpdir(), "question-report-stale-promotion-"));
  try {
    const artifactsDir = auditArtifactsDir(root);
    const run_id = await ensureQuestionReviewRunIdUnlocked(artifactsDir);
    const ledger = join(artifactsDir, "runs", run_id);
    await mkdir(ledger, { recursive: true });
    const ledgerPath = join(ledger, "host-accepted-results-ledger.json");
    const answers = [answer("current", [finding("not-promoted")])];
    const bytes = JSON.stringify({
      contract_version: schema_version, run_id, answers, adjudications: [],
    });
    await writeFile(ledgerPath, bytes);
    const current = buildQuestionAuditFindingsReport({
      plan, accepted: answers, evidence: [], auditRead: null, dependenciesByQuestion,
    });
    const prior = buildQuestionAuditFindingsReport({
      plan, accepted: [], evidence: [], auditRead: null, dependenciesByQuestion,
    });
    await writeFile(join(artifactsDir, "review_plan.json"), JSON.stringify(plan));
    await writeFile(join(artifactsDir, "audit-findings.json"), JSON.stringify(current));
    await writeFile(join(artifactsDir, "audit-report.md"), renderAuditReportMarkdown(current));
    await writeFile(promotedAuditFindingsPath(artifactsDir), JSON.stringify(prior));
    await writeFile(promotedAuditReportPath(artifactsDir), renderAuditReportMarkdown(prior));
    await markRunEnded(artifactsDir);
    expect(await rollOverFinishedRun(artifactsDir)).toBe(false);
    expect(await readFile(ledgerPath, "utf8")).toBe(bytes);
    expect(await readFile(promotedAuditFindingsPath(artifactsDir), "utf8")).toBe(JSON.stringify(prior));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["newer ledger", "stale Markdown"] as const)(
  "refuses an otherwise identical promotion and preserves source records with %s", async mode => {
    const root = await mkdtemp(join(tmpdir(), "question-report-pair-"));
    try {
      const artifactsDir = auditArtifactsDir(root);
      const run_id = await ensureQuestionReviewRunIdUnlocked(artifactsDir);
      const ledgerDir = join(artifactsDir, "runs", run_id);
      await mkdir(ledgerDir, { recursive: true });
      const ledgerPath = join(ledgerDir, "host-accepted-results-ledger.json");
      const answers = [answer("recorded", [finding("reported")])];
      const { updated } = runQuestionSynthesisExecutor({ review_plan: plan }, {
        auditRead: null, questionReview: { accepted: answers, evidence: [], dependenciesByQuestion },
      });
      const ledger = (rows: ReviewAcceptedAnswer[]) => JSON.stringify({
        contract_version: schema_version, run_id, answers: rows, adjudications: [],
      });
      await writeFile(ledgerPath, ledger(answers));
      await writeCoreArtifacts(artifactsDir, updated, { prune: true });
      const promoted = await promoteFinalAuditReport({ artifactsDir });
      expect(promoted).toMatchObject({ promoted: true, archived: true });
      const machinePath = promotedAuditFindingsPath(artifactsDir);
      const reportPath = promotedAuditReportPath(artifactsDir);
      const machineBytes = await readFile(machinePath, "utf8");
      const reportBytes = await readFile(reportPath, "utf8");
      expect(await readFile(join(artifactsDir, "audit-findings.json"), "utf8")).toBe(machineBytes);
      expect(await readFile(join(artifactsDir, "audit-report.md"), "utf8")).toBe(reportBytes);

      // No changed revision, snapshot, or report JSON identity.
      const expectedLedger = mode === "newer ledger"
        ? ledger([...answers, answer("accepted-later", [finding("not-in-report")])]) : ledger(answers);
      await writeFile(ledgerPath, expectedLedger);
      if (mode === "stale Markdown") {
        const prior = buildQuestionAuditFindingsReport({
          plan, accepted: [], evidence: [], auditRead: null, dependenciesByQuestion,
        });
        await writeFile(join(artifactsDir, "audit-report.md"), renderAuditReportMarkdown(prior));
      }
      await markRunEnded(artifactsDir);
      if (mode === "newer ledger") {
        expect(await rollOverFinishedRun(artifactsDir)).toBe(false);
      } else {
        expect(await promoteFinalAuditReport({ artifactsDir })).toMatchObject({ promoted: false, archived: false });
      }
      expect(await readFile(ledgerPath, "utf8")).toBe(expectedLedger);
      expect(await readFile(machinePath, "utf8")).toBe(machineBytes);
      expect(await readFile(reportPath, "utf8")).toBe(reportBytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("archived unsupported or ambiguous claims do not borrow a sibling claim's authority", () => {
  const valid = finding("valid");
  const unrelated = { ...finding("unrelated"), observation_ids: ["other"] };
  const legacy = { ...finding("legacy"), observation_ids: undefined };
  const duplicate = finding("duplicate");
  const record = answer("old", [valid, unrelated, legacy, duplicate, { ...duplicate, claim: "Other claim" }]);
  const a = record.submission.answer;
  a.parts.push({ part_id: "scheduled", outcome: "inconclusive", observation_ids: ["other"] });
  a.observations.push({ ...a.observations[0]!, observation_id: "other", part_id: "scheduled" });
  const report = QuestionAuditFindingsReportSchema.parse(buildQuestionAuditFindingsReport({
    plan, accepted: [record], evidence: [], auditRead: null, dependenciesByQuestion,
  }));
  expect(report.findings).toHaveLength(1);
  expect(report.findings[0]?.question_review_sources?.[0]?.finding_id).toBe("valid");
  expect(report.question_review.accepted[0]?.submission.answer.findings).toHaveLength(5);
});

test("no planned questions is not a completed review", () => {
  const report = buildQuestionAuditFindingsReport({
    plan: { ...plan, inventory: [], omissions: [], questions: [] },
    dependenciesByQuestion: new Map(),
    evidence: [],
    accepted: [],
    auditRead: null,
  });
  expect(report.question_review.completion).toBe("incomplete");
  expect(report.question_review.questions).toEqual([]);
  expect(report.findings).toEqual([]);
});

test("surviving v2 machine marker prevents presentation and rollover without plan or session", async () => {
  const root = await mkdtemp(join(tmpdir(), "question-report-marker-"));
  try {
    const artifactsDir = auditArtifactsDir(root);
    await mkdir(artifactsDir, { recursive: true });
    const report = buildQuestionAuditFindingsReport({
      plan, accepted: [], evidence: [], auditRead: null, dependenciesByQuestion,
    });
    const machine = JSON.stringify(report);
    const markdown = renderAuditReportMarkdown(report);
    const working = join(artifactsDir, "audit-findings.json");
    await writeFile(working, machine);
    await writeFile(join(artifactsDir, "audit-report.md"), markdown);
    // Even a byte-identical promoted predecessor is not proof of the lost authority.
    await writeFile(promotedAuditFindingsPath(artifactsDir), machine);
    await writeFile(promotedAuditReportPath(artifactsDir), markdown);

    const terminal = await buildTerminalStep({ root, sourceRoot: root, artifactsDir },
      { audit_findings: report, audit_report: markdown },
      { status: "complete", blockers: [], obligations: [] }, "done");
    expect(terminal).toMatchObject({ kind: "blocked", reason: expect.stringContaining("could not be verified") });
    await markRunEnded(artifactsDir);
    expect(await rollOverFinishedRun(artifactsDir)).toBe(false);
    expect(await readFile(working, "utf8")).toBe(machine);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports current grounded design opportunities separately and keeps candidate disposition provenance", () => {
  const a = answer("current", [finding("current-design", "design_opportunity")]);
  const old = answer("obsolete", [finding("obsolete-design", "design_opportunity")]);
  old.submission.revision_id = "older";
  old.submission.answer.findings[0]!.revision_id = "older";
  const workspacePlan = { ...plan, questions: [{ ...plan.questions[0]!, plan_status: "pending" as const }], signal_dispositions: [
    { signal_id: "contract:001", outcome: "promoted" as const, reason: "Material boundary", question_id: "resume", source_refs: [src] },
    { signal_id: "systemic:004", outcome: "grouped" as const, reason: "Same mechanism", question_id: "resume" },
    { signal_id: "charter:002", outcome: "not_promoted" as const, reason: "No contract change", source_refs: [src] },
  ] };
  const report = QuestionAuditFindingsReportSchema.parse(buildQuestionAuditFindingsReport({
    plan: workspacePlan, accepted: [old, a], evidence: [], dependenciesByQuestion, auditRead: null,
  }));
  expect(report.findings).toEqual([]);
  expect(report.question_review.signal_dispositions).toEqual(workspacePlan.signal_dispositions);
  const markdown = renderAuditReportMarkdown(report);
  const priority = markdown.split("## Supported design opportunities")[1]?.split("## ")[0];
  expect(priority).toContain("prioritized separately from confirmed defects");
  expect(priority).toContain("listing one does not approve implementation");
  expect(priority).toContain("current-design");
  expect(priority).not.toContain("obsolete-design");
  expect(markdown.split("## Findings and leads")[1]).toContain("obsolete-design");
  expect(markdown).toContain("systemic:004: grouped");
  expect(markdown).toContain("charter:002: not promoted");
  expect(markdown).toContain("src/resume.ts:1");
  for (const plan_status of ["blocked", "deferred"] as const) {
    const inactive = buildQuestionAuditFindingsReport({
      plan: { ...workspacePlan, questions: [{ ...workspacePlan.questions[0]!, plan_status, plan_reason: "Unavailable" }] },
      accepted: [a], evidence: [], dependenciesByQuestion, auditRead: null,
    });
    expect(renderAuditReportMarkdown(inactive)).not.toContain("## Supported design opportunities");
    expect(inactive.findings).toEqual([]);
  }
});

test("reports exact grouped leaf outcomes without borrowing another part's conclusion", () => {
  const a = answer("grouped", [finding("current-design", "design_opportunity")]);
  const originalObservation = a.submission.answer.observations[0]!;
  a.submission.answer.observations = [
    { ...originalObservation, part_id: "design-lead:verified" },
    { ...originalObservation, part_id: "design-lead:justified", observation_id: "why-necessary" },
  ];
  a.submission.answer.parts = [
    { part_id: "design-lead:verified", outcome: "findings", observation_ids: ["manual-check"] },
    { part_id: "design-lead:justified", outcome: "clean", observation_ids: ["why-necessary"], reason: "Separate retention policy requires it." },
    { part_id: "design-lead:unknown", outcome: "inconclusive", observation_ids: [], reason: "Missing paired evidence." },
  ];
  const leaves = ["verified", "justified", "unknown", "missing"];
  const planWithGroup = {
    ...plan,
    questions: [{ ...plan.questions[0]!, requested_parts: leaves.slice(0, 3).map(leaf =>
      ({ part_id: `design-lead:${leaf}`, expectation: leaf })) }],
    signal_dispositions: leaves.map(leaf =>
      ({ signal_id: `design-lead:${leaf}`, outcome: "grouped" as const, reason: "Common source boundary", question_id: binding.question_id })),
  };
  const report = buildQuestionAuditFindingsReport({
    plan: planWithGroup, accepted: [a], evidence: [], dependenciesByQuestion, auditRead: null,
  });
  expect(report.question_review.questions[0]?.state).toBe("inconclusive");
  const rows = renderAuditReportMarkdown(report).split("\n").filter(line => line.startsWith("- design-lead:"));
  expect(rows.find(line => line.includes("design-lead:verified"))).toContain("review part: findings");
  expect(rows.find(line => line.includes("design-lead:justified"))).toContain("review part: scoped clean / no change substantiated");
  expect(rows.find(line => line.includes("design-lead:unknown"))).toContain("review part: inconclusive");
  expect(rows.find(line => line.includes("design-lead:missing"))).toContain("no matching review part");
});
