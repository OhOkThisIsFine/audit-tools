import type {
  ClarificationRequest,
  RemediationItemState,
} from "../state/types.js";
import type { RemediationState } from "../state/store.js";
import {
  INTAKE_CLARIFICATION_SCHEMA_VERSION,
  INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION,
  INTAKE_SUMMARY_SCHEMA_VERSION,
  blockingIntakeQuestions,
  intakePaths,
  type IntakeSource,
  type IntakeSummary,
} from "../intake.js";

export function loaderCommand(command: string): string {
  return `remediate-code ${command}`;
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

export function triagePrompt(state: RemediationState, resolutionPath: string): string {
  const blocked = blockedItems(state);
  return `
# Resolve Remediation Triage

Ask the user for one decision per blocked item: \`retry\`, \`ignore\`, or \`halt\`.

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
): string {
  const clarificationText = hasClarificationResolution
    ? `\nAlso read the clarification answers at:\n\n\`${paths.clarificationResolution}\`\n`
    : "";

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

Use \`source_type\` of \`documents\`, \`conversation\`, or \`mixed\`.

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

export function extractFindingsPrompt(
  paths: ReturnType<typeof intakePaths>,
  sources: IntakeSource[],
): string {
  return `
# Extract Findings From Intake Brief

Read the remediation launch brief:

\`${paths.brief}\`

You may use the source files listed below only to preserve evidence and
traceability:

${formatIntakeSources(sources)}

Extract actionable remediation items into JSON at exactly:

\`${paths.extractedPlan}\`

Use this exact shape:

\`\`\`json
{
  "findings": [
    {
      "id": "FINDING-001",
      "title": "Short title",
      "category": "User Goal",
      "severity": "medium",
      "confidence": "high",
      "lens": "maintainability",
      "summary": "One-sentence description",
      "affected_files": [{ "path": "relative/path/to/file.ts" }],
      "evidence": ["specific source note, user statement, or document observation"]
    }
  ],
  "blocks": [
    {
      "block_id": "B-001",
      "items": ["FINDING-001", "FINDING-002"],
      "parallel_safe": true,
      "dependencies": []
    }
  ]
}
\`\`\`

For conversational refactor goals, choose the closest existing \`lens\` value
instead of inventing a new one: \`correctness\`, \`architecture\`,
\`maintainability\`, \`security\`, \`reliability\`, \`performance\`,
\`data_integrity\`, \`tests\`, \`operability\`, \`config_deployment\`, or
\`observability\`. Group related findings into blocks by shared files or
logical cohesion. Do not edit source files.

Then run:

\`${loaderCommand("next-step")}\`
`;
}
