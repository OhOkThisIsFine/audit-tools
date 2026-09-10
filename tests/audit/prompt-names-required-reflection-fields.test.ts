import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  AgentReflectionSchema,
  AGENT_FEEDBACK_FILENAME,
} from "../../src/shared/agentReflections.js";
import {
  writeCurrentStep,
  AGENT_FEEDBACK_ARTIFACT_KEY,
} from "../../src/audit/cli/steps.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

// The canonical loader body. Every IDE/host asset renders from this one file
// (see host-asset-renderer-drift.test.ts), so binding the check here covers the
// rendered assets too.
const CANONICAL_PROMPT = join(
  repoRoot,
  "skills",
  "audit-code",
  "audit-code.prompt.md",
);

/**
 * The fields `parseReflectionsNdjson` REQUIRES, derived from the schema rather
 * than hand-listed — a hand copy is the drift this test exists to prevent.
 */
function requiredReflectionFields(): string[] {
  return Object.entries(AgentReflectionSchema.shape)
    .filter(([, field]) => !field.isOptional())
    .map(([name]) => name)
    .sort();
}

// The defect this pins, observed 2026-09-06: the prompt asked the host to record
// a reserved `audit-capability-preflight` reflection and named `task_id` and
// `severity`, but never `instruction_clarity`. `parseReflectionsNdjson` requires
// all three and drops a line missing any of them SILENTLY, by explicit design.
// So a host that followed the shipped prompt exactly produced a line the parser
// discarded whole, and the capability-preflight channel — the one that decides
// whether a run may be called comprehensive — could not carry a single message.
//
// This is the auditor-agnostic rule applied to our own prompt: the host must not
// have to guess a field the tool silently requires.
test("the shipped audit loader prompt names every reflection field the parser requires", () => {
  const body = readFileSync(CANONICAL_PROMPT, "utf8");
  const required = requiredReflectionFields();

  expect(required.length, "the reflection schema must have required fields to check").toBeGreaterThan(0);

  for (const field of required) {
    expect(
      body.includes(field),
      `the loader prompt must name the required reflection field '${field}'; ` +
        `parseReflectionsNdjson discards any line missing it, and the drop is silent`,
    ).toBe(true);
  }
});

// The same silent-loss class, one step further out (nightly decision
// `docs-audit-prompt-reflection-destination-unnamed`): the prompt named the
// FIELDS but never the DESTINATION, so a host that followed it exactly still had
// to guess a filename. A wrong guess is not reported — `parseReflectionsNdjson`
// returns an empty list for an absent file with no affirmation — so the
// reflection simply never appears and the report's limitations section is
// silently thinner.
//
// The fix is the auditor-agnostic one: the tool SUPPLIES the path rather than
// asking a host to reproduce it. `writeCurrentStep` — the one funnel every audit
// step emission goes through — stamps `artifact_paths.agent_feedback`, and the
// loader body names that key instead of a filename.
test("the shipped audit loader prompt names the reflection destination by its step-contract key", () => {
  const body = readFileSync(CANONICAL_PROMPT, "utf8");
  expect(
    body.includes(`artifact_paths.${AGENT_FEEDBACK_ARTIFACT_KEY}`),
    `the loader prompt must name the step-contract key that carries the reflection path ` +
      `(artifact_paths.${AGENT_FEEDBACK_ARTIFACT_KEY}); a host that has to guess the file ` +
      `produces a silently empty channel`,
  ).toBe(true);
  // It must NOT spell the raw filename: that is the guess this replaces, and a
  // prompt that names both invites a host to use the wrong one.
  expect(
    body.includes(AGENT_FEEDBACK_FILENAME),
    `the loader prompt must not spell the raw filename '${AGENT_FEEDBACK_FILENAME}' — ` +
      `the step contract supplies it`,
  ).toBe(false);
});

test("every emitted audit step carries the reflection path on the contract", async () => {
  const artifactsDir = await mkdtemp(join(tmpdir(), "audit-step-reflection-"));
  try {
    const step = await writeCurrentStep({
      artifactsDir,
      stepKind: "dispatch_review",
      status: "ready",
      runId: null,
      allowedCommands: [],
      stopCondition: "stop",
      repoRoot: artifactsDir,
      artifactPaths: { artifact_paths: "caller-value" },
      prompt: "do the work",
    });
    const emitted = step.artifact_paths[AGENT_FEEDBACK_ARTIFACT_KEY];
    expect(
      typeof emitted === "string" && emitted.endsWith(AGENT_FEEDBACK_FILENAME),
      `every audit step must carry artifact_paths.${AGENT_FEEDBACK_ARTIFACT_KEY} pointing at ` +
        `${AGENT_FEEDBACK_FILENAME} — a step without it makes the destination a guess again`,
    ).toBe(true);
    // It resolves inside the run's artifacts dir, and survives the writer's
    // forward-slash path normalization (so a host can use it as given).
    expect(emitted?.replace(/\\/g, "/")).toContain(
      `${artifactsDir.replace(/\\/g, "/")}/${AGENT_FEEDBACK_FILENAME}`,
    );
  } finally {
    await rm(artifactsDir, { recursive: true, force: true });
  }
});
