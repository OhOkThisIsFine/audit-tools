// Guard-reach registry — the canonical declaration of every guard and what it
// actually covers (nightly determination ec64d159). Reconciled by
// `scripts/check-guard-reach.mjs` (`npm run check:guard-reach`, in
// verify:checks); the contract is pinned by tests/shared/guard-reach-gate.test.ts.
//
// SEMANTICS — read before editing:
//   • A `guardedBy` claim means "this guard actually scans or executes these
//     files", NEVER "these files are protected from every defect". A broad glob
//     with an inflated guard list is fake coverage — the exact failure this
//     registry exists to make visible.
//   • `uncovered` is the stated uncovered half, as data. The durable-traps
//     policy ("a partly-enforced trap must state the uncovered half") lives
//     HERE for reach, not in prose that decays.
//   • `guardedBy: 'declared-gap'` claims files deliberately guarded by nothing;
//     `note` must say why that is the accepted state. A gap is a decision,
//     silence is a defect.
//   • Overlap is expected (a file may be claimed by several rows); a tracked
//     file claimed by ZERO rows fails the build.
//
// Glob grammar is check-doc-manifest.mjs's: `*` within a segment, `**/` across
// segments, `?` one character.

import { RUNTIME_NAME_SOURCES } from "./shared/generate-runtime-artifact-names.mjs";
import { SPEC_MIRROR_DOCS, SPEC_MIRROR_SOURCE_FILES } from "./shared/spec-mirror-data.mjs";

/**
 * @typedef {object} GuardRow
 * @property {string} id
 * @property {'gate'|'hook'|'git-hook'|'contract-test'} kind
 * @property {string} impl gate: npm script name, or a repo path referenced
 *   verbatim by a script reachable from verify:release; hook: the hook file's
 *   repo path (must be registered in .claude/settings.json); git-hook: the
 *   module's repo path, run by git through the tracked `.githooks/<name>`
 *   files named in `hooks` (each must be tracked and must name the module —
 *   P53: a gate at git's own boundary is wired by git, not by settings.json);
 *   contract-test: the test file's repo path (must live under tests/ — vitest
 *   excludes .claude/**).
 * @property {string[]} [hooks] git-hook only, REQUIRED there: the tracked
 *   `.githooks/<name>` files that exec this module.
 * @property {false|'reach'|'always'|'final'} [preCommit] gates only, REQUIRED
 *   there (reconciled — a gate row without it is a red build): whether and how
 *   the pre-commit hook runs this gate as a derived leg
 *   (scripts/shared/derived-file-preflight.mjs `buildPreCommitLegs`).
 *   `false`   = deliberate CI-only. Omission is a STATEMENT, never silence.
 *   `'reach'` = run when the staged set intersects the union of the `files`
 *               globs of every REACH row citing this gate, ∪ the gate's own
 *               impl script path (parsed from package.json) ∪ package.json.
 *   `'always'`= unconditional whenever the repo wires the script
 *               (check:guard-reach — tree membership changes on ANY staged
 *               add/delete/rename, so there is no narrower honest trigger).
 *   `'final'` = reach-triggered but runs AFTER every structural refusal
 *               (check:doc-links only — the broadest trigger in the gate must
 *               never mask a more specific refusal behind it).
 * @property {{scope:'file', maxMs:number}} [writeTime] gates only. Declares a
 *   reach-triggered gate safe to run after one edited file. `maxMs` must be at
 *   most 1000: write-time feedback is advisory, but it must also stay cheap.
 * @property {string} [fix] one-line remediation hint printed by the pre-commit
 *   gate leg and the attest preflight when this gate fails. Gates: REQUIRED
 *   (reconciled — the regenerate-shaped meta-test
 *   tests/shared/generator-gates-run-at-commit.test.ts filters on this string,
 *   so a fixless gate row is invisible to it; the F2 hole, 2026-08-29).
 * @property {string} [note]
 * @property {FormFixture[]} [forms] the SYNTAX FORMS this guard recognizes (P51,
 *   owner decision baf2da68fa9cd24f): each a literal positive sample the guard
 *   MUST flag, plus how tests/shared/guard-form-reach.test.ts drives the REAL
 *   recognizer over it. Declared by form-recognizing guards only — a file-set
 *   or structural guard has none. A form the guard stops recognizing goes RED,
 *   and so does a form declared without teaching the guard: the declaration is
 *   the source of truth. Positive fixtures only; a suppression form (a marker
 *   that makes the guard NOT flag) is stated in the row's `note`.
 */

/**
 * @typedef {object} FormFixture
 * @property {string} name
 * @property {string} sample the literal text the guard must flag
 * @property {'script'|'export'|'hook'|'test'} drive
 *   script — spawn `script` in a throwaway git repo holding `sample` as the
 *            tracked file `path` (default docs/fixture.md), with `extraFiles`
 *            and `fixtureDirs` beside it and `env` set ($FIXTURE_ROOT expands);
 *            expect a non-zero exit whose output contains `expect`.
 *            Set `advisory: true` when the guard reports the form and exits 0 —
 *            a WARNING the guard cannot fail on, because the fix belongs to a
 *            boundary it does not own (the spec-symbol leg: a constitutional
 *            spec is escalate-only, PH-05). The form must still be recognized;
 *            the assertion is exit 0 + `expect` present, never "no output".
 *   export — import `module`, call `exportName` per `call` — `text`: fn(sample);
 *            `file-content`: fn(fixturePath, sample); `sources-map`:
 *            fn(new Map([[fixturePath, sample]])) — expect a non-empty result.
 *            The only drive for a script that resolves its tree from its own
 *            file location, and the natural one for a pure recognizer.
 *   hook   — spawn `hook` with `payload` on stdin ($SAMPLE, $SAMPLE_FILE and
 *            $SESSION expand; `sampleFile` writes the sample into a file of that
 *            format; `rootFixture` files are copied into the throwaway project
 *            root); expect exit 2 with `expect` on stderr.
 *   test   — the form is pinned by the dedicated harness test `test`; the
 *            declared sample must still appear in it.
 * @property {string} [expect]
 * @property {boolean} [advisory] the guard reports this form but exits 0
 * @property {string} [script]
 * @property {string} [path]
 * @property {Record<string,string>} [env]
 * @property {string[]} [fixtureDirs]
 * @property {Record<string,string>} [extraFiles]
 * @property {string} [module]
 * @property {string} [exportName]
 * @property {'text'|'file-content'|'sources-map'} [call]
 * @property {string} [fixturePath]
 * @property {string} [hook]
 * @property {unknown} [payload]
 * @property {'transcript-jsonl'} [sampleFile]
 * @property {string[]} [rootFixture]
 * @property {{files: Record<string,string>, unstaged?: Record<string,string>}} [rootGit] hook: a git
 *   repo at the project root — `files` committed, then `unstaged` written over them
 * @property {string} [test]
 */

/**
 * @typedef {object} ReachRow
 * @property {string} area
 * @property {string[]} files
 * @property {string[]|'declared-gap'} guardedBy
 * @property {string} [uncovered]
 * @property {string} [note]
 */

/** @type {GuardRow[]} */
export const GUARDS = [
  // ── gates (npm scripts reachable from verify:release) ──────────────────────
  {
    id: 'build',
    kind: 'gate',
    impl: 'build',
    preCommit: false,
    fix:
      'tsc failed over src/ — fix the reported type error; in a fresh checkout or worktree run ' +
      '`npm install` first (a stale dist/ fakes "no exported member" errors)',
    note: 'tsc over src/ + data-asset copy; the pre-commit gate hand-codes its `npm run check` leg',
  },
  {
    id: 'check:tests',
    kind: 'gate',
    impl: 'check:tests',
    preCommit: 'reach',
    fix:
      'the test tree failed its typecheck (tsconfig.test.json) — fix the staged type error; ' +
      'untyped destructured test params infer never[] and red only this leg and release CI',
    note: 'tsc over the test tree (tsconfig.test.json); ~7s, so the src-reach widening is deliberate',
  },
  {
    id: 'check:control-bytes',
    kind: 'gate',
    impl: 'check:control-bytes',
    preCommit: 'always',
    fix:
      'a tracked file carries raw control bytes — strip them at the named offsets; this gate covers ' +
      'the merge/import paths the tool-input-guard write-time hook never sees',
    note:
      "'always' rather than 'reach': a control byte can enter ANY tracked file, so there is no " +
      'narrower honest trigger — the same argument check:guard-reach makes. This row read ' +
      'preCommit false until 2026-09-05, on the premise that the tool-input-guard hook already ' +
      'refuses control bytes AT WRITE TIME. That premise only covers writes made through THIS ' +
      "agent's tools. A delegated lane writes in its own process, so the hook never sees it: an " +
      'offloaded lane authoring a doc emitted nine raw 0x1A bytes where arrows belonged, every ' +
      'local gate passed, and the gate that caught it was release CI — 22s in, on main. The row ' +
      "already knew about paths the hook cannot see (its own fix text says so); what it got wrong " +
      'was treating those paths as rare. The gate scans 1405 files in 0.2s.',
  },
  {
    id: 'check:shared-primitives',
    kind: 'gate',
    forms: [
      { name: 'comparator body', drive: 'export', module: 'scripts/check-shared-primitives.mjs',
        exportName: 'scanFile', call: 'file-content', sample: 'const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;' },
      { name: 'containment predicate', drive: 'export', module: 'scripts/check-shared-primitives.mjs',
        exportName: 'scanFile', call: 'file-content', sample: 'const outside = relative(root, target).startsWith("..");' },
      { name: 'sha256 chain', drive: 'export', module: 'scripts/check-shared-primitives.mjs',
        exportName: 'scanFile', call: 'file-content', sample: 'const digest = createHash("sha256").update(body).digest("hex");' },
      { name: 'truncated hash chain', drive: 'export', module: 'scripts/check-shared-primitives.mjs',
        exportName: 'scanFile', call: 'file-content', sample: 'const short = createHash("sha1").update(body).digest("hex").slice(0, 8);' },
      { name: 'Intl.Collator', drive: 'export', module: 'scripts/check-shared-primitives.mjs',
        exportName: 'scanFile', call: 'file-content', sample: 'const collator = new Intl.Collator("en");' },
      { name: 'localeCompare', drive: 'export', module: 'scripts/check-shared-primitives.mjs',
        exportName: 'scanFile', call: 'file-content', sample: 'names.sort((a, b) => a.localeCompare(b));' },
      { name: 'single-definition re-roll', drive: 'export', module: 'scripts/check-shared-primitives.mjs',
        exportName: 'scanFile', call: 'file-content', sample: 'function isPlainObject(value) { return typeof value === "object"; }' },
    ],
    impl: 'check:shared-primitives',
    preCommit: 'reach',
    fix:
      'adopt the canonical shared helper the violation names (compareCodeUnits / isRecord / ' +
      'hashContent / pathContainment / paths.ts), or amend the DATA tables in ' +
      'scripts/check-shared-primitives.mjs — an exception is a file + reason row, never prose',
    note:
      'single-definition rules plus defect-class pattern rules (comparator body, containment ' +
      'predicate, sha256 chain, localeCompare/ICU collation) over tracked src/**/*.ts AND the ' +
      'governance tree (scripts/, wrapper/, dispatch/, .claude/hooks/, the root bins) — the ' +
      'enforcement layer used to be the one tree exempt from the rule it enforces (ceremony review ' +
      '2026-08-29, F1), which is why the generated-artifact pattern was written fifteen times there. ' +
      'Three primitives have TWO declared homes: the src/ file and the pre-build twin in ' +
      'scripts/shared/primitives.mjs (the governance tree cannot reach dist/). ' +
      'PATTERN_DATA_SOURCES exempts the two declaration files whose literals ARE the banned ' +
      'spelling as data. UNCOVERED: tests/**/*.ts stays out of scope — a test oracle must not ' +
      'import the code it validates — as does tests/**.mjs, so a comparator copy in a test helper ' +
      'passes; and the pattern rules match SPELLINGS, not semantics',
  },
  {
    id: 'check:agents-region',
    kind: 'gate',
    impl: 'check:agents-region',
    preCommit: 'reach',
    fix:
      "AGENTS.md's generated region states a CLAUDE.md size that no longer matches the tree — run " +
      '`node ~/.agent-config/sync.mjs --projects` and stage AGENTS.md in the SAME commit as the ' +
      'CLAUDE.md edit (the generator lives outside this repository, so nothing else can fix it)',
    note:
      'the ONE generated region whose generator is not tracked here: `~/.agent-config/sync.mjs` ' +
      'writes the shared:start/shared:end block, and check:generated-artifacts can only reconcile ' +
      'TRACKED generators — so this file had no freshness authority at all. In POINTER mode the ' +
      'printed byte length is the only CLAUDE.md-derived input to the region body (the generator ' +
      'computes bytes/1024 to one decimal and hashes the body into shared-region-id), which makes ' +
      'comparing the stated figure exact rather than a proxy. UNCOVERED HALF: only the pointer-mode ' +
      'size sentence is checked — the rest of the region (the shared-region-id hash, the ' +
      'remediate-code/audit-code blocks above it) is unverified, and if the machine-wide fix retires ' +
      'the sentence this gate fails closed with the message saying so rather than passing vacuously ' +
      '(P64, owner decision 2026-09-10; the machine-wide half is filed separately)',
  },
  {
    id: 'check:deadcode',
    kind: 'gate',
    impl: 'check:deadcode',
    preCommit: false,
    fix:
      'knip reports an exported symbol with zero consumers anywhere (tests included) — delete the ' +
      'symbol and its orphaned tests, or land the consumer in the same commit; an additive export ' +
      'with no adopter reds this gate',
    note: 'knip, default mode',
  },
  {
    id: 'check:orphan-modules',
    kind: 'gate',
    impl: 'check:orphan-modules',
    preCommit: 'reach',
    fix:
      'a src module is unreachable from every production root (the three package entries plus ' +
      'dist-referenced files) — delete it with its orphaned tests, wire the intended consumer, or ' +
      'add an ORPHAN_ALLOW row with the reason (a wiring the resolver cannot see)',
    note:
      'closes the orphan-module class that refilled after the 2026-08-12 slimdown (CY-01, ceremony ' +
      'review): knip cannot see the class — its vitest plugin makes test files entries, so a module ' +
      'consumed only by its own test counts as used. TWO passes: a file-level walk from the ' +
      'production roots, plus the RELATIVE-IMPORT pass (Track 2.5) asking the symbol question over a ' +
      'TypeScript program — a src module that is not a package entry, declares exports of its own, ' +
      'is reached by the tests, and has none of those names referenced from any other production src ' +
      'file is production-dead however many barrels re-export it. ' +
      'UNCOVERED: a non-literal dynamic import of an in-repo module is unresolvable (today both such ' +
      'sites load external packages); the symbol pass reads only the TYPE CHECKER\'s view, so a ' +
      'module whose exports are addressed purely by string (a reflection-shaped lookup) would be ' +
      'flagged and needs an ORPHAN_ALLOW row; and the pass costs ~4-5s, since binding symbols over ' +
      'all of src/ is what makes the name flow followable at all',
  },
  {
    id: 'check:pin-obligations',
    kind: 'gate',
    impl: 'check:pin-obligations',
    preCommit: 'reach',
    fix:
      'a PINS row in scripts/shared/derived-file-preflight.mjs names a subject or a test that is not ' +
      'tracked, or a test that imports the BUILT package (no dist/ in a fresh worktree) — point the ' +
      'row at the right tracked file, or delete it. This check is what keeps a subject-keyed pin leg ' +
      'from silently obliging nothing',
    note:
      'configuration-time reconciliation of the PINS graph: every row resolves against the tracked ' +
      'tree and is build-free. It does NOT prove a bound test still asserts the literal — that is a ' +
      'reading, not a mechanism, and it is stated in the check header',
  },
  {
    id: 'check:doc-manifest',
    kind: 'gate',
    impl: 'check:doc-manifest',
    preCommit: 'reach',
    fix:
      'register the staged doc (type + reason to exist) in scripts/doc-manifest-data.mjs and re-render ' +
      'with `node scripts/check-doc-manifest.mjs --write`, or delete the doc — this is the check that ' +
      'fails RELEASE CI and burns a release tag',
    note:
      'the reach trigger keys on the staged PATH SET (`git diff --cached --name-only`), so a staged ' +
      'DELETION of a manifest-listed doc fires it exactly as an edit does — the half left open by the ' +
      '2026-08-26 bite (`a56f274d` deleted GEMINI.md and committed clean). Pinned by a contract test ' +
      "in tests/shared/doc-manifest-gate.test.ts ('runs the doc-manifest check for a staged DELETION " +
      "of a manifest-listed doc'), whose control case proves the trigger is what fires. The other " +
      'half the entry left open — the committing session running no hooks at all — is closed ' +
      'structurally by P53: git runs its own hook for its own commits',
  },
  {
    id: 'check:doc-links',
    kind: 'gate',
    forms: [
      { name: 'inline link', drive: 'script', script: 'scripts/check-doc-links.mjs',
        sample: 'read [the plan](missing-target.md) first', expect: 'missing-target.md' },
      { name: 'reference definition', drive: 'script', script: 'scripts/check-doc-links.mjs',
        sample: '[plan]: ./missing-target.md', expect: 'missing-target.md' },
      { name: 'line-suffixed target', drive: 'script', script: 'scripts/check-doc-links.mjs',
        sample: 'see [the anchor](./fixture.md:9999)', expect: 'line-suffixed' },
    ],
    impl: 'check:doc-links',
    preCommit: 'final',
    fix:
      'a relative markdown link does not resolve on disk — if the dead link is in a GENERATED doc ' +
      '(docs/HANDOFF.md, docs/backlog.md), fix the LIFT in scripts/shared/rebase-relative-links.mjs; ' +
      'editing the generated file is overwritten by the next regeneration',
    note:
      'uncovered half: generated deliverable renders are excluded (shared/generated-renders.mjs) — ' +
      'their worker-authored prose may quote link-shaped text (2026-08-18)',
  },
  {
    id: 'check:doc-code-citations',
    kind: 'gate',
    forms: [
      // A tracked src/ file keeps `src/…` a repo path rather than a third-party token.
      { name: 'backticked path citation', drive: 'script', script: 'scripts/check-doc-code-citations.mjs',
        sample: 'the reader lives in `src/does-not-exist.ts`', extraFiles: { 'src/present.ts': 'export {};\n' },
        expect: 'does-not-exist.ts' },
      // The spec SYMBOL leg — a warning at exit 0, so the expect string is the
      // advisory's own text; `src/present.ts` keeps `src/` a real top-level dir.
      { name: 'dangling symbol citation in spec/', drive: 'script', script: 'scripts/check-doc-code-citations.mjs',
        sample: 'A separate `leanFastPath` was the wrong shape.\n', path: 'spec/design.md',
        extraFiles: { 'src/present.ts': 'export {};\n' }, advisory: true,
        expect: 'name nothing the tree declares' },
    ],
    impl: 'check:doc-code-citations',
    preCommit: 'reach',
    writeTime: { scope: 'file', maxMs: 1000 },
    fix:
      'a backticked citation in a staged doc does not resolve — a slashed path must name a tracked file, ' +
      'a trailing-slash directory must exist (root- or doc-relative), and a bare filename must match ' +
      'exactly one tracked basename (a lone repo-root candidate wins a tie; run-artifact names from ' +
      'scripts/shared/runtime-artifact-names.generated.mjs are skipped) — fix the citation, cite the ' +
      'full path, or add a doc-citation-exempt marker',
    note:
      'THREE rules, and their scopes differ deliberately: path resolution over the manifest set, the ' +
      'line-anchor refusal over every tracked doc outside the runtime state dirs, and — new 2026-09-10 ' +
      '— the spec-symbol leg over spec/** only, which PRINTS a dangling backticked symbol and exits 0 ' +
      '(a constitutional spec is escalate-only, so only an owner may resolve one; a red would enforce ' +
      'at a boundary this gate does not own, PH-05). ' +
      'uncovered halves, declared: unbackticked path mentions in prose/tables (the P29 glossary case) ' +
      'are out of scope; bare names with a leading dot or dash (.gitignore/.npmrc — extension-mention ' +
      'idiom) and bare names whose extension no TRACKED file uses go unchecked (the extension census ' +
      'reads tracked + index only, so an untracked scratch file cannot change which citations are ' +
      'examined); slashed tokens with no ' +
      'extension and no trailing slash, and backslashed Windows-path prose, are skipped; gitignored and ' +
      'non-repo (~/drive/URL) citations are out of scope by construction; the symbol leg reads only ' +
      'spec/**, only un-slashed extension-less identifiers in one of two spellings, and takes a ' +
      '`symbol-citation-exempt:` marker for a record naming a retired mechanism ' +
      '(2026-08-18; extension-census source narrowed 2026-09-10)',
  },
  {
    id: 'check:gate-enumeration',
    kind: 'gate',
    impl: 'check:gate-enumeration',
    preCommit: 'reach',
    fix:
      'a registered enumeration target is stale against package.json — re-render with ' +
      '`node scripts/check-gate-enumeration.mjs --write`; step order and membership are READ from ' +
      'package.json, so fix the gate wiring rather than a rendered copy',
  },
  {
    id: 'check:philosophy-brief',
    kind: 'gate',
    impl: 'check:philosophy-brief',
    preCommit: 'reach',
    fix:
      "README.md's Philosophy section is GENERATED from docs/project-philosophy.md — regenerate with " +
      '`npm run check:philosophy-brief -- --write`; never hand-edit the rendered block',
  },
  {
    id: 'check:readme-sample-report',
    kind: 'gate',
    impl: 'check:readme-sample-report',
    preCommit: 'reach',
    fix:
      "README.md's sample-report block is GENERATED from the report renderer — regenerate with " +
      '`npm run check:readme-sample-report -- --write`; never hand-edit the rendered block',
  },
  {
    id: 'check:proposal-red-at',
    kind: 'gate',
    impl: 'check:proposal-red-at',
    preCommit: 'reach',
    fix:
      'a proposal dir ships a *.test.ts/*.test.mjs with no sibling RED-AT.txt — run the test at ' +
      'HEAD and record the exact command, sha, and verbatim failure (or one line stating why it ' +
      'cannot run at HEAD)',
  },
  {
    id: 'check:loop-core-patterns',
    kind: 'gate',
    impl: 'check:loop-core-patterns',
    preCommit: 'reach',
    fix:
      '.claude/hooks/loop-core-patterns.mjs is stale against src/shared/loopCorePaths.ts — ' +
      'run `node scripts/shared/generate-loop-core-patterns.mjs`, then re-stage it',
  },
  {
    id: 'check:loop-core-closure',
    kind: 'gate',
    impl: 'check:loop-core-closure',
    preCommit: 'reach',
    fix:
      'a module is reachable ONLY through loop-core but is neither in LOOP_CORE_PATTERNS nor ' +
      'declared — add it to src/shared/loopCorePaths.ts (then regenerate) if it is core, or add a ' +
      'row with its reason to scripts/shared/loopCoreClosureData.mjs if it is not',
  },
  {
    id: 'check:constitutional-doc-paths',
    kind: 'gate',
    impl: 'check:constitutional-doc-paths',
    preCommit: 'reach',
    fix:
      'scripts/shared/constitutional-doc-paths.generated.mjs is stale against ' +
      'src/shared/constitutionalDocPaths.ts — run ' +
      '`node scripts/shared/generate-constitutional-doc-paths.mjs`, then re-stage it',
  },
  {
    id: 'check:runtime-artifact-names',
    kind: 'gate',
    impl: 'check:runtime-artifact-names',
    preCommit: 'reach',
    fix: 'runtime-artifact-names.generated.mjs is stale — run node scripts/shared/generate-runtime-artifact-names.mjs',
  },
  {
    id: 'check:friction-categories',
    kind: 'gate',
    impl: 'check:friction-categories',
    preCommit: 'reach',
    fix:
      'scripts/shared/friction-categories.generated.mjs is stale against ' +
      'src/shared/friction/frictionRecord.ts — run ' +
      '`node scripts/shared/generate-friction-categories.mjs`, then re-stage it',
  },
  {
    id: 'check:executor-producers',
    kind: 'gate',
    impl: 'check:executor-producers',
    preCommit: 'reach',
    fix:
      'spec/audit/executor-producers.generated.md is stale — run `node scripts/shared/generate-executor-producers.mjs`, ' +
      'then re-stage it. The producer relation is declared on EXECUTOR_REGISTRY[].produces; never hand-edit the render',
  },
  {
    id: 'check:ingestion-checks',
    kind: 'gate',
    impl: 'check:ingestion-checks',
    preCommit: 'reach',
    fix:
      'the ingestion-check block in docs/audit-pkg/contracts.md is stale — run ' +
      '`node scripts/shared/generate-ingestion-checks.mjs`, then re-stage it. The check set is declared ' +
      'in INGESTION_CHECKS (src/shared/submission/ingestionChecks.ts); never hand-edit the render',
  },
  {
    id: 'check:spec-mirrors',
    kind: 'gate',
    impl: 'check:spec-mirrors',
    preCommit: 'reach',
    fix:
      'a generated table region in spec/audit/artifact-contract.md, executor-catalog.md or ' +
      'dependency-map.md is stale — run `node scripts/shared/generate-spec-mirrors.mjs`, then ' +
      're-stage the doc(s). Never hand-edit between the markers: the rows come from ' +
      'ARTIFACT_DEFINITIONS / EXECUTOR_REGISTRY / ARTIFACT_DEPENDS_ON_MAP and the Purpose/Notes ' +
      'prose from scripts/shared/spec-mirror-data.mjs. If the check instead names a row the ' +
      'declaration and the registry disagree about, fix the declaration — a new registry entry ' +
      'must be filed under a section with its prose before it can render',
  },
  {
    id: 'check:loader-fragments',
    kind: 'gate',
    impl: 'check:loader-fragments',
    preCommit: 'reach',
    fix:
      'a shipped loader asset drifted from its canonical fragment — reconcile it against ' +
      'scripts/shared/loader-fragments-data.mjs (embed the fragment verbatim where it is declared ' +
      '`verbatimIn`, or point at the `home` asset in prose where it is not), then re-run ' +
      '`npm run check:loader-fragments`',
    note:
      'the four shipped loader assets (skills/<tool>/<tool>.prompt.md + skills/<tool>/SKILL.md, both ' +
      'pairs) previously carried the same instruction in four drifted copies. UNCOVERED HALF: the ' +
      'check reconciles only the fragments DECLARED in the data module, so a NEW duplicated ' +
      'instruction is invisible until someone adds a fragment row for it — the module is the ' +
      'inventory, not a detector of duplication',
  },
  {
    id: 'check:cli-surface',
    kind: 'gate',
    impl: 'check:cli-surface',
    preCommit: 'reach',
    fix:
      "docs/audit-pkg/product.md's installer-verb block is stale — run " +
      '`node scripts/shared/generate-cli-surface.mjs`, then re-stage it. The verbs and their ' +
      'summaries are declared in wrapper/installer-verb-help.mjs (what both bins answer ' +
      '`<verb> --help` from); never hand-edit inside the markers',
    note:
      'covers the four wrapper-intercepted INSTALLER verbs only. UNCOVERED HALF: every OTHER command ' +
      "wrapper/audit-code-wrapper-lib.mjs's printHelp() lists — `prompt-path`, `mcp`, `validate`, " +
      '`explain-task`, the ingest verbs — carries its one-line summary as loose prose rather than a ' +
      'declaration this render can read, so doc prose naming those stays hand-written and unchecked ' +
      '(lift them from printHelp to a declaration the way the installer verbs were)',
  },
  {
    id: 'check:handoff-roadmap',
    kind: 'gate',
    forms: [
      { name: 'dated bullet', drive: 'export', module: 'scripts/shared/generate-handoff-roadmap.mjs',
        exportName: 'findHandwrittenCreep', call: 'text', sample: '- 2026-08-12: the queue was answered in full' },
      { name: 'landed narrative', drive: 'export', module: 'scripts/shared/generate-handoff-roadmap.mjs',
        exportName: 'findHandwrittenCreep', call: 'text', sample: 'The cleanup rule is LANDED on main.' },
      { name: 'shipped narrative', drive: 'export', module: 'scripts/shared/generate-handoff-roadmap.mjs',
        exportName: 'findHandwrittenCreep', call: 'text', sample: 'That fix shipped in v0.34.' },
      { name: 'built-first narrative', drive: 'export', module: 'scripts/shared/generate-handoff-roadmap.mjs',
        exportName: 'findHandwrittenCreep', call: 'text', sample: 'Built red-tests-first (7 contract tests).' },
      { name: 'verification-state heading', drive: 'export', module: 'scripts/shared/generate-handoff-roadmap.mjs',
        exportName: 'findHandwrittenCreep', call: 'text', sample: '## Verification state' },
      // The length bound recognizes no phrasing, so its one form is the SHAPE it
      // fires on: an Immediate-next section carrying more WORDS than the bound
      // allows. The sample is the real recurrence (the 2026-09-10 lap
      // paragraph), not an arbitrary long string — a form fixture that drifts
      // under the bound would otherwise pass vacuously.
      { name: 'Immediate-next over its length bound', drive: 'export',
        module: 'scripts/shared/generate-handoff-roadmap.mjs',
        exportName: 'findImmediateNextOverrun', call: 'text',
        sample:
          '## Immediate next\n\n**Cleanup-and-implementation lap (opened 2026-09-10).** P00 cleanup is on `main`: the maintenance routine\'s commits are fast-forwarded, and stray worktrees, merged branches and the forensics stash are gone. Seven implementation waves follow — each packet in its own worktree outside the repo root on a DeepSeek lane through llm-relay, landed by fast-forward, the full suite re-run on `main` after every wave, and a `/ship` release after the last wave. The plan, the per-packet briefs and the 161-entry coverage check live in the lap\'s machine-local plan directory. The waiting maintenance decisions are settled there by standing convictions and are ticked in the inbox when their packets land.\n' },
    ],
    impl: 'check:handoff-roadmap',
    preCommit: 'reach',
    fix:
      'run `node scripts/shared/generate-handoff-roadmap.mjs`, then re-stage docs/HANDOFF.md. Do NOT ' +
      'hand-edit inside either generated block; queue detail lives in docs/nightly-inbox.md and ' +
      'roadmap entry text lives in the backlog. If the check instead names hand-written changelog ' +
      'creep (dated bullet / landing narrative / Verification-state heading), regenerating fixes ' +
      'NOTHING — trim or reword the named line; shipped-work narration belongs in git log, the ' +
      'backlog, or memory. If it names the `## Immediate next` bound, cut that section to the ' +
      'single next action plus the live owner decision — the lap chronology it regrew into belongs ' +
      'in git log and the documents that own each fact — and note that REWRAPPING does not help: ' +
      'the bound counts words',
    note:
      'uncovered halves, declared. (1) The creep leg is a shape-catch: narration avoiding all five ' +
      'shapes passes — mid-line dates ("decided 2026-08-18"), a date as the bullet\'s second word, ' +
      'lowercase "landed", "is COMPLETE", novel phrasings; the nightly doc leg remains the semantic ' +
      'backstop (2026-08-18). (2) The `## Immediate next` leg is a WORD BUDGET, not a semantic ' +
      'one: a chronology dense enough to fit inside it passes, and so does a short section naming ' +
      'the wrong action — the bound raises the cost of the recurrence and reds the common case, it ' +
      'does not make the section immediate-next by construction. Words rather than lines because a ' +
      'line count measures the wrap width, not the content',
  },
  {
    id: 'check:retired-infrastructure',
    kind: 'gate',
    forms: [
      { name: 'a live-sounding mention of a retired service', drive: 'export',
        module: 'scripts/check-retired-infrastructure.mjs',
        exportName: 'findRetiredMentions', call: 'text',
        sample: 'Restart the freellmapi router before the fan-out.' },
    ],
    impl: 'check:retired-infrastructure',
    preCommit: 'reach',
    writeTime: { scope: 'file', maxMs: 1000 },
    fix:
      'a doc names infrastructure that has been RETIRED — the register of those is ' +
      'scripts/shared/retired-infrastructure-data.mjs, and this gate found a mention of one. Two ' +
      'legal answers: DELETE the entry (a trap that existed only because the retired thing existed ' +
      'retires with it), or KEEP it deliberately as a record and say what REPLACED the retired ' +
      'infrastructure, marking the line `<!-- retired-infrastructure-exempt: <id> — <replacement> -->`. ' +
      'The replacement is the point: an entry naming dead infrastructure and no successor still ' +
      'sends the reader to a wrong action',
    note:
      'the register is the DECLARATION half and this gate is the ENFORCEMENT half, so a retirement ' +
      'is a one-line edit there rather than a sweep somebody remembers to do. SCOPE IS DECLARED ' +
      'AND NARROW (SCANNED_DOCS in the gate): docs/backlog/durable-traps.md only, because that is ' +
      'the standing REFERENCE a session reads to decide what to run, where a stale entry costs a ' +
      'wrong action. UNCOVERED HALVES, stated: (1) a retirement nobody ADDS A ROW FOR is invisible — ' +
      'the gate cannot see a service being shut down, only a declaration that it was; (2) the ' +
      'exemption marker is a line-level assertion and the gate does not judge whether the stated ' +
      'replacement is real, so a marker with a false successor passes; (3) the scan is a literal ' +
      'identifier match, so an entry that refers to retired infrastructure only by DESCRIPTION ' +
      '("the old router on the other port") is not caught',
  },
  {
    id: 'check:backlog-index',
    kind: 'gate',
    impl: 'check:backlog-index',
    preCommit: 'reach',
    fix:
      'run `node scripts/shared/generate-backlog-index.mjs`, then re-stage docs/backlog.md. Do NOT ' +
      'hand-patch line numbers inside the generated seek-index markers; they are derived, and the ' +
      'next backlog edit moves them again',
  },
  {
    id: 'check:backlog-budget',
    kind: 'gate',
    forms: [
      // The states-the-property half (second backlog-clearance lap, 2026-07-24):
      // a prescription with no `**Property:**` marker beside it. Driven through
      // the pure detector — `evaluateBacklog` takes a file LIST, which no form
      // kind supplies, and the detector is what decides either leg's refusal.
      { name: 'prescribed fix with no property', drive: 'export',
        module: 'scripts/check-backlog-budget.mjs',
        exportName: 'prescribedFixShapes', call: 'text',
        sample: '- **An entry.** The fix is to move it into one module.' },
      { name: 'imperative remedy instead of a property', drive: 'export',
        module: 'scripts/check-backlog-budget.mjs',
        exportName: 'prescribedFixShapes', call: 'text',
        sample: '- **An entry.** Anchor the deletion on the next bullet instead of a count.' },
    ],
    impl: 'check:backlog-budget',
    preCommit: 'reach',
    writeTime: { scope: 'file', maxMs: 1000 },
    fix:
      'a staged backlog entry or file is over its size ceiling, and an over-budget file may only ' +
      'shrink — condense at write time: keep the MECHANISM and the open PROPERTY, link the primary ' +
      'record (git log, docs/reviews/) instead of retelling it. There is no per-entry ceiling to raise. ' +
      'A refusal naming a PRESCRIBED FIX MECHANISM is the states-the-property leg instead: the entry ' +
      'says how to change the code without saying what must become true, so add `**Property:** …` — ' +
      'the prescribed mechanism is the part that does not survive contact with the tree (a lap opened ' +
      'on one whose fix would have regressed the run)',
    note:
      'TWO legs, one gate, because both are entry WRITE-TIME shape rules over the same parsed corpus ' +
      '(the size budget, and the states-the-property rule from the 2026-07-24 second-backlog-clearance ' +
      'lap). The property leg is DELIBERATELY NARROW: it refuses an entry that prescribes a fix ' +
      '(PRESCRIBED_FIX_SHAPES — three literal shapes drawn from live entries) without a `**Property:**` ' +
      'marker, not "every entry needs a marker" — half the corpus is measurements, residual lists and ' +
      'live-run watches that prescribe nothing, and requiring the marker there would red 100+ entries ' +
      'for a rule they cannot satisfy. Pre-existing prescriptions are amnestied BY NAME in ' +
      '`entries_prescribing_mechanism` (the same shape as the byte amnesty, and it drops a key as soon ' +
      'as the entry gains its marker). UNCOVERED HALF, stated: the leg detects the marker\'s PRESENCE, ' +
      'never whether the sentence after it states a property rather than a mechanism in different ' +
      'words — nor an entry that states a property and then prescribes a mechanism anyway in its body. ' +
      'The shape list errs toward false NEGATIVES by construction (a wider net flags legitimate ' +
      '`**Property:** a lap can …` prose, and a gate that cries wolf on its own corpus gets disabled). ' +
      'Those are readings; the nightly doc leg is the semantic backstop',
  },
  {
    id: 'check:backlog-status',
    kind: 'gate',
    forms: [
      { name: 'status glyph', drive: 'export', module: 'scripts/check-backlog-status-tokens.mjs',
        exportName: 'findStatusMarkers', call: 'text', sample: '- ✅ the fix landed' },
      { name: 'emphasised status label', drive: 'export', module: 'scripts/check-backlog-status-tokens.mjs',
        exportName: 'findStatusMarkers', call: 'text', sample: '- **SHIPPED 2026-07-19.** the entry' },
      { name: 'leading status label', drive: 'export', module: 'scripts/check-backlog-status-tokens.mjs',
        exportName: 'findStatusMarkers', call: 'text', sample: '- DONE: the entry' },
    ],
    impl: 'check:backlog-status',
    preCommit: 'reach',
    fix:
      'a staged backlog entry leads with a status label, and the backlog is a living to-do list, not a ' +
      'status log — a fully-closed entry is DELETED (durables move to their real home first), a ' +
      'partial one is TRIMMED to its open remainder. Only the leading-label form is refused',
  },
  {
    id: 'check:backlog-friction-tags',
    kind: 'gate',
    forms: [
      { name: 'off-vocabulary friction tag', drive: 'export', module: 'scripts/check-backlog-friction-tags.mjs',
        exportName: 'findFrictionTags', call: 'file-content', fixturePath: 'open-bugs.md',
        sample: '- **A thing (2026-08-30, low, friction: false_red).** prose' },
    ],
    impl: 'check:backlog-friction-tags',
    preCommit: 'reach',
    writeTime: { scope: 'file', maxMs: 1000 },
    fix:
      'a backlog entry tags a `friction:` category the vocabulary does not hold — map it onto the ' +
      'canonical three (ambiguous_direction | tool_should_decide | inefficient_feeding) whose ' +
      'definition it fits; do NOT add a category, the list is single-sourced in ' +
      'src/shared/friction/frictionRecord.ts and the close-out gate counts coverage per category',
    note:
      'the tag is the field a closeout walk or a triage sweep GROUPS BY, and nothing read it: the ' +
      'vocabulary existed in three places already (the TS source, its generated sibling, the ' +
      'close-out gate) while seven off-vocabulary tags accumulated in docs/backlog/ — five of them ' +
      'synonyms of the canonical three, which made any grouping silently incomplete. The gate ' +
      'imports the GENERATED sibling, never audit-tools/shared, so it runs in a never-built ' +
      'checkout. UNCOVERED HALF: an untagged entry is not refused (the tag is a grouping aid, not ' +
      'a required field), and the tags a friction WALK writes into its own prose line are matched ' +
      'only in `friction: <word>` form — a tag phrased some other way is not seen. Whether a tag ' +
      'is the RIGHT one of the three remains a reading, not a mechanism',
  },
  {
    id: 'check:backlog-line-numbers',
    kind: 'gate',
    forms: [
      { name: 'backticked path with line suffix', drive: 'export', module: 'scripts/check-backlog-line-numbers.mjs',
        exportName: 'findLineNumberCitations', call: 'text', sample: 'see `src/x.ts:123` for the write' },
      { name: 'backticked bare line suffix', drive: 'export', module: 'scripts/check-backlog-line-numbers.mjs',
        exportName: 'findLineNumberCitations', call: 'text', sample: 'the anchor at `:21` moved' },
    ],
    impl: 'check:backlog-line-numbers',
    preCommit: 'reach',
    writeTime: { scope: 'file', maxMs: 1000 },
    fix:
      'a staged backlog entry cites a bare line number (a backticked `path:123` or a bare `:21` span) — ' +
      'cite the SYMBOL instead, or the file alone when no good symbol exists; never auto-resolve a ' +
      'drifted number to the nearest declaration (dropping the number beats false precision)',
  },
  {
    id: 'check:review-routing',
    kind: 'gate',
    forms: [
      { name: 'routing declaration in a review record', drive: 'export', module: 'scripts/check-review-routing.mjs',
        exportName: 'findRoutingDeclarations', call: 'text',
        sample: '<!-- review-routing: backlog-bugs -->' },
    ],
    impl: 'check:review-routing',
    preCommit: 'reach',
    writeTime: { scope: 'file', maxMs: 1000 },
    fix:
      'a review record added since this mechanism landed carries no routing declaration — add ' +
      '`<!-- review-routing: <row> -->` in its first lines, naming a row from ' +
      'scripts/review-routing-data.mjs; a record whose analysis produced no work declares ' +
      '`no-forward-work` explicitly rather than by omitting the line',
    note:
      'A record is a RATCHET, not each record. 73 dated records predate the mechanism and sit on the ' +
      'declared-debt baseline (docs/reviews/.routing-baseline.json), which only SHRINKS: a declared ' +
      'record still listed there is a RED, as is a baseline path that no longer exists. Uncovered, ' +
      'declared: the gate checks the declaration EXISTS and names a live row — it cannot check that ' +
      'the author picked the TRUE row, because whether a prose analysis identified work is the ' +
      'semantic judgment that made the obvious "every review is cited from somewhere" gate wrong ' +
      '(it reds a dogfood log and a measurement record, and a false red gets a gate disabled). A ' +
      'baselined record is announced in the pass line, never silently exempt (2026-09-10)',
  },
  {
    id: 'check:memory-citations',
    kind: 'gate',
    forms: [
      // The store is pointed at an EMPTY fixture dir, so every cited name is dangling by construction.
      { name: 'lowercase inline list', drive: 'script', script: 'scripts/check-memory-citations.mjs',
        sample: '(see memory: this-note-does-not-exist)', fixtureDirs: ['memory'],
        env: { AUDIT_TOOLS_MEMORY_DIR: '$FIXTURE_ROOT/memory' }, expect: 'this-note-does-not-exist' },
      { name: 'sentence-initial list', drive: 'script', script: 'scripts/check-memory-citations.mjs',
        sample: 'Memory: this-note-does-not-exist', fixtureDirs: ['memory'],
        env: { AUDIT_TOOLS_MEMORY_DIR: '$FIXTURE_ROOT/memory' }, expect: 'this-note-does-not-exist' },
      // Memories cite each other as [[name]]; the scan runs over the STORE, so the sample is a note.
      { name: 'wikilink between memories', drive: 'script', script: 'scripts/check-memory-citations.mjs',
        sample: 'related: [[this-note-does-not-exist]]', path: 'memory/fixture-note.md',
        env: { AUDIT_TOOLS_MEMORY_DIR: '$FIXTURE_ROOT/memory' }, expect: 'this-note-does-not-exist' },
      // The third direction: a NOTE citing a repo path. The fixture repo carries
      // `src/` so `src/does-not-exist.ts` is a repo-shaped token, not prose.
      { name: 'note citing a repo path that is gone', drive: 'script', script: 'scripts/check-memory-citations.mjs',
        sample: 'the reader was `src/does-not-exist.ts` then', path: 'memory/fixture-note.md',
        extraFiles: { 'src/present.ts': 'export {};\n' },
        env: { AUDIT_TOOLS_MEMORY_DIR: '$FIXTURE_ROOT/memory' }, expect: 'does-not-exist.ts' },
    ],
    impl: 'check:memory-citations',
    preCommit: 'reach',
    writeTime: { scope: 'file', maxMs: 1000 },
    fix:
      'a staged doc cites a memory file that does not exist, or a memory note cites a repo path ' +
      'that does not resolve — fix the citation, restore the file, or (for a note whose point is ' +
      'that a subsystem was DELETED) put `<!-- memory-path-exempt: <what that path was> -->` on ' +
      'the line above it',
    note:
      'ALL THREE DIRECTIONS, and the roster is stated here rather than implied: doc → memory ' +
      '(`memory: <name>`), memory → memory (`[[name]]`), and memory → repo PATH (the direction ' +
      'scanned by nothing until 2026-09-10 — the previous row declared the [[name]] half ' +
      'uncovered, which the script had already closed, while saying nothing about the path ' +
      'direction it had not). Uncovered halves, declared: a store that cannot be found is a ' +
      'non-tick warning at exit 0, never a RED, because a fresh CI clone genuinely has none, so ' +
      'an authoring machine whose store MOVED is announced but not failed; the path leg needs an ' +
      'exemption marker for deliberate archaeology and skips globs, `<placeholders>`, ' +
      'non-repo tokens and gitignored paths by rule, so a note citing a DELETED path inside a ' +
      'glob or a bare filename (no slash) goes unchecked; generated deliverable renders ' +
      '(.audit-tools/audit-report.md, remediation-report.md) are excluded — their worker-authored ' +
      'prose may quote citation-shaped text (2026-08-18; store-resolution note 2026-08-30; path ' +
      'direction 2026-09-10)',
  },
  {
    id: 'check:version-gates',
    kind: 'gate',
    forms: [
      // A version constant, a payload type stamped with it, and a read-back that never compares it.
      { name: 'stamped version read back unchecked', drive: 'export', module: 'scripts/check-version-gates.mjs',
        exportName: 'scanVersionGates', call: 'sources-map', fixturePath: 'src/fixture.ts',
        sample: [
          'export const FIXTURE_SCHEMA_VERSION = "fixture/v1";',
          'export interface FixturePayload {',
          '  schema_version: typeof FIXTURE_SCHEMA_VERSION;',
          '}',
          'export async function loadFixture(path: string) {',
          '  return await readJsonFile<FixturePayload>(path);',
          '}',
        ].join('\n') },
    ],
    impl: 'check:version-gates',
    preCommit: false,
    fix:
      'a schema version is stamped on write but never compared where the payload is read back — ' +
      'add the version check at the read site (discardOnSchemaVersionMismatch or an explicit ' +
      'compare); never silence the constant by widening the scan rules',
    note: 'preCommit false is deliberate (CI-only) — cheap, flip to reach if wanted',
  },
  {
    id: 'check:guard-reach',
    kind: 'gate',
    impl: 'check:guard-reach',
    preCommit: 'always',
    fix:
      "register the file or guard in scripts/guard-reach-data.mjs (guardedBy a real guard id, or " +
      "'declared-gap' with the reason in note)",
    note: 'this registry, reconciled; always: tree membership changes on ANY staged add/delete/rename',
  },
  {
    id: 'check:generated-artifacts',
    kind: 'gate',
    impl: 'check:generated-artifacts',
    preCommit: 'always',
    fix:
      'add or correct the generator row in the GENERATED section of scripts/guard-reach-data.mjs; ' +
      'each tracked generator needs exactly one check, contractTest, or explained onDemand authority',
    note: 'always: adding, deleting, or renaming any tracked generator changes the reconciled set',
  },
  {
    id: 'check:invariant-glossary',
    kind: 'gate',
    impl: 'check:invariant-glossary',
    preCommit: 'reach',
    fix:
      'add the missing uppercase nonnumeric INV-* namespace to docs/glossary-ids.md with its ' +
      'contract and owning symbol/file, or retire the last source occurrence',
  },
  {
    id: 'check:nightly-inbox',
    kind: 'gate',
    impl: 'check:nightly-inbox',
    preCommit: 'reach',
    fix: 'run `node scripts/nightly/render-inbox.mjs`, then re-stage docs/nightly-inbox.md',
  },
  {
    id: 'check:ci-trigger-paths',
    kind: 'gate',
    impl: 'check:ci-trigger-paths',
    preCommit: 'reach',
    fix:
      "ci.yml's paths: blocks are GENERATED from this registry — regenerate with " +
      '`node scripts/shared/generate-ci-trigger-paths.mjs` and re-stage .github/workflows/ci.yml',
    note:
      'derives the ci.yml trigger-path list from non-declared-gap REACH rows + the always-trigger ' +
      'base, so a new claimed tree cannot land outside the CI trigger set',
  },
  {
    id: 'check:lint',
    kind: 'gate',
    impl: 'check:lint',
    preCommit: false,
    fix:
      'eslint failed — fix the named violation; the ruleset is curated zero-tolerance, so prefer ' +
      'the fix over a disable comment, and a disable carries its reason on the same line',
    note:
      'eslint, curated zero-tolerance ruleset (eslint.config.js): unused-vars + verified sonarjs ' +
      'correctness rules over src (type-aware), tests (type-aware, unused-vars only) and the ' +
      '.mjs script surface (scripts/wrapper/dispatch/root bins; typed by check:scripts since 2026-08-25)',
  },
  {
    id: 'check:scripts',
    kind: 'gate',
    impl: 'check:scripts',
    preCommit: 'reach',
    fix:
      'checkJs typecheck over scripts/, wrapper/, dispatch/, .claude/hooks/ and the root bins ' +
      '(tsconfig.scripts.json) failed — fix the type error or annotate with JSDoc; noImplicitAny ' +
      'stays relaxed there by design',
  },
  {
    id: 'check:dup',
    kind: 'gate',
    impl: 'check:dup',
    preCommit: false,
    fix:
      'jscpd is over the .jscpd.json threshold — extract the duplicated logic into its shared ' +
      'home instead of raising the threshold',
    note: 'jscpd duplication ratchet (.jscpd.json threshold) over src+scripts+tests',
  },
  {
    id: 'check:depgraph',
    kind: 'gate',
    impl: 'check:depgraph',
    preCommit: false,
    fix:
      'dependency-cruiser found a runtime import cycle in src/, or src/shared importing an ' +
      'orchestrator — break the cycle or invert the dependency; never widen .dependency-cruiser.cjs',
    note:
      'dependency-cruiser (.dependency-cruiser.cjs): no runtime import cycles in src; ' +
      'src/shared never imports src/audit|src/remediate',
  },
  {
    id: 'verify:hosts',
    kind: 'gate',
    impl: 'verify:hosts',
    preCommit: 'reach',
    fix:
      'an audit host asset failed its isolated deploy+verify — regenerate the rendered assets from ' +
      'the canonical prompt body (src/shared/hostAssets.ts render path); never hand-edit a rendered asset',
  },
  {
    id: 'verify:remediate-hosts',
    kind: 'gate',
    impl: 'verify:remediate-hosts',
    preCommit: 'reach',
    fix:
      'a remediate host asset failed its isolated deploy+verify — regenerate the rendered assets from ' +
      'the canonical prompt body (src/shared/hostAssets.ts render path); never hand-edit a rendered asset',
  },
  {
    id: 'pack:smoke',
    kind: 'gate',
    impl: 'pack:smoke',
    preCommit: false,
    fix:
      'the packed tarball failed its smoke — packaged/global drift is caught ONLY by the pack/smoke ' +
      'family, never by dev checks, so fix the packaging (package.json files, requiredPackagedPaths), ' +
      'not the smoke',
  },
  {
    id: 'smoke:packaged-audit-code',
    kind: 'gate',
    impl: 'smoke:packaged-audit-code',
    preCommit: false,
    fix:
      'the packaged audit-code bin failed its installed-tarball smoke — fix the packaging or the bin ' +
      'entry it names, never the smoke',
  },
  {
    id: 'smoke:packaged-remediate-code',
    kind: 'gate',
    impl: 'smoke:packaged-remediate-code',
    preCommit: false,
    fix:
      'the packaged remediate-code bin failed its installed-tarball smoke — fix the packaging or the ' +
      'bin entry it names, never the smoke',
  },
  {
    id: 'smoke:remediate-gate',
    kind: 'gate',
    impl: 'smoke:remediate-gate',
    preCommit: false,
    fix:
      'the tool-owned final gate failed its fixture drive — fix the GATE (runToolOwnedFinalGate / ' +
      'toolOwnedFinalGateCommands in src/remediate/steps/), never the smoke: a gate that cannot pass ' +
      'on a clean tree blocks every remediate run (the v0.32.61 node:test-runner bug shipped exactly ' +
      'that way because the gate execution path had no end-to-end check)',
  },
  {
    id: 'smoke:linked-audit-code',
    kind: 'gate',
    impl: 'smoke:linked-audit-code',
    preCommit: false,
    fix:
      'the npm-linked audit-code bin failed its smoke — a link-only failure is resolution drift ' +
      '(junction / global-bin shadowing); fix the wrapper resolution, not the smoke',
  },
  {
    id: 'smoke:linked-remediate-code',
    kind: 'gate',
    impl: 'smoke:linked-remediate-code',
    preCommit: false,
    fix:
      'the npm-linked remediate-code bin failed its smoke — a link-only failure is resolution drift ' +
      '(junction / global-bin shadowing); fix the wrapper resolution, not the smoke',
  },
  {
    id: 'vitest-gate',
    kind: 'gate',
    impl: 'scripts/shared/run-vitest-gate.mjs',
    preCommit: false,
    fix:
      'the full suite is red — rerun the failing file alone before calling it a regression ' +
      '(passing alone = hermeticity flake; fix the test), and never mask the exit code behind a pipe',
    note: 'the full suite, invoked by path in verify:release',
  },

  // ── hooks (registered in .claude/settings.json) ────────────────────────────
  { id: 'session-start', kind: 'hook', impl: '.claude/hooks/session-start.sh' },
  { id: 'nightly-surface', kind: 'hook', impl: '.claude/hooks/nightly-surface.mjs' },
  { id: 'session-start-guards', kind: 'hook', impl: '.claude/hooks/session-start-guards.mjs' },
  {
    id: 'shell-trap-guard',
    kind: 'hook',
    impl: '.claude/hooks/shell-trap-guard.mjs',
    forms: [
      { name: 'codex exec with stdin left open', drive: 'hook', hook: '.claude/hooks/shell-trap-guard.mjs',
        payload: { tool_name: 'Bash', tool_input: { command: '$SAMPLE' } },
        sample: 'codex exec "reply ok"', expect: 'stdin closed' },
      { name: 'destructive worktree restore', drive: 'hook', hook: '.claude/hooks/shell-trap-guard.mjs',
        payload: { tool_name: 'Bash', tool_input: { command: '$SAMPLE' } },
        sample: 'git checkout -- src/x.ts', expect: 'destructive restore',
        rootGit: { files: { 'src/x.ts': 'export const x = 1;\n' }, unstaged: { 'src/x.ts': 'export const x = 2;\n' } } },
      { name: 'pathspec stash removes unstaged work', drive: 'hook', hook: '.claude/hooks/shell-trap-guard.mjs',
        payload: { tool_name: 'Bash', tool_input: { command: '$SAMPLE' } },
        sample: 'git stash push -- src/x.ts', expect: 'destructive restore',
        rootGit: { files: { 'src/x.ts': 'export const x = 1;\n' }, unstaged: { 'src/x.ts': 'export const x = 2;\n' } } },
      { name: 'suite exit code masked by a pipe', drive: 'hook', hook: '.claude/hooks/shell-trap-guard.mjs',
        payload: { tool_name: 'Bash', tool_input: { command: '$SAMPLE' } },
        sample: 'npm test | tail -50', expect: 'masked suite exit code' },
      { name: 'state-changing exit code masked by a pipe', drive: 'hook', hook: '.claude/hooks/shell-trap-guard.mjs',
        payload: { tool_name: 'Bash', tool_input: { command: '$SAMPLE' } },
        sample: 'git push origin main | tail -3', expect: 'masked state-changing exit code' },
    ],
  },
  {
    id: 'commit-gate',
    kind: 'git-hook',
    impl: '.claude/hooks/commit-gate.mjs',
    hooks: ['.githooks/pre-commit', '.githooks/pre-merge-commit', '.githooks/pre-applypatch'],
    note:
      'the commit legs at GIT\'s own boundary (P53, owner decision 2026-09-05): `npm run check` on the ' +
      'staged snapshot, the derived verify:checks legs, the doc-contract subset, the constitutional-doc ' +
      'refusal, the loop-core attestation, the branch-strand and child-session refusals. Jurisdiction is ' +
      'by construction — git runs this repository\'s hook for this repository\'s commits only. Its one ' +
      'content FORM — the `[vitest-gate] ATTRIBUTION:` line the doc-contract leg emits — is pinned by ' +
      'the harness test rather than driven here: reproducing it needs a staged repo, a stub doc-contract ' +
      'suite and the gate\'s own round-trip, which that test already owns. core.hooksPath is pointed at ' +
      '.githooks by session-start-guards.mjs; a clone that never opened a session runs no hook until then',
    forms: [
      { name: 'doc-contract attribution line', drive: 'test',
        test: 'tests/shared/pre-commit-gate-doc-contract-attribution.test.ts', sample: '[vitest-gate] ATTRIBUTION:' },
    ],
  },
  {
    id: 'pre-commit-gate',
    kind: 'hook',
    impl: '.claude/hooks/pre-commit-gate.mjs',
    note:
      'the THIN tool-boundary half (P53): refuses what git cannot see — a `--no-verify`/`-n`/`core.hooksPath` ' +
      'bypass on a commit-creating command (fail-closed even on an unresolvable target), the child-session ' +
      'PUSH refusal, and ROUTING of gated incoming content for the verbs git does not hook (a merge that ' +
      'could fast-forward → `--no-ff`; a cherry-pick or revert → `-n` then `git commit`). It also heals a ' +
      'crashed staged-snapshot round-trip on every shell call. An unresolvable target with none of those ' +
      'is out of jurisdiction (the mktemp false RED of 2026-09-04 is closed by construction)',
  },
  {
    id: 'tool-input-guard',
    kind: 'hook',
    impl: '.claude/hooks/tool-input-guard.mjs',
    note: 'the control-byte form (rule 1) is deliberately NOT declared: its positive sample is the very byte the guard bans, and a raw control byte cannot live in this tracked file (check:control-bytes); the hook-trap-guards test pins it with a runtime-built string',
    forms: [
      { name: 'CLI name in a dispatch prompt', drive: 'hook', hook: '.claude/hooks/tool-input-guard.mjs',
        payload: { tool_name: 'Agent', tool_input: { prompt: '$SAMPLE', isolation: 'worktree' } },
        sample: 'Run remediate-code for this node in the bound worktree', expect: 'isolation' },
      { name: 'implement-node phrase', drive: 'hook', hook: '.claude/hooks/tool-input-guard.mjs',
        payload: { tool_name: 'Agent', tool_input: { prompt: '$SAMPLE', isolation: 'worktree' } },
        sample: 'Please implement node 2 from the plan', expect: 'isolation' },
      { name: 'node-id token', drive: 'hook', hook: '.claude/hooks/tool-input-guard.mjs',
        payload: { tool_name: 'Agent', tool_input: { prompt: '$SAMPLE', isolation: 'worktree' } },
        sample: 'Work in the node_id n3 tree', expect: 'isolation' },
    ],
  },
  {
    id: 'question-philosophy-gate',
    kind: 'hook',
    impl: '.claude/hooks/question-philosophy-gate.mjs',
    note: 'the Stop leg reads the transcript FILE the payload names and needs docs/project-philosophy.md under the project root, so the fixture root carries a copy of the brief',
    forms: [
      { name: 'trailing question in the final message', drive: 'hook', hook: '.claude/hooks/question-philosophy-gate.mjs',
        payload: { hook_event_name: 'Stop', session_id: '$SESSION', transcript_path: '$SAMPLE_FILE', stop_hook_active: false },
        sampleFile: 'transcript-jsonl', rootFixture: ['docs/project-philosophy.md'],
        sample: 'Landed the fix.\n\nWant me to also split the backlog?', expect: 'ends in a question to the owner' },
    ],
  },
  {
    id: 'push-gate',
    kind: 'hook',
    impl: '.claude/hooks/push-gate.mjs',
    forms: [
      // A refspec that NAMES the protected branch decides the case without
      // reading HEAD, so the fixture needs no branch state.
      { name: 'agent push to main with no suite-green stamp', drive: 'hook', hook: '.claude/hooks/push-gate.mjs',
        payload: { tool_name: 'Bash', tool_input: { command: '$SAMPLE' } },
        sample: 'git push origin main', expect: 'push to a PROTECTED branch',
        env: { CLAUDE_CODE_SESSION_ID: 'guard-form-reach' },
        rootGit: { files: { 'package.json': '{"name":"x","private":true}\n' } } },
    ],
    note:
      'PreToolUse on Bash|PowerShell. Refuses an AGENT push that would put a PROTECTED branch (main/master) ' +
      'on the remote unless suiteGreenVerdict (scripts/shared/suiteGreenStamp.mjs) certifies the tree being ' +
      'pushed. The gap it closes: every narrow gate passes on a touched area, and a CROSS-AREA invariant is ' +
      'reachable only by the full suite — which nothing local runs before a push (two commits shipped red on ' +
      '2026-08-27 this way). The stamp is minted by the one gate runner on a FULL run, so the only way to ' +
      'satisfy this hook is to have actually run the suite on this content. Its uncovered halves are ' +
      'stated on its REACH row.',
  },
  { id: 'async-typecheck', kind: 'hook', impl: '.claude/hooks/async-typecheck.mjs' },
  { id: 'friction-stop-gate', kind: 'hook', impl: '.claude/hooks/friction-stop-gate.mjs' },
  { id: 'closeout-challenge-gate', kind: 'hook', impl: '.claude/hooks/closeout-challenge-gate.mjs' },

  // ── contract tests (the guards' own guards) ────────────────────────────────
  {
    id: 'guard-form-reach-test',
    kind: 'contract-test',
    impl: 'tests/shared/guard-form-reach.test.ts',
    note:
      'P51: drives the REAL recognizer of every guard row that declares `forms` over each declared ' +
      'sample (script in a fixture repo, exported pure function, or hook payload), so a syntax form a ' +
      'guard stops recognizing goes red instead of being found by accident',
  },
  {
    id: 'shared-primitives-gate-test',
    kind: 'contract-test',
    impl: 'tests/shared/check-shared-primitives.test.ts',
    note:
      'pins the rule matching semantics of check:shared-primitives on synthetic content; its forms are ' +
      'the gate\'s own (declared on the check:shared-primitives row), driven through the same scanFile export',
  },
  {
    id: 'push-gate-test',
    kind: 'contract-test',
    impl: 'tests/shared/push-gate.test.ts',
    note:
      'spawns the REAL push-gate hook with a PreToolUse payload against a throwaway repo, and mints its ' +
      'stamp through the REAL writeSuiteGreenStamp — so the refusal case, the bound case, the STALE case ' +
      '(a stamp covering different content) and the announced relocated-push fail-open are all pinned ' +
      'against the shipped mechanism rather than a hand-rolled stamp file',
  },
  {
    id: 'suite-green-stamp-test',
    kind: 'contract-test',
    impl: 'tests/shared/suite-green-stamp.test.ts',
    note:
      'pins the full-suite green stamp (P48): the full-suite predicate, the tree-bound stamp path, ' +
      'the run-vitest-gate write wiring, and the closeout-challenge-gate read wiring',
  },
  {
    id: 'sync-spawn-budget-test',
    kind: 'contract-test',
    impl: 'tests/shared/sync-spawn-budget.test.ts',
    note:
      'no worker blocks its event loop for >= SYNC_BLOCK_BUDGET_MS (60s) in one synchronous spawn ' +
      '(the P14 worktree-RPC-starvation half): tests/helpers/trackedSpawn.ts records (file, command, ms) ' +
      'per spawnSync call into a run-scoped ledger and this test is the gate over it, so a checker that ' +
      'acquires a network call or a full-tree walk goes red naming the command rather than surfacing as ' +
      'an unattributable flaky worker. UNCOVERED: a sync spawn that bypasses tests/helpers/spawn.mjs ' +
      'with a raw node:child_process import is not recorded — INV-WH ' +
      '(tests/shared/shared-tests-invariants.test.mjs) is the sibling guard that fails exactly that ' +
      'import, so the half is closed by a different mechanism, not left to memory.',
  },
  {
    id: 'test-mirrors-production-test',
    kind: 'contract-test',
    impl: 'tests/shared/test-mirrors-production.test.ts',
    note:
      'a test file may not re-implement its subject: a test-declared function whose NAME matches a ' +
      'production export, whose body BRANCHES, and whose body calls nothing imported from production ' +
      'is a copy, and a copy stays green after the original changes. Three signals together separate a ' +
      'mirror from a fixture builder (no branching) and from a delegation wrapper (imports the name). ' +
      'Drove five live conversions — stableStringify x2, compareCodeUnits, globToRegExp, countLines, ' +
      'the AuditResult producer x2. UNCOVERED, stated: detection is textual, so an SEMANTIC mirror ' +
      'under a different name is not caught (the survey that sized this guard found ~13 of those, ' +
      'including a hand-rolled cycle detector and a release poll loop); and a mirror whose name ' +
      'coincides with no production export is invisible to the name-match signal.',
  },
  { id: 'hook-trap-guards-test', kind: 'contract-test', impl: 'tests/shared/hook-trap-guards.test.ts' },
  {
    id: 'shipped-import-closure-test',
    kind: 'contract-test',
    impl: 'tests/shared/shipped-import-closure.test.ts',
    note:
      'the packed package must carry everything its shipped scripts import: the walk derives its ' +
      'roots from package.json `files` and follows RELATIVE import edges from every shipped module, ' +
      'so a reachable file `files` does not cover is RED. Closes the 2026-09-10 defect where ' +
      'wrapper/audit-code-wrapper-build.mjs began importing scripts/shared/primitives.mjs and only ' +
      'smoke:packaged-audit-code noticed, as an ERR_MODULE_NOT_FOUND inside a temp install. ' +
      'UNCOVERED, stated: a non-literal specifier is invisible to the reader, a bare specifier is ' +
      'never followed (external packages, and audit-tools/shared which resolves into dist/**), and a ' +
      'relative specifier that resolves to nothing on disk is skipped — that is a broken import, ' +
      'which the packaged smokes catch directly, not a coverage hole.',
  },
  {
    id: 'green-mechanism-declaration-test',
    kind: 'contract-test',
    impl: 'tests/shared/green-mechanism-declaration.test.ts',
  },
  { id: 'hook-session-gates-test', kind: 'contract-test', impl: 'tests/shared/hook-session-gates.test.ts' },
  {
    id: 'session-registry-test',
    kind: 'contract-test',
    impl: 'tests/shared/session-registry.test.ts',
    note:
      'session registry substrate (child-session split + closeout dirt partition): the registration ' +
      'leg end-to-end, the explicit-id CLI, and the readSessionRegistry predicate the session-scoped ' +
      'gates import',
  },
  {
    id: 'run-hermeticity-test',
    kind: 'contract-test',
    impl: 'tests/shared/run-hermeticity.test.ts',
    note:
      'the live-child teardown check in tests/helpers/global-setup.ts: a run whose own spawned ' +
      'child is still alive fails with pid and command named (ledger: tests/helpers/trackedSpawn.ts). ' +
      'UNCOVERED: a `shell: true` grandchild, since the ledger holds the pid of the cmd.exe its ' +
      'parent actually spawned, not of what cmd.exe started; and sync spawns, which cannot straggle. ' +
      'UNCOVERED, NEW 2026-08-30: the repo ROOT is no longer observed by any suite check — the ' +
      'root-delta half (repoRootProblems / unexpectedRootEntries / RUN_OWNED_ROOT_ENTRIES) was ' +
      'DELETED on the owner ruling that this project no longer produces the artifacts, which its own ' +
      'creation commit f3cac01b had already measured (6,496 spawns, zero carrying `>`). Consequences, ' +
      'stated rather than discovered later: npm test can now mint a suite-green stamp over a tree ' +
      'that contains an unignored root leak; a future regression in THIS project spawn discipline ' +
      'leaks a zero-byte root file that nothing names; and the nearest remaining reader is the ' +
      "closeout Stop gate's session-dirt line, which is session-scoped, capped, skipped for " +
      'unregistered child sessions, absent in CI, and cleared by committing. A leak matching an ' +
      'ignore rule (*.log, /result.json, /temp*.json, /part*.txt, .audit-code-build.lock) is seen by ' +
      'NOTHING at all, including the `git add -A` tree the suite-green stamp binds. ' +
      '⚠ check-guard-reach.mjs never reads this `note` field — it validates only that `impl` is a ' +
      'tracked file under tests/ — so this text is unenforced: read the row, never trust a green gate ' +
      'to have checked it. Diagnosis and remedy: docs/backlog/durable-traps.md',
  },
  { id: 'nightly-routine-test', kind: 'contract-test', impl: 'tests/shared/nightly-routine.test.ts' },
  { id: 'nightly-items-mandatory-fields-test', kind: 'contract-test', impl: 'tests/shared/nightly-items-mandatory-fields.test.ts' },
  { id: 'nightly-scope-ledger-test', kind: 'contract-test', impl: 'tests/shared/nightly-scope-ledger.test.ts' },
  { id: 'script-argv-refusal-test', kind: 'contract-test', impl: 'tests/shared/script-argv-refusal.test.ts' },
  { id: 'hook-async-typecheck-test', kind: 'contract-test', impl: 'tests/shared/hook-async-typecheck.test.ts' },
  {
    id: 'write-time-derived-gates-test',
    kind: 'contract-test',
    impl: 'tests/shared/write-time-derived-gates.test.ts',
    note:
      'the write-time half of the backlog gates: the leg set the PostToolUse hook draws is read from ' +
      'the LIVE guard registry (buildWriteTimeLegs), the runner returns findings as data and owns no ' +
      'exit code, and the size-budget leg is SKIPPED at write time and announced as deferred — its ' +
      'remedy rewrites lap-scoped baseline state. Also pins the hook end-to-end: with four legs wired ' +
      'to failing commands it must still exit 0 and print the deferral',
  },
  { id: 'hook-friction-stop-test', kind: 'contract-test', impl: 'tests/shared/hook-friction-stop-gate.test.ts' },
  { id: 'hook-session-start-guards-test', kind: 'contract-test', impl: 'tests/shared/hook-session-start-guards.test.ts' },
  { id: 'session-start-hook-test', kind: 'contract-test', impl: 'tests/audit/session-start-hook.test.ts' },
  {
    id: 'installer-verb-help-test',
    kind: 'contract-test',
    impl: 'tests/shared/installer-verb-help.test.ts',
    note:
      'the installer-verb declaration and its copies: every verb of both bins answers --help without ' +
      'installing, and the two enumerations that cannot import the module are pinned verb AND summary',
  },
  {
    id: 'shipped-doc-surface-test',
    kind: 'contract-test',
    impl: 'tests/shared/shipped-doc-surface.test.ts',
    forms: [
      { name: 'inline link target', drive: 'export', module: 'tests/helpers/recognizers.ts', exportName: 'relativeLinkTargets', call: 'text',
        sample: 'read [the guide](docs/audit-pkg/operator-guide.md#supported-surfaces)' },
      { name: 'reference-definition target', drive: 'export', module: 'tests/helpers/recognizers.ts', exportName: 'relativeLinkTargets', call: 'text',
        sample: '[guide]: ./docs/audit-pkg/product.md' },
      { name: 'heading anchor', drive: 'export', module: 'tests/helpers/recognizers.ts', exportName: 'headingAnchors', call: 'text',
        sample: '## Supported surfaces' },
      { name: 'absolute GitHub URL', drive: 'export', module: 'tests/helpers/recognizers.ts', exportName: 'absoluteGitHubSlugs', call: 'text',
        sample: 'see https://github.com/owner/repo/blob/main/docs/x.md' },
    ],
    note:
      'the npm tarball as a doc surface: which docs/ pages ship, README naming exactly them, no ' +
      'relative link or fragment leaving the set, every absolute github.com slug bound to ' +
      'package.json `repository`, and the target-directory rule stated once across the loader pair',
  },
  { id: 'doc-manifest-gate-test', kind: 'contract-test', impl: 'tests/shared/doc-manifest-gate.test.ts' },
  { id: 'guard-reach-gate-test', kind: 'contract-test', impl: 'tests/shared/guard-reach-gate.test.ts' },
  {
    id: 'orphan-modules-relative-import-test',
    kind: 'contract-test',
    impl: 'tests/shared/orphan-modules-relative-import.test.ts',
    note:
      'Track 2.5: drives the relative-import pass over fixture trees on disk, pinning both the ' +
      'detection (a module whose only production edge is an unconsumed re-export chain) and each ' +
      'exemption that keeps it from becoming a noise list — package entries, a barrel production ' +
      'actually consumes, a production file that re-exports the name, and a module the tests never ' +
      'reach (left to the file-level pass and knip)',
  },
  {
    id: 'host-asset-plan-test',
    kind: 'contract-test',
    impl: 'tests/shared/host-asset-plan.test.ts',
    note:
      'the declared host-asset install plan the two postinstalls execute: one row per bin (pinned ' +
      'against package.json `bin`), derived per-tool TARGET paths, the declared-optional Codex UI ' +
      'metadata target, the per-tool agent name, and the per-tool policy that legitimately differs ' +
      '(template trim, frontmatter stripping). Its last case asserts each postinstall entry READS ' +
      'the plan and hand-spells no host target path — the two-installers-drifting shape the backlog ' +
      'entry names',
  },
  {
    id: 'agents-region-gate-test',
    kind: 'contract-test',
    impl: 'tests/shared/agents-region-gate.test.ts',
    note:
      'P64: pins check:agents-region in both polarities (equal figure fresh, different figure ' +
      'refused naming both figures) plus the fail-closed shape when the pointer sentence is absent, ' +
      'so a machine-wide retirement of the sentence cannot leave a green check over an ' +
      'unrecognized region',
  },
  {
    id: 'sync-spawn-fold-safety-test',
    kind: 'contract-test',
    impl: 'tests/shared/sync-spawn-fold-safety.test.ts',
    forms: [
      { name: 'spawnSync call', drive: 'export', module: 'tests/helpers/recognizers.ts', exportName: 'syncSpawnHits', call: 'text',
        sample: 'const r = spawnSync("git", ["status"]);' },
      { name: 'sync runTracked twin', drive: 'export', module: 'tests/helpers/recognizers.ts', exportName: 'syncSpawnHits', call: 'text',
        sample: 'const r = runTracked(["git", "status"], { cwd });' },
      { name: 'execSync call', drive: 'export', module: 'tests/helpers/recognizers.ts', exportName: 'syncSpawnHits', call: 'text',
        sample: 'const out = execSync("git status");' },
    ],
    note:
      'INV-SSF: the fold-reachable modules (shared git helpers, the disposition extractor, the ' +
      'analyzer-dep installer) spawn children only through the async exec twin — a synchronous child ' +
      'starves the held file lock’s mtime heartbeat until another process steals the LIVE lock; ' +
      'the sync twin itself requires a declared timeout at the type level (RunTrackedSyncOptions). ' +
      'UNCOVERED: the module list is the reviewed reachability claim — a NEW fold-reachable module ' +
      'must be added to the test by hand; and the remediate-side sync spawns (triage verify ' +
      'commands, hostHandoff git probes, findingGrounding / contractPipelineGates enumerations) are ' +
      'outside the scan — tracked in the open-bugs entry',
  },
  {
    id: 'submission-no-sizing-identity-test',
    kind: 'contract-test',
    impl: 'tests/shared/submission-contract-has-no-sizing-identity.test.ts',
    forms: [
      { name: 'banned key on an emitted object', drive: 'export', module: 'tests/helpers/recognizers.ts', exportName: 'bannedSizingKeys', call: 'text',
        sample: '{"submission_id": "s1", "shard": 2}' },
      { name: 'banned identifier in source', drive: 'export', module: 'tests/helpers/recognizers.ts', exportName: 'bannedSizingIdentifierLines', call: 'text',
        sample: 'const shard_index = 2;' },
    ],
    note:
      'mechanical replacement for a backlog note: the submission core must not re-grow a packet/shard/' +
      'provider/model/budget field, in the emitted objects OR as a source identifier',
  },
  {
    id: 'lane-demand-no-execution-identity-test',
    kind: 'contract-test',
    impl: 'tests/shared/lane-demand.test.ts',
    forms: [
      { name: 'execution-choice key on an emitted demand ranking', drive: 'export', module: 'tests/helpers/recognizers.ts', exportName: 'bannedLaneExecutionKeys', call: 'text',
        sample: '{"size": "small", "complexity": "focused", "risk": "low", "model_tier": "pool/medium"}' },
    ],
    note:
      'the emitted-lane demand ranking names DEMAND only (size/complexity/risk); backend, provider, ' +
      'model and tier selection belong to the host, so a lane that names one has moved execution ' +
      'selection into the tool. The schema is .strict() and this row pins the emitted key set',
  },
  {
    id: 'submission-path-tool-owned-test',
    kind: 'contract-test',
    impl: 'tests/shared/submission-path-is-tool-owned.test.ts',
    forms: [
      { name: 'incoming as a path segment', drive: 'export', module: 'tests/helpers/recognizers.ts', exportName: 'incomingLiteralLines', call: 'text',
        sample: 'const dir = join(artifactsDir, "incoming", name);' },
      { name: 'incoming as a rendered path', drive: 'export', module: 'tests/helpers/recognizers.ts', exportName: 'incomingLiteralLines', call: 'text',
        sample: 'const line = `write the result to incoming/${id}.json`;' },
    ],
    note:
      'scans all of src/ for a reintroduced host-typed drop directory — the guard that keeps the ' +
      'tool-owned submission path from being undone one call site at a time',
  },
  {
    id: 'pre-commit-staged-snapshot-test',
    kind: 'contract-test',
    impl: 'tests/shared/pre-commit-gate-staged-snapshot.test.ts',
    note: 'staged-snapshot leg of the pre-commit-gate-*.test.ts family (shared fixture: pre-commit-gate-harness.ts)',
  },
  {
    id: 'pre-commit-commit-detection-test',
    kind: 'contract-test',
    impl: 'tests/shared/pre-commit-gate-commit-detection.test.ts',
    note: 'commit-detection + crash-recovery + live-lock leg of the pre-commit-gate family',
  },
  {
    id: 'pre-commit-roundtrip-journal-test',
    kind: 'contract-test',
    impl: 'tests/shared/pre-commit-gate-roundtrip-journal.test.ts',
    note:
      'round-trip journal HEAD binding: recovery refuses + quarantines on a moved or unrecorded HEAD, ' +
      'and history-moving verbs take the direct check instead of the materializing round-trip',
  },
  {
    id: 'pre-commit-commit-creating-test',
    kind: 'contract-test',
    impl: 'tests/shared/pre-commit-gate-commit-creating.test.ts',
    note: 'P9 commit-creating-subcommand leg of the pre-commit-gate family',
  },
  {
    id: 'pre-commit-attestation-test',
    kind: 'contract-test',
    impl: 'tests/shared/pre-commit-gate-attestation.test.ts',
    note: 'spawns the pre-commit gate AND the attest-loop-core-review hook end-to-end',
  },
  {
    id: 'pre-commit-branch-strand-test',
    kind: 'contract-test',
    impl: 'tests/shared/pre-commit-gate-branch-strand.test.ts',
    note: 'branch-strand refusal + fail-open announcement leg of the pre-commit-gate family',
  },
  {
    id: 'pre-commit-child-session-test',
    kind: 'contract-test',
    impl: 'tests/shared/pre-commit-gate-child-session.test.ts',
    note: 'Build 1 (P23) child-session commit/push refusal + push narrowness leg of the pre-commit-gate family',
  },
  {
    id: 'pre-commit-target-repo-test',
    kind: 'contract-test',
    impl: 'tests/shared/pre-commit-gate-target-repo.test.ts',
    note:
      'target-repo scoping leg of the pre-commit-gate family: a commit/push into a DIFFERENT ' +
      'repository (via cd chain, `git -C`, or the payload cwd) is out of jurisdiction — closes the ' +
      '2026-08-19 false-RED class (an unrelated repo\'s commit blocked by audit-tools\' red index) — ' +
      'while linked worktrees of THIS repo and unresolvable targets stay gated, fail-closed',
  },
  {
    id: 'loop-core-gate-parity-test',
    kind: 'contract-test',
    impl: 'tests/shared/loop-core-gate-parity.test.ts',
    note: 'pins pattern + predicate parity between pre-commit-gate and attest-loop-core-review',
  },
  {
    id: 'attest-derived-file-preflight-test',
    kind: 'contract-test',
    impl: 'tests/shared/attest-derived-file-preflight.test.ts',
    note:
      'P19: attest scripts run the gate-shared derived-file checks before binding and refuse a tree ' +
      'the gate would reject — and since 2026-08-30 they refuse ONLY when the worktree tree equals ' +
      'the staged tree before and after the legs, abstaining otherwise',
  },
  {
    id: 'precommit-leg-derivation-test',
    kind: 'contract-test',
    impl: 'tests/shared/precommit-leg-derivation.test.ts',
    note:
      'P34 unit matrix over buildPreCommitLegs: every derived leg trigger reproduces (or safely ' +
      'widens) the retired hand-coded trigger it replaced, against the LIVE registry',
  },
  {
    id: 'pre-commit-derived-legs-test',
    kind: 'contract-test',
    impl: 'tests/shared/pre-commit-gate-derived-legs.test.ts',
    note: 'P34 spawn smoke: the real hook runs the derived leg loop end-to-end (block on a wired failing leg, announced skip on an unwired one)',
  },
  {
    id: 'ci-trigger-paths-test',
    kind: 'contract-test',
    impl: 'tests/shared/ci-trigger-paths.test.ts',
    note: 'P26: derivation excludes declared-gap rows, keeps the always-trigger base, and the tracked ci.yml matches the generator byte-for-byte',
  },
  {
    id: 'runtime-artifact-names-drift-test',
    kind: 'contract-test',
    impl: 'tests/shared/runtime-artifact-names-drift.test.ts',
    note:
      'drift pin for the generated run-artifact name set the doc-citation gate consumes — re-runs the ' +
      'textual extraction against the runtime-layout sources and cross-checks ARTIFACT_DEFINITIONS directly',
  },
  {
    id: 'commit-gate-git-boundary-test',
    kind: 'contract-test',
    impl: 'tests/shared/commit-gate-git-boundary.test.ts',
    note:
      'drives a REAL `git commit` in a fixture whose core.hooksPath runs commit-gate.mjs: a GOOD snapshot ' +
      'lands, a BAD one is refused with the gate\'s own text and HEAD does not move, the staged snapshot ' +
      '(not the worktree) is judged and the worktree restored, `commit -a` is judged on the temporary index ' +
      'git hands the hook, a routed cherry-pick (-n, then commit) is judged on the applied tree; and pins ' +
      'the tracked .githooks/* files — executable in the index, LF, running the gate relative to themselves, ' +
      'pre-push delegating to the local .git/hooks/pre-push identity guard',
  },
  {
    id: 'ingestion-checks-drift-test',
    kind: 'contract-test',
    impl: 'tests/shared/ingestion-checks-drift.test.ts',
    note:
      'pins the contracts.md ingestion-check block against INGESTION_CHECKS (render from declaration, ' +
      'tracked page byte-equal, the two former copies reduced to pointers), and pins the registry as ' +
      'load-bearing by structural extraction: the shared scan and each host-handoff twin cite exactly ' +
      'the checks the registry declares for them, in both directions',
  },
  {
    id: 'executor-producer-declaration-test',
    kind: 'contract-test',
    impl: 'tests/audit/executor-artifact-production-declaration.test.ts',
    note:
      'pins EXECUTOR_REGISTRY[].produces against what the executor sources actually write, in both ' +
      'directions (declared ⊇ extracted, and extracted ∪ data-declared dynamic contributors ⊇ declared), ' +
      'plus one primary producer per registry artifact and drift of the generated render',
  },
  {
    id: 'spec-mirror-drift-test',
    kind: 'contract-test',
    impl: 'tests/shared/spec-mirror-drift.test.ts',
    note:
      'asserts the three docs against a fresh render of the registries (not against themselves, which ' +
      'the gate already does), pins the both-way membership reconciliation red on a dropped and on an ' +
      'invented row, and pins the splice refusals for a missing / duplicated marker pair',
  },
  {
    id: 'lane-dispatch-driver-test',
    kind: 'contract-test',
    impl: 'tests/shared/lane-dispatch.test.ts',
    note:
      'P28 wrapper half (sol-3): the shared one-item-per-call dispatch driver — one lane call per ' +
      'item, resume drops errored rows and re-queues exactly them, preflight aborts with a stamped ' +
      'sidecar and a typed throw, per-item log redirect before parse, finish_reason/output_bytes on ' +
      'every lane-answered row, and the read-verbatim coverage-stamp field names/order the nightly ' +
      'routine consumes',
  },
  {
    id: 'prompt-capability-test',
    kind: 'contract-test',
    impl: 'tests/shared/prompt-capability.test.ts',
    forms: [
      { name: 'required-inputs entry', drive: 'export', module: 'tests/helpers/recognizers.ts', exportName: 'requiredInputEntries', call: 'text',
        sample: '## Required Inputs\n- `/project/.audit-tools/remediation/intake/goal-spec.json` (goal_spec)\n' },
      { name: 'second results-path heading', drive: 'export', module: 'tests/helpers/recognizers.ts', exportName: 'resultsPathDriftLines', call: 'text',
        sample: 'const footer = "## Results path";' },
      { name: 'results path promised below', drive: 'export', module: 'tests/helpers/recognizers.ts', exportName: 'resultsPathDriftLines', call: 'text',
        sample: 'const note = "write to the results path provided below";' },
    ],
    note:
      'C2 (sol-10/P35): a rendered imperative must be satisfiable by the worker it is handed to — ' +
      'contract-pipeline Required Inputs are DERIVED from DEPENDENCY_MAP (no hand-kept per-role list), ' +
      'a tool-derived artifact is materialized at the host-facing input path as well as the canonical ' +
      'envelope, and every fan-out lane prompt ends with the chokepoint footer carrying its own bound ' +
      'path plus the read-only-executor alternative. Uncovered halves, declared: whether a named path ' +
      'EXISTS on disk is a run property (pinned only for the targeted single-phase scenario in ' +
      'tests/remediate/contract-pipeline-required-inputs.test.ts — a collapsed framing step ' +
      'legitimately names paths written later in the same round-trip); archived-artifact references ' +
      'are not pinned; renderContractRepairPrompt keeps its own declared six-input list and its ' +
      '"Regenerate IN FULL" instruction, so the INV-CO-13 in-full-vs-targeted trap (durable-traps) is ' +
      'out of this guard\'s reach; and the src scan is LITERAL (the "## Results path" heading and the ' +
      '"results path provided below" dangling reference), so a differently-worded per-emitter write ' +
      'imperative — including the driver-facing "The executor must write ... to:" step-prompt lines, ' +
      'which are deliberately in scope for neither — goes unflagged',
  },
  {
    id: 'prompt-renders-its-contract-test',
    kind: 'contract-test',
    impl: 'tests/shared/prompt-renders-its-contract.test.ts',
    note:
      'P41 (nightly 2026-08-25): typed prompt-contract registry records every known builder as ' +
      'derived, projection, or declared-gap; derived rows render fixtures and assert required ' +
      'top-level schema keys plus exhaustive closed enums, projection rows assert rendered field ' +
      'tokens and schema-subset membership where a zod object exists, and declared gaps require ' +
      'reasons. A recursive fs-only source reconciliation makes every exported /Prompt/ builder ' +
      'claim exactly one row. The two P40 behavioral/source pins remain.',
  },
  {
    id: 'conceptual-category-comment-drift-test',
    kind: 'contract-test',
    impl: 'tests/audit/conceptual-category-comment-drift.test.ts',
    forms: [
      { name: 'comment re-enumerating the category set', drive: 'export', module: 'tests/helpers/recognizers.ts', exportName: 'enumeratingCommentLines', call: 'text',
        sample: '// one of: fundamental_approach, core_assumption, structural_risk' },
    ],
    note:
      'P50: conceptual finding categories are single-sourced; scans tracked src/**/*.ts comment ' +
      'lines for 3+ canonical token enumerations. Uncovered: comments naming 1-2 tokens (accepted ' +
      'as topical discussion rather than enumeration) and non-.ts files are outside the scan',
  },
  {
    id: 'check:doc-test-consumers',
    kind: 'gate',
    forms: [
      // The map recognises a STAGED DOC as one whose consumers must be named.
      { name: 'a staged doc with declared test consumers', drive: 'export', module: 'scripts/check-doc-test-consumers.mjs',
        exportName: 'describeStagedHits', call: 'text', sample: 'docs/HANDOFF.md',
        expect: 'docs/HANDOFF.md → asserts:' },
    ],
    impl: 'check:doc-test-consumers',
    // No reach semantics: it validates a repo-wide MAP and surfaces it for the
    // staged docs. A staged-path trigger would make the map's own rows the only
    // thing that fires it, which is not what it checks.
    preCommit: false,
    fix:
      'the declared doc → test consumer map names a doc or test that is not tracked, a duplicate doc, ' +
      'a row with no consumer, or a row with no `what` — fix the row in ' +
      'scripts/doc-test-consumers-data.mjs, or drop it and declare the doc UNCLAIMED',
    note:
      'A map plus a stderr SURFACE, never an enforcement. When a mapped doc is staged the map is ' +
      'printed with the tests that assert it (`--staged`), so the editor is handed the list without ' +
      'grepping — which is the cost the record names (a nightly-routine.md edit green through every ' +
      'local doc gate, red in release CI on a parity test that pinned the retired helper, burning tag ' +
      'v0.34.40). Uncovered, declared: it does NOT check that the named tests still ASSERT the doc, nor ' +
      'that an unmapped doc is uncovered — it is only UNCLAIMED. Both need assertion-level provenance ' +
      '(which string in a test came from which doc), the undecidable class the acquired-analyzer ' +
      'boundary already declares, so the map is CURATED and only its SHAPE is checked (2026-09-10)',
  },
  {
    id: 'doc-test-consumers-map-test',
    kind: 'contract-test',
    impl: 'tests/shared/doc-test-consumers-gate.test.ts',
    note:
      'P09: pins the map check itself — a row must name a tracked doc, tracked tests, and a `what`; ' +
      'duplicates are refused, because a second row for one doc is how a map grows two answers',
  },
  {
    id: 'review-routing-gate-test',
    kind: 'contract-test',
    impl: 'tests/shared/review-routing-gate.test.ts',
    forms: [
      { name: 'routing declaration recognized', drive: 'export', module: 'scripts/check-review-routing.mjs',
        exportName: 'findRoutingDeclarations', call: 'text',
        sample: '<!-- review-routing: no-forward-work -->' },
    ],
    note:
      'P09: `docs/reviews/` records are the analysis surface no gate reconciled against a work queue, ' +
      'so a review could identify a whole program and reach nothing. The mechanism is an author-written ' +
      'declaration checked for existence and shape, with pre-mechanism records on a shrinking ' +
      'declared-debt baseline. Uncovered: the gate cannot tell whether the author picked the TRUE row',
  },
  {
    id: 'comment-symbol-drift-test',
    kind: 'contract-test',
    impl: 'tests/shared/comment-symbol-drift.test.ts',
    forms: [
      { name: 'comment citing a symbol the tree does not declare', drive: 'export', module: 'tests/helpers/recognizers.ts', exportName: 'backtickedSymbolsInComments', call: 'text',
        sample: '// the reader is `goneForeverHelper` and the set is `GONE_FOREVER_SET`' },
    ],
    note:
      'P09: a COMMENT naming a backticked symbol was gated by nothing — DOCS are covered by ' +
      'check:doc-code-citations and LINKS by check:doc-links, so a comment could keep describing a ' +
      'symbol the tree had renamed or deleted (the 2026-08-31 finding: continuityScore.ts claimed ' +
      'audit re-exported computeContinuityScores and biased packet ORDERING with it, long after that ' +
      'wiring was gone). Resolution is against identifiers, FIELD/MEMBER names, static member ' +
      'access, string literals, and module basenames declared anywhere in the tracked tree. ' +
      'UNCOVERED HALF, two directions and neither is "nothing could have noticed". (1) A comment ' +
      'stating a workflow SHAPE names no identifier, so no text rule reaches it — the two P50-era ' +
      'category comments are that class and were reconciled by editing them, not by this gate. ' +
      '(2) A symbol that ALSO appears as a NON-comment token in the same file is skipped, because a ' +
      'comment referencing the symbol its own file declares is self-evidencing and needs no ' +
      'cross-tree lookup — the continuityScore case above is exactly that shape (the name survived ' +
      'as a declaration in its own module while the header described deleted WIRING), so THIS GATE ' +
      'WOULD NOT HAVE CAUGHT IT either. Also excluded: a host-global camelCase API ' +
      '(structuredClone, setInterval) by a closed list in the recognizer. Covered by an inline ' +
      'marker: `comment-symbol-exempt:` reaching the rest of its comment block, for deliberate ' +
      'archaeology',
  },
];

/** @type {ReachRow[]} */
export const REACH = [
  {
    area: 'shared primitive single-source (comparator / containment / hash / paths / collation)',
    // The scan set, both levels of each tree: `**/` requires an intervening
    // directory, so `scripts/**/*.mjs` alone omits `scripts/*.mjs`.
    files: [
      'src/**/*.ts',
      'scripts/*.mjs',
      'scripts/**/*.mjs',
      'wrapper/*.mjs',
      'wrapper/**/*.mjs',
      'dispatch/*.mjs',
      'dispatch/**/*.mjs',
      '.claude/hooks/*.mjs',
      'audit-code.mjs',
      'remediate-code.mjs',
      'scripts/check-shared-primitives.mjs',
    ],
    guardedBy: ['check:shared-primitives', 'shared-primitives-gate-test'],
    uncovered:
      'tests/** is deliberately out of the scan set — a test oracle must not import the code it ' +
      'validates, so test-tree comparator copies are accepted; the pattern rules match SPELLINGS, ' +
      'not semantics — a first-segment-split containment re-roll, an aliased `relative as rel` ' +
      'import, or an equivalent comparator under a novel spelling (`a === b ? 0 : a < b ? -1 : 1`) ' +
      'under a NEW name passes (the known fork names are banned individually; review + jscpd are ' +
      'the layers behind the gate)',
  },
  {
    area: 'runtime artifact-name layout sources',
    // DERIVED from the generator's declared input set — never hand-listed. A path
    // added to RUNTIME_NAME_SOURCES joins the commit gate's reach in the same edit.
    files: [
      ...RUNTIME_NAME_SOURCES.map((s) => s.file),
      'scripts/shared/generate-runtime-artifact-names.mjs',
      'scripts/shared/runtime-artifact-names.generated.mjs',
    ],
    guardedBy: ['check:runtime-artifact-names'],
  },
  {
    area: 'loop-core pattern parity sources',
    files: [
      'src/shared/loopCorePaths.ts',
      'scripts/shared/generate-loop-core-patterns.mjs',
      '.claude/hooks/loop-core-patterns.mjs',
    ],
    guardedBy: ['check:loop-core-patterns'],
    note:
      'the F2 hole (ceremony review 2026-08-29): the generated hook copy is what the pre-build ' +
      'commit gate matches loop-core paths against, so an unregenerated loopCorePaths.ts edit must ' +
      'red AT COMMIT, not first in release CI',
  },
  {
    area: 'loop-core closure sources',
    files: [
      'scripts/check-loop-core-closure.mjs',
      'scripts/shared/loopCoreClosure.mjs',
      'scripts/shared/loopCoreClosureData.mjs',
    ],
    guardedBy: ['check:loop-core-closure'],
    note:
      'the loop-core SET is hand-maintained, so a symbol moving into a new module left attestation ' +
      'coverage silently (quarantineSubmissionFile at b4a3eb4a). This gate makes the reach a ' +
      'property of the import graph instead: a module imported only by loop-core is core, or it ' +
      'is declared with a reason',
    uncovered:
      'the rule claims a module only when EVERY importer is loop-core, so a genuinely-core module ' +
      'that also has one ordinary consumer is not claimed and must still be added by hand. The 25 ' +
      "rows' CAPABILITY is now re-derived every run (a claim from the closed set pure | reads-only | " +
      'mutates), so a row can no longer stay green after the shape it describes changed — but the ' +
      "claim is a capability fact, not a judgement that the module is correctly outside the set: a " +
      "row reading 'pure' may still be workflow-core on some other axis, and nothing checks that. " +
      "For the four 'mutates' rows the WHERE argument (every write location derives from a " +
      'caller-supplied artifactsDir) is prose in the row reason — which location a write targets is ' +
      'not mechanically decidable from source text, and that half is declared rather than guessed',
  },
  {
    area: 'friction-category parity sources',
    files: [
      'src/shared/friction/frictionRecord.ts',
      'scripts/shared/generate-friction-categories.mjs',
      'scripts/shared/friction-categories.generated.mjs',
    ],
    guardedBy: ['check:friction-categories'],
    note:
      'the closeout renderer chain must run in a never-built checkout, so it imports the ' +
      'generated sibling, never audit-tools/shared (backlog 2026-08-29)',
  },
  {
    area: 'constitutional doc-path parity sources',
    files: [
      'src/shared/constitutionalDocPaths.ts',
      'scripts/shared/generate-constitutional-doc-paths.mjs',
      'scripts/shared/constitutional-doc-paths.generated.mjs',
    ],
    guardedBy: ['check:constitutional-doc-paths'],
    note: 'same parity class as the loop-core patterns row above',
  },
  {
    area: 'executor→artifact producer relation',
    files: [
      'src/audit/orchestrator/executors.ts',
      'scripts/shared/executor-write-sites.mjs',
      'scripts/shared/generate-executor-producers.mjs',
      'spec/audit/executor-producers.generated.md',
    ],
    guardedBy: ['check:executor-producers', 'executor-producer-declaration-test'],
    uncovered:
      'the extraction reads DECLARED write sites (scopes and CLI rules in executor-write-sites.mjs) — a ' +
      'SOME-of-the-set relocation into a helper the site does not name is invisible to it, and the ' +
      'declared-⊇-extracted direction then passes vacuously for the moved artifact (the declared side is ' +
      'still caught by DECL-4). A renamed scope, and a relocation that empties the scope, both refuse loudly. ' +
      'Separately, design_review_contract and design_review_conceptual share ONE whole-file artifactsDirWrites ' +
      'rule over src/audit/cli/nextStepHelpers.ts, so the two cannot be told apart: a CLI-site write added there ' +
      'for only one of them forces BOTH to declare it and the render credits an executor that never writes it. ' +
      'A `no-writes` site is checked in the writes-appeared direction only when it names a file+scope: ' +
      'intent_equivalence_executor does, semantic_review_executor CANNOT (no deterministic runner exists — the ' +
      'host returns results through the submission ledger), so if that executor ever started writing an artifact ' +
      'nothing would extract it and its declared-⊇-extracted pin would stay vacuous. Within a `produces` entry only ' +
      'the artifact name is checked against the code: the `role` (primary vs refresh) and `note` fields are ' +
      'hand-authored and mechanically unchecked, so a wrong role or a stale note renders faithfully',
  },
  {
    area: 'spec/audit registry mirrors',
    // DERIVED from the render's own declared input/output sets — never hand-listed, so a
    // registry or doc added to the mirror joins the commit gate's reach in the same edit.
    files: [
      ...SPEC_MIRROR_SOURCE_FILES,
      ...SPEC_MIRROR_DOCS,
      'scripts/shared/generate-spec-mirrors.mjs',
      'scripts/shared/spec-mirror-data.mjs',
    ],
    guardedBy: ['check:spec-mirrors', 'spec-mirror-drift-test'],
    note:
      'the three tables that used to hand-mirror ARTIFACT_DEFINITIONS, EXECUTOR_REGISTRY and ' +
      'ARTIFACT_DEPENDS_ON_MAP. Membership is reconciled BOTH ways — a registry row no region ' +
      'declares, and a declared row no registry holds, are hard refusals — so the row set cannot ' +
      'drift; the two constant sources are read only to resolve filenames the registries name by ' +
      'identifier',
    uncovered:
      'only the registry-DERIVED cells are checked. The Purpose / Notes prose is hand-authored in ' +
      'spec-mirror-data.mjs and mechanically unverified, so a stale purpose renders faithfully ' +
      '(the same half the producer-relation row states for `role`/`note`). Section membership is ' +
      'declared, not derived, for two of the three: EXECUTOR_REGISTRY declares no pipeline stage ' +
      'and the DAG phases are not the artifact registry\'s phases, so an executor filed under the ' +
      'wrong stage — or a DAG row under the wrong phase — passes; only the artifact-contract ' +
      'regions pin membership against the registry phase. Row ORDER within a region is declaration ' +
      'order and is unchecked. The one declared non-registry row is checked only for being ABSENT ' +
      'from ARTIFACT_DEFINITIONS; nothing verifies the runtime submission it describes still behaves ' +
      'as stated',
  },
  {
    area: 'git hooks — the commit gate\'s boundary (P53)',
    files: ['.githooks/pre-commit', '.githooks/pre-merge-commit', '.githooks/pre-applypatch', '.githooks/pre-push'],
    guardedBy: ['commit-gate-git-boundary-test'],
    note:
      'the tracked hook files git runs through core.hooksPath: three exec commit-gate.mjs relative to ' +
      'themselves (so a linked worktree on an older branch still runs the current gate), pre-push delegates ' +
      'to the local, never-committed .git/hooks/pre-push identity guard that pointing core.hooksPath here ' +
      'would otherwise silence. check:guard-reach verifies each git-hook row\'s files exist and name the module',
    uncovered:
      'core.hooksPath itself is a per-clone git setting: a clone in which no Claude Code session has started ' +
      '(session-start-guards.mjs sets it) runs no commit gate, and nothing in the tree can observe that. ' +
      'CI does not commit, so it is unaffected; a human clone is the exposed case',
  },
  {
    area: 'result-ingestion check registry and its render',
    files: ['src/shared/submission/ingestionChecks.ts', 'scripts/shared/generate-ingestion-checks.mjs'],
    guardedBy: ['check:ingestion-checks', 'vitest-gate', 'ingestion-checks-drift-test'],
    note:
      'the declared check set both host-handoff twins cite on every refusal, plus its doc render; the ' +
      'render target docs/audit-pkg/contracts.md is claimed by the shipped-doc-surface row. The ' +
      'citation extractor recognises literal first arguments of refuse/invalidResult/bindingFailure and ' +
      'literal `check:` properties; a passthrough (`check: parsed.check`) is deliberately not a citation',
    uncovered:
      'a refusal whose check id is computed rather than literal is invisible to the extractor, so a draw ' +
      'could satisfy the type and still be uncited — the test then reads as a MISSING citation for that ' +
      'id, which is the loud direction, not a silent pass',
  },
  {
    area: 'installer-verb surface render',
    files: ['wrapper/installer-verb-help.mjs', 'scripts/shared/generate-cli-surface.mjs'],
    guardedBy: ['check:cli-surface', 'vitest-gate', 'installer-verb-help-test'],
    note:
      'the declaration (verbs + summaries) both bins read, plus its doc render; the render target ' +
      'docs/audit-pkg/product.md is claimed by the shipped-doc-surface row. The two consumers that ' +
      'CANNOT import it — remediate-code.mjs (literal argv comparisons) and src/remediate/index.ts ' +
      '(no allowJs) — are pinned verb-and-summary by installer-verb-help-test, which also spawns ' +
      '`audit-code --help` and matches the printed listing against the declaration',
    uncovered:
      'the summaries are pinned only where a copy exists TODAY — a NEW hand-restatement in a third ' +
      'file is claimed by no rule, since only src/remediate/index.ts and remediate-code.mjs are ' +
      "scanned; and `remediate-code --help` (commander, dist-side) is not spawned, only its source " +
      "table read. printHelp()'s non-installer command lines stay prose (check:cli-surface note)",
  },
  {
    area: 'shipped doc surface',
    files: ['docs/audit-pkg/*.md'],
    guardedBy: ['check:cli-surface', 'vitest-gate', 'shipped-doc-surface-test'],
    note:
      'package.json `files` decides which of these reach npm; tests/shared/shipped-doc-surface.test.ts ' +
      'pins the shipped set, pins README to name exactly it, refuses a relative link that leaves it, ' +
      'resolves every relative link fragment against the target page\'s headings, and binds every ' +
      'absolute github.com owner/repo in a shipped page to package.json `repository`',
    uncovered:
      'only the owner/repo segment of an absolute URL is checked — the PATH after it is never ' +
      'fetched, so a page moved on GitHub goes stale silently, and the same slug in non-markdown ' +
      'sources (scripts/audit/postinstall.mjs) is outside this rule. Anchor resolution covers ' +
      'RELATIVE links only: a fragment on an absolute repository URL is unchecked. The loader-pair ' +
      'single-statement rule is pinned by exact flag spelling only — the literal substring ' +
      '`--root <path>`, so a restatement worded any other way (`--root <dir>`, `the --root flag`, ' +
      'or prose that omits the flag) passes green',
  },
  {
    area: 'source',
    files: ['src/**'],
    guardedBy: [
      'build',
      'check:tests',
      'vitest-gate',
      'check:deadcode',
      'check:orphan-modules',
      'check:lint',
      'check:dup',
      'check:depgraph',
      'pre-commit-gate',
      'prompt-capability-test',
      'prompt-renders-its-contract-test',
      'conceptual-category-comment-drift-test',
      'check:invariant-glossary',
    ],
    uncovered:
      'the loop-core attestation half of pre-commit-gate covers only LOOP_CORE_PATTERNS prefixes ' +
      '(src/shared/loopCorePaths.ts), not every dispatch-adjacent CLI file; no gate refuses direct ' +
      'child_process.spawn that bypasses spawnLoggedCommand (durable-traps). Registry shape rules ' +
      'are not full field-set reconciliation; manual-validator consumers are declared-gap rows; ' +
      'render fixtures cover the rows that have them',
  },
  {
    area: 'launcher entrypoints + packaging manifest',
    files: [
      'package.json',
      'audit-code.mjs',
      'remediate-code.mjs',
      'scripts/shared/shipCoverage.mjs',
    ],
    guardedBy: ['shipped-import-closure-test', 'smoke:packaged-audit-code', 'smoke:packaged-remediate-code'],
    note:
      'the two root bins are the package launchers and package.json `files` is the manifest this pair ' +
      'of claims reads; shipCoverage.mjs is the shared walk substrate reached from the test named ' +
      'here (so a change to the walk itself re-runs the closure). The smokes execute the packaged ' +
      'bins end-to-end, which is the same property observed from outside the tree.',
  },
  {
    area: 'tests',
    files: ['tests/**'],
    guardedBy: ['check:tests', 'vitest-gate', 'check:lint', 'check:dup'],
    uncovered:
      'checkJs:false excludes the deliberate .mjs holdout(s) from the typecheck (the 563/564 floor), ' +
      'and check:lint likewise lints only tests/**/*.ts; ' +
      'the vi.spyOn barrel guard (INV-remediate-tests-12) scans only tests/remediate',
  },
  {
    area: 'markdown corpus',
    files: ['**/*.md'],
    guardedBy: ['check:doc-manifest', 'check:doc-links', 'check:doc-code-citations', 'check:memory-citations'],
    note:
      'the four whole-corpus doc gates (memory-citations scans every tracked *.md for memory-file ' +
      'cites); backlog, HANDOFF and README are additionally claimed by ' +
      'their own precise rows below',
  },
  {
    area: 'review-record routing',
    // The records themselves are already claimed by `**/*.md`; what this row
    // adds is the DECLARATION each one must carry and the baseline the ratchet
    // reads. A record with no declaration is what the gate exists to catch.
    files: ['docs/reviews/**', 'docs/reviews/.routing-baseline.json', 'scripts/review-routing-data.mjs'],
    guardedBy: ['check:review-routing', 'review-routing-gate-test'],
    uncovered:
      'the declaration is checked for EXISTENCE and for naming a live row — never for truth, ' +
      'because whether a prose analysis identified work is a semantic judgment; a baselined ' +
      'pre-mechanism record is announced in the pass line rather than silently exempt',
  },
  {
    area: 'hooks',
    files: ['.claude/hooks/**'],
    guardedBy: [
      'hook-trap-guards-test',
      'guard-form-reach-test',
      'hook-session-gates-test',
      'hook-async-typecheck-test',
      'write-time-derived-gates-test',
      'hook-friction-stop-test',
      'hook-session-start-guards-test',
      'session-registry-test',
      'session-start-hook-test',
      'doc-manifest-gate-test',
      'pre-commit-staged-snapshot-test',
      'pre-commit-commit-detection-test',
      'pre-commit-commit-creating-test',
      'pre-commit-attestation-test',
      'pre-commit-branch-strand-test',
      'pre-commit-child-session-test',
      'pre-commit-target-repo-test',
      'pre-commit-derived-legs-test',
      'loop-core-gate-parity-test',
      'check:loop-core-patterns',
      'check:guard-reach',
      'check:scripts',
    ],
    uncovered:
      'shell-split (the trap-guard split helper, home of bypassEnabled) has no dedicated test FILE of ' +
      'its own — its separator set and heredoc determinism are pinned inside hook-trap-guards-test, and ' +
      'the rest is exercised through pre-commit-child-session-test. What that leaves uncovered: ' +
      'stripQuoted/collapseQuoted/findLiveBackticks/findLiveExpansions/findQuotedSpans have no direct ' +
      'assertions, so a defect there is caught only when it changes a guard verdict. ' +
      '(question-philosophy-gate and closeout-challenge-gate are covered ' +
      'by hook-session-gates-test; attest-loop-core-review by the attestation and parity tests; ' +
      'nightly-surface by nightly-routine-test.)' +
      ' The P28 long-dispatch refusal in shell-trap-guard measures only the INLINE quoted prompt — a ' +
      'prompt delivered via a stdin file (`codex exec < prompt.txt`), `$(cat …)`, or a heredoc body ' +
      '(blanked before scanning) escapes measurement; scripts/shared/lane-dispatch.mjs is the primary fix. ' +
      '.claude/hooks/friction-stop-gate.mjs re-implements the friction-dir *.json listing by hand ' +
      '(readdirSync + .endsWith(".json")) because a pre-build hook cannot import built src — a ' +
      'hand-maintained duplicate of listFrictionRecordFilenames that drifts independently.' +
      ' hook-trap-guards-test pins tool-input-guard cases to a temp root (runInputGuard) so rule 3 ' +
      'cannot consume the live stale-main marker, and scans for REPO_ROOT source paths to keep the ' +
      'payloads inside that root — but BOTH halves are scoped to that ONE file. A future test file ' +
      'that spawns tool-input-guard.mjs against the real repository is not covered, and today ' +
      'nothing but hook-trap-guards-test references that hook, so the gap is latent rather than open.' +
      ' The repo-lane refusal in shell-trap-guard REFUSES a recognizable lane invocation at the ' +
      'dispatching tool call; it does NOT detect a delegated lane, which remains unsolved. Its ' +
      'uncovered halves: a lane launched from a shell no PreToolUse hook sees; a dispatch reaching ' +
      'git through a script rather than a tool call (scripts/release-and-publish.mjs); and a lane ' +
      'whose invocation LANE_CMD does not match (a new CLI, or an unusual flag spelling), which ' +
      'still self-registers as an owner exactly as before. Inside the lane process nothing ' +
      'distinguishes it from an owner, and the signals that appear to (a loopback ' +
      'ANTHROPIC_BASE_URL, a lane-specific CLAUDE_CONFIG_DIR) are the host execution facts 467b1e8f ' +
      'and 3bea76ee retired, so they are not available to this repo.',
  },
  {
    area: 'gate scripts (the guards themselves)',
    files: [
      'scripts/check-*.mjs',
      'scripts/doc-manifest-data.mjs',
      'scripts/guard-reach-data.mjs',
      'scripts/gate-enumeration-data.mjs',
      'scripts/shared/generate-*.mjs',
      'scripts/attest-constitutional-doc-change.mjs',
      'scripts/render-closeout.mjs',
      'scripts/closeout-sections-data.mjs',
    ],
    guardedBy: [
      'check:guard-reach',
      'doc-manifest-gate-test',
      'guard-reach-gate-test',
      'guard-form-reach-test',
      'check:lint',
      'check:dup',
      // Area-granular citations (existing precedent in this row): each gate
      // READS its own data module here — doc-manifest-data.mjs,
      // gate-enumeration-data.mjs, guard-reach-data.mjs respectively.
      'check:doc-manifest',
      'check:gate-enumeration',
      'check:ci-trigger-paths',
      // Parity over its own generator (scripts/shared/generate-runtime-artifact-names.mjs --check).
      'check:runtime-artifact-names',
      'check:scripts',
    ],
    uncovered:
      'check:scripts typechecks the script trees with noImplicitAny relaxed — implicit-any ' +
      'signatures pass by design, so the typed floor is narrower than src strict; ' +
      'attest-constitutional-doc-change is invoked per constitutional override, wired into no verify gate; ' +
      'render-closeout is invoked per hand-back, wired into no verify gate either — its enforcement is ' +
      'the closeout-challenge Stop gate reading the record it writes, so a session that never renders is ' +
      'challenged, not blocked. That record OWNS ITS SESSION by ID: the renderer reads ' +
      'CLAUDE_CODE_SESSION_ID (the name the environment actually supplies, whose value is the filename ' +
      'of the session record the registry resolves) and writes ONE FILE PER SESSION under the state ' +
      'dir; the gate reads the record for its own session id, so an earlier or CONCURRENT render does ' +
      'not satisfy it. A render made with no session id falls back to the legacy repo-global path and ' +
      'is accepted by nobody, which is the conservative direction. The worktree-tree comparison still ' +
      'applies on top, so a record written for this session against different content is caught too',
  },
  {
    area: 'pipeline, smoke & release scripts',
    files: [
      'scripts/audit/**',
      'scripts/remediate/**',
      'scripts/shared/**',
      'scripts/postinstall.mjs',
      'scripts/release-and-publish.mjs',
      'scripts/poll-log-throttle.mjs',
    ],
    guardedBy: [
      'pack:smoke',
      'smoke:packaged-audit-code',
      'smoke:packaged-remediate-code',
      'verify:hosts',
      'verify:remediate-hosts',
      'vitest-gate',
      'check:lint',
      'check:dup',
      // Executes scripts/shared/derived-file-preflight.mjs directly (P34).
      'precommit-leg-derivation-test',
      'lane-dispatch-driver-test',
      'check:scripts',
      // Reads the PINS graph declared beside it, and reconciles it against the
      // tracked tree.
      'check:pin-obligations',
    ],
    uncovered:
      'release-and-publish, update-languages, triage-backlog, rebaseline-flakes and ' +
      'poll-log-throttle run only at release/maintenance time — no build gate executes them ' +
      "(triage-backlog's sweep driver is shared lane-dispatch.mjs, gate-executed via " +
      "tests/shared/lane-dispatch.test.ts, and its llm-relay dispatch lane is mcp-dispatch-lane.mjs, " +
      'gate-executed against a fake MCP server via tests/shared/triage-lane-health.test.ts — the ' +
      "uncovered half is triage-backlog's task/record binding + CLI shell only). " +
      'derived-file-preflight refuses only when the worktree tree equals the staged ' +
      'tree before AND after its legs; three halves stay open, all stated in the open-bugs entry: ' +
      'the DIVERGENT case gets no verdict at all (the preflight abstains, so a genuine staged-tree ' +
      'failure reaches the gate at commit and costs one P19 double-attestation); even an ' +
      'attributable verdict is a PREDICTION, since gitignored state, $HOME and cwd can change ' +
      'between attest and commit; and per-leg attribution by declared REACH is permanently ' +
      "unavailable, because this reconciler verifies existence and wiring, not guard internals — a " +
      "row's reach may be narrower than its guard's true inputs, which is sound for a TRIGGER " +
      '(under-declaration means a leg does not fire) and unsound for ATTRIBUTION (under-declaration ' +
      'would stamp a refusal as proven)',
  },

  {
    area: 'nightly routine',
    files: ['scripts/nightly/**'],
    guardedBy: ['nightly-routine-test', 'nightly-scope-ledger-test', 'nightly-items-mandatory-fields-test', 'check:lint', 'check:dup', 'check:scripts'],
    note:
      'items.mjs, render-inbox.mjs, ingest-answers.mjs, answer.mjs and the nightly-surface hook are all ' +
      'exercised by tests/shared/nightly-routine.test.ts — subject-key identity, the settled/resolved ' +
      'partition, premise probing, the inbox round-trip (a ticked box becomes a ledger entry) and its ' +
      'refusals. The P32 answerability refusals in writeOpenItems (options[]/eli5), the subject_key ' +
      'derive-or-refuse, the title refusal, the bounded queue index and the in-write HANDOFF ' +
      'regeneration are pinned by tests/shared/nightly-items-mandatory-fields.test.ts. ' +
      'scope-ledger.mjs is covered by tests/shared/nightly-scope-ledger.test.ts — item ' +
      'identity, the refusal of an unanchored stamp, the never-examined window, and the coverage ' +
      'record, including the run-derived cold count. UNCOVERED HALF: nothing executes the routine ' +
      'end-to-end, so the ORDER of the legs, the ' +
      'decision to escalate-vs-apply, and whether a run actually CALLS `stamp` for the docs it claims ' +
      'to have examined all remain behavioural, guarded by docs/nightly-routine.md and the three-agent ' +
      'gate rather than by a test.',
  },
  {
    area: 'script argv refusal',
    files: ['scripts/**'],
    guardedBy: ['script-argv-refusal-test', 'check:scripts', 'check:lint'],
    note:
      'a script that reads process.argv and does not adopt scripts/shared/argvGuard.mjs must appear in ' +
      'ARGV_GUARD_GAP inside tests/shared/script-argv-refusal.test.ts — the ratchet fails on a new ' +
      'unguarded reader and on a stale gap entry. The behaviour is pinned end-to-end on the nightly ' +
      'CLIs whose default action writes durable state: a bogus flag exits non-zero naming it and ' +
      'creates no artifact, --help prints usage without writing. ⚠ UNCOVERED HALF, stated rather than ' +
      'implied per the durable-traps rule: 42 of the tracked scripts still read process.argv without ' +
      'the guard, and the list above is a DECLARED boundary, not a clean sweep — those scripts can ' +
      'still ignore an unrecognized flag. Migrating them is mechanical but reaches gate entry points ' +
      'such as run-vitest-gate.mjs and profile-run.mjs, which forward variadic arguments to another ' +
      'process; each needs its own spec, so it is its own change.',
  },
  {
    area: 'nightly inbox projection',
    files: [
      'docs/nightly-inbox.md',
      '.audit-tools/nightly/open-items.json',
      '.audit-tools/nightly/open-items-index.json',
      '.claude/nightly-decisions.json',
      'scripts/nightly/items.mjs',
      'scripts/nightly/render-inbox.mjs',
    ],
    guardedBy: ['check:nightly-inbox'],
    note:
      'render-inbox --check projects the tracked queue through the decisions ledger and byte-compares ' +
      'ALL THREE derived artifacts — the markdown inbox, the queue snapshot, and the bounded ' +
      'open-items-index — so none of them can assert open what the ledger records settled. The index ' +
      'is a pure projection (no timestamp) precisely so two writers can emit identical bytes.',
  },
  {
    area: 'rendered host assets',
    files: ['skills/**', '.github/prompts/**', '.github/agents/**', '.gemini/**', '.agent/**', 'opencode.json'],
    guardedBy: ['verify:hosts', 'verify:remediate-hosts', 'check:loader-fragments'],
    note:
      'rendered per-IDE from universal sources; renderer drift is what the two gates pin. The ' +
      'canonical loader SOURCES under skills/** are additionally reconciled for loader-pair ' +
      'instruction duplication by check:loader-fragments, which the IDE renders inherit (they ' +
      'embed the canonical body verbatim)',
  },
  {
    area: 'CI workflow trigger paths',
    files: ['.github/workflows/ci.yml'],
    guardedBy: ['check:ci-trigger-paths', 'ci-trigger-paths-test'],
    note:
      "ci.yml's two paths: blocks are GENERATED from this registry (non-declared-gap rows + the " +
      'always-trigger base) and reconciled by the gate; the rest of the yml is still unparsed locally',
  },
  {
    area: 'CI workflows',
    files: ['.github/workflows/**'],
    guardedBy: 'declared-gap',
    note:
      'CI definitions — validated by GitHub at push; latest-run OUTCOMES are surfaced by the closeout ' +
      'gate via scripts/shared/ciRedWorkflows.mjs, but no local gate parses the yml beyond ci.yml\'s ' +
      'generated paths blocks (row above). audit-code-test-suite.yml carries its OWN hand-written ' +
      'duplicated paths block — a known un-generated sibling (the P26 decision scoped generation to ' +
      'ci.yml only)',
  },
  {
    area: 'worker dispatch assets',
    files: ['dispatch/**'],
    guardedBy: ['vitest-gate', 'smoke:packaged-audit-code', 'check:scripts'],
    note: 'validate/merge exercised by tests/audit/dispatch-validate.test.ts and the packaged smoke',
  },
  {
    area: 'schemas',
    files: ['schemas/**'],
    guardedBy: ['vitest-gate'],
    note: 'generated by scripts/audit/generate-schemas.mjs; consumed by result validation and its tests',
  },
  {
    area: 'bins & wrapper',
    files: ['audit-code.mjs', 'remediate-code.mjs', 'wrapper/**'],
    guardedBy: [
      'smoke:packaged-audit-code',
      'smoke:packaged-remediate-code',
      'smoke:linked-audit-code',
      'smoke:linked-remediate-code',
      'vitest-gate',
      'check:lint',
      'check:scripts',
    ],
  },
  {
    area: 'toolchain config',
    files: [
      'package.json',
      'tsconfig.json',
      'tsconfig.base.json',
      'tsconfig.test.json',
      'tsconfig.scripts.json',
      'vitest.config.ts',
      'knip.json',
      'eslint.config.js',
      '.jscpd.json',
      '.dependency-cruiser.cjs',
    ],
    guardedBy: [
      'build',
      'check:tests',
      'vitest-gate',
      'check:deadcode',
      'check:guard-reach',
      'check:lint',
      'check:dup',
      'check:depgraph',
    ],
    note:
      'each config is loaded by the gate it configures — malformed fails that gate loudly; the scripts ' +
      'wiring in package.json is what check:guard-reach reconciles',
  },
  {
    area: 'agent settings',
    files: ['.claude/settings.json'],
    guardedBy: ['check:guard-reach'],
    note: 'hook registrations reconciled against tracked hook files and this registry',
  },
  {
    area: 'generated AGENTS.md region (untracked generator)',
    files: ['AGENTS.md', 'CLAUDE.md'],
    guardedBy: ['check:agents-region', 'agents-region-gate-test'],
    note:
      'the pointer-mode size sentence in AGENTS.md is the one region body input derived from ' +
      'CLAUDE.md, so comparing the two IS the freshness check; the generator that writes the region ' +
      'is machine-wide and untracked, which is why no GENERATED row can claim it',
    uncovered:
      'only the size sentence. The shared-region-id hash beside it, and the audit-code / ' +
      'remediate-code blocks above the region, are outside the scan (P64 scope)',
  },
  {
    area: 'owner skills',
    files: ['.claude/skills/**'],
    guardedBy: ['check:doc-manifest', 'check:doc-links', 'check:doc-code-citations'],
    note: 'markdown skills for the owner-side workflow; routed like any tracked doc',
  },
  // ── precise per-gate rows (P34): each names exactly what its gate READS, so
  // the derived pre-commit triggers reproduce the retired hand-coded ones
  // rather than silently narrowing them. Overlap with the markdown-corpus row
  // is expected — a file may be claimed by several rows.
  {
    area: 'backlog entry files',
    files: ['docs/backlog/*.md'],
    guardedBy: [
      'check:backlog-index',
      'check:backlog-budget',
      'check:backlog-status',
      'check:backlog-line-numbers',
      'check:backlog-friction-tags',
      'check:handoff-roadmap',
      // Reads exactly ONE of these files today (docs/backlog/durable-traps.md — SCANNED_DOCS
      // in the gate); cited here because that is the glob its scan target lives under.
      'check:retired-infrastructure',
    ],
    note:
      'the gates that actually read the split backlog files (seek-index parity, size budget, ' +
      'status-label ban, line-number-citation ban, friction-category vocabulary, roadmap title ' +
      'lift, retired-infrastructure mentions); the markdown-corpus row carries the generic doc ' +
      'gates. Four of them (doc-code-' +
      'citations, budget, line-numbers, memory-citations) additionally carry writeTime metadata, ' +
      'so the PostToolUse hook runs them against the file the moment it is edited — the budget leg ' +
      'reported there and DEFERRED to commit, because its remedy rewrites lap-scoped baseline state',
  },
  {
    area: 'backlog seek index',
    files: ['docs/backlog.md'],
    guardedBy: ['check:backlog-index'],
    note:
      'the GENERATED router/index file — only the index-parity gate reads it (the budget, status and ' +
      'roadmap gates read the split entry files above, deliberately: firing the roadmap check on the ' +
      'generated index would train the regenerate step into noise)',
  },
  {
    area: 'philosophy pair',
    files: ['docs/project-philosophy.md', 'README.md'],
    guardedBy: ['check:philosophy-brief'],
    note: 'the gate reads ONLY these two — the README Philosophy block is generated from the brief',
  },
  {
    area: 'proposal-test RED-AT records',
    files: ['.audit-tools/nightly/proposals/**'],
    guardedBy: ['check:proposal-red-at'],
    note:
      'the gate scans the tracked proposals tree: a proposal dir shipping a *.test.ts/*.test.mjs ' +
      'must carry a non-empty sibling RED-AT.txt (measured red, or a declared not-runnable line). ' +
      'Uncovered half: the record body is free-form — the gate enforces existence and non-emptiness, ' +
      'not that the recorded run was real or fresh',
  },
  {
    area: 'README sample-report render',
    files: [
      'README.md',
      'src/audit/cli/sampleRunCommand.ts',
      'src/audit/reporting/synthesis.ts',
      'src/shared/reporting/findingDisplay.ts',
    ],
    guardedBy: ['check:readme-sample-report'],
    note:
      'the gate renders the sample bundle through the real renderer and diffs the README block — ' +
      'a renderer heading/bullet change reds it instead of silently drifting the README sample',
  },
  {
    area: 'gate-enumeration render target',
    files: ['.claude/skills/ship/SKILL.md'],
    guardedBy: ['check:gate-enumeration'],
    note: 'the one rendered enumeration block (ENUMERATION_TARGETS); step membership/order come from package.json',
  },
  {
    area: 'HANDOFF',
    files: ['docs/HANDOFF.md'],
    guardedBy: ['check:handoff-roadmap'],
    note:
      'generated-block parity PLUS hand-written-region creep heuristics AND the empty-queue ' +
      'projection contract (`hasHandwrittenNightlyClaim`) over the handoff itself — the projection ' +
      'case used to be reachable ONLY from the full suite (`tests/shared/handoff-roadmap.test.ts`, ' +
      "describe 'the live tree'), which is how a hand-written live-state edit using the banned word " +
      'landed through a green pre-commit gate and burned tag v0.50.0. It now runs in this leg, ' +
      'which fires on any HANDOFF edit; its queue/ledger sources have their own rows below. The ' +
      'hand-written region additionally carries the `## Immediate next` length bound ' +
      '(`findImmediateNextOverrun`), whose uncovered half is stated on the gate row above',
  },
  {
    area: 'relative-link lift',
    files: ['scripts/shared/rebase-relative-links.mjs'],
    guardedBy: ['check:handoff-roadmap', 'check:backlog-index'],
    note:
      'both generators IMPORT the lift, so the two parity gates execute it — a lift edit stales the ' +
      'generated docs and the parity legs catch it (the retired hand trigger ran check:doc-links here, ' +
      'which scans only markdown and could never see a lift-only change)',
  },
  {
    area: 'backlog size ratchet baseline',
    files: ['docs/backlog/.size-baseline.json'],
    guardedBy: ['check:backlog-budget'],
    note: 'the per-file ratchet data the budget gate compares against',
  },
  {
    area: 'invariant namespace glossary',
    files: ['docs/glossary-ids.md', 'scripts/check-invariant-glossary.mjs'],
    guardedBy: ['check:invariant-glossary'],
    note:
      'the gate scans tracked src/**/*.ts and reconciles every uppercase nonnumeric INV-* namespace ' +
      'against the glossary table; numeric and lowercase file-local families stay out of scope',
  },
  {
    area: 'green-mechanism declaration',
    files: ['.claude/green-mechanism.json', 'scripts/shared/suite-green-status.mjs'],
    guardedBy: ['green-mechanism-declaration-test'],
    note:
      'the declaration names the repository-owned status command and the machine-wide ' +
      '~/.agent-config/verify-green.mjs executes that command for check while still refusing its ' +
      'own record path, so no second green ledger can exist beside suiteGreenStamp.mjs. The ' +
      'contract test pins both declaration shape and declared-command execution; the external ' +
      'consumer itself remains outside this repository.',
  },
  {
    area: 'nightly determinations ledger',
    files: ['.claude/nightly-decisions.json'],
    guardedBy: [
      'check:handoff-roadmap',
      'pre-commit-gate',
      'closeout-challenge-gate',
    ],
    note:
      'read/written by scripts/nightly/answer.mjs and surfaced by the nightly-surface hook; HANDOFF ' +
      'parity now reads it in verify:checks, at commit when the ledger changes, and at closeout. ' +
      'UNCOVERED HALF: canonical readDecisions remains fail-soft, so parity guards the rendered view ' +
      'but does not schema-validate a malformed ledger.',
  },
  {
    area: 'nightly open queue projection',
    files: ['.audit-tools/nightly/open-items.json'],
    guardedBy: [
      'check:handoff-roadmap',
      'pre-commit-gate',
      'closeout-challenge-gate',
    ],
    note:
      'authoritative persisted queue; strictly read by the generated HANDOFF parity check, with queue ' +
      'and decision edits triggering the same check before commit; current premise-probe source paths ' +
      'are derived from the queue, and positive probe needles use staged git-pickaxe reach so moved ' +
      'copies can trigger parity too',
  },
  {
    area: 'promoted deliverables',
    files: [
      '.audit-tools/audit-findings.json',
      '.audit-tools/audit-report.md',
      '.audit-tools/remediation-outcomes.json',
      '.audit-tools/remediation-report.md',
      '.audit-tools/nightly/proposals/**',
    ],
    guardedBy: 'declared-gap',
    note: 'run outputs promoted for reference (tracked deliberately); products, not sources',
  },
  {
    area: 'operator examples',
    files: ['examples/**'],
    guardedBy: 'declared-gap',
    note:
      'operator templates and catalog samples for off-repo declarations (~/.audit-code); read by no ' +
      'gate — the same untested-territory fact recorded for sources-declared.json',
  },
  {
    area: 'repo meta',
    files: ['LICENSE', '.gitignore', '.gitattributes', '.audit-tools-visibility', 'package-lock.json'],
    guardedBy: 'declared-gap',
    note:
      'inert by content or npm-owned; the .gitignore hook-whitelist half is enforced by the pre-commit ' +
      'gate (a settings.json referencing a hook the commit does not carry is refused)',
  },
];

/**
 * One row per tracked generator, naming exactly one freshness authority.
 * `onDemand` is a deliberate, reviewable exception — never an omitted gate.
 * @typedef {object} GeneratedRow
 * @property {string} generator
 * @property {'check'|'contractTest'} [authority]
 * @property {string} [npmScript]
 * @property {'flag'|'default'} [checkMode] check authority only; omitted means
 *   the npm command must pass --check, while default means its no-flag mode is
 *   the read-only freshness check and --write is the explicit mutation arm.
 * @property {string} [contractTest]
 * @property {boolean} [onDemand]
 * @property {string} [reason]
 * @property {string[]} [artifacts]
 * @property {string} [note]
 */

/** @type {GeneratedRow[]} */
export const GENERATED = [
  {
    generator: 'scripts/check-doc-manifest.mjs',
    authority: 'check',
    npmScript: 'check:doc-manifest',
    checkMode: 'default',
  },
  {
    generator: 'scripts/check-gate-enumeration.mjs',
    authority: 'check',
    npmScript: 'check:gate-enumeration',
    checkMode: 'default',
  },
  {
    generator: 'scripts/check-philosophy-brief.mjs',
    authority: 'check',
    npmScript: 'check:philosophy-brief',
    checkMode: 'default',
  },
  {
    generator: 'scripts/check-readme-sample-report.mjs',
    authority: 'check',
    npmScript: 'check:readme-sample-report',
    checkMode: 'default',
  },
  {
    generator: 'scripts/render-closeout.mjs',
    authority: 'contractTest',
    contractTest: 'tests/shared/closeout-render.test.ts',
    note:
      'This renderer writes tree-bound runtime state rather than a tracked artifact, so freshness ' +
      'is not meaningful; its rendering and refusal contract is pinned by the named test.',
  },
  { generator: 'scripts/shared/generate-backlog-index.mjs', authority: 'check', npmScript: 'check:backlog-index' },
  { generator: 'scripts/shared/generate-ci-trigger-paths.mjs', authority: 'check', npmScript: 'check:ci-trigger-paths' },
  { generator: 'scripts/shared/generate-cli-surface.mjs', authority: 'check', npmScript: 'check:cli-surface' },
  { generator: 'scripts/shared/generate-constitutional-doc-paths.mjs', authority: 'check', npmScript: 'check:constitutional-doc-paths' },
  { generator: 'scripts/shared/generate-executor-producers.mjs', authority: 'check', npmScript: 'check:executor-producers' },
  { generator: 'scripts/shared/generate-friction-categories.mjs', authority: 'check', npmScript: 'check:friction-categories' },
  { generator: 'scripts/shared/generate-handoff-roadmap.mjs', authority: 'check', npmScript: 'check:handoff-roadmap' },
  { generator: 'scripts/shared/generate-ingestion-checks.mjs', authority: 'check', npmScript: 'check:ingestion-checks' },
  { generator: 'scripts/shared/generate-loop-core-patterns.mjs', authority: 'check', npmScript: 'check:loop-core-patterns' },
  { generator: 'scripts/shared/generate-runtime-artifact-names.mjs', authority: 'check', npmScript: 'check:runtime-artifact-names' },
  { generator: 'scripts/shared/generate-spec-mirrors.mjs', authority: 'check', npmScript: 'check:spec-mirrors' },
  {
    generator: 'scripts/nightly/render-inbox.mjs',
    authority: 'check',
    npmScript: 'check:nightly-inbox',
    artifacts: ['docs/nightly-inbox.md', '.audit-tools/nightly/open-items.json'],
  },
  {
    generator: 'scripts/shared/generate-filelock-export-surface.mjs',
    authority: 'contractTest',
    contractTest: 'tests/shared/filelock-export-surface.test.ts',
    artifacts: ['scripts/shared/filelock-export-surface.generated.json'],
    note: 'No --check arm by design; the contract test re-renders and byte-compares the surface.',
  },
  {
    generator: 'scripts/audit/generate-schemas.mjs',
    authority: 'contractTest',
    contractTest: 'tests/audit/worker-schema-generation.test.ts',
  },
  {
    generator: 'scripts/remediate/generate-auditor-contract-fixture.mjs',
    authority: 'contractTest',
    contractTest: 'tests/remediate/fixture-generator-drift-guard.test.ts',
  },
  {
    generator: 'scripts/shared/generate-vitest-shard-baseline.mjs',
    onDemand: true,
    reason:
      'The shard baseline is a measurement of this machine under current load, not a deterministic ' +
      'render of tracked source. A parity check would manufacture cross-machine timing failures; ' +
      'rewrite it deliberately with `npm run generate:shard-baseline` when suite shape changes.',
  },
];
