# P54 — a guard's REFUSAL TEXT is declared data per rule, and a printed remedy is driven back through the recognizer

**Leg 3 (recurring-problem solutions). Proposal only — nothing was landed.**
**Scope: OPEN — see *The form is the question*.** Nightly 2026-09-06, HEAD `97f3033a`.

## The trap

A guard refuses, and prints what to do instead. The refusal text is a
hand-written string literal beside the rule. Nothing checks that the remedy
works, that it is the remedy for the rule that actually fired, or that the
guard's own recognizer would admit it. So a guard can refuse a command and, in
the same breath, hand the caller a command it will refuse again — or a command
belonging to a different rule entirely.

The failure mode is worse than a missing remedy. A stated escape that does not
work trains the reader that the guard is broken, and the next step from there is
to stop believing its other refusals. The repo's own memory says exactly this:
*"a guard whose stated escape does not work is worse than one documenting no
escape."*

## Recurrence — 5 records across 4 distinct dates

| # | Record | Date | The defect |
|---|---|---|---|
| 1 | memory `a-guards-escape-must-work-as-stated.md` | 2026-07-26 | all three `shell-trap-guard.mjs` bypasses read `process.env` — the **hook's** environment. The advertised `re-run with AUDIT_TOOLS_ALLOW_X=1` inline prefix set the variable on a child the guard never sees, so the refusal simply repeated |
| 2 | proposal `P27-guard-remedy-prescribes-the-trap` | 2026-08-13 | the masked-suite-exit denial's own remedy (`npm test > run.log 2>&1; echo "EXIT=$?"`) is itself exit-masking when backgrounded — the guard teaching the trap it exists to prevent |
| 3 | `docs/backlog/open-bugs.md:39` | 2026-09-04 | `bypassEnabled` accepts the escape only at string start, after `;`/`&`/`\|`, or after `export`. A **newline is not in the set**, while the same module's `splitShellStatements` splits on newlines — so a later statement is checked while its advertised escape is silently ignored |
| 4 | `docs/backlog/open-bugs.md:205` | 2026-08-27 | the PowerShell here-string rule admitted two `git commit -m @'…'@` calls and refused a third, near-identical, in one session. The remedy was correct; the *reach* was not deterministic over the input |
| 5 | `C:\Code\docs\backlog.md:35` | 2026-09-05 | `shell-conventions-guard.mjs` refused a heredoc that writes a FILE with the **commit-message** rule's text and its `git commit -F` remedy — the printed remedy unusable for the command actually blocked |

Five records, four distinct dates (2026-07-26, 2026-08-13, 2026-08-27,
2026-09-04, 2026-09-05 — five dates, in fact; the prior lane's "four" undercounts
by one, since records 4 and 5 fall on different days).

## Verification at HEAD — record 3 is LIVE, and record 5 REPRODUCES

Both of the load-bearing claims were run, not read.

**Record 3 — live at HEAD.** `.claude/hooks/shell-split.mjs:211` anchors on
`(?:^|[;&|]\s*|\bexport\s+)` with no `m` flag, so `^` is string start only.
Driving the real module:

```
newline sep    | bypassEnabled= false | stmts= ["echo hi","AUDIT_TOOLS_ALLOW_BACKTICKS=1 npm run x"]
semicolon sep  | bypassEnabled= true  | stmts= ["echo hi","AUDIT_TOOLS_ALLOW_BACKTICKS=1 npm run x"]
leading        | bypassEnabled= true  | stmts= ["AUDIT_TOOLS_ALLOW_BACKTICKS=1 npm run x"]
&& sep         | bypassEnabled= true  | stmts= ["echo hi","AUDIT_TOOLS_ALLOW_BACKTICKS=1 npm run x"]
```

Identical statement lists, opposite verdicts, decided only by the separator. The
defect is exactly as the entry describes, at HEAD, and the entry is correctly
OPEN. (Note `[;&|]\s*` does swallow a newline *after* a `;`, so
`foo;\nBYPASS=1 …` works — it is the bare-newline separator that fails. That
narrowness is why it survived.)

**Record 5 — REPRODUCED, and the prior lane's caveat is overturned.** The prior
lane flagged this record unverifiable at HEAD because rule 1 of
`~/.claude/hooks/shell-conventions-guard.mjs` is gated behind
`const isGitCommit = /\bgit\s+commit\b/.test(command)`, and the blocked command
contained no `git commit`. That reasoning has a hole: **`isGitCommit` tests the
ENTIRE command text, heredoc BODY included.** A heredoc that edits
`C:\Code\docs\backlog.md` writes prose about gates, and prose about gates
contains the words *git commit*. Rule 1's gate is then satisfied by the payload,
`hasHeredoc` is true, and the commit-message refusal fires on a command that
commits nothing.

This was reproduced first-hand this run, without instrumentation: an ordinary
Bash call in this session — a heredoc writing a JSON probe file whose body
mentioned `git commit` — was refused with

```
BLOCKED: multi-line commit message via heredoc/here-string/inline -m.
These leak shell syntax into commit subjects on Windows.
Do this instead:
  1) Write the message to a file with the Write tool.
  2) Run: git commit -F <that file>
```

Rule 2 (`writing file content through a heredoc/here-string`) exists three lines
below with its own correct message, and it is the rule whose *verdict* is
defensible. The caller is handed rule 1's remedy for rule 2's refusal. **The
record is accurate and the mechanism is now established**, which the entry itself
said was missing. Machine-wide file — the correction belongs in
`C:\Code\docs\backlog.md`, and leg 3 does not edit it.

## Why the existing mechanism does not catch it

P51 landed the right instinct one field short. `scripts/guard-reach-data.mjs`
now carries `forms: [{ name, sample, drive, … }]` on **18 rows** (verified by
count at HEAD), and `tests/shared/guard-form-reach.test.ts` drives each declared
sample through the **real recognizer** — four drivers (`script`, `export`,
`hook`, `test`) chosen per form.

So the repo can already state, and mechanically check, *what a guard recognizes*.
It cannot state *what a guard says when it recognizes it*. The refusal strings
are 15 hand-written `denials.push(...)` literals inside
`.claude/hooks/shell-trap-guard.mjs`, each carrying `fix:` / `deliberate:`
sub-lines — for example the unset-env rule's

```
  deliberate: set it in the command itself (`TMPDIR=/c/tmp …`), or re-run with
  AUDIT_TOOLS_ALLOW_UNSET_ENV=1.
```

That last line is record 3's defect in printed form: it advertises the escape
that fails on any statement after a newline. Nothing connects the string to the
`bypassEnabled` it names, so nothing can go red.

## The mechanism

Add a `remedy` to each declared form:

```js
forms: [
  { name: 'unset env expansion', drive: 'hook', sample: '> "$TMPDIR/x.log"',
    remedy: { kind: 'command', text: 'AUDIT_TOOLS_ALLOW_UNSET_ENV=1 echo > "$TMPDIR/x.log"' } },
  { name: 'live backtick in prose', drive: 'hook', sample: 'git commit -m "see `foo`"',
    remedy: { kind: 'prose', text: 'use $() for a substitution, or -F <file> for prose' } },
]
```

Three parts, and they are separable:

1. **Build the denial string FROM the row** rather than from the literal beside
   the rule. The rule contributes the match; the row contributes the name, the
   explanation and the remedy. A rule then cannot print another rule's text —
   which is record 5's whole defect.
2. **A new test leg**: for every `kind: 'command'` remedy, feed the remedy text
   back through the **same recognizer, in the same fixture**, and assert it is
   **ADMITTED**. A remedy the guard would refuse is red. That is records 1, 2 and
   3, all three, mechanically.
3. `kind: 'prose'` remedies are asserted non-empty and nothing more — they are
   advice, not a command, and pretending to execute them would be the false
   precision this repo bans.

The critical property is the *round trip*. Every prior fix here has been to make
one escape work; this makes "the escape works" a checked property of the
declaration, so the next bypass added cannot reintroduce it — the same
class-closing move `bypassEnabled` itself was.

## What it would have caught

- **Record 1** (2026-07-26) directly: the inline-prefix remedy fed back through
  the guard would have been refused, at the moment the remedy was written.
- **Record 3** (2026-09-04, live now) directly, and this is the strongest case:
  the declared remedy for a rule whose sample sits after a newline is refused by
  `bypassEnabled` at HEAD, today. It is red the first time the leg runs.
- **Record 2** (2026-08-13) *partially, and only with an honest caveat.* The
  masked-exit remedy is not refused by the guard — it is admitted, and that is
  exactly the problem: it is admitted and still wrong when backgrounded. Part 2
  of this mechanism would pass it. What part 1 buys there is that the remedy
  becomes declared data in one place instead of two branch literals, so P27's
  "correct the remedy text on BOTH branches" becomes a one-line edit that cannot
  half-land. P27 remains the proposal that fixes record 2; this one does not.
- **Record 5** (2026-09-05) by construction, *if* the machine-wide mirror is in
  scope: a refusal built from the row that matched cannot carry a different
  rule's remedy.
- **Record 4** (2026-08-27) **not at all.** That is a reach non-determinism, not
  a remedy defect, and P51's `forms` field is the mechanism that addresses it. It
  is counted here as a member of the class the two proposals jointly cover, not
  as a catch. Claiming it would be the inflated-coverage move the guard-reach
  registry exists to make visible.

## False-positive surface

Moderate, and higher than P51's — worth stating plainly rather than minimizing.

- **The round trip needs a remedy that is executable in the fixture.** A remedy
  like `git commit -F <that file>` is a template, not a command. Declaring it
  `kind: 'command'` would need a real file in the fixture; declaring it
  `kind: 'prose'` is honest but exempts it from the check that matters. The
  boundary between the two kinds is a judgment call made once per form, and a
  form mis-declared as prose is silently uncovered — the same "declared only as
  complete as what someone thought to declare" cost P51 already accepted, one
  notch sharper.
- **Admission is not correctness.** The leg asserts the remedy is *not refused*.
  A remedy can be admitted and still wrong (record 2 is precisely that). The
  test's promise must be stated as "the guard does not contradict its own
  advice", never as "the advice is good".
- **Rendering denials from data changes 15 refusal messages at once.** Any test
  asserting on today's exact wording goes red in the same commit. That is churn,
  not a false positive, but it is real and it lands all at once.
- **Low risk on the other side:** the fixtures are synthetic, already exist for
  P51's samples, and the drivers are the ones `guard-form-reach.test.ts` already
  runs — this adds a field and a leg to a live mechanism rather than a new gate.

## The form is the question — three options

The three do not share code, so **no patch is written**. A patch authored before
the scope decision picks a file layout, an import graph and a test root that two
of the three options discard, and writing one would be work the decision throws
away. This is stated rather than quietly skipped.

**(A) audit-tools only.** `remedy` on the existing `forms` rows in
`scripts/guard-reach-data.mjs`; denials in `.claude/hooks/shell-trap-guard.mjs`
built from the row; the round-trip leg added to
`tests/shared/guard-form-reach.test.ts`.
*Pros:* one repo, one registry, one test file, all already existing. Fully
red-green validatable — record 3 is live at HEAD, so the leg is red before the
fix and green after, with no synthetic setup. Smallest blast radius.
*Cons:* leaves record 5 — the only one whose *verdict* was right and whose
*message* was wrong — entirely uncovered, because that guard lives in
`~/.claude/hooks/`. Covers 3 of the 5 records.

**(B) audit-tools plus a machine-wide mirror** for
`~/.claude/hooks/shell-conventions-guard.mjs`.
*Pros:* the only option covering record 5, and record 5 is the one now
mechanically established this run. `shell-conventions-guard.mjs` is the
machine-wide sibling of `shell-trap-guard.mjs` and has the same four-rule,
hand-literal shape, so the same defect is latent in it by construction.
*Cons:* **it cannot be red-green validated the way this repo requires.** The
machine-wide hook has no registry, no test tree and no gate — there is nowhere
for a contract test to live and nothing to run it, so "the leg is red at HEAD"
is unavailable and the fix would land on assertion. It also files machine-wide
(`C:\Code\docs\backlog.md`), where the entry is a *proposal for a mechanism that
does not exist yet* rather than work against a registry. Two mechanisms, two
homes, and the machine-wide half will decay independently — which is the exact
shape the durable-traps policy warns about.

**(C) fix only the live `bypassEnabled` instance** — add `\n` to the separator
set so it matches `splitShellStatements`, with the pinning test
`open-bugs.md:39` already specifies ("a test that feeds one bypass through
both").
*Pros:* smallest, immediate, closes a defect that is live today. Its property is
already written and unambiguous. Roughly a one-line change plus a test.
*Cons:* **this repo's own "fix the defect CLASS, not the named instance" rule
argues against it directly**, and this cluster is the case study — record 1 was
this same fix, made once already, and records 3 and 5 are the class re-emerging
in two new shapes. Taking (C) means the sixth record is a matter of time. In its
favour, and stated honestly: (C) is not exclusive with (A). (C) is the change
(A)'s round-trip leg would *force*, so doing (C) alone is choosing to make the
fix without making it checkable.

**A note on ordering, not a fourth option:** (C) is contained in (A). If the
owner wants the live defect closed tonight and the class closed later, (C)-then-(A)
is coherent — but the atomic-replace ordering invariant means (A) must then
arrive as its own complete change, not as an accreted follow-on.

## Files in this proposal

This record only. No patch, no test — see *The form is the question*.
