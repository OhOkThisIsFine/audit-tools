/**
 * Repo-root hermeticity: a vitest invocation leaves the repo root as it found it.
 *
 * THE DEFECT THIS PINS. Runs kept leaving empty files in the repo root with
 * names lifted out of source and prose — `o.testId)`, `60s`, `0)`. Each is a
 * shell-redirect artifact: a command STRING handed to a shell carries the
 * shell's grammar, and `cmd.exe` reads `>` as a redirect anywhere in the line,
 * ending the target token at whitespace, `;`, `,` or `=`. So
 * `… .map((o) => o.testId);` writes a file named `o.testId)`, and prose reading
 * `the >60s blocking worker` writes one named `60s`. The artifact is empty and
 * tracked by nothing, so it survives every clean-tree check that looks at
 * CONTENT and only shows up as an untracked path in `git status`.
 *
 * WHY THE CHECK IS A SET DIFFERENCE, not a clean-root assertion: the root of a
 * working checkout legitimately holds artifacts nobody wants a suite to fail
 * on, including artifacts left by an EARLIER leak. The property is ownership of
 * the delta — this run added this entry — which is also what makes the report
 * name a producer rather than an inventory.
 *
 * The guard itself runs in `tests/helpers/global-setup.ts`'s teardown, the only
 * place that observes the tree after every test has finished. Exercised here
 * through its pure half, so the contract is red/green without a suite run.
 */
import { describe, it, expect } from "vitest";
import {
  RUN_OWNED_ROOT_ENTRIES,
  unexpectedRootEntries,
} from "../helpers/global-setup.js";

const BEFORE = ["CLAUDE.md", "package.json", "src", "tests"];

describe("repo-root hermeticity — a run's added entries are reported by name", () => {
  it("reports nothing when the root is unchanged", () => {
    expect(unexpectedRootEntries(BEFORE, [...BEFORE])).toEqual([]);
  });

  it("reports the shell-redirect artifacts that motivated the guard", () => {
    // The three names observed on this repo, each a fragment of real repo text.
    const leaked = unexpectedRootEntries(BEFORE, [...BEFORE, "o.testId)", "60s", "0)"]);
    expect(leaked).toEqual(["0)", "60s", "o.testId)"]);
  });

  it("reports a test writing a deliberate-looking file outside its scratch dir", () => {
    expect(unexpectedRootEntries(BEFORE, [...BEFORE, "result.json"])).toEqual(["result.json"]);
  });

  it("never reports an entry that was already there", () => {
    // A leak from an EARLIER run belongs to that run. Reporting it here would
    // fail every suite until someone deleted it, which trains the failure out.
    const before = [...BEFORE, "0)"];
    expect(unexpectedRootEntries(before, [...before])).toEqual([]);
  });

  it("never reports a declared tool-owned entry", () => {
    const after = [...BEFORE, ...RUN_OWNED_ROOT_ENTRIES, "tsconfig.tsbuildinfo"];
    expect(unexpectedRootEntries(BEFORE, after)).toEqual([]);
  });

  it("reports a removed entry as nothing — the check is about ADDITIONS", () => {
    // Deletion is a different defect with a different owner (a test cleaning up
    // a path it did not create). Folding it in here would make one report mean
    // two things.
    expect(unexpectedRootEntries(BEFORE, ["package.json"])).toEqual([]);
  });
});
