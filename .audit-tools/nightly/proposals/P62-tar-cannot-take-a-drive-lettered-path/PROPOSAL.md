# P62 — `tar` reads a Windows drive letter as a hostname, so the full suite cannot go green on this machine

**Scope: REPO.** The defect is `createIsolatedSnapshot` in
`scripts/shared/dispatch-load-flake-investigation.mjs`. The work item belongs in
`docs/backlog/open-bugs.md`.

**This is not a proposition about a hypothetical. The suite is RED right now.**
The 2026-09-09 nightly ran `npm test` on HEAD `23079f37` and got exit 1 with
exactly one failure, and the vitest gate re-ran that file alone and it failed
alone — so it is a regression candidate, not a flake. Evidence and the full
environment measurement are in `RED-AT.txt`.

## The mechanism

`createIsolatedSnapshot` extracts a `git archive` tarball into a temporary
directory:

```js
const unpacked = spawnSync("tar", ["-xf", archive, "-C", snapshot], { … });
```

`archive` is an absolute path, so on Windows it begins `C:\`. GNU tar parses a
leading `host:` as a REMOTE MACHINE, so it never opens the file:

```
tar: Cannot connect to C: resolve failed
```

The executable is a bare `tar`, resolved through PATH. On this machine PATH
yields Git Bash's GNU tar 1.35 first, ahead of `C:\Windows\System32\tar.exe`
(bsdtar), which handles drive letters correctly. The call therefore reaches the
one tar on the box that cannot do the job.

## Why it shipped

On Linux the archive path has no drive letter, so GNU tar treats it as an
ordinary path and the test passes. CI is Linux, so CI is green. The defect is
reachable only on win32 — which is the exact class this repository's conventions
name: *no platform-baked path, shell, or command assumptions in core logic*, and
*package-manager shims resolve reliably through `resolveExecArgv`*.

## What it costs today

More than one test. The full-suite green stamp
(`scripts/shared/suiteGreenStamp.mjs`) is minted only by a clean `npm test`, and
`scripts/render-closeout.mjs` refuses to render a hand-back whose green does not
bind to the tree being handed off. So while this is red, **no closeout can be
rendered on this machine at all** — including this nightly's own. A single
Windows-only defect has made the repository's whole local hand-back path
unreachable, which is a much larger blast radius than one failing assertion
suggests.

## Proposed fix

Name a tar that accepts a drive-lettered path rather than taking whatever PATH
yields:

```js
const tarExe =
  process.platform === "win32"
    ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
    : "tar";
const unpacked = spawnSync(tarExe, ["-xf", archive, "-C", snapshot], { … });
```

That is the form proven green in `RED-AT.txt`. It is a no-op off win32.

**A second form, and this is the owner's choice.** GNU tar's own answer is
`--force-local`, which tells it to treat the argument as a local file even when
it contains a colon. That keeps one code path for every platform and does not
hard-code a system path — but it is a GNU-only flag, so it would break bsdtar if
bsdtar were ever the one resolved. The two forms fail in opposite directions,
which is why this is asked rather than assumed.

A third option is worth naming because this repository already owns machinery for
it: route the spawn through `resolveExecArgv`, the existing abstraction for
exactly this "the right executable on this platform" question, and let one place
answer it for every caller. That is the largest change and the only one that
stops the next such call site repeating the defect.

## False-positive surface

Minimal for the first form: it changes only which executable is named, not what
counts as success, and off win32 the value is the same bare `tar` as today. The
residual risk is a Windows installation with no `System32\tar.exe`, which is
Windows 10 1803 and older; a fallback to the bare name would cover it and would
degrade to today's behaviour rather than to something worse.

## Relationship to P58

Same family, one layer apart, and worth reading together. P58 is a child process
that cannot be LAUNCHED on Windows because a bare name resolves to an npm `.cmd`
shim. P62 is a child process that launches fine and then cannot READ its argument
because a bare name resolved to the wrong tar. Both are "the argv was assembled
without asking what platform it runs on", both were invisible until measured on
Windows, and both present a machinery defect in the vocabulary of a real result —
a dead lane, a failing test.

That the 2026-09-09 nightly found two of these independently, in one night, is
itself the recurrence signal for the third option above.
