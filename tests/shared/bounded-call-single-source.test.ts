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

test("every fold that drives the engine routes its non-convergence through the ONE describer (inv-3)", async () => {
  // inv-3 asks that a consumer PAUSE rather than report a finished run when the
  // fold stops without converging.
  //
  // This assertion replaces a "satisfied by absence" record whose premise was
  // false when it was written (2026-08-24, `9d32c078`). That record said "the
  // remediate step machine does not drive the shared engine at all, so it has no
  // bound to reach", and kept itself true by asserting only that the token
  // `maxTransitions` was absent from remediate's step machine. But remediate had
  // been driving `advance` since 2026-06-17 (A3 slices `54aa2ce9` / `0a321cc1`),
  // two months earlier — so the guard was green for the wrong reason, and the
  // very defect it existed to catch (both remediate sites branching on `.step`
  // alone, reporting a wedged fold as a finished run) lived underneath it.
  //
  // An absence record is only ever as strong as its premise, and nothing
  // re-checks a premise. So this asserts the PRESENT property instead: a file
  // that drives the engine must describe a non-convergent stop through
  // `describeStoppedFold`, the single home for that description. Hand-rolling
  // the cause string is what let the two audit copies and the two remediate
  // omissions diverge in the first place.
  const offenders: string[] = [];
  for (const file of await sourceFiles()) {
    const source = await readFile(file, "utf8");
    // Files that DRIVE the engine — the shared entry point, or its alias.
    const drivesEngine = /(?:await\s+)?\b(?:advance|advanceObligations)\s*\(/.test(source);
    // The engine module itself DEFINES both; it is not a consumer of them.
    const isEngineItself = repoRelative(file) === "src/shared/engine/obligationEngine.ts";
    if (!drivesEngine || isEngineItself) continue;
    if (!/\bdescribeStoppedFold\s*\(/.test(source)) offenders.push(repoRelative(file));
  }
  expect(
    offenders,
    "these files drive the obligation engine but never describe a non-convergent stop — a caller " +
      "that branches on `step` alone cannot tell completion from non-convergence, so it reports a " +
      "wedged fold as a finished run; route the outcome through describeStoppedFold()",
  ).toEqual([]);
});
