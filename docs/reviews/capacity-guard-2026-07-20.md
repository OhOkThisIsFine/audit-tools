# Capacity guard — the prerequisite of identity-migration stage 4

## Why this existed

`buildSourcePools` applies the operator's confirmed exclusion rules as a set-difference over freshly
gathered dispatch reach. When the rules matched *every* gathered source it returned `[]`, and no caller
checked: the audit seam passed it into `dedupHostAndSourcePools`, the remediate seam returned or merged
it. The run then had zero source capacity and **nothing anywhere recorded that a policy — rather than a
missing configuration — caused it.**

`spec/backend-identity-axes.md` names this a precondition of the axis-explicit exclusion grammar rather
than a follow-up, and that ordering is right: `service:nim` is a *single* rule that closes every
transport reaching one vendor at once, so one-rule-zeroes-everything stops being exotic the moment the
grammar ships.

## The discrimination

Empty is not inherently a defect — `buildAuditSourcePools` returns empty legitimately when no source is
configured (→ no hybrid). The defect is specifically:

```
excludedBackends supplied  &&  gathered.length > 0  &&  sources.length === 0
```

reach existed, and the rules removed all of it. This is computable at exactly one point in the program;
one line later the pre-filter population is gone. A guard keyed on bare `pools.length === 0` would cry
wolf on every unconfigured run.

## Shape, and why not the obvious one

The reactive dispatch hooks (`onCostDrift`, `onCreditExhausted`, `onModelUnavailable`) are the
established idiom for "quota layer has a fact, step machine owns `artifactsDir`/`runId`". They are all
optional, and documented "omit to leave the exclusion silent."

That idiom is wrong *here*, because silence is the defect being fixed. An optional hook reproduces the
bug for any caller that omits it — "works because the caller remembered" is the latent failure mode
*Auditor-agnostic robustness* forbids. So the fact is a **required field on the return type**
(`SourcePoolBuild`), propagated up to the layers that can report it. Forgetting is impossible; only
deliberate ignoring is. The type checker enumerated every consumer when the shape changed, which is the
property being bought.

`DispatchExclusion` gained `excludedBy(backend) → pattern | null`, and `excludes` is now **derived** from
it. That is not a convenience: it is what makes "zeroed but no patterns to name" unrepresentable. A
non-null zeroing means every gathered source returned `true` from `excludes`, hence a non-null pattern
from `excludedBy`, hence a non-empty `patterns` array. Two parallel implementations could drift into a
zeroing the guard cannot explain.

## Emission

Reuses the step-boundary chokepoint as an `exclusion_zeroed_capacity` fact, registered in **both** the
event union and `STEP_BOUNDARY_CATEGORY` — the category map is a `Record<string, …>` with a
`?? "inefficient_feeding"` fallback, so an unregistered type type-checks fine and lands in the wrong
category silently. It is `tool_should_decide`: only the operator can say whether they meant it.

Awaited, matching `captureNewlyReachableBackendFriction`'s stated reasoning — these fire where the CLI
can emit its step and exit immediately, and a dropped write would mean the zeroing stayed silent.

Audit's pool build happens **before** the review run is materialized, so no run id exists at that point.
It emits under `PROVIDER_CONFIRMATION_FRICTION_RUN_KEY`, the same stable synthetic key Gate-0's
fail-closed capture already used for exactly this reason. That constant moved into shared and is now
single-sourced — two consumers needing the same key is precisely how it would otherwise have drifted
into two, splitting one operator problem across two run scopes.

## What this does NOT do

It does not implement the stage-4 grammar. Today's parser still infers rule kind from the head token
against the closed provider-name set and falls back to `kind: endpoint`, so a `service:`-prefixed rule
parses as an endpoint host literal and matches nothing — fail-open and silent. That is the stage-4
build; this is only its prerequisite. `ExcludableBackend` still carries no `service` field, which is the
shape that must change for a service-axis rule to match anything.

## The one finding that did not survive

An adversarial pass on the finished diff returned `do_not_ship` over a self-rated **minor** defect: that
`patterns` could be empty while `zeroedByExclusion` is non-null, via a `DispatchExclusion` whose
`excludedBy` returns a blank string — yielding an unnameable zeroing, the very silence the guard exists
to prevent. It correctly noted `parseExclusionPatterns` sanitizes blanks only on the artifact READ path,
so an in-process caller building its own policy object bypasses it.

It was falsified by red-green validation. A blank pattern parses to an endpoint rule with a blank host,
which matches nothing — so it can never be *attributed*, because `excludedBy` returns the first
**matching** rule. A defensive filter was written, then reverted when reintroducing the "defect" left
the new test green: the test could not detect the absence of the thing it was testing.

The invariant holds for a stronger reason than any filter. `patterns` is empty only if no gathered
source yielded a pattern; `sources.length === 0` means `excludes` was true for all of them; and
`excludes` is *derived* from `excludedBy(b) !== null`. Empty-patterns-with-non-null-zeroing is
unrepresentable by construction. The scenario required a hypothetical foreign implementor of the
interface, not reachable code — so the honest resolution was to delete the speculative hardening and the
decorative test rather than keep code no test could justify. [[test-must-reach-the-code-it-claims]]

## Method note

The first adversarial pass on this design was worthless and looked like model incapacity: the reviewer
was asked to verify `file:line` citations against source inlined **without line numbers**, answered
"NOT VERIFIABLE" eight times, refuted nothing, and still returned `premise_false`. The fault was the
caller's, not the model's. The re-run, sighted, returned `sound_with_corrections` and surfaced the one
correction that mattered — that neither call seam actually has `artifactsDir`/`runId` in scope, which is
what forced the propagation design above. [[offload-lane-failures-are-usually-the-caller]]
