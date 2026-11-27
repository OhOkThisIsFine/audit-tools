import { admitRemediationDirtyBaseline } from "../state/dirtyBaseline.js";
// sites-pinned: tests/self-remediation-gate.test.mjs
import { isFileMissingError } from "../../shared/io/json.js";
import { hashContent } from "../../shared/hash.js";
import { discoverProjectCommands } from "../../shared/tooling/testCommand.js";
import { existsSync, statSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { normalizeRepoPath } from "../../shared/validation/findingGrounding.js";
import { AUDIT_TOOLS_DIRNAME } from "../../shared/io/auditToolsPaths.js";
import { headCommit, stagedAndUntracked, workingTreeTree } from "../../shared/git.js";
import { uniqueSorted } from "../../shared/compareCodeUnits.js";

// Pinned, deterministically-derived gate command set for the audit-tools monorepo.
// Single-sourced here so every gate that runs it (the tool-owned final gate and
// the phase-boundary gate) draws the exact command from one derivation rather
// than a hardcoded string literal — a literal `"npm run check"` default is
// host-discretion-by-prose (it assumes npm + a `check` script) and fails the
// everything-agnostic test. It imports no remediation step module, so any of
// them can import it without an import cycle.

/** One command in the tool-owned final gate. */
export interface FinalGateCommandSpec {
  argv: string[];
  /** True for commands that neither build nor run a build-prepending test script. */
  build_free: boolean;
  /** The package this command's unit suite targets (single-flight key), if any. */
  package_dir?: string;
  /** Which layer of the floor this belongs to. */
  layer: "build" | "check" | "lint" | "unit";
}

/** The same build-free suite used by the release, resolved relative to the checkout. */
const CONTRACT_TEST_SCRIPT = join("scripts", "shared", "run-contract-tests.mjs");

/**
 * Whether `root` is the audit-tools monorepo — the repo the tool-owned final
 * gate's suite (INV-RS-10, literally the audit-tools build/check/per-package
 * commands) applies to. The gate's command list is audit-tools-specific by
 * design (this remediation run remediates the audit-tools monorepo), so it is
 * scoped to that structure rather than fabricated for an arbitrary target repo.
 *
 * The predicate checks every marker AND the script the gate will actually spawn.
 * Checking only the layout markers made applicability a COINCIDENCE: a tree with
 * the five markers but no gate script would be judged in-scope, then run
 * `node <missing path>`, exit 1, and report a whole-repo RED on a healthy repo —
 * precisely the false-red class this gate's pause design exists to avoid, and
 * reachable because a five-marker tree is easy to construct (a test fixture is
 * one). A tree that cannot run the suite is OUT of scope, not failing it.
 */
export function isAuditToolsMonorepo(root: string): boolean {
  // Single-package layout: the three subsystems are inlined under src/ and both
  // bins live at the repo root. (Name kept for continuity; it is now one package.)
  return (
    existsSync(join(root, "src", "shared")) &&
    existsSync(join(root, "src", "audit")) &&
    existsSync(join(root, "src", "remediate")) &&
    existsSync(join(root, "audit-code.mjs")) &&
    existsSync(join(root, "remediate-code.mjs")) &&
    existsSync(join(root, CONTRACT_TEST_SCRIPT))
  );
}

// ── Red attribution ──────────────────────────────────────────────────────────

/**
 * The tool's own run artifacts, and the ONE path family that must never count as
 * run-touched EDIT. This is not a heuristic about what "real source" is — it is
 * the exact carve-out `collectStagingFiles` and `resolveEditSurfaceManifest`
 * already apply to the closing commit (`AUDIT_TOOLS_EXCLUDE_PATTERN`), for the
 * same reason and with the same consequence if omitted here.
 *
 * The stake is specific: `<artifactsDir>` is dirty in EVERY run — the step
 * contract, the run log, the state file are all rewritten each call — so a run
 * that did nothing but take a step would have a non-empty touched set, EVERY
 * red would carry an overlap, and the `environment` verdict would be
 * unreachable. The exemption is what makes the verdict able to fire at all.
 *
 * Deliberately the DEFAULT artifacts dir, not a resolved one. `state` carries no
 * artifacts-dir member (it is derived from `--root`), so a run on a custom
 * `--artifacts-dir` gets no exemption — a DECLARED residual, not a silent one.
 * The failure direction is safe: the un-exempted scratch can only ever ADD a
 * run-touched path, which pushes the verdict toward `run`/`unattributable` and
 * never toward the fail-open `environment` answer.
 */
const RUN_SCRATCH_PREFIX = `${AUDIT_TOOLS_DIRNAME}/`;

/**
 * The slice of remediation state red attribution reads. Declared structurally
 * rather than imported, so this module depends only on the fields attribution
 * reads, not on the full remediation state type.
 *
 * `run_baseline_diff` is the one member that is NOT a persisted field: the gate
 * derives it from `root` beside the state and hands it over on the same object,
 * so there is exactly one shape flowing into {@link attributeGateRed} rather than
 * a state argument and a loose path array that can drift apart.
 */
export interface RemediationGateState {
  /** The union of every landed host result's corroborated changed-file set. */
  applied_edit_surface?: readonly string[];
  /** Paths dirty at run start — pre-existing dirt the run cannot own. */
  run_start_dirty?: readonly string[];
  run_start_dirty_encoding?: "git-z/v1";
  /** Paths dirty relative to the run-start baseline (derived at the gate). */
  run_baseline_diff?: readonly string[];
}

/**
 * How many failing paths a red record names. Bounded like the output tails
 * beside it: this lands in a durable artifact a prompt POINTS AT, and a red on a
 * badly broken tree can implicate hundreds of files. The COUNT is always
 * recorded; only the sample is capped.
 */
export const GATE_ATTRIBUTION_SAMPLE_LIMIT = 20;

/** The attribution verdict carried on a red gate record. */
export interface GateRedAttribution {
  /**
   * `run`         — at least one failing path is one the run itself touched.
   * `environment` — a non-empty failing set of NON-TEST paths, none of which the
   *                 run touched: path non-overlap only, not causal proof. FAIL-CLOSED
   *                 on the test-file case — see {@link isTestFilePath}: a red
   *                 located in a test file names a path a run edits source and
   *                 never touches, so it can never be the evidence that excuses
   *                 the run.
   * `unattributable` — no failing path could be harvested (the command failed
   *                 before naming files), the run touched nothing, or every
   *                 failing path is a test file with no overlap. Stated as its
   *                 own value rather than folded into either side: "no evidence"
   *                 is not "evidence of innocence", and the predecessor's whole
   *                 failure was GUESSING which of the two an unattributable red
   *                 was.
   */
  verdict: "run" | "environment" | "unattributable";
  /** The run-touched paths the gate could derive, normalized and sorted. */
  run_paths_considered: string[];
  /** Failing paths that ARE in the run's touched set (capped, sorted). */
  run_paths: string[];
  /** Failing paths that are NOT (capped, sorted) — present when the verdict is `environment`. */
  foreign_paths: string[];
  /** How many failing paths were harvested in total, before the sample cap. */
  failing_paths_count: number;
  /** How the paths were read — the honest label for the derivation below. */
  source: "diff-against-run-start-baseline" | "none";
}

/**
 * The paths the RUN is responsible for: its declared edit surface (the union of
 * every landed host result's corroborated changed-file set) plus whatever is
 * dirty relative to the run-start baseline. Baselines are merged in
 * `run_start_dirty` order AFTER the surface, and the whole set is content-sorted.
 *
 * Both halves are REQUIRED. `applied_edit_surface` alone has `[]` as its
 * legitimate value — a run that lands its work as commits is CLEAN at the gate —
 * and a set built from that field alone would leave every healthy run
 * `unattributable`, which is useless precisely where attribution matters most.
 * The dirty-vs-baseline half is what covers the run that is mid-flight.
 *
 * Nothing here is guessed from a command's own text: this is the same
 * edit-surface set `resolveEditSurfaceManifest` (close.ts) fences the closing
 * commit with, derived from `state`, never from what a failing suite happened to
 * print.
 */
async function runTouchedPaths(
  root: string,
  state: RemediationGateState,
): Promise<string[]> {
  admitRemediationDirtyBaseline(state);
  const paths = new Set<string>();
  for (const path of state.applied_edit_surface ?? []) {
    if (path.length > 0) paths.add(normalizeRepoPath(path));
  }
  for (const path of state.run_baseline_diff ?? []) {
    if (path.length > 0) paths.add(normalizeRepoPath(path));
  }
  for (const path of await currentRunDiff(root, state)) {
    paths.add(path);
  }
  return uniqueSorted(paths);
}

/**
 * The run's THIRD path source: what is dirty NOW but was clean at run start.
 *
 * `applied_edit_surface` covers work that has already landed, which is precisely
 * nothing while a run is mid-flight — the state where a boundary gate fires. So
 * the gate derives the working-tree half itself: `stagedAndUntracked` minus
 * `run_start_dirty`. Dirt present at run start is excluded because it cannot be
 * the run's edit (the same fence `resolveEditSurfaceManifest` applies to the
 * closing commit), which is also what makes this the signal that separates
 * FOREIGN live-tree dirt from the run's own.
 *
 * Missing historical authority or incomplete live discovery refuses attribution.
 * Neither can be converted into an empty run-owned surface.
 */
async function currentRunDiff(root: string, state: RemediationGateState): Promise<string[]> {
  const baseline = admitRemediationDirtyBaseline(state);
  const dirty = await stagedAndUntracked(root);
  const atRunStart = new Set(baseline.map(normalizeRepoPath));
  const paths = new Set<string>();
  for (const path of dirty) {
    const normalized = normalizeRepoPath(path);
    if (atRunStart.has(normalized)) continue;
    if (normalized.startsWith(RUN_SCRATCH_PREFIX)) continue;
    if (normalized.length > 0) paths.add(normalized);
  }
  return uniqueSorted(paths);
}

/**
 * A path segment naming a place tests live, in the conventions the ecosystems
 * this tool meets actually use. Segment equality, never a substring: `latest/`
 * and `contest/` are ordinary directories, and a substring rule would call a
 * red in either of them "a test failure".
 */
const TEST_DIR_SEGMENTS = new Set(["test", "tests", "__tests__", "__test__"]);

/**
 * Whether `path` is a TEST file — a file a suite RUNS rather than one the run
 * was asked to WRITE.
 *
 * This is not a heuristic about importance; it is the boundary of the edit
 * surface. A remediation run edits source, and a test file it did not edit
 * cannot have been broken by it — but a suite that fails PRINTS the failing
 * test file, so every red whose failure is located in a test names a path the
 * run never touched. {@link attributeGateRed} intersects the printed paths with
 * the run's touched set, so without this the intersection is empty and the
 * verdict is `environment` — the fail-OPEN answer that tells the host to skip
 * work it owes. A test red is therefore never `environment`.
 *
 * Language-neutral by construction: `*.test.*` / `*.spec.*` (JS/TS/Ruby/Python
 * variants) and the `test` / `tests` / `__tests__` segment conventions. A
 * language this misses degrades to the safe direction — an unrecognised test
 * file is treated as source, so the red attributes to the RUN.
 */
export function isTestFilePath(path: string): boolean {
  const segments = path.split("/");
  const name = segments.at(-1) ?? "";
  // `foo.test.ts`, `foo.spec.mjs`, `foo_test.go` — the stem before the first
  // dot (or before the trailing `_test`), never the extension alone.
  if (/\.(?:test|spec)\.[A-Za-z0-9]+$/u.test(name)) return true;
  if (/^test_.*\.[A-Za-z0-9]+$/u.test(name)) return true;
  if (/_test\.[A-Za-z0-9]+$/u.test(name)) return true;
  return segments.slice(0, -1).some((segment) => TEST_DIR_SEGMENTS.has(segment));
}

/**
 * Harvest the repo-relative file paths out of a failing command's output.
 *
 * TWO SOURCES, both textual, and the ORDER is the point (architecture PH-05: a
 * gate states the boundary it OWNS). The failing command's own output is the
 * primary — but the output captured at the gate is the tail of a whole suite
 * log, so relying on it alone would make attribution depend on which command
 * happened to print which paths at which moment. The diff from the run's
 * baseline is the SECOND, authoritative source: it is what "the run touched"
 * means, computed by git rather than parsed out of prose.
 *
 * The output half is conservative by construction: a token must look like a repo
 * path (contain a separator, or end in a source-file extension) and must resolve
 * to a REGULAR FILE that EXISTS under `root`. Test output is full of numbers,
 * timestamps and prose fragments, and a phantom path admitted here would be
 * compared against the run's set and, not matching, reported as foreign — the
 * exact false-environment answer this must never produce.
 *
 * Regular files only, and no trailing separator: `npm test` and `tsc` both print
 * DIRECTORY names (`src/`, `docs/`) in ordinary output, and a directory is not
 * a failing path — admitting one manufactures exactly the phantom-foreign entry
 * above, by a route no existence check can catch.
 */
function failingPathsFromOutput(output: string, root: string): string[] {
  const found = new Set<string>();
  // A candidate is a whitespace-delimited token that carries a path separator or
  // a short extension. Deliberately loose; the existence check below is the
  // narrowing step, and it is the one that cannot be fooled by a coincidence.
  const candidate = /[A-Za-z0-9_@.\\/-]*[\\/][A-Za-z0-9_@.\\/-]*|[A-Za-z0-9_@.-]+\.[A-Za-z]{1,6}/gu;
  for (const token of output.match(candidate) ?? []) {
    // `./` / `../` prefixes and a trailing `:line:col` suffix are what a runner
    // prints; neither is part of the path.
    const stripped = token
      .replace(/^\.\//, "")
      .replace(/^\.\.\//, "")
      .replace(/[:#][0-9]+(?::[0-9]+)?$/, "");
    if (stripped.length === 0) continue;
    if (stripped.split(/[\\/]/).some((segment) => segment === "..")) continue;
    const normalized = normalizeRepoPath(stripped);
    if (normalized.endsWith("/")) continue;
    if (normalized.startsWith("node_modules/")) continue;
    const absolute = join(root, ...normalized.split("/"));
    let stat;
    try {
      stat = statSync(absolute);
    } catch {
      continue; // missing or unreadable — not a path we can name
    }
    if (!stat.isFile()) continue;
    found.add(normalized);
  }
  return uniqueSorted(found);
}

/**
 * The CONTENT identity of the working tree — what a gate verdict is valid for.
 *
 * The property it serves: a verdict is about a TREE, so re-running a 2–5 minute
 * whole-repo floor against a tree that has not changed since the last verdict is
 * pure waste (the backlog entry: "the phase-boundary repository gate re-runs on
 * EVERY next-step at the boundary … it runs once per boundary and its verdict is
 * cached against the tree hash"). Two runs over identical content against an
 * identical environment cannot disagree, so the second one is redundant.
 *
 * DERIVED BY GIT, from the bytes, through a TEMPORARY index: the shared
 * `workingTreeTree` seeds it from HEAD (`git read-tree`), writes the working tree
 * into it (`git add -A`), and returns ONE tree id (`git write-tree`).
 *
 * WHY NOT A HAND-ROLLED DIGEST. The predecessor read each dirty path itself
 * through `normalizeRepoPath` — a lower-casing COMPARISON key — so on a
 * <!-- comment-citation-exempt: illustrative case-collision path -->
 * case-sensitive checkout two different contents of `src/auditStep.ts` hashed to
 * the same id, and a git-quoted non-ASCII path was dropped outright on win32.
 * Both are silent: the id still looks like an id, and a collision serves a
 * verdict for a tree nobody judged. `git write-tree` cannot have either failure,
 * because git never re-derives the path from a comparison key — it hashes the
 * bytes it hashed before.
 *
 * TWO CARVE-OUTS, both because the gate would otherwise invalidate its own
 * verdict the instant it was written:
 *   • IGNORED FILES stay out, by construction — `git add -A` honors .gitignore
 *     exactly as a commit would. `dist/` is a build OUTPUT the gate's own build
 *     leg rewrites, and `.audit-tools/` is this repo's ignored scratch, so
 *     keying on either makes every verdict one-shot.
 *   • {@link RUN_SCRATCH_PREFIX} is subtracted explicitly, for the case where
 *     the run's artifacts dir is NOT ignored in the target repository (an
 *     artifacts dir outside a repo whose .gitignore knows about it). Same reason
 *     red attribution exempts it: the step contract, the run log and state.json
 *     are rewritten by the very call that reaches the gate, so an un-exempted
 *     scratch would move the tree on every call and the cache could never hit.
 *
 * The residual that follows, stated where the cache is read as well: an
 * out-of-tree change (a dependency install, an environment change) under
 * unchanged content is NOT detected, and neither is a change confined to ignored
 * files or to the run's own scratch.
 *
 * `null` is "cannot tell" — not a repository, no HEAD yet, or any step of the
 * plumbing failing for any reason. A PARTIAL id is never returned: half an
 * identity is worse than none, because it would still be a key. Callers must
 * treat `null` as NO IDENTITY: never as a cache key, and never as a match.
 * Never throws; a gate must not fail on the diagnostic it was deriving.
 */
export async function worktreeContentId(root: string): Promise<string | null> {
  if ((await headCommit(root)) === null) return null;
  // The shared temporary-index tree — the same carve-outs (ignored files by
  // construction, {@link RUN_SCRATCH_PREFIX} explicitly) the audit run's
  // snapshot pin is built from.
  return workingTreeTree(root);
}

/**
 * Attribute a red gate to the run or to the environment (the backlog entry:
 * "a gate red is attributed to run-touched paths where possible, so foreign
 * live-tree dirt reports as environment rather than as the run's failure").
 *
 * The gate itself stays whole-repo and non-mutating — this ADDS a verdict to the
 * record and never changes what the run does with it. Nothing is re-opened, no
 * item moves, and the pause is exactly as resumable as before.
 *
 * `run_start_dirty` is excluded from the run's own set on purpose: dirt that
 * predates the run cannot be the run's edit. Same rule, same reason, as
 * `resolveEditSurfaceManifest`. It is folded in here only to produce
 * `run_paths_considered` when the edit surface is empty.
 */
export async function attributeGateRed(params: {
  root: string;
  state: RemediationGateState;
  output: string;
}): Promise<GateRedAttribution> {
  const runPaths = await runTouchedPaths(params.root, params.state);
  const failing = failingPathsFromOutput(params.output, params.root);
  const sample = (paths: string[]): string[] =>
    paths.slice(0, GATE_ATTRIBUTION_SAMPLE_LIMIT);

  if (failing.length === 0 || runPaths.length === 0) {
    return {
      verdict: "unattributable",
      run_paths_considered: sample(runPaths),
      run_paths: [],
      foreign_paths: [],
      failing_paths_count: failing.length,
      source: runPaths.length > 0 ? "diff-against-run-start-baseline" : "none",
    };
  }

  const runSet = new Set(runPaths);
  const own = failing.filter((path) => runSet.has(path));
  const foreign = failing.filter((path) => !runSet.has(path));
  // Test failures often name a test rather than the source it exercises;
  // even the narrower non-overlap heuristic is not useful in that case.
  const testPathInvolved = failing.some(isTestFilePath);
  return {
    // Preserve any observed overlap, even if some failure paths are foreign.
    verdict:
      own.length > 0 ? "run" : testPathInvolved ? "unattributable" : "environment",
    run_paths_considered: sample(runPaths),
    run_paths: sample(own),
    foreign_paths: sample(foreign),
    failing_paths_count: failing.length,
    source: "diff-against-run-start-baseline",
  };
}

/** Whether the persisted path heuristic found only outside-run non-test paths. */
export function carriesEnvironmentVerdict(
  attribution: GateRedAttribution | undefined,
): boolean {
  return attribution?.verdict === "environment";
}

/**
 * Render the attribution verdict for the paused step's prompt.
 *
 * ALWAYS returns a block, including for `unattributable` — the three verdicts
 * distinguish run overlap, non-overlap and insufficient path evidence, and a missing
 * block would collapse the third into silence. Never the raw path lists in full:
 * the record holds them, and the prompt names the record.
 */
export function renderGateAttribution(
  attribution: GateRedAttribution | undefined,
): string {
  if (attribution === undefined) {
    return [
      "Attribution: not evaluated for this red (no run state was in scope when the",
      "record was written). Treat this as unattributed and inspect the record.",
    ].join("\n");
  }
  if (attribution.verdict === "run") {
    return [
      `Attribution: RUN — ${attribution.run_paths.length} of the failing path(s) are ones`,
      "this run touched:",
      ...attribution.run_paths.map((path) => `  - ${path}`),
      "",
      "Fix these before re-running; the red is plausibly this run's own breakage.",
    ].join("\n");
  }
  if (carriesEnvironmentVerdict(attribution)) {
    return [
      `Attribution: ENVIRONMENT — none of the ${attribution.failing_paths_count} failing path(s)`,
      "is one this run touched, and none is a test file:",
      ...attribution.foreign_paths.map((path) => `  - ${path}`),
      "",
      "These paths do not overlap the run's edits. That does not establish the cause:",
      "a change in this run can still break an untouched file. Inspect the failure",
      "before deciding what needs to change, then re-run the gate.",
    ].join("\n");
  }
  return [
    "Attribution: UNATTRIBUTABLE — the failing command named no path the repository",
    "could resolve as a file, or every path it named is a TEST file the run never",
    "edited (a failing suite prints the test it choked on, not the source that broke",
    "it), or the run's own edit surface could not be derived.",
    "",
    "This says nothing either way; investigate before assuming it is not this run's.",
    "A red located in a test is most plausibly caused by the source that test covers.",
  ].join("\n");
}

/**
 * Repository-declared verification in build/typecheck/lint/test order. The
 * audit-tools profile retains its build-free unit floor. An explicit test
 * command replaces only the generic test role, never the other checks.
 */
export function toolOwnedFinalGateCommands(root: string, testCommand?: string[]): FinalGateCommandSpec[] {
  if (!isAuditToolsMonorepo(root)) {
    const commands = discoverProjectCommands(root);
    if (testCommand?.length) commands.test = testCommand;
    const roles = [
      ["build", "build"], ["typecheck", "check"], ["lint", "lint"], ["test", "unit"],
    ] as const;
    return roles.flatMap(([role, layer]) => commands[role]?.length
      ? [{ argv: commands[role], layer, build_free: role !== "build" && role !== "test" }]
      : []);
  }
  return [
    { argv: ["npm", "run", "build"], build_free: false, layer: "build" },
    { argv: ["npm", "run", "check"], build_free: true, layer: "check" },
    { argv: ["npm", "run", "check:tests"], build_free: true, layer: "check" },
    {
      // Build already ran above; use the same contracts as CI without rebuilding.
      argv: ["node", "scripts/shared/run-contract-tests.mjs"],
      build_free: true,
      layer: "unit",
    },
  ];
}

/** Cache identity includes declarations even when the worktree probe cannot see ignored files. */
export function finalGateBinding(root: string, testCommand?: string[]): string {
  const canonicalRoot = realpathSync(root);
  const declarations = ["package.json", "go.mod", "pyproject.toml", "pytest.ini", "Cargo.toml", "pom.xml"].map((name) => {
    try { return [name, readFileSync(join(canonicalRoot, name), "utf8")]; }
    catch (error) {
      if (isFileMissingError(error)) return [name, null];
      throw error;
    }
  });
  return hashContent(JSON.stringify({
    root: canonicalRoot, commands: toolOwnedFinalGateCommands(canonicalRoot, testCommand), declarations,
  }));
}
