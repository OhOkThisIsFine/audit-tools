import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentReflectionSchema } from "../../src/shared/agentReflections.js";

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
