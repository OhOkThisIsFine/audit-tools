// Red/green for the `--list` open-run write-scope block (nightly proposal P43).
//
// RED against HEAD: `--list` prints nothing about an open remediation run, so
// both "prints the scope" assertions fail while the "silent when absent" one
// passes vacuously. GREEN once the patch lands.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSyncHidden } from "../helpers/spawn.mjs";
import { afterEach, expect, test } from "vitest";

const ANSWER = join(process.cwd(), "scripts", "nightly", "answer.mjs");
const roots: string[] = [];

function makeRoot(runState: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "p43-"));
  roots.push(root);
  mkdirSync(join(root, ".claude"), { recursive: true });
  // One answered-but-not-done decision, so the --list branch reaches the block.
  writeFileSync(
    join(root, ".claude", "nightly-decisions.json"),
    // The ledger is a FLAT map keyed by subject key — not a { decisions: … }
    // envelope. A wrapped fixture reads as an empty ledger, `--list` takes its
    // "nothing to report" early exit, and the block under test is never reached.
    JSON.stringify({
      deadbeefdeadbeef: {
        disposition: "settled",
        answer: "do the thing",
        path: "docs/project-philosophy.md",
        decided_at: "2026-08-23T00:00:00.000Z",
      },
    }),
  );
  if (runState) {
    mkdirSync(join(root, ".audit-tools", "remediation"), { recursive: true });
    writeFileSync(
      join(root, ".audit-tools", "remediation", "state.json"),
      JSON.stringify(runState),
    );
  }
  return root;
}

function list(root: string): string {
  return execFileSyncHidden(process.execPath, [ANSWER, "--list"], {
    cwd: root,
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("no remediation state: --list says nothing about a run", () => {
  const out = list(makeRoot(null));
  expect(out).not.toMatch(/REMEDIATION RUN IS OPEN/);
});

test("an open run: --list prints each non-terminal item's declared write scope", () => {
  const out = list(
    makeRoot({
      status: "implementing",
      items: {
        "CP-NODE-7": { status: "pending", block_id: "B7" },
        "CP-NODE-9": { status: "resolved", block_id: "B9" },
      },
      plan: {
        blocks: [
          { id: "B7", touched_files: ["src/shared/engine/obligationEngine.ts"] },
          { id: "B9", touched_files: ["src/audit/README.md"] },
        ],
      },
    }),
  );
  expect(out).toMatch(/REMEDIATION RUN IS OPEN — 1 item\(s\)/);
  expect(out).toMatch(/CP-NODE-7/);
  expect(out).toMatch(/src\/shared\/engine\/obligationEngine\.ts/);
  // A terminal item's scope is not a live claim and must not be printed.
  expect(out).not.toMatch(/CP-NODE-9/);
});

test("a closed run claims nothing", () => {
  const out = list(
    makeRoot({
      status: "complete",
      items: { "CP-NODE-7": { status: "pending", block_id: "B7" } },
      plan: { blocks: [{ id: "B7", touched_files: ["src/x.ts"] }] },
    }),
  );
  expect(out).not.toMatch(/REMEDIATION RUN IS OPEN/);
});
