// sites-pinned: tests/remediate/clarification-round-contract.test.ts, tests/remediate/intake-starting-point-contract.test.ts, tests/remediate/n-r04-intent-checkpoint.test.ts
import type {
  ClarificationRequest,
  RemediationItemState,
} from "../state/types.js";
import type { RemediationState } from "../state/store.js";
import type { ReviewRequest } from "../review/reviewGate.js";
import {
  findingLead,
  renderFindingBadgeBody,
  renderPromptCommand,
} from "audit-tools/shared";
import {
  INTAKE_CLARIFICATION_SCHEMA_VERSION,
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

/**
 * The resolution-entry rules: an example entry, the three actions as a table,
 * the `scope_additions` rule, and the whole-file refusal. They state exactly
 * what the one resolution parser (`readPlanClarificationResolutions`,
 * nextStep.ts) accepts.
 */
function resolutionEntryRules(
  firstId: string,
  rationaleExample: string,
): string {
  return `\`\`\`json
[
  {
    "finding_id": "${firstId}",
    "action": "clarified",
    "rationale": "${rationaleExample}"
  }
]
\`\`\`

The file is a JSON array with one entry per finding. Each entry has
\`finding_id\`, \`action\` and, for \`clarified\`, \`rationale\`. Use one of these
three actions:

| \`action\` | Use it when | Effect |
|---|---|---|
| \`clarified\` | The user answered, or the question was not ambiguous after all. | The fix continues. \`rationale\` is REQUIRED and must not be empty: it carries the answer to the worker. |
| \`reject_finding\` | The finding itself is not a real issue. | The finding is DROPPED. Never use it to say only that the question was not ambiguous. |
| \`defer\` | The user chose to skip this finding in this run. | The finding is not fixed in this run. Only the user decides a deferral. |

A \`clarified\` entry can also have \`scope_additions\`: a list of files that the
answer adds to the fix's write scope, such as a test the fix must create. Write
each path relative to the repository root. A path may name a new file, but its
directory must already contain a file that git tracks. Do not put
\`scope_additions\` on a \`reject_finding\` or \`defer\` entry. Never edit the
plan's \`touched_files\` by hand.

The tool refuses the WHOLE file when any entry is wrong: an unknown action, a
missing or empty \`rationale\` on \`clarified\`, a \`scope_additions\` path that
breaks the rule above, a duplicate \`finding_id\`, or an id outside the set below.
The refusal names the entry and the field. Nothing is applied, and this step
comes back.`;
}

/**
 * The one refusal banner every resolution prompt shows after the tool refused
 * and archived the previous file. The reason names each problem, so the banner
 * does not guess which kind of problem it was.
 */
function refusalBanner(
  refusal: string | undefined,
  outcome: "applied" | "recorded",
): string {
  return refusal
    ? `
> ⚠ **Your previous resolution was REFUSED and archived — nothing was ${outcome}.**
> ${refusal}
> Fix each problem named above. Then re-submit the WHOLE file.
`
    : "";
}

export function clarificationPrompt(
  clarifications: ClarificationRequest[],
  resolutionPath: string,
  refusal?: string,
): string {
  const ids = clarifications.map((c) => c.finding_id);
  const count = clarifications.length;
  return `
# Resolve Remediation Clarifications
${refusalBanner(refusal, "applied")}
Workers paused ${count} finding${count === 1 ? "" : "s"} because each needs an
answer from the user. Ask the user all of the questions in one message.

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

${resolutionEntryRules(ids[0] ?? "F-001", "the user's answer, in words the worker can act on")}

\`finding_id\` MUST be drawn from this closed set (copy, never retype):
${ids.map((id) => `\`${id}\``).join(", ") || "_(none)_"}.

You can answer only some of the findings. A finding with no entry stays paused,
and a later step asks about it again.

Then run \`${loaderCommand("next-step")}\`.
`;
}

/**
 * Up-front ambiguity-review prompt (note 3, part A). The tool seeds deterministic
 * CANDIDATE ambiguities; the host's job is the judgment slot the tool cannot
 * fill: review each candidate against the actual code, dismiss false positives,
 * ADD any genuine scoping/judgment ambiguity it finds, then batch ALL genuine
 * ones into ONE round of user questions before any fix is implemented. This is
 * the gate that stops a scoping question from falling silently to triage mid-run.
 *
 * If, after reviewing with repo access, there is nothing genuinely ambiguous, the
 * host writes an empty array to proceed — no user round is forced on a clean plan.
 */
export function ambiguityReviewPrompt(
  candidates: ClarificationRequest[],
  resolutionPath: string,
  validFindingIds: readonly string[] = [],
  refusal?: string,
): string {
  const count = candidates.length;
  const intro = count
    ? `The tool found ${count} candidate ambigu${count === 1 ? "ity" : "ities"} in the remediation plan. A candidate is a
starting point, not a final list.`
    : `The tool found no candidate ambiguity in the remediation plan. Still review
the findings in the set below yourself.`;
  const candidateBlock = candidates
    .map(
      (item) => `
## ${item.finding_id}

- Category: ${item.category}
- Candidate: ${item.description}
`,
    )
    .join("");
  const firstId = candidates[0]?.finding_id ?? validFindingIds[0] ?? "F-001";

  return `
# Resolve ambiguity in the plan before implementation
${refusalBanner(refusal, "applied")}
${intro}
${candidateBlock}
Do these steps:

1. Read the cited files for each candidate. Drop a candidate that is not a real
   ambiguity.
2. Add each real ambiguity that the candidates missed: an unclear scope, an
   unclear intended behavior, or an unclear choice to fix at all. It can be about
   any finding in the set below.
3. Ask the user all of the remaining questions in one message. Do not leave a
   scope question for a later step.

After the user answers, write JSON to exactly:

\`${resolutionPath}\`

If no real ambiguity remains, write \`[]\`. The plan then continues unchanged.

${resolutionEntryRules(firstId, "the user's answer: the scope the fix must have")}

\`finding_id\` MUST be drawn from this closed set (copy, never retype):
${validFindingIds.map((id) => `\`${id}\``).join(", ") || "_(none)_"}.

A finding with no entry continues as planned.

Then run \`${loaderCommand("next-step")}\`.
`;
}

/**
 * Render the review-approval gate prompt. The tool has already done the
 * deterministic work — bucketed every original finding by review-necessity,
 * with a rationale and a coarse implementation cost. The host's job is the
 * semantic slot the tool cannot fill: present each item to the user with the
 * pros/cons of acting vs. not, and collect approve/decline. The gate exists
 * because design-review (strategic) findings were previously swept to a terminal
 * disposition inside quality-tail blocks without ever being shown — so the
 * strategic tier MUST be presented item-by-item, never rubber-stamped.
 *
 * Default is approve-all: an empty/absent resolution proceeds with every
 * finding. Declined items are RECORDED with a reason, never silently closed.
 */
export function reviewApprovalPrompt(
  request: ReviewRequest,
  resolutionPath: string,
  refusal?: string,
): string {
  const tierSections = request.tiers
    .map((tier) => {
      const items = tier.items
        .map((item) => {
          // Parallel with the auditor's finding block (note 2): one-line lead +
          // the SAME fixed-order badge (Severity → Confidence → Lens → Files →
          // Details), then the review-specific decision fields. Grounding is not
          // part of the review projection, so it is omitted here.
          const lead = findingLead(item.summary);
          const badge = renderFindingBadgeBody(item, {
            showGrounding: false,
            evidencePointer: "audit-findings.json",
          }).join("\n");
          return [
            `### ${item.finding_id} — ${item.title}`,
            "",
            ...(lead ? [lead, ""] : []),
            badge,
            `- Why this tier: ${item.rationale}`,
            `- Implementation cost (blast radius): \`${item.implementation_cost}\``,
          ].join("\n");
        })
        .join("\n\n");
      return `## ${tier.label} — ${tier.items.length} item(s)\n\n${tier.description}\n\n${items}`;
    })
    .join("\n\n");

  const validIds = request.tiers.flatMap((t) => t.items.map((i) => i.finding_id));
  return `
# Review-Approval Gate — the user approves or declines each finding
${refusalBanner(refusal, "recorded")}
The user decides which findings to fix before any code changes. Present every
finding below to the user. For each Strategic finding, state the benefit and the
cost of a fix and of no fix, and get a separate decision from the user.

- Total findings: **${request.total}**
- Strategic: **${request.counts.strategic}** · Concrete: **${request.counts.concrete}** · Mechanical: **${request.counts.mechanical}**

${tierSections}

---

## Record the user's decision

Every finding is fixed unless the user declines it. Write JSON to exactly:

\`${resolutionPath}\`

\`\`\`json
{
  "declined_findings": [],
  "declined_tiers": []
}
\`\`\`

The file above approves every finding.

- To decline one finding, add \`{ "finding_id": "<id>", "reason": "<the user's
  reason, in their words>" }\` to \`declined_findings\`. \`reason\` is optional; leave
  it out when the user gave none.
- To decline a whole tier, add its name to \`declined_tiers\`: \`strategic\`,
  \`concrete\` or \`mechanical\`.
- A declined finding is not fixed. The final report lists it with the user's
  reason.
- \`finding_id\` MUST be drawn from this closed set (copy, never retype):
  ${validIds.map((id) => `\`${id}\``).join(", ")}.

The tool refuses the WHOLE file when it is not valid JSON, has a field not shown
above, has a wrong type, or names an id or tier outside the sets above. The
refusal names each problem. Nothing is recorded, and this step comes back.

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

/**
 * The step emitted when an extracted plan was UNUSABLE and has been removed.
 *
 * This exists because the alternative was `collectStartingPointPrompt`, which is
 * headed "Collect Remediation Starting Point" and lists the default input
 * locations. Telling a host whose plan was just destroyed to go and find an input
 * is a wrong instruction, not merely a vague one: the input was supplied, it was
 * read, and it failed for a stated reason the tool already knew. The reason went
 * to the run log and to stderr, neither of which the host reads.
 *
 * @param reason the failure that made the plan unusable, verbatim
 * @param archivePath where the original bytes were preserved, when they were
 */
export function extractedPlanDiscardedPrompt(
  reason: string,
  archivePath: string | undefined,
  paths: ReturnType<typeof intakePaths>,
): string {
  const archiveNote = archivePath
    ? `The plan that failed was archived first, unchanged, at:\n\n\`${archivePath}\`\n\nRead it to see exactly what was rejected.`
    : "There was no plan file on disk to archive, so nothing was preserved.";

  return `
# Extracted Plan Discarded

The extracted plan was read and could not be used, so it was removed. **This is
not a missing input** — an input was supplied and parsed. Do not go looking for
one.

## Why it was rejected

${reason}

## The original

${archiveNote}

## What to do

Correct the cause named above, then write a corrected plan to exactly:

\`${paths.extractedPlan}\`

and run next-step again. Re-extracting without changing anything reproduces this
exact rejection: the failure is in the plan's content, not in the reading of it.

Two causes account for most rejections, and they need different corrections:

- **Every finding cited only paths that do not exist.** Cite real repository
  paths, relative to the repository root.
- **A finding carried no evidence.** Give each finding at least one concrete
  citation — name a symbol and the file that holds it, not a line number.
`;
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

Give the starting point to the tool with command flags. The tool records the
sources itself: do not write a source manifest, and do not edit source files.

- **Documents.** Pass each path with \`--input\`. Repeat \`--input\` once for each
  document. An \`audit-findings.json\` report is read as structured findings.

  \`${loaderCommand("next-step --input <path> --input <path>")}\`

- **Conversational feedback.** Write the user's full feedback, in their words,
  to exactly:

  \`${paths.conversationStart}\`

  Then pass that file with \`--guidance-file\`:

  \`${loaderCommand(["next-step", "--guidance-file", paths.conversationStart])}\`

- **Both.** Write the feedback file as above. Then pass both flags in one command:

  \`${loaderCommand(["next-step", "--input", "<path>", "--guidance-file", paths.conversationStart])}\`
`;
}

/**
 * The host writes ONE file here: the intake summary. It is the single source
 * the tool reads — the tool renders `remediation-brief.md` from it
 * (`writeRemediationBrief`), and the confirm step builds its scope proposal
 * from it. The host once also wrote the brief and a "draft" intent checkpoint,
 * which put the same facts in three files that could disagree.
 */
export function synthesizeIntakePrompt(
  sources: IntakeSource[],
  paths: ReturnType<typeof intakePaths>,
  hasClarificationResolution: boolean,
): string {
  const clarificationText = hasClarificationResolution
    ? `\nAlso read the user's answers to the earlier questions:\n\n- \`${paths.clarificationResolution}\`\n`
    : "";

  return `
# Synthesize the remediation intake

Read these source files:

${formatIntakeSources(sources)}
${clarificationText}
Do not edit any file except the one below.

Write JSON to exactly:

\`${paths.summary}\`

\`\`\`json
{
  "schema_version": "${INTAKE_SUMMARY_SCHEMA_VERSION}",
  "ready": false,
  "source_type": "documents",
  "source_summary": "What the sources ask for, in two or three sentences.",
  "goals": ["a specific remediation goal"],
  "non_goals": ["a change that is out of scope"],
  "constraints": ["a compatibility, dependency, test, timing or style constraint"],
  "affected_files": [{ "path": "src/router.ts", "reason": "why this file is part of the fix" }],
  "acceptance_criteria": ["an observable result that shows the goal is met"],
  "scope_summary": "One sentence: the files and areas in scope.",
  "intent_summary": "One sentence: the purpose of this run.",
  "filters": {},
  "open_questions": [
    {
      "id": "Q-001",
      "category": "scope_of_fix",
      "question": "Does the refactor include the CLI package, or only the server?",
      "blocking": true
    }
  ]
}
\`\`\`

Rules:

- \`source_type\` is one of \`structured_audit\`, \`documents\`, \`conversation\`, \`mixed\`.
- Set \`ready\` to \`true\` only when no implementation choice depends on another
  user decision. Then \`goals\` must not be empty, and \`affected_files\` must not be
  empty unless \`source_type\` is \`structured_audit\`.
- Set \`ready\` to \`false\` when the user must decide something first. Then add each
  question to \`open_questions\` with \`"blocking": true\`. \`ready: false\` with no
  blocking question is refused.
- A question without \`"blocking": true\` is information only. The user sees it at
  confirmation, and it does not stop the run.
- \`filters\` stays \`{}\` unless the sources clearly limit the run. Its keys are
  \`severity\`, \`lenses\`, \`packages\` and \`themes\`, each a list of strings.
- \`intent_interpretation\` (optional): when a conversation source states the
  user's intent in free words, write one sentence on how you read it.

The tool refuses the file when a field is missing, has a wrong type, or breaks a
rule above. The refusal names each problem, and this step comes back.

The tool writes the Markdown brief and the scope proposal from this file. Do not
write them.

Then run \`${loaderCommand("next-step")}\`.
`;
}

export function collectIntakeClarificationsPrompt(
  summary: IntakeSummary,
  paths: ReturnType<typeof intakePaths>,
): string {
  const questions = blockingIntakeQuestions(summary);
  const ids = questions.map((question) => question.id);
  return `
# Resolve Remediation Intake Questions

Ask the user all of the blocking intake questions below in one message.

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
      "question_id": "${ids[0] ?? "Q-001"}",
      "answer": "the user's answer, in their words"
    }
  ]
}
\`\`\`

Write one entry in \`answers\` for each question the user answered. \`answer\` is
required and must not be blank. You can add an optional \`rationale\`: a short
note on how the answer removes the ambiguity.

\`question_id\` MUST be drawn from this closed set (copy, never retype):
${ids.map((id) => `\`${id}\``).join(", ") || "_(none)_"}.

The tool refuses the file when an entry has an unknown \`question_id\` or a blank
\`answer\`, or when no entry answers a question above. The refusal names each
problem, and this step comes back.

Then run:

\`${loaderCommand("next-step")}\`
`;
}
