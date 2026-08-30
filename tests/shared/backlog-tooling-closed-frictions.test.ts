/**
 * A friction the TOOLING now refuses must not also be narrated in `docs/backlog/`.
 *
 * WHY THIS IS A TEST AND NOT A CAUTION. CLAUDE.md's rule is explicit — "a trap that can be
 * detected at a tool call is refused there, and its backlog entry is DELETED rather than
 * restated (two copies decay independently; the guard states the trap and the fix when it
 * fires)" — and it was written down and then not applied: the 2026-07-24 clear-out lap's
 * friction walk still carried a proxy-went-down instance months after a session-start probe
 * began reporting it, and a retracted `vitest` mutex whose hazard the source had already
 * removed. Both read as open work to every pass that opened the file, which is the cost: a
 * closed sub-item is not merely noise, it is a lead that sends the next lap to re-solve a
 * solved problem.
 *
 * THE ASSERTION IS TWO-SIDED, deliberately. Asserting the backlog's SILENCE alone would pass
 * vacuously if the guard were ever deleted — the backlog would be quiet about a friction that
 * had come back. So each row first proves its guard is LIVE in the source, and only then
 * requires the backlog not to carry a second copy. Remove the guard and the first assertion
 * goes red, naming the entry the backlog is now allowed to carry again.
 *
 * The table is the extension point: a row is added when a guard closes a backlog friction, in
 * the same change that deletes the entry. It stays small on purpose — a `restatement` pattern
 * is matched against every backlog file, so a loose one is false-RED surface on entries that
 * legitimately discuss the same subsystem.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const BACKLOG_DIR = join(REPO_ROOT, "docs", "backlog");

/**
 * Frictions a mechanism now guards, each anchored to the code that guards it.
 *
 * `guard.evidence` names two INDEPENDENT halves of the mechanism — detection and report —
 * so a partial gutting (a probe whose refusal was dropped, or vice versa) is caught rather
 * than passing on one surviving keyword.
 */
const CLOSED_BY_TOOLING = [
  {
    friction: "the offload proxy dying silently between laps, discovered only by a failed batch",
    guard: {
      file: join(".claude", "hooks", "session-start-guards.mjs"),
      evidence: [/probeLane\??\.?\(/, /OFFLOAD LANE DOWN/],
    },
    restatement: /LiteLLM proxy[\s\S]{0,80}?died/i,
  },
  {
    friction: "a mutex over concurrent vitest suites, defending a hazard fixture isolation had removed",
    guard: {
      file: join("scripts", "shared", "guard-no-suite-running.mjs"),
      evidence: [/concurrent SUITES are[\s\S]{0,40}safe/, /never refused/],
    },
    restatement: /refused a second\s*(?:\r?\n\s*)?`?vitest/i,
  },
];

/** Every backlog section file, read once. */
function backlogFiles() {
  return readdirSync(BACKLOG_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((file) => ({ file, text: readFileSync(join(BACKLOG_DIR, file), "utf8") }));
}

describe("a friction closed in tooling is not also carried in the backlog", () => {
  it("the table is non-empty, or this file is guarding nothing", () => {
    expect(CLOSED_BY_TOOLING.length).toBeGreaterThan(0);
  });

  for (const { friction, guard, restatement } of CLOSED_BY_TOOLING) {
    it(`the guard for ${friction} is live in ${guard.file.replace(/\\/g, "/")}`, () => {
      const src = readFileSync(join(REPO_ROOT, guard.file), "utf8");
      for (const pattern of guard.evidence) {
        expect(
          pattern.test(src),
          `${guard.file} no longer matches ${pattern} — the guard is gone, so the backlog may ` +
            `legitimately carry this friction again. Delete the row rather than the assertion.`,
        ).toBe(true);
      }
    });

    it(`no backlog file restates ${friction}`, () => {
      const offenders = backlogFiles()
        .filter(({ text }) => restatement.test(text))
        .map(({ file, text }) => `docs/backlog/${file}: ${JSON.stringify(text.match(restatement)![0])}`);
      expect(
        offenders,
        `A guarded friction is stated by the guard when it fires; a backlog copy decays ` +
          `independently and reads as open work. Trim the entry to its still-open remainder.`,
      ).toEqual([]);
    });
  }
});
