import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// INV-WH: a raw `node:child_process` entry point flashes a console window when
// the parent is windowless on win32. The hidden wrapper is the only door.
import { execSyncHidden } from "../helpers/spawn.mjs";
// The recognizer lives in the shared helper so the guard-form-reach test can
// drive the REAL matcher over each declared sample (P51).
import {
  CONCEPTUAL_CATEGORY_TOKENS as CANONICAL,
  enumeratingCommentLines,
} from "../helpers/recognizers.js";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");

function trackedTsSources(): string[] {
  return execSyncHidden('git ls-files "src/**/*.ts"', {
    cwd: REPO_ROOT,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);
}


describe("conceptual finding categories are single-sourced", () => {
  it("no source comment re-enumerates the category set", () => {
    const offenders = trackedTsSources().flatMap((file) =>
      enumeratingCommentLines(readFileSync(resolve(REPO_ROOT, file), "utf8")).map((hit) => ({
        file,
        ...hit,
      })),
    );
    const detail = offenders
      .map(
        (o) =>
          `${o.file}:${o.line} names ${o.named.length}/${CANONICAL.length} categories ` +
          `(missing: ${CANONICAL.filter((c) => !o.named.includes(c)).join(", ") || "none"})\n    ${o.text}`,
      )
      .join("\n  ");
    expect(
      offenders,
      offenders.length
        ? `A comment hand-copies the conceptual category set, so it drifts silently when the set changes.\n  ${detail}`
        : "",
    ).toEqual([]);
  });
});
