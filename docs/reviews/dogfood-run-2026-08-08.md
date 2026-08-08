# Dogfood run — 2026-08-08 (audit-code v0.39.9, self-audit)

Live-run record for the `/audit-code` dogfood of `audit-tools` against itself. Observations are
recorded as they happen; the run's own findings land in `audit-findings.json` / `audit-report.md`.

## Run setup

- Source: `main` at `f2e2e069`, clean tree. `audit-code` / `audit-tools` both 0.39.9.
- `.audit-tools/audit/` and `.audit-tools/remediation/` cleared to run fresh (prior contents were
  step envelopes + friction records only; backed up to the session scratchpad).
- Scope: 1267 auditable files, git available, **no mis-scope smells**. 51 files correctly excluded as
  `vcs_ignored`; disposition honored `.gitignore` (checked directly — the intake walker traverses
  ignored dirs and logs oversized skips from them, but they never reach the auditable set).
- Intent: all four mandatory lenses + all seven optional lenses; conceptual design review **deep**
  (5 perspectives).
- Graph: 1289 nodes, 5811 edges across 4 graph types.

## Offload posture

Host is a Claude Desktop session, so subagents bypass the relay entirely
([[claude-desktop-proxy-redirect-flip-flops]]). LLM lanes were therefore offloaded by POSTing the
lane prompt + inlined packet to llm-relay's OpenAI-compatible endpoint directly
(`127.0.0.1:8791/v1/chat/completions`), with every returned artifact verified against
`repo_manifest.json` before it was written.

## Observations

### O1 — the declared relay lanes were dead, and looked alive (fixed in-run)

`~/.audit-code/sources-declared.json` declared `pool/fast`, `pool/coding`, `pool/reasoning`. All three
were retired at llm-relay v0.15.4 and now return a 400 naming the valid set. The lanes still resolved
GREEN through `resolveAmbientSources`, because an `openai-compatible` source proves reach by ENDPOINT
liveness (`/v1/models`, `/health`) — which a running relay answers regardless of whether the declared
`model` resolves. So the lanes would have been admitted as CapacityPools and 400'd on every packet.

Root cause was a tracked doc: `docs/backlog/durable-traps.md` told operators to use exactly those three
retired names. Both fixed this run (doc rewritten to the effort-tier pools + the endpoint-alive-is-not-
lane-alive trap recorded; declaration rewritten onto `pool/{low,medium,high,xhigh}`).

**Property to hold:** a source's declared MODEL is proven, not just its endpoint — or the reach report
says plainly that the model was not checked.

### O2 — 3 of 3 charter lanes drifted on the output contract

All three blind charter lanes (stated / structural / revealed) returned their JSON wrapped in a
markdown fence rather than as a bare object. Zero fabricated file paths in these three, and every lane
returned 6 well-formed nodes once unwrapped.

This is a direct reproduction of the pinned open bug *"Incoming design-review/charter/challenge
artifacts have no submit chokepoint"* (2026-08-05: 5 of 8 lanes drifted, host hand-repaired all of
them). The host-side repair is invisible to the tool, which is precisely why the defect survives: had
this run not been instrumented to REPORT drift, three fence-wrapped submissions would have been quietly
unwrapped and the run would have looked clean.

**Property to hold:** every incoming artifact rides a tool-validated write, and drift is recorded rather
than absorbed by a capable host.

### O3 — the critical-flow lane fabricated one plausible path

The critical-flow fallback lane returned 11 flows; one cited `src/audit/validation/findingGrounding.ts`,
which does not exist. Structure was right, the citation was invented — the exact shape
[[offload-lane-failures-are-usually-the-caller]] and the fabricated-quotes trap warn about. Caught by
verifying every cited path against `repo_manifest.json`; the flow was trimmed, not dropped.

### O4 — the offload trap's SIZE and CONCURRENCY axes are both NIM-specific, not lane-wide

`durable-traps.md` recorded a lane-wide concurrency ceiling (≤2/model) and a size threshold where 48KB+
calls produced no first byte in 28 min and 105KB died `ECONNRESET`. Neither held here. Three lanes ran
concurrently against the relay and all three returned `finish_reason: "stop"`, served by
`gemini-3.6-flash`, at 162KB / 77KB / 26KB prompts in 148s / 141s / 142s respectively.

The owner had already narrowed the concurrency axis to NIM on 2026-07-28; the trap entry had not picked
that up. Corrected this run. The size axis is now equally suspect as a lane-wide claim — it is
per-backend too, on this evidence.

Re-confirmed later in the run at **6-wide**: contract + 5 conceptual perspectives dispatched
simultaneously, all six returning HTTP 200. The one degenerate response among them (O5) was a
request-shape defect, not contention.

### O5 — a tool-capable model on a no-tool lane returns a success-shaped empty result

Conceptual perspective 3 came back HTTP 200, `finish_reason: "tool_calls"`, **10 completion tokens**,
message body carrying only a `thought_signature` and no content. `gemini-3.6-flash` tried to call a tool
to go read the repository. A single-shot lane has no tools, so the call went nowhere and the lane
produced nothing — while looking, at the transport layer, exactly like a success.

The fix is caller-side, not model rotation: the request never said tools were unavailable. Adding a
system message stating there are no tools, no file-system access, and that any emitted tool call is
discarded, resolved it. This matters beyond the ad-hoc script — `openai-compatible` is a permanent
single-shot provider class in this repo, and any tool-capable model behind it can fail this way.

**Property to hold:** the `openai-compatible` provider's request states that the worker has no tools;
and a response with `finish_reason: "tool_calls"` (or an empty message) is refused as a failed packet
rather than accepted as an empty result. [[success-shaped-empty-needs-affirmation]]

### O7 — the systemic-challenge loop has no ceiling, and its yield tracks the SERVING MODEL

⚠ **This run's convergence was HOST-FORCED, not genuine.** After 11 rounds and **42 accepted
improvements with no repeats**, the loop was still producing. Round 12 was submitted as an empty array
to release the run. That empty submission is the tool's only exit, so the register now records a `dry`
round that did not actually happen. Read the 42 findings as "what 11 rounds surfaced", never as "the
improvement space is exhausted".

Two mechanisms behind it:

**No ceiling exists.** `MAX_DRAIN_STEPS` bounds the deterministic drain, but the challenge loop has no
equivalent. `src/audit/orchestrator/state.ts` keeps the obligation unmet until a round returns
nothing-new, so **planning is blocked indefinitely** and the only way out is a submission the host may
have to fabricate. There is no honest host-side stop.

**Yield tracks which model served the round, not exhaustion.** Per-round new findings ran
3, 4, 3, 2, 2, 1, 2, 2, **7, 6**, **10** — the jumps at rounds 9/10 are `minimax-m3` and at round 11
`deepseek-v4-flash` replacing `gemini-3.6-flash`. A terser model reads as convergence; a more thorough
one reopens the loop. Since every round gets a FRESH adversary with no memory, "nothing new" is a
judgment the round cannot reliably make.

**Prompt-craft is load-bearing, which confirms the open bug.** By round 10 every finding had collapsed
into one template — *"concern X is scattered across N files, consolidate it"* — with only the noun
changing. Adding an explicit hardened variation bar that CLOSED that template changed the *kind* of
finding immediately (round 11 returned sequencing, algorithmic, and who-does-the-work changes). That is
exactly the *"convergence also rested on host prompt-craft"* clause of the open entry, reproduced: the
tool's own round prompt carries neither a covered-themes digest nor a variation bar, so both had to be
built host-side to get past template repetition.

**Properties to hold:** the loop carries a round ceiling that ends it WITHOUT a false dry signal; the
round prompt carries the covered-themes digest and variation bar the tool already has the data for
(prior findings live at `systemic_challenge.json` → `findings`, not `rounds[].findings`); and a
host-forced stop is recordable as such rather than as convergence.

### O8 — agentic dispatch through the relay WORKS, but loses the deliverable at the last step

llm-relay 0.23.0 (owner fix, mid-run) makes agentic dispatch viable: a `claude -p` child fronted by
the relay onto a free backend, with real Read/Grep/Glob tools. First single-packet test passed
end-to-end — the child read its five files, wrote a schema-valid result, and returned the packet's
exact confirmation line. `validate-results` reported 0 errors / 0 warnings.

At any scale beyond one packet the reliability problem is **where the deliverable lives**. The packet
contract asks the worker to `Write` its result file and then reply with a one-line confirmation.
Observed repeatedly: the child completes the whole analysis, says *"Now let me write the result
file"* — and the session ends **without ever calling Write**. Exit code 0, no file, all work
discarded, and it is indistinguishable from success at the process level.

Moving the deliverable to the FINAL MESSAGE (the one output `-p` mode guarantees) and having the
driver write the file removes that failure class, at the cost of overriding the packet's own output
instructions. The child stays agentic where it matters — it still reads its own files.

Two further failure modes, both invisible to exit status:
- **Raw tool-call markup leaked as text.** One child emitted `<｜DSML｜parameter name="prompt">…` —
  the backend's native tool-call syntax rendered into the reply instead of executed.
- **A naive JSON extractor manufactures success.** First-`[`-to-last-`]` matched `[published]` out of
  a quoted YAML snippet and parsed "fine". Any host-side extractor must require the array to look
  like AuditResults (first element carrying `task_id`), or it will silently write garbage.

**Properties to hold:** a packet's deliverable rides the channel the worker cannot skip; a worker that
produces no parseable result is a failed packet, never a clean one; and no exit-0-with-no-result is
ever counted as success.

### O9 — dispatch children inherit the repo's own `.claude` surface

A child was observed loading this repo's `security-review` skill in the middle of an audit packet and
reasoning about how that skill's mandate conflicted with the packet's. Dispatch children run with
cwd = the checkout, so they inherit its skills — the same inheritance already recorded for hooks in
[[dispatch-lane-children-hit-repo-stop-gates]], which is why this run carried the three gate
kill-switches. Hooks were the known half; **skills are the uncovered half**, and a packet worker
silently acquiring an unrelated mandate is a correctness risk, not just noise.

**Property to hold:** a dispatch child's inherited surface is DECLARED — hooks and skills both — not
whatever happens to sit in the cwd.

### O6 — fence drift is near-universal but not total

5 of 6 design-review lanes wrapped their JSON in a markdown fence; perspective 2 did not. Combined with
the 4 charter/flow lanes, the running rate is **9 of 10 offloaded lanes drifting** on the output
contract. One lane getting it right is what makes this a tooling problem rather than a model problem:
the contract is expressible, it just is not enforced at the write.
