import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Permanent invariant (INV-S04): the user's raw `free_form_intent` is INTERPRETED
// into lens/priority signals at planning time and is NEVER threaded verbatim into
// a worker prompt. Unlike the opentoken migration guard, this is a forever-rule:
// the temptation to paste the intent string straight into a prompt recurs every
// time someone touches the worker-prompt renderer, so the guard stays for good.
//
// The renderer that builds the auditor worker packet prompt must therefore carry
// no reference to free_form_intent at all (interpretation happens upstream, in
// planningExecutors.interpretFreeFormIntent).

const here = dirname(fileURLToPath(import.meta.url));
const auditCodeRoot = join(here, "..");

const WORKER_PROMPT_RENDERERS = [
  join(auditCodeRoot, "src", "cli", "dispatch", "packetPrompt.ts"),
];

const FORBIDDEN = /free_form_intent|freeFormIntent/u;

for (const file of WORKER_PROMPT_RENDERERS) {
  test(`worker-prompt renderer does not thread free_form_intent verbatim: ${file.slice(auditCodeRoot.length + 1)}`, () => {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    const hits = [];
    lines.forEach((line, i) => {
      // The renderer carries no free_form_intent reference at all — interpretation
      // happens upstream, so even a comment should use prose, not the literal token.
      if (FORBIDDEN.test(line)) {
        hits.push(`${i + 1}: ${line.trim()}`);
      }
    });
    assert.equal(
      hits.length,
      0,
      `Worker prompts must not contain the raw free_form_intent — interpret it into ` +
        `lens/priority signals at planning instead (INV-S04):\n${hits.join("\n")}`,
    );
  });
}
