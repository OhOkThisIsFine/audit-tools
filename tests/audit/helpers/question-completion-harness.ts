import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { expect } from "vitest";
import { QuestionAuditFindingsReportSchema } from "../../../src/shared/types/questionReviewReport.js";
import { REVIEW_QUESTION_CONTRACT_VERSION, type ReviewAssignment, type ReviewQuestion, type ReviewSubmission } from "../../../src/shared/types/reviewQuestion.js";
import { callNextStep } from "./completion-harness.js";

type Item = { binding: { question: ReviewQuestion; assignment: ReviewAssignment }; result_path: string };
type Step = Awaited<ReturnType<typeof callNextStep>>;

export async function readQuestionWorkload(step: Step) {
  expect(step.step_kind).toBe("dispatch_review");
  const workload = JSON.parse(await readFile(step.artifact_paths.host_workload, "utf8")) as {
    contract_version: string; run_id: string; work_items: Item[];
  };
  expect(workload.contract_version).toBe("audit-tools/question-review/v1");
  expect(workload.work_items.length).toBeGreaterThan(1);
  return workload;
}

export async function submitQuestions(root: string, items: Item[]) {
  return Promise.all(items.map(async ({ binding: { question, assignment }, result_path }) => {
    const result: ReviewSubmission = {
      schema_version: REVIEW_QUESTION_CONTRACT_VERSION,
      submission_id: `fixture-${assignment.assignment_id}`,
      assignment_id: assignment.assignment_id, question_id: question.question_id,
      revision_id: question.revision_id, snapshot_id: question.snapshot_id,
      inspected_sources: assignment.suggested_sources.slice(0, 1), evidence_ids: [],
      limitations: ["Synthetic fixture could not establish the requested behavior."],
      answer: { outcome: "inconclusive", findings: [], observations: [], parts: [{
        part_id: question.requested_parts[0]!.part_id, outcome: "inconclusive",
        observation_ids: [], reason: "No observation for this case.",
      }] },
    };
    const file = resolve(root, result_path);
    const local = relative(join(root, ".audit-tools"), file);
    expect(isAbsolute(local) || local.split(sep)[0] === "..").toBe(false);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(result));
    return result;
  }));
}

export async function readAcceptedAnswers(dir: string, runId: string) {
  const path = join(dir, "runs", runId, "host-accepted-results-ledger.json");
  const ledger = JSON.parse(await readFile(path, "utf8")) as { answers: { submission: ReviewSubmission }[] };
  return ledger.answers.map(({ submission }) => submission);
}

export async function readQuestionFindings(path: string) {
  return QuestionAuditFindingsReportSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export async function presentQuestionReport(
  root: string,
  onStep?: (step: Step) => Promise<void>,
  nextStep?: () => Promise<Step>,
) {
  const dir = join(root, ".audit-tools/audit");
  const trail: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    const step = await (nextStep ? nextStep() : callNextStep(root, dir));
    trail.push(`${step.step_kind}:${step.status}`);
    await onStep?.(step);
    if (step.step_kind === "synthesis_narrative") {
      const path = step.artifact_paths?.synthesis_narrative_results;
      expect(typeof path).toBe("string");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify({ themes: [], top_risks: [] }) + "\n");
    } else if (step.step_kind === "present_report") {
      if (step.status === "complete") return step;
      const path = step.artifact_paths?.friction_record;
      expect(step.status).toBe("ready");
      expect(typeof path).toBe("string");
      const record = JSON.parse(await readFile(path, "utf8").catch(() => "{}"));
      record.category_attestations = ["ambiguous_direction", "tool_should_decide", "inefficient_feeding"]
        .map(category => ({ category, note: "Synthetic fixture." }));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(record) + "\n");
    } else {
      expect(step.step_kind, trail.join(" -> ")).toBe("blocked");
    }
  }
  throw new Error(`Question completion did not reach present_report: ${trail.join(" -> ")}`);
}
