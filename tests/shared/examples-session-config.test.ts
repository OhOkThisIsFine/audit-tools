/**
 * examples-session-config.test.mjs
 *
 * Anti-rot guard for the bundled example configs. The G2 RepoSessionIntent split
 * made dispatch-inventory fields (provider / per-backend launch blocks / sources)
 * unrepresentable on the persisted `session-config.json` — and every bundled
 * session-config example silently rotted against that contract because nothing
 * validated them. This test holds each example to the SAME validator the load
 * boundary runs, so an example that stops passing `validateRepoSessionIntent`
 * fails the suite instead of misleading an operator.
 *
 * - `examples/session-config/*.json` — persisted repo intent; must pass
 *   `validateRepoSessionIntent` with zero error-severity issues.
 * - `examples/auditor-descriptor/*.json` — the `--auditor` descriptor; its
 *   `sources[]` must pass the shared `validateSessionConfig` sources check
 *   (the same bar `readSourceDeclaration` holds the machine declaration to).
 *
 * The machine declaration itself (`~/.audit-code/sources-declared.json`) has no
 * bundled example to guard: it named another broker's pools, went stale when they
 * were renamed, and was deleted rather than re-pinned. `readSourceDeclaration`'s
 * own coverage lives in `tests/shared/auditor-sources.test.ts`.
 */
import { test, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateRepoSessionIntent,
  validateSessionConfig,
} from "../../src/shared/validation/sessionConfig.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const EXAMPLES = join(REPO_ROOT, "examples");

function readJsonExamples(dir: string) {
  const files = readdirSync(dir).filter((name) => name.endsWith(".json"));
  return files.map((name) => ({
    name,
    value: JSON.parse(readFileSync(join(dir, name), "utf8")),
  }));
}

function errorIssues<T extends { severity: string }>(issues: T[]): T[] {
  return issues.filter((issue) => issue.severity === "error");
}

test("every examples/session-config/*.json passes validateRepoSessionIntent", () => {
  const examples = readJsonExamples(join(EXAMPLES, "session-config"));
  expect(examples.length, "at least one session-config example must exist").toBeGreaterThan(0);
  for (const { name, value } of examples) {
    const errors = errorIssues(validateRepoSessionIntent(value));
    expect(
      errors,
      `examples/session-config/${name} must be a valid persisted RepoSessionIntent`,
    ).toEqual([]);
  }
});

test("every examples/auditor-descriptor/*.json carries valid sources", () => {
  const examples = readJsonExamples(join(EXAMPLES, "auditor-descriptor"));
  expect(examples.length, "at least one auditor-descriptor example must exist").toBeGreaterThan(0);
  for (const { name, value } of examples) {
    expect(value.self, `examples/auditor-descriptor/${name} must have a self block`).toBeTypeOf(
      "object",
    );
    if (value.sources !== undefined) {
      const errors = errorIssues(validateSessionConfig({ sources: value.sources }));
      expect(
        errors,
        `examples/auditor-descriptor/${name} sources[] must pass the shared validator`,
      ).toEqual([]);
    }
  }
});
