// P51 — a form-recognizing guard's recognized FORMS are declared data.
//
// RED AT HEAD: the `check:memory-citations` row in scripts/guard-reach-data.mjs
// carries no `forms` field, so this test finds nothing to reconcile and fails on
// the declaration itself. See RED-AT.txt beside this file for the measured run.
//
// The test drives the REAL guard over each declared sample in a throwaway repo,
// so it asserts recognition by the shipped implementation rather than by a
// re-implementation of its regexes (which would pass while the guard rotted).
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterAll } from "vitest";

import { GUARDS } from "../../scripts/guard-reach-data.mjs";

const ROOT = process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd();

/** Guards that declare the syntax forms they must recognize. */
const formGuards = (GUARDS as Array<Record<string, unknown>>).filter(
  (g) => Array.isArray(g["forms"]) && (g["forms"] as unknown[]).length > 0,
);

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/**
 * A throwaway git repo holding one doc that carries `sample`, plus an empty
 * memory store — so every citation in the sample is dangling by construction and
 * the assertion never depends on the real store's contents.
 */
function runGuardOver(sample: string): { status: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "guard-form-reach-"));
  temps.push(dir);
  const memory = join(dir, "memory");
  mkdirSync(memory);
  writeFileSync(join(dir, "doc.md"), `# fixture\n\n${sample}\n`);
  execFileSync("git", ["init", "--quiet"], { cwd: dir, windowsHide: true });
  execFileSync("git", ["add", "doc.md"], { cwd: dir, windowsHide: true });

  const result = execFileSync(
    process.execPath,
    [join(ROOT, "scripts", "check-memory-citations.mjs")],
    {
      cwd: dir,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, AUDIT_TOOLS_MEMORY_DIR: memory },
      // a dangling citation exits non-zero; capture rather than throw
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return { status: 0, output: result };
}

describe("guard form reach", () => {
  it("at least one guard declares the forms it must recognize", () => {
    // The declaration is the source of truth. An empty set means the mechanism
    // is not wired, which is exactly the HEAD state this proposal addresses.
    expect(formGuards.length).toBeGreaterThan(0);
  });

  for (const guard of formGuards) {
    const id = String(guard["id"]);
    const forms = guard["forms"] as Array<{ name: string; sample: string }>;
    for (const form of forms) {
      it(`${id} still recognizes the ${form.name} form`, () => {
        let output = "";
        try {
          output = runGuardOver(form.sample).output;
        } catch (error) {
          // non-zero exit is the DETECTED path — the guard found the dangling cite
          const e = error as { stdout?: string; stderr?: string };
          output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
        }
        expect(output).toContain("this-note-does-not-exist");
      });
    }
  }
});
