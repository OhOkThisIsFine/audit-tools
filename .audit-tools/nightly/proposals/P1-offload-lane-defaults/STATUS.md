# P1 — PARTIALLY SHIPPED, and its companion cleanup was WRONG. Re-verified 2026-07-25.

Verified at HEAD `430c25d9` by the reviewer and independently by the adversary, both reading
`C:\Users\ethan\.claude\llm-call.mjs` (now 123 lines, was 67).

## The three proposed items

| # | Item | Status |
|---|---|---|
| 1 | `--schema <file\|json>` override | **SHIPPED.** L13-18 parses the flag (`exit 2` on a missing arg), L39-50 does file-or-inline detection with a sanitized `schemaName`, L27-36 keeps the generic container only when the flag is absent. The proposal's exact mechanism, including its rationale comment. |
| 2 | Number inlined lines so a model can cite | **STILL LIVE.** L24-26 is `files.map(f => \`=== ${f} ===\n${fs.readFileSync(f,"utf8")}\`)` — raw text, no `N<TAB>` prefix, and the system prompt (L64) says nothing about numbering. No `--no-line-numbers` escape exists because there is nothing to escape. |
| 3 | Surface a non-`stop` finish on stdout; exit nonzero on `length` | **STILL LIVE.** L122 prints `finish_reason=…` to **stderr**, L123 unconditionally prints the content to stdout, and the process exits 0 regardless. A truncated answer is indistinguishable from a complete one on the stream any piped caller reads. |

A fourth improvement landed unproposed: a `/v1/models` reach preflight exiting 3 with the restart
command (L71-96).

**Item 2 is not a new finding.** It is already an open backlog entry —
`docs/backlog/durable-traps.md:81-87`, dated 2026-07-20, with a named smoke check — standing
unfixed for five days. Any action here is *executing that entry*, not discovering it.

## ⚠ The companion cleanup in the original proposal is WRONG at HEAD — do not apply it

P1 asked to retire two backlog entries as describing already-fixed behaviour. Both verdicts are
dead, for different reasons. This is itself an instance of the pattern the routine keeps finding
(a fix derived from an entry's prose rather than from the code).

- **The undici headers-timeout trap** (P1 cited `docs/backlog.md:1517`; now in
  `docs/backlog/durable-traps.md`) was **rewritten on 2026-07-24** into three legs. Leg (b)
  already says the helper is fixed. Leg (a) is live in-repo (the undici `Agent` dispatcher in
  `openAiCompatibleProvider.ts`) and leg (c) is live for hand-rolled `~/.claude/*.mjs` scripts,
  re-verified 2026-07-24. **Retiring it would delete two live legs.**

- **The `max_tokens` / `strict:true` entry** (P1 cited `docs/backlog.md:1511`; now
  `docs/backlog/open-bugs.md:505-527`) retains **two** live properties, not zero. Property (i)'s
  `max_tokens` half shipped (L62, default 8000 + `LLM_MAX_TOKENS`) but its
  *"treats `finish_reason !== "stop"` as a failure, not a result"* half is exactly P1's still-live
  item 3. Property (iii) — *"a structurally-conformant response with placeholder or missing content
  must be detectable as such"* — is entirely unimplemented and was missed by the first review too.
  Only property (ii) is fully closed.

**Correct action on both: rewrite to the open remainder, never retire.** The routine did not do
this — it is a multi-property rewrite, above the mechanical-cleanup bar, and property (iii)'s
scope is a judgment call.

## What remains for the owner

Items 2 and 3 in the helper (out-of-repo, so the routine cannot gate them anyway), and the
two-entry rewrite above. Item 3 is the higher-value half: it is the
[[an-advisory-that-fires-and-is-read-past]] shape one file over — the one signal that distinguishes
a truncated answer from a real one is printed to the stream nobody reads.
