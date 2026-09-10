/**
 * A test either calls production code, or it says why it does not.
 *
 * THE DEFECT THIS CLOSES. A test file that re-implements the thing it is
 * testing does not test it. It tests a copy, and the copy stays green after the
 * original changes — the failure is silent by construction, because nothing in
 * the copy knows the original exists. The sweep this encodes ("Sweep the test
 * tree for tests that re-implement their subject", open-bugs) found the class
 * live and varied:
 *
 *   - `tests/shared/remediation-contracts.test.ts` declared its own
 *     `stableStringify`, so the artifact hashes it verified were computed with a
 *     serializer that had ALREADY drifted from the production one (production
 *     normalizes `undefined`; the copy did not). A fixture with a
 *     present-but-undefined field hashed two ways.
 *   - `tests/shared/verify-guards-denylist.test.ts` declared its own
 *     `globToRegExp`, "minimal" by its own comment, and graded whether the
 *     `verify:guards` denylist still matches real files with a different glob
 *     grammar than the runner uses.
 *   - `tests/audit/helpers/synthetic-results.mjs` hand-built the AuditResult
 *     payload — the second construction site in the repo, and the exact class
 *     `tests/audit/smoke-producer-contract.test.ts` documents as having failed
 *     release CI when `reviewed_clean` joined the contract.
 *   - `tests/audit/helpers/countLines.mjs` re-implemented the auditor's line
 *     counter, whose convention (`total_lines`) is what the fixtures exist to
 *     satisfy — so a divergence would have made the FIXTURES wrong, not the
 *     tests red.
 *
 * THE RULE. A test-file-declared function whose NAME matches a production export,
 * whose body BRANCHES, and whose file never imports that production name is a
 * mirror. It must either call the production symbol (import it, possibly
 * aliased — the `X as XImpl` wrapper pattern is explicitly FINE and common
 * here) or be listed below with a reason.
 *
 * WHY THIS SHAPE. Detection is heuristic by nature — "does this function
 * re-derive production logic" is not decidable from text, and the survey that
 * sized this guard found ~144 name collisions against ~13 genuine mirrors. The
 * three signals together (name match ∧ branching ∧ no production import) are
 * what separate them: a fixture BUILDER has no branching or no name collision; a
 * delegation WRAPPER imports the name; a fake for injection replaces a
 * dependency rather than an algorithm and does not collide with a production
 * export at all. The residual false positives are named below, one reason each.
 *
 * WHY AN ALLOWLIST IS THE RIGHT RESIDUE. The alternative — a broader rule — buys
 * coverage by flagging delegation wrappers, which would train the reader to
 * append an exception without reading. Every entry here is a function that is
 * genuinely NOT a mirror and cannot be made to import the colliding name.
 *
 * THE ALLOWLIST ROTS SAFE. Each entry's function is still required to be present
 * and still required to match under the same predicate, so deleting one of these
 * copies fails this test until its entry is removed. An entry cannot outlive the
 * code it excuses.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const TESTS_ROOT = join(REPO_ROOT, "tests");

/** Production roots: the code a test may legitimately be testing. */
const PRODUCTION_ROOTS = ["src", "scripts", "dispatch", "wrapper"];

/**
 * Test-declared functions that share a production export's name, branch, and do
 * not import it — yet are genuinely not mirrors. One line each, stating WHY the
 * production symbol is not what this function means.
 *
 * Keyed `<repo-relative path>::<function name>`.
 */
const NOT_A_MIRROR: Readonly<Record<string, string>> = {
  "tests/audit/cleanup.test.ts::fileExists": "answers 'is this a regular FILE', where the wrapper's same-named helper answers 'does this path resolve at all' (access). Folding them would change what the assertion means.",
  "tests/audit/next-step-helpers.test.ts::fileExists": "answers 'can this be READ as utf8', which is the property the test asserts about a written results file — deliberately stricter than path existence.",
  "tests/remediate/fixture-generator-drift-guard.test.ts::runGenerator": "a PROCESS LAUNCHER for the generator, not a re-implementation of it: it spawns the real script under tsx and the test byte-compares that output. The name collides with an unrelated helper in the roadmap generator; the subject is invoked, not copied.",
};

/** A `.test.*` / helper path under tests/, repo-relative with forward slashes. */
function toRepoPath(absolute: string): string {
  return relative(REPO_ROOT, absolute).split(sep).join("/");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // Dot-prefixed dirs are transient fixtures (a concurrently-running test's
    // scratch tree), never test source — the same exclusion INV-WH makes.
    if (entry.isDirectory() && entry.name.startsWith(".")) continue;
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && /\.(ts|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Every name exported by the production roots, mapped to its defining file. */
function productionExports(): Map<string, string> {
  const files = PRODUCTION_ROOTS.flatMap((root) =>
    walk(join(REPO_ROOT, root)).filter((f) => !f.endsWith(".d.ts")),
  );
  const names = new Map<string, string>();
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const pattern of [
      /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
      /export\s+const\s+([A-Za-z_$][\w$]*)\s*=/g,
      /export\s+class\s+([A-Za-z_$][\w$]*)/g,
    ]) {
      for (const match of source.matchAll(pattern)) {
        if (!names.has(match[1]!)) names.set(match[1]!, toRepoPath(file));
      }
    }
  }
  return names;
}

/**
 * The names this file binds from PRODUCTION — a module outside `tests/`, other
 * than a node builtin.
 *
 * A test that imports `stableStringify` from `audit-tools/shared` — or imports it
 * as `stableStringifyImpl` and wraps it — has answered the question this guard
 * asks. Whether the wrapped call is faithful is that wrapper's own test's
 * business, not this one's; what this guard refuses is a function that never
 * consults production at all.
 *
 * `tests/helpers/*` deliberately does NOT count as production. A helper that
 * delegates to production is good, but "my sibling in tests/ does it" is not
 * evidence that THIS function does — and the sibling may itself be the copy.
 * That exclusion is what keeps `tests/audit/helpers/countLines.mjs` visible even
 * though its consumers import it.
 */
function productionBoundNames(source: string): Set<string> {
  const bound = new Set<string>();
  const isProductionModule = (specifier: string): boolean => {
    if (specifier.startsWith("node:")) return false;
    if (specifier.startsWith("audit-tools/")) return true;
    // Relative: resolve the intent from the path, not the cwd. Anything that
    // climbs to `src/`, `scripts/`, `dispatch/` or `wrapper/` is production;
    // anything staying inside `tests/` is not.
    return /(?:^|\/)(src|scripts|dispatch|wrapper)\//.test(specifier);
  };

  const addClause = (clause: string): void => {
    for (const part of clause.split(",")) {
      const trimmed = part.trim().replace(/^type\s+/, "");
      if (trimmed.length === 0) continue;
      // `{ a as b }` and the TS `{ a: b }` form both bind `b`.
      const afterAs = trimmed.split(/\s+as\s+/);
      const afterColon = (afterAs[1] ?? afterAs[0]!).split(":");
      bound.add((afterColon[1] ?? afterColon[0]!).trim());
    }
  };

  for (const match of source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    if (isProductionModule(match[2]!)) addClause(match[1]!);
  }
  for (const match of source.matchAll(/import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{([^}]*)\})?\s*from\s*["']([^"']+)["']/g)) {
    if (!isProductionModule(match[3]!)) continue;
    bound.add(match[1]!);
    if (match[2]) addClause(match[2]);
  }
  for (const match of source.matchAll(/import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*["']([^"']+)["']/g)) {
    if (isProductionModule(match[2]!)) bound.add(match[1]!);
  }
  // The dynamic forms the test tree uses heavily to defeat stale `dist/`:
  // `const { a: b } = await import("…")` and `const ns = await import("…")`.
  for (const match of source.matchAll(/const\s*\{([^}]*)\}\s*=\s*await\s+import\(\s*["']([^"']+)["']/g)) {
    if (isProductionModule(match[2]!)) addClause(match[1]!);
  }
  for (const match of source.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+import\(\s*["']([^"']+)["']/g)) {
    if (isProductionModule(match[2]!)) bound.add(match[1]!);
  }
  return bound;
}

interface DeclaredFunction {
  name: string;
  body: string;
}

/** The `{ … }` body starting at the first `{` at or after `from`, brace-balanced. */
function balancedBody(source: string, from: number): string | null {
  const open = source.indexOf("{", from);
  if (open === -1) return null;
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  return null;
}

/**
 * Every function this file DECLARES — at any nesting depth.
 *
 * Top-level-only matching would miss the three strongest instances the survey
 * found, each of which was declared inside a `test()` body (an ingest-flag
 * mutex, a reachability closure, a recursive cycle detector). A `function`
 * declaration and a `const f = (…) =>` / `const f = async (…) =>` binding are
 * both declarations; an imported `XImpl` is not, because it is not declared here.
 */
function declaredFunctions(source: string): DeclaredFunction[] {
  const found: DeclaredFunction[] = [];
  const patterns = [
    /(?:^|\n)[ \t]*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g,
    /(?:^|\n)[ \t]*const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const body = balancedBody(source, match.index + match[0].length);
      if (body !== null) found.push({ name: match[1]!, body });
    }
  }
  return found;
}

/** Control flow that means the function COMPUTES something rather than builds a literal. */
const BRANCHES = /\b(if|for|while|switch|catch)\b/;

interface Mirror {
  key: string;
  production: string;
}

/**
 * The mirrors this tree declares, excluding the documented non-mirrors.
 *
 * The "calls production" test is deliberately about the BODY, not the file's
 * imports: a wrapper imports production under a local alias (`X as XImpl`) and
 * calls it, which is the pattern this repo uses and wants. Requiring the local
 * function to be named identically to an import would forbid that pattern and
 * buy nothing. What is refused is a body that computes its result with no
 * production call in it at all.
 */
function findMirrors(): Mirror[] {
  const production = productionExports();
  const mirrors: Mirror[] = [];
  for (const file of walk(TESTS_ROOT)) {
    const source = readFileSync(file, "utf8");
    const bound = productionBoundNames(source);
    const repoPath = toRepoPath(file);
    for (const declared of declaredFunctions(source)) {
      if (!production.has(declared.name)) continue;
      if (!BRANCHES.test(declared.body)) continue;
      const callsProduction = [...bound].some((name) =>
        new RegExp(`\\b${name}\\s*\\(`).test(declared.body),
      );
      if (callsProduction) continue;
      const key = `${repoPath}::${declared.name}`;
      if (key in NOT_A_MIRROR) continue;
      mirrors.push({ key, production: production.get(declared.name)! });
    }
  }
  return mirrors.sort((a, b) => a.key.localeCompare(b.key));
}

const MIRRORS = findMirrors();

describe("no test file re-implements its subject", () => {
  it("the detector is non-vacuous — it finds declarations, exports and branches at all", () => {
    // A scanner that silently matched nothing would report an empty violation
    // list, which is indistinguishable from a clean tree. Pin each half against
    // a synthetic sample so a broken regex fails HERE rather than by going quiet.
    const sample = [
      'import { realThing as aliased } from "../../src/x.js";',
      "function stableJson(value) {",
      "  if (Array.isArray(value)) return '[]';",
      "  return '{}';",
      "}",
      "function realThing(v) { if (v) return aliased(v); return null; }",
      "function countLines(root, p) { if (!p) return 0; return 1; }",
      "const helper = (a) => { for (const x of a) { a.push(x); } };",
    ].join("\n");

    const declared = declaredFunctions(sample).map((d) => d.name).sort();
    expect(declared, "both the function declaration and the arrow-const form must be found").toEqual([
      "countLines",
      "helper",
      "realThing",
      "stableJson",
    ]);

    const bound = productionBoundNames(sample);
    // `import { realThing as aliased }` binds ONLY `aliased` — `as` replaces the
    // local name rather than adding one. The wrapper pattern depends on this:
    // `X as XImpl` must leave `X` free for the wrapper to declare.
    expect(bound.has("aliased"), "an aliased production import binds the alias").toBe(true);
    expect(bound.has("realThing"), "an aliased import must NOT bind the original name").toBe(false);
    expect(bound.has("stableJson"), "a name with no import must NOT register").toBe(false);

    // A tests/-local helper is not production: importing it is not evidence that
    // the importing function consults production.
    expect(
      productionBoundNames('import { countLines } from "./countLines.mjs";').has("countLines"),
      "a tests/-relative import must not count as production",
    ).toBe(false);
    expect(
      productionBoundNames('import { stableStringify } from "audit-tools/shared";').has("stableStringify"),
      "the package barrel is production",
    ).toBe(true);
    expect(
      productionBoundNames('import { countLines } from "../../src/audit/cli/args.js";').has("countLines"),
      "a relative climb to src/ is production",
    ).toBe(true);
  });

  it("every production root contributes export names (the scan is not looking at an empty set)", () => {
    const production = productionExports();
    expect(production.size, "production export names must be discoverable").toBeGreaterThan(500);
    for (const name of ["stableStringify", "compareCodeUnits", "countLines"]) {
      expect(production.has(name), `${name} must be a known production export`).toBe(true);
    }
  });

  it("no test-declared function re-implements a production function of the same name", () => {
    expect(
      MIRRORS,
      MIRRORS.map(
        (mirror) =>
          `${mirror.key} re-declares a function named like the production export in ${mirror.production} ` +
          `without importing it.\n` +
          `  → a copy is tested, not the subject: the copy stays green after the original changes.\n` +
          `  → Fix: import the production symbol (aliasing it is fine — \`import { x as xImpl }\` and a ` +
          `thin wrapper is the established pattern here), or add a "${mirror.key}" entry to ` +
          `NOT_A_MIRROR in this file stating why the collision is not a duplication.`,
      ).join("\n\n"),
    ).toEqual([]);
  });

  it("every NOT_A_MIRROR entry still names a real function on disk — the allowlist cannot rot", () => {
    // An entry that outlives the code it excused silently widens the exemption
    // for whatever is written at that path next.
    const entries = Object.keys(NOT_A_MIRROR);
    expect(entries.length, "the allowlist is small enough to read in full").toBeLessThan(10);

    const stale: string[] = [];
    for (const entry of entries) {
      const [repoPath, name] = entry.split("::");
      let source: string;
      try {
        source = readFileSync(join(REPO_ROOT, repoPath!), "utf8");
      } catch {
        stale.push(`${entry} — the file no longer exists`);
        continue;
      }
      if (!declaredFunctions(source).some((declared) => declared.name === name)) {
        stale.push(`${entry} — the file declares no function named ${String(name)}`);
      }
    }
    expect(stale, `these NOT_A_MIRROR entries excuse nothing:\n${stale.join("\n")}`).toEqual([]);
  });
});
