import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Permanent invariant (INV-S04): the user's raw `free_form_intent` is INTERPRETED
// into lens/priority signals at planning time and is NEVER threaded verbatim into
// a host work-item prompt. Unlike one-time migration guards, this is a forever-rule:
// the temptation to paste the intent string straight into a prompt recurs every
// time someone touches the host-handoff renderer, so the guard stays for good.
//
// The renderer that builds the host work-item prompt must therefore carry
// no reference to free_form_intent at all (interpretation happens upstream, in
// planningExecutors.interpretFreeFormIntent).

const here = dirname(fileURLToPath(import.meta.url));
const auditCodeRoot = join(here, "..", "..");

const HOST_WORKLOAD_RENDERERS = [
  join(auditCodeRoot, "src", "audit", "cli", "dispatch", "hostHandoff.ts"),
];

const FORBIDDEN = /free_form_intent|freeFormIntent/u;

for (const file of HOST_WORKLOAD_RENDERERS) {
  test(`host-workload renderer does not thread free_form_intent verbatim: ${file.slice(auditCodeRoot.length + 1)}`, () => {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    const hits: string[] = [];
    lines.forEach((line, i) => {
      // The renderer carries no free_form_intent reference at all — interpretation
      // happens upstream, so even a comment should use prose, not the literal token.
      if (FORBIDDEN.test(line)) {
        hits.push(`${i + 1}: ${line.trim()}`);
      }
    });
    expect(hits.length, `Host work-item prompts must not contain the raw free_form_intent — interpret it into ` +
        `lens/priority signals at planning instead (INV-S04):\n${hits.join("\n")}`).toBe(0);
  });
}
