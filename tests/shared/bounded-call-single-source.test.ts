/**
 * CP-NODE-7 (OBL-impl-block-5-inv-1, -inv-3, -fail-1) — the bounded-call
 * invariant has ONE home, and no consumer recognizes it by reading prose.
 *
 * fail-1 names the failure this file exists to prevent: "cap unified but one
 * consumer still catches by message substring — silent behavioral divergence;
 * the grep verification must be part of the change set." A one-off grep at
 * review time cannot hold that, because the next edit is not reviewed by the
 * person who ran it. So the verification is a test.
 *
 * These are TREE properties, so they are asserted over source text on purpose.
 * A type-level or call-level assertion cannot see the thing being banned: a
 * second constant that nobody imports, or a `catch` that rebuilds the engine's
 * bound out of a message, are both perfectly well-typed.
 */

import { test, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MAX_TRANSITIONS,
  ENGINE_TRANSITION_HEADROOM,
  deriveEngineBound,
} from "audit-tools/shared";
import { MAX_DRAIN_STEPS, engineMaxTransitions } from "../../src/audit/orchestrator/advance.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC_ROOT = join(REPO_ROOT, "src");

/** Every `.ts` file under `src/`, path-sorted so the walk is deterministic. */
async function sourceFiles(dir: string = SRC_ROOT): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await sourceFiles(full)));
    } else if (entry.name.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found;
}

function repoRelative(absolute: string): string {
  return absolute.slice(REPO_ROOT.length + 1).replaceAll("\\", "/");
}

test("the engine states the bound, and the audit cap DERIVES from it", () => {
  expect(deriveEngineBound(MAX_DRAIN_STEPS)).toBe(
    MAX_DRAIN_STEPS + ENGINE_TRANSITION_HEADROOM,
  );
  // The audit consumer's bound IS the engine's derivation, not a parallel one.
  expect(engineMaxTransitions()).toBe(deriveEngineBound(MAX_DRAIN_STEPS));
  expect(engineMaxTransitions(10)).toBe(deriveEngineBound(10));
  expect(typeof DEFAULT_MAX_TRANSITIONS).toBe("number");
});

test("the transition headroom is written in exactly ONE source file", async () => {
  const files = await sourceFiles();
  const declaring: string[] = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    // A DECLARATION of the headroom, not a mention of it: the ban is on a
    // second constant, not on naming the concept in a comment.
    if (/(?:const|let|var)\s+ENGINE_TRANSITION_HEADROOM\b/.test(source)) {
      declaring.push(repoRelative(file));
    }
  }
  expect(
    declaring,
    "a second headroom constant decouples the graceful cap from the derived bound",
  ).toEqual(["src/shared/engine/obligationEngine.ts"]);
});

test("no consumer recognizes the engine bound by string-matching an error message", async () => {
  const files = await sourceFiles();
  const offenders: string[] = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    // Whitespace-normalized, so the ban survives reformatting: the offending
    // idiom wrapped across two lines by prettier is the same defect as the
    // one-liner, and a per-line scan would miss it. The banned shape is a
    // message TEST — reading `.message` and asking whether the engine's bound
    // text is in it. The engine reports the bound as `stopped: "bound"` plus
    // `lastObligationId`, so code reaching for prose is reconstructing a
    // contract that is already structured.
    const flat = source.replace(/\s+/g, " ");
    const pattern = /\.message\b[^;]{0,160}?(?:maxTransitions|exceeded maxTransitions)/gi;
    for (const match of flat.matchAll(pattern)) {
      offenders.push(`${repoRelative(file)}: ${match[0].trim()}`);
    }
  }
  expect(
    offenders,
    "the engine bound is a structured outcome; matching its message text is the divergence fail-1 names",
  ).toEqual([]);
});

test("the remediate step machine drives no second, uncapped fold (inv-3, by absence)", async () => {
  // inv-3 asks that remediate pause rather than crash at the bound. Verified at
  // HEAD and recorded here rather than satisfied by invention: the remediate
  // step machine does not drive the shared engine at all, so it has no bound to
  // reach. This test is what keeps that TRUE — the day it starts driving the
  // engine, this red is the reminder that it needs the pause handling the audit
  // CLI has.
  const source = await readFile(
    join(REPO_ROOT, "src/remediate/steps/nextStep.ts"),
    "utf8",
  );
  expect(
    /\bmaxTransitions\b/.test(source),
    "remediate's step machine has started bounding a fold — give it the graceful stopped:'bound' handling too",
  ).toBe(false);
});
