# P16 — `<tool> <installer-verb> --help` runs the side-effectful verb instead of printing help

**Leg 3 (recurring-problem solutions). Proposal only — nothing was applied.**
**Recurrence: the third date for one defect class, and the first time it is in the SHIPPED
product rather than a repo script.**

## The recurrence

This is the class P14 named on 2026-08-08: *a command that takes its arguments positionally, or
checks flags too narrowly, treats `--help` as data and does the work instead of printing help.*
It has now been fixed twice and found a third time, one layer up.

| Date | Site | Fix |
|---|---|---|
| 2026-07-30 | `scripts/check-gate-enumeration.mjs` | `6b8f8d7a` — positional guarded with `!startsWith('--')` |
| 2026-08-08 | `scripts/shared/triage-backlog.mjs` | `af37bbad` (nightly P14) — `IS_CLI`-bound `-h`/`--help` + unknown-flag refusal |
| 2026-08-09 | **`audit-code.mjs` and `remediate-code.mjs` — the two shipped bins** | open |

Both previous fixes were single-site. `CLAUDE.md`'s own rule and
[[fix-the-defect-class-not-the-named-instance]] both say the class is the unit of repair; a third
instance, in the product this time, is the evidence that the site-by-site approach is not closing
it.

## What is wrong, verified at HEAD

### remediate-code — the installer verbs are routed before anything else

`remediate-code.mjs:129-138`:

```js
const verb = argv[0];
if (verb === "install" || verb === "ensure" || verb === "verify-install" || verb === "install-host") {
  const installer = await import(INSTALLER_MODULE);
  if (verb === "install") await installer.installBootstrap(argv.slice(1));
  ...
  return;
}
```

There is no help handling before this branch and none inside `installBootstrap` — the installer
reads flags with `hasFlag`/`getFlag` (`wrapper/remediate-code-wrapper-install-hosts.mjs:40-51`),
neither of which knows `--help`. Observed this run:

```
$ node remediate-code.mjs install --help
EXIT=0
{ "host": "all", "repo_root": "C:\\Code\\audit-tools",
  "installed_prompt_path": "...\\.remediate-code\\install\\remediate-code.import.md", ... }
```

The install ran. It wrote four files. A reader asking what a command does got the command.

### audit-code — the help check is real but positionally too narrow

`wrapper/audit-code-wrapper-lib.mjs:281` short-circuits on `--help`, but through
`hasLeadingFlag` (`:39-45`), which stops at the first token that does not start with `-`:

```js
function hasLeadingFlag(argv, name) {
  for (const token of argv) {
    if (token === name) return true;
    if (!token.startsWith('-')) return false;   // `install` — bail out
  }
  return false;
}
```

So `audit-code --help` prints help and `audit-code install --help` does not. Confirmed this run
with the non-destructive verb:

```
$ node audit-code.mjs verify-install --help
EXIT=0
{ "root": "C:\\Code\\audit-tools", "requested_host": "all", "status": "ok", ... }
```

`hasLeadingFlag` is not a bug in itself — it exists so `--help` appearing as a *value*
(`--host --help`) is not mistaken for the flag. The gap is that no per-verb help exists to take
over once the leading position is spent.

### remediate-code additionally has a help page that is wrong in two directions

`remediate-code --help` is commander's page, and the wrapper intercepts the installer verbs
before commander is ever constructed. So:

- **Three of the four are invisible.** `install`, `verify-install` and `install-host` appear
  nowhere in the ten listed commands — yet `skills/remediate-code/SKILL.md:71` documents
  `remediate-code install` as the explicit installer path. The doc is correct and the command
  works; the CLI's own help denies it exists.
- **The fourth is listed but SHADOWED — two different implementations, one description.**
  `src/remediate/index.ts:362-369` registers `ensure` with the description *"Repair/check global
  /remediate-code host assets"*, and its action calls **`ensureGlobalAssets`**. That action is
  unreachable through the bin: `remediate-code.mjs:130` catches `ensure` first and calls
  **`installer.ensureBootstrap`** from `wrapper/remediate-code-wrapper-install-hosts.mjs:1115`,
  returning before dist is ever spawned. Confirmed both ways — the entry appears in
  `node dist/remediate/index.js --help` and the wrapper never reaches it. So an operator reads
  one implementation's description and runs a different implementation's code. That is worse
  than an omission, and it is the more valuable half of this finding: the shadow is invisible to
  every reader *and* to `check:deadcode`, which sees a registered commander action as a live
  consumer and cannot know the wrapper intercepts it — the same blind spot
  [[orphan-modules-are-invisible-to-both-knip-modes]] describes.
  ⚠ Whether `ensureGlobalAssets` has any OTHER live caller was not checked; establish that
  before deleting rather than assuming the shadow is its only one.

`audit-code` has neither half — its `printHelp` lists the installer verbs explicitly, and its
wrapper is the only implementation of them.

## Why this is worse than the two script instances

The two fixed sites were repo-internal scripts run by an agent that could read the source. These
are the **published bins**, and the affected verbs are the ones an operator reaches for first,
before they know anything about the tool. Two of the four (`install`, `ensure`) write host assets
into the user's repo and home directory. "Ask the tool what this does" is the single most likely
first command, and it performs the installation instead of describing it.

It also lands squarely on the project's own conventions: *conversation-first* says normal usage
needs no manual flags, and *auditor-agnostic robustness* says a workflow must not depend on the
host knowing something. A CLI whose help omits four commands and whose `--help` executes them is
the same latent failure mode one layer out.

## The mechanism

Fix the CLASS at the one place both bins already share — argument handling in the wrapper layer —
rather than adding a third bespoke guard.

1. **Hoist the informational check above verb routing, in both wrappers.** `--help` / `-h` /
   `--version` / `-v` anywhere in `argv` **before the first non-flag token OR immediately after a
   known verb** short-circuits. Concretely: keep `hasLeadingFlag` for the bare form and add a
   `wantsVerbHelp(argv, verbs)` that fires when `argv[0]` is a known verb and `--help`/`-h`
   appears anywhere in the remainder that is not consumed as a flag VALUE.
2. **Give each installer verb a one-paragraph help body.** `printHelp` in
   `audit-code-wrapper-lib.mjs` already holds the text for all four; `wantsVerbHelp` selects the
   matching section instead of printing the whole page. remediate-code has no equivalent — it
   gets the same four sections, sourced from the same place so they cannot drift.
3. **Resolve the shadowed `ensure` and register the other three.** Delete commander's
   unreachable `ensure` action in `src/remediate/` (nothing can reach it through the bin), and
   register all four verbs as `.command(...).description(...)` stubs whose action throws — purely
   so they appear in `--help` with the description of the implementation that actually runs. A
   stub that can never run is the cheap fix; the alternative — moving the installer inside
   commander — pulls the lazy-import boundary the wrapper comment at `remediate-code.mjs:12-16`
   deliberately keeps.
   ⚠ Check `src/audit/` for the same shadow before assuming it is remediate-only; this proposal
   verified the audit *wrapper* lists the verbs, not that no second implementation exists behind
   it.
4. **Refuse an unrecognized flag** on the installer verbs, the second half of the P14 fix, so
   `install --hsot copilot` fails loudly rather than installing to the default host.

### Contract test — the class, not the instances

The durable half is a single test that enumerates **every verb of both bins** and asserts, for
each, that `<verb> --help` exits 0, prints text containing the verb name, and **produces no
filesystem writes** (run against a temp `--root`, asserting the directory is still empty). Written
that way it covers a verb added later, which is the property the two site-by-site fixes did not
have.

This should live beside the existing wrapper contract tests under `tests/audit/` and
`tests/remediate/` (not `.claude/**`, which vitest excludes).

## Not written as a patch, and why

P15 in this run ships a full patch because a hook rule is ~40 lines with a mechanical property.
This one is a CLI surface change across two wrappers, one installer module, commander wiring and
a new contract test, and step 1 has a real design choice inside it — where exactly the
"informational flag" boundary sits once a verb can also take `--host --help` as a flag value.
Writing that as a nightly patch would be authoring product design unattended, which is outside
leg 3's bound. The evidence, the class, and the shape are here; the cut is the owner's.

## The backlog entry this replaces

None — this defect is not in `docs/backlog/`. If the owner declines the fix, the honest outcome
is an entry in `docs/backlog/open-bugs.md` stating the invariant (*an informational flag never
performs work; every verb of a shipped bin answers `--help`*), not a note that it was looked at.
⚠ `open-bugs.md` is at 129,560 bytes against a 120,000 ceiling and the budget gate accepts only
shrinkage, so adding it requires an offsetting condensation in the same edit.
