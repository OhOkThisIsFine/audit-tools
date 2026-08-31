/**
 * The pre-commit doc-contract leg must name the cause it OBSERVED, or say it
 * could not tell — it must never assert one of several possible causes as fact
 * (`docs/backlog/open-bugs.md`).
 *
 * The leg fires whenever a `.md`, `opencode.json` or `.gemini/*` is staged,
 * which is nearly every commit here, and it runs `npm run test:doc-contract`.
 * Its `catch` returned ONE fixed headline: "A staged doc/asset broke a test
 * that pins its exact content (release-contract / *-doc-sync /
 * host-asset-renderer-drift)". That run also carries the suite `globalSetup`
 * and `teardown`, so an in-tree fixture leak, a live child of the run, or an
 * ordinary flake produced the same confident sentence — naming three files that
 * were not the problem, above the real evidence.
 *
 * Attribution belongs to the gate RUNNER, not to this hook: the hook sees only
 * a process exit code, while `scripts/shared/run-vitest-gate.mjs` holds the
 * run-token-validated ledger that records which files failed (PH-05 — a gate
 * states the boundary it OWNS, and a gate guessing at a boundary owned by
 * something else is moved to the boundary that owns it). So the runner STATES
 * the attribution on one machine-readable line and the hook RELAYS it.
 */
import { rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, beforeEach, afterEach } from "vitest";
import { initGateRepo, runGate, g } from "./pre-commit-gate-harness.js";

let repo: string;

beforeEach(() => {
  repo = initGateRepo();
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

/** Point `test:doc-contract` at a script that fails the way this case needs. */
function withFailingDocContract(body: string): void {
  writeFileSync(join(repo, "fail-doc-contract.mjs"), body);
  const pkgPath = join(repo, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.scripts["test:doc-contract"] = "node fail-doc-contract.mjs";
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  g(repo, "add", "-A");
  g(repo, "commit", "-qm", "fixture: a failing doc-contract leg");
}

/** Stage a markdown file, which is what arms the doc-contract leg. */
function stageDoc(): void {
  writeFileSync(join(repo, "docs-note.md"), "# note\n");
  g(repo, "add", "-A");
}

test("an unattributable doc-contract failure is reported as unattributable, not as a broken content pin", () => {
  // The run dies OUTSIDE the tests — a globalSetup fault, a live child, a
  // crashed worker. It states no attribution, because it has none.
  withFailingDocContract(
    'process.stderr.write("Error: globalSetup threw before any test ran\\n");\nprocess.exit(1);\n',
  );
  stageDoc();

  const r = runGate(repo);
  const out = `${r.stdout}${r.stderr}`;

  // It still BLOCKS: an unattributable failure is a failure.
  expect(out).toMatch(/doc-contract/i);
  // But it must not assert the cause it never observed.
  expect(out).not.toMatch(/broke a test that pins its exact content/);
  expect(out).toMatch(/could not (?:tell|attribute)/i);
});

test("an attributed doc-contract failure names the file the runner reported", () => {
  // The runner states what its own token-validated ledger recorded.
  withFailingDocContract(
    'process.stderr.write("[vitest-gate] ATTRIBUTION: files=tests/shared/handoff-roadmap.test.ts\\n");\nprocess.exit(1);\n',
  );
  stageDoc();

  const r = runGate(repo);
  const out = `${r.stdout}${r.stderr}`;

  // The failing file is named IN THE HEADLINE. Asserting only that the output
  // contains the name would pass today for the wrong reason: the handler echoes
  // the last 40 lines of the run, so the name is already down there under a
  // headline that contradicts it.
  const headline = out.split(/\r?\n/).find((l) => /doc-contract tests FAILED/.test(l)) ?? "";
  expect(headline).toMatch(/handoff-roadmap\.test\.ts/);
  // Note it is the FOURTH file of the real `test:doc-contract` run — the one
  // the old fixed three-file list never mentioned at all.
  expect(out).not.toMatch(/release-contract \/ \*-doc-sync/);
  expect(out).not.toMatch(/could not (?:tell|attribute)/i);
});
