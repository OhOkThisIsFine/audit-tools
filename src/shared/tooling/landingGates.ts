// sites-pinned: tests/shared/landing-gates.test.ts, tests/remediate/host-handoff.test.ts
//   The discovery/vocabulary/scope rules are pinned by the shared suite; the
//   per-item wiring that remains (the glossary write scope) is pinned by the
//   host-handoff suite's "landing gates" block, and the close leg by
//   tests/remediate/landing-gates-close.test.ts.
//
// The repository's LANDING GATES: the tree-wide guard suites and the cheap
// release gates a LANDING must run, discovered from the target repository's own
// declared command surface.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
//
// The per-item required tests were the block's `targeted_commands`, which are
// MODULE-SCOPED: a block that edits one module declares the command that
// exercises that module. Three remediation landings reddened CI after green
// per-item runs, each on a gate no per-item command covers —
//
//   • a hand-restated `.audit-tools` literal caught only by the tree-wide
//     `tests/shared/audit-tools-path-guard.test.ts` (`1e7a4a54` fixed it),
//   • a case-folding assertion true only on a case-insensitive volume
//     (`011c6ae0`), and
//   • an intra-`src/shared` import cycle a reviewer graded minor that
//     `check:depgraph` refuses (`b5963957`).
//
// ── WHERE THE GATES RUN: THE CLOSE, NOT THE ITEM ─────────────────────────────
//
// The first attempt folded these gates into EVERY work item's `required_tests`.
// That was wrong, and the way it was wrong is worth keeping: these gates state
// facts about the WHOLE tree, so an item that adds an export whose only consumer
// lands in a LATER item could not pass, and no edit inside its own scope could
// make it pass; another item's fault could refuse this one too. A gate that
// GUESSES at a boundary owned by something else is moved to the boundary that
// owns it (CLAUDE.md, *A gate states the boundary it OWNS*) — and the merged tree
// exists only at the CLOSE. So the loop is: this module DISCOVERS the gates, and
// `verifyLandingGates` (`src/remediate/phases/closeVerifyLandingGates.ts`) runs
// them once each at close and folds the result into `fullyGreen`.
//
// What stays per-item is the one scope fact a prepare owns: a block that coins
// an invariant id needs the glossary document in its write scope, or the gate is
// unsatisfiable for the item that coins it (`withGlossaryScope` below).
//
// ── WHY IT IS DISCOVERED, NOT BAKED IN ───────────────────────────────────────
//
// `remediate-code` runs against ARBITRARY repositories. `check:depgraph`,
// `check:deadcode` and `check:lint` are THIS repository's script names; a
// language-neutral tool that hardcoded them would demand a target repo declare
// audit-tools' own private vocabulary, and would run the wrong thing (or
// nothing) everywhere else. So the gates are read from the target repo's
// `package.json` scripts through a DECLARED, preference-ordered vocabulary —
// exactly the shape `discoverProjectCommands` (./testCommand.ts) already uses
// for test/e2e/build/lint, so a "discover a project command by role" question
// has one answer in this codebase rather than two.
//
// Degrade-to-empty is the contract: a repo with no `package.json`, a malformed
// one, or one declaring none of these roles contributes NO landing gate. A
// missing gate narrows the landing command set; it never throws and never
// invents a command the repository did not declare.
//
// ⚠ WHAT "NO GATE DISCOVERED" DOES AND DOES NOT MEAN. Discovery reads the target
// repository's `package.json` `scripts` map and NOTHING ELSE — there is no
// `Makefile`, `Cargo.toml`, `build.gradle` or shell-script arm, and none is
// planned, because no portable way exists to read another build system's target
// names and a guessed target would run the wrong thing. So "no landing gate" is
// a fact about the manifest, never a claim that the repository has no tree-wide
// check: a repository with another build system gets NO landing gate at all, and
// the close report says so in one line rather than silently reporting a green
// gate set. A gate is only ever ADDED by the target declaring it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compareCodeUnits } from "../compareCodeUnits.js";

/**
 * One landing-gate ROLE, with the npm script names that declare it in
 * preference order — the same ordering rule `testCommand.ts` states: generic /
 * widely-adopted names first, framework- or repo-specific aliases last, and
 * `pickScript` returns the FIRST match.
 */
export interface LandingGateRole {
  /**
   * The gate's role. Named so a report, a test and a prompt can all say WHICH
   * gate a repo contributes without parsing its script name.
   */
  readonly role: "guard" | "deadcode" | "depgraph" | "glossary" | "lint";
  /**
   * One line, rendered wherever the landing gate is described to a host — the
   * gate's own statement of what it refuses, never restated at the call site.
   */
  readonly refuses: string;
  /** npm script names declaring this role, most generic first. */
  readonly scripts: readonly string[];
}

/**
 * The declared landing-gate vocabulary.
 *
 * ORDER IS THE EMITTED ORDER, and the four roles are independent: a repo
 * declaring only `check:lint` contributes exactly one command. Sorted by role
 * name (deadcode, depgraph, guard, lint) as the array literal, so the emitted
 * list is content-stable and a re-derivation cannot churn the workload digest
 * (CLAUDE.md, "Extractors emit stable, content-derived array order").
 *
 * `guard` is separate from the three cheap gates because it is the EXPENSIVE
 * one: the repository's own cross-cutting test suite. It is here because a
 * guard suite is precisely the gate a module-scoped `targeted_commands` entry
 * cannot stand in for — `tests/shared/audit-tools-path-guard.test.ts` is the
 * live example.
 */
export const LANDING_GATE_SCRIPT_NAMES: readonly LandingGateRole[] = [
  {
    role: "deadcode",
    refuses: "an exported symbol with zero consumers anywhere, including tests",
    scripts: ["check:deadcode", "check:dead-code", "deadcode", "knip"],
  },
  {
    role: "depgraph",
    refuses:
      "a module-graph violation — an import cycle, or an upward import out of the shared base layer",
    scripts: ["check:depgraph", "check:dep-graph", "depgraph", "depcruise"],
  },
  {
    role: "glossary",
    refuses:
      "an opaque identifier used in the source tree that no glossary row documents — the id-glossary gate",
    scripts: [
      "check:invariant-glossary",
      "check:glossary",
      "check:glossary-ids",
      "glossary:check",
    ],
  },
  {
    role: "guard",
    refuses:
      "a tree-wide invariant the repository's cross-cutting suites assert and no module-scoped command covers",
    scripts: ["verify:guards", "test:guards", "guards", "test:guard"],
  },
  {
    role: "lint",
    refuses: "a lint violation anywhere in the tree",
    scripts: ["check:lint", "lint", "lint:check"],
  },
];

function readPackageScripts(root: string): Record<string, unknown> | null {
  const packageJsonPath = join(root, "package.json");
  if (!existsSync(packageJsonPath)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const scripts = (parsed as { scripts?: unknown }).scripts;
    return scripts !== null && typeof scripts === "object" && !Array.isArray(scripts)
      ? (scripts as Record<string, unknown>)
      : null;
  } catch {
    // Unreadable / malformed package.json: no landing gates. A prepare must not
    // fail because a manifest it does not own is malformed — the same
    // degrade-to-empty rule `discoverProjectCommands` follows.
    return null;
  }
}

/** The `npm run <script>` command for a declared script name. */
function npmRun(script: string): string {
  return `npm run ${script}`;
}

/**
 * The repository's landing gates, as runnable command strings, in the
 * vocabulary's declared role order.
 *
 * Pure over `(root)` and deterministic: reads one manifest, emits a
 * content-stable sorted-by-role list, spawns nothing.
 */
export function discoverLandingGates(root: string): string[] {
  const scripts = readPackageScripts(root);
  if (scripts === null) return [];
  const commands: string[] = [];
  for (const gate of LANDING_GATE_SCRIPT_NAMES) {
    for (const name of gate.scripts) {
      const body = scripts[name];
      if (typeof body === "string" && body.trim().length > 0) {
        commands.push(npmRun(name));
        break;
      }
    }
  }
  return commands.sort(compareCodeUnits);
}

/**
 * The opaque-identifier family the id-glossary gate scans the source tree for.
 * Anchored to a word boundary at the end too, so a short namespace does not
 * match inside a longer token; and to `INV-` + an uppercase letter start, so a
 * lowercase test-family id (`INV-remediate-state-01`) is not read as a
 * production namespace — the same split `scripts/check-invariant-glossary.mjs`
 * draws.
 *
 * GLOBAL on purpose: {@link declaredInvariantIds} collects EVERY id in a value,
 * so the lastIndex state a `/g` regex carries is reset before each use there.
 */
const INVARIANT_ID = /\bINV-[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*\b/gu;

/**
 * Every invariant id a value DECLARES anywhere it can be nested — a module
 * contract's `invariants`, an obligation slug, or any other string a producer
 * hangs an id on. Walks objects and arrays rather than reading one named field,
 * because a contract's shape is the producer's, not this predicate's.
 *
 * Returns the SET of ids, not a boolean, because the caller has to subtract the
 * ids the glossary already documents: mentioning an existing id is not coining
 * one (see {@link withGlossaryScope}).
 */
export function declaredInvariantIds(value: unknown): Set<string> {
  const found = new Set<string>();
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      INVARIANT_ID.lastIndex = 0;
      for (const match of node.matchAll(INVARIANT_ID)) found.add(match[0]);
      return;
    }
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry);
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const entry of Object.values(node as Record<string, unknown>)) walk(entry);
    }
  };
  walk(value);
  return found;
}

/**
 * Whether a value declares ANY invariant id — the boolean form of
 * {@link declaredInvariantIds}, for a caller that only needs the predicate.
 */
export function declaresInvariantId(value: unknown): boolean {
  return declaredInvariantIds(value).size > 0;
}

/**
 * The one-line statement of what a landing gate command REFUSES, or `null` when
 * the command was not declared as one.
 *
 * Rendered wherever a host is told what its required tests cover, so the
 * sentence stating a gate's authority is written once, beside the vocabulary
 * that declares the gate. `null` for an item's own `targeted_commands`, which
 * are not landing gates and carry no vocabulary entry.
 */
export function landingGateRefusal(command: string): string | null {
  for (const gate of LANDING_GATE_SCRIPT_NAMES) {
    if (gate.scripts.some((name) => npmRun(name) === command)) {
      return `\`${command}\` — refuses ${gate.refuses}`;
    }
  }
  return null;
}

/**
 * The glossary document a scope must be able to write when it coins an
 * invariant id. Repo-relative, so it composes with `allowed_files` unchanged.
 *
 * ⚠ This is THIS repository's convention, and it is only ever consulted as a
 * CANDIDATE. `remediate-code` runs against arbitrary repositories, so the path
 * being a constant is not a claim that the document exists — a target root that
 * has no such file gets NO widening at all (a content fact, checked by
 * {@link withGlossaryScope}). A tool that widened on the NAME alone would hand
 * an item write scope over a file its repository does not have.
 */
export const GLOSSARY_DOCUMENT_PATH = "docs/glossary-ids.md";

/**
 * The invariant ids the glossary document at `root` already carries, or `null`
 * when the document does not exist there.
 *
 * `null` and an empty set are DIFFERENT answers, and collapsing them is the bug
 * this return type exists to prevent: absent means this repository keeps no
 * glossary document, so nothing can be coined against it and no scope widens;
 * present-and-empty means every id in the contract is new.
 */
function documentedInvariantIds(root: string): Set<string> | null {
  const documentPath = join(root, ...GLOSSARY_DOCUMENT_PATH.split("/"));
  if (!existsSync(documentPath)) return null;
  try {
    return declaredInvariantIds(readFileSync(documentPath, "utf8"));
  } catch {
    // Unreadable glossary: "cannot tell which ids are documented". The EMPTY
    // set is the conservative answer — it widens for any declared id, granting
    // only a scope an item's own contract asked for, whereas returning `null`
    // turns a read error into the silent dead-end this function removes.
    return new Set<string>();
  }
}

/**
 * Widen a work item's write scope so an item that COINS an invariant id can
 * actually satisfy the id-glossary gate.
 *
 * ── THE FRICTION THIS CLOSES ─────────────────────────────────────────────────
 *
 * The glossary document is outside every module's `file_scope`; the glossary
 * gate scans `src/` for `INV-*` ids and fails on one with no glossary row. So
 * an item that coins an id in `src/` is STRUCTURALLY UNABLE to satisfy the
 * gate: the fix is a glossary edit its write scope forbids, and the red lands
 * silently, discovered by the NEXT item's worker. It happened twice in one
 * session (`INV-SSP-DEFERRED-SET-REPORTED` at CP-NODE-10, and the id the
 * charter-delta parser coined at CP-NODE-18, since retired with that parser) —
 * the "tool_should_decide" friction in `docs/backlog/open-bugs.md`.
 *
 * ── THREE CONDITIONS, EACH NARROWING ─────────────────────────────────────────
 *
 *  1. The document must EXIST in the target root. The path is this
 *     repository's convention; an arbitrary target repo may keep none, and
 *     widening for a document that is not there grants scope over nothing.
 *  2. The contract must declare at least one id the document does NOT already
 *     carry. A contract that merely MENTIONS `INV-COVERAGE` — a seam adjustment
 *     citing an existing invariant, a prose reference — coins nothing, and
 *     widening for it hands the item a document it has no business editing.
 *     Only an id with no row yet is a COIN, because only that id needs one.
 *  3. The scope must not already carry the path (idempotence).
 *
 * The gate itself is bound separately, at the CLOSE — scope without the gate
 * would leave the red silent; the gate without scope would turn it into a
 * dead-end refusal. Both halves are the one decision.
 *
 * Deterministic, stable-ordered and idempotent: a scope that already carries
 * the path is returned unchanged.
 */
export function withGlossaryScope(
  root: string,
  allowedFiles: readonly string[],
  declaredIds: ReadonlySet<string>,
): string[] {
  if (declaredIds.size === 0 || allowedFiles.includes(GLOSSARY_DOCUMENT_PATH)) {
    return [...allowedFiles];
  }
  const documented = documentedInvariantIds(root);
  if (documented === null) return [...allowedFiles];
  if (![...declaredIds].some((id) => !documented.has(id))) return [...allowedFiles];
  return [...allowedFiles, GLOSSARY_DOCUMENT_PATH].sort(compareCodeUnits);
}

