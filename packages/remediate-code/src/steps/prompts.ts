import type {
  ClarificationRequest,
  RemediationItemState,
} from "../state/types.js";
import type { RemediationState } from "../state/store.js";
import type { ReviewRequest } from "../review/reviewGate.js";
import { renderPromptCommand } from "@audit-tools/shared";
import {
  INTAKE_CLARIFICATION_SCHEMA_VERSION,
  INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION,
  INTAKE_SUMMARY_SCHEMA_VERSION,
  blockingIntakeQuestions,
  intakePaths,
  type IntakeSource,
  type IntakeSummary,
} from "../intake.js";

export function loaderCommand(command: string | string[]): string {
  const args = Array.isArray(command)
    ? command
    : command.trim().split(/\s+/u).filter(Boolean);
  return renderPromptCommand(["remediate-code", ...args]);
}

function blockedItems(state: RemediationState): RemediationItemState[] {
  return Object.values(state.items ?? {}).filter((item) => item.status === "blocked");
}

export function clarificationPrompt(
  clarifications: ClarificationRequest[],
  resolutionPath: string,
): string {
  return `
# Resolve Remediation Clarifications

Ask the user to resolve all clarifications in one batched response.

${clarifications
  .map(
    (item) => `
## ${item.finding_id}

- Category: ${item.category}
- Question: ${item.description}
${item.options?.length ? `- Options: ${item.options.join(", ")}` : ""}
`,
  )
  .join("\n")}

After the user answers, write JSON to exactly:

\`${resolutionPath}\`

\`\`\`json
[
  {
    "finding_id": "...",
    "action": "clarified",
    "rationale": "..."
  }
]
\`\`\`

Use \`"action": "deemed_inappropriate"\` for out-of-scope items. Then run
\`${loaderCommand("next-step")}\`.
`;
}

/**
 * Render the review-approval gate prompt. The tool has already done the
 * deterministic work — bucketed every original finding by review-necessity,
 * with a rationale and a coarse implementation cost. The host's job is the
 * semantic slot the tool cannot fill: present each item to the user with the
 * pros/cons of acting vs. not, and collect approve/disapprove. The gate exists
 * because design-review (strategic) findings were previously swept to a terminal
 * disposition inside quality-tail blocks without ever being shown — so the
 * strategic tier MUST be presented item-by-item, never rubber-stamped.
 *
 * Default is approve-all: an empty/absent resolution proceeds with every
 * finding. Disapproved items are RECORDED with a reason, never silently closed.
 */
export function reviewApprovalPrompt(
  request: ReviewRequest,
  resolutionPath: string,
): string {
  const tierSections = request.tiers
    .map((tier) => {
      const items = tier.items
        .map(
          (item) => `
### ${item.finding_id} — ${item.title}

- Lens / severity / confidence: \`${item.lens}\` / \`${item.severity}\` / \`${item.confidence}\`
- Why this tier: ${item.rationale}
- Implementation cost (blast radius): \`${item.implementation_cost}\`
- Affected files: ${item.affected_files.length ? item.affected_files.map((f) => `\`${f}\``).join(", ") : "_none cited_"}
- Summary: ${item.summary}
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**`,
        )
        .join("\n");
      return `## ${tier.label} — ${tier.items.length} item(s)\n\n${tier.description}\n${items}`;
    })
    .join("\n\n");

  return `
# Review-Approval Gate — approve or disapprove before implementation

Before any code changes, every audit finding is presented below, bucketed by how
much of **your** judgment it needs. This gate exists so that strategic
(design/architecture) findings are never quietly closed without your sight — so
walk the user through them, especially the **Strategic** tier, with the trade-offs
of acting vs. leaving each as-is.

- Total findings: **${request.total}**
- Strategic: **${request.counts.strategic}** · Concrete: **${request.counts.concrete}** · Mechanical: **${request.counts.mechanical}**

${tierSections}

---

## Record the user's decision

The default is to **proceed with every finding**. You only need to record the
items the user wants to **disapprove** (skip). Write JSON to exactly:

\`${resolutionPath}\`

\`\`\`json
{
  "disapproved_findings": ["FINDING-ID-the-user-declined"],
  "disapproved_tiers": []
}
\`\`\`

- Leave \`disapproved_findings\` empty (\`[]\`) to approve everything.
- Use \`disapproved_tiers\` (e.g. \`["mechanical"]\`) to decline an entire tier at once.
- Disapproved findings are recorded as a declined disposition with a reason —
  they are not acted on, and they are not silently dropped.

Then run \`${loaderCommand("next-step")}\`.
`;
}

export function triagePrompt(state: RemediationState, resolutionPath: string): string {
  const blocked = blockedItems(state);
  return `
# Resolve Remediation Triage

Ask the user for one decision per blocked item: \`retry\`, \`ignore\`, or \`halt\`.
Use \`retry\` for blocked, deferred, retry-later, or prerequisite-dependent work.
Use \`ignore\` only when the user explicitly says the finding should not be
remediated.

${blocked
  .map((item) => {
    const finding = state.plan?.findings.find((entry) => entry.id === item.finding_id);
    return `
## ${item.finding_id} - ${finding?.title ?? "Untitled finding"}

- Failure reason: ${item.failure_reason ?? "Unknown"}
- Last successful step: ${item.last_successful_step ?? "none"}
`;
  })
  .join("\n")}

After the user answers, write JSON to exactly:

\`${resolutionPath}\`

\`\`\`json
{
  "items": [
    {
      "finding_id": "...",
      "action": "retry",
      "rationale": "..."
    }
  ]
}
\`\`\`

Then run \`${loaderCommand("next-step")}\`.
`;
}

export function formatIntakeSources(sources: IntakeSource[]): string {
  if (sources.length === 0) return "- none";
  return sources.map((source) => `- ${source.type}: \`${source.path}\``).join("\n");
}

export function collectStartingPointPrompt(
  root: string,
  checkedPaths: string[],
  missingPaths: string[],
  paths: ReturnType<typeof intakePaths>,
): string {
  const missing = missingPaths.length
    ? `\n\nThe supplied input path did not exist:\n${missingPaths
        .map((path) => `- \`${path}\``)
        .join("\n")}`
    : "";

  return `
# Collect Remediation Starting Point

Ask the user for the starting point for this remediation. Accept either:

- one or more paths to audit reports, feedback documents, issue notes, or design
  notes
- conversational feedback describing the refactor or remediation goal
- both documents and conversational context

Repository root:

\`${root}\`

Checked default input locations:
${checkedPaths.map((candidate) => `- \`${candidate}\``).join("\n")}
${missing}

If the user provides document paths, write JSON to exactly:

\`${paths.sourceManifest}\`

\`\`\`json
{
  "schema_version": "${INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION}",
  "created_from": "conversation",
  "sources": [
    { "type": "document", "path": "path/from/user-or-absolute-path", "label": "input-01" }
  ]
}
\`\`\`

If the user provides conversational feedback, write their full feedback to
exactly:

\`${paths.conversationStart}\`

Then include that file in the source manifest:

\`\`\`json
{
  "schema_version": "${INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION}",
  "created_from": "conversation",
  "sources": [
    { "type": "conversation", "path": ${JSON.stringify(paths.conversationStart)}, "label": "conversation-start" }
  ]
}
\`\`\`

If the user provides both, include both source types in the same manifest. Do
not edit source files.

Then run:

\`${loaderCommand("next-step")}\`
`;
}

export function synthesizeIntakePrompt(
  manifestPath: string,
  sources: IntakeSource[],
  paths: ReturnType<typeof intakePaths>,
  hasClarificationResolution: boolean,
  intentCheckpointPath?: string,
): string {
  const clarificationText = hasClarificationResolution
    ? `\nAlso read the clarification answers at:\n\n\`${paths.clarificationResolution}\`\n`
    : "";

  const checkpointPath = intentCheckpointPath ?? paths.intentCheckpoint;

  return `
# Synthesize Remediation Intake

Read the source manifest:

\`${manifestPath}\`

Then read only the listed source files:

${formatIntakeSources(sources)}
${clarificationText}
Create a launch brief for the remediation workflow. The goal is to eliminate
ambiguity before the normal remediation planner turns this into findings.

Write JSON to exactly:

\`${paths.summary}\`

\`\`\`json
{
  "schema_version": "${INTAKE_SUMMARY_SCHEMA_VERSION}",
  "ready": false,
  "source_type": "documents",
  "goals": ["specific remediation goal"],
  "non_goals": ["explicitly out-of-scope change"],
  "constraints": ["compatibility, dependency, testing, timing, or style constraint"],
  "affected_files": [{ "path": "relative/path.ts", "reason": "why this file is implicated" }],
  "open_questions": [
    {
      "id": "Q-001",
      "category": "scope_of_fix",
      "question": "What needs to be clarified before code changes?",
      "blocking": true
    }
  ]
}
\`\`\`

Set \`ready\` to \`true\` only when the goals, non-goals, affected areas, and
success criteria are clear enough that implementation choices will not depend
on another user decision. If any blocking ambiguity remains, set \`ready\` to
\`false\` and list the questions.

Use \`source_type\` of \`structured_audit\`, \`documents\`, \`conversation\`,
or \`mixed\`.

Also write a Markdown launch brief to exactly:

\`${paths.brief}\`

The brief must include:

- source summary
- goals
- non-goals
- constraints
- affected files or discovery targets
- acceptance criteria
- open questions, if any

Also write a preliminary intent checkpoint to exactly:

\`${checkpointPath}\`

\`\`\`json
{
  "schema_version": "intent-checkpoint/v1",
  "confirmed_at": "<ISO-8601 timestamp for when this draft was created>",
  "confirmed_by": "draft",
  "scope_summary": "<pre-populated scope derived from the goals and affected_files above>",
  "intent_summary": "<pre-populated intent derived from the goals and source_type above>",
  "filters": {},
  "pre_draft_questions": [
    {
      "id": "Q-001",
      "question": "<question text from open_questions above>",
      "blocking": true
    }
  ],
  "closing_action": "commit"
}
\`\`\`

Rules for the preliminary checkpoint:
- \`confirmed_by\` MUST be \`"draft"\` (sentinel for unconfirmed state).
- Pre-populate \`scope_summary\` from the goals and affected areas; pre-populate
  \`intent_summary\` from the overall purpose (e.g. "full remediation of security
  findings from the audit report").
- Copy ALL open_questions into \`pre_draft_questions\`, preserving their ids and
  blocking flags. Non-blocking questions are included as FYI context.
- Suggest \`closing_action\` as \`"commit"\` by default (valid options:
  \`"commit"\`, \`"none"\`).
- If a \`free_form_intent\` was interpreted (e.g. "prioritizing security
  findings"), record a brief explanation in \`intent_interpretation\`.
- Leave \`filters\` empty (\`{}\`) unless the source clearly implies specific
  severity/lens/package scope.

Do not edit source files.

Then run:

\`${loaderCommand("next-step")}\`
`;
}

export function collectIntakeClarificationsPrompt(
  summary: IntakeSummary,
  paths: ReturnType<typeof intakePaths>,
): string {
  const questions = blockingIntakeQuestions(summary);
  return `
# Resolve Remediation Intake Questions

Ask the user to answer all blocking intake questions in one response.

${questions
  .map(
    (question) => `
## ${question.id}

- Category: ${question.category ?? "scope"}
- Question: ${question.question}
`,
  )
  .join("\n")}

After the user answers, write JSON to exactly:

\`${paths.clarificationResolution}\`

\`\`\`json
{
  "schema_version": "${INTAKE_CLARIFICATION_SCHEMA_VERSION}",
  "answers": [
    {
      "question_id": "Q-001",
      "answer": "User's answer",
      "rationale": "Optional short note about how the answer resolves ambiguity"
    }
  ]
}
\`\`\`

Then run:

\`${loaderCommand("next-step")}\`
`;
}

