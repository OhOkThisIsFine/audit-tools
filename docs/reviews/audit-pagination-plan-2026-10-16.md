# audit-tools: final six-lens follow-on plan

<!-- review-routing: backlog-bugs -->

Date: 2026-10-16. Reviewed main: `bfa8cb3665972abf02292e66cdc7d5076fab24c4`.

Execution intake: the separate dependency unit has since landed through [PR46](https://github.com/OhOkThisIsFine/audit-tools/pull/46), at `bd46c833e4fa680d0853bbcbb6e999d38ac28753`, after its exact-tree local gates and seventeen exact-head CI checks passed. Pagination begins from that commit. The reviewed plan below retains its original review-time context.

## Decision

Keep the architecture. Promote one narrow P2 landing-completeness repair: collect every page of required-check evidence before evaluating a poll. This is a source-confirmed latent correctness defect, not a demonstrated current-repository incident or a quota-saving optimization. No evidence establishes that this repository currently has more than 100 check runs or more than one page of commit statuses on a commit.

All six October 15 units are already merged in [PR45](https://github.com/OhOkThisIsFine/audit-tools/pull/45): failure-aware delta discovery, verified release-source binding, app-pinned status-query suppression, manifest-relative target construction, graph-context indexing, and ordered obligation priority. The parent review reports seventeen exact-main checks passed and no open PR at initial review. Those are prior observations, not tests rerun in this planning pass. Recheck the current head and open work before implementation.

The independently fetched [package manifest](https://github.com/OhOkThisIsFine/audit-tools/blob/bfa8cb3665972abf02292e66cdc7d5076fab24c4/package.json) remains version 0.55.7. PR45 did not itself publish a new version. Do not report merged source as released software.

The known smol-toml advisory upgrade already has an active implementation owner. Do not open a competing dependency patch, change its lockfile, or claim it complete from this review. Coordinate its final SHA and qualification separately before any shared release.

## Six-lens disposition

1. Architecture: no new verified change. Existing shared integrity classification appropriately leaves audit/remediation path resolution and sync/async refusal policies with their callers.
2. Simplicity/reuse: no new qualifying extraction; retain the small existing seams rather than creating a universal filesystem or polling framework.
3. Code efficiency: prior packet-index optimization is merged. No fresh optimization qualifies; ordered reachability must retain visitation and insertion order.
4. Service contracts: no new verified defect reported. Do not invent one to fill a category.
5. Quota/data acquisition: the pagination gap below is confirmed by independent immutable-source inspection. Correctness may require more HTTP requests, not fewer.
6. Security: sampled source/process boundaries yielded no new confirmed exploit. The active dependency repair remains separate; this is not an exhaustive security clearance.

Reviewed inputs: architecture/simplicity, code-efficiency and security reports dated October 16; parent-provided service-contract and quota findings; immutable current script, tests, manifest and [prior final plan](https://github.com/OhOkThisIsFine/audit-tools/blob/bfa8cb3665972abf02292e66cdc7d5076fab24c4/docs/reviews/audit-final-refactor-plan.md). No implementation, test execution, live landing, release or deployment was performed in this pass.

## Verified finding and unchanged authority

[landThroughPullRequest.mjs, lines 244–252](https://github.com/OhOkThisIsFine/audit-tools/blob/bfa8cb3665972abf02292e66cdc7d5076fab24c4/scripts/shared/landThroughPullRequest.mjs#L244-L252) requests `check-runs?per_page=100` once and, when needed, `/status` once. Neither request paginates. The API documents page parameters and a maximum page size of 100; combined status defaults to 30. A required context on page two can therefore remain falsely unlisted on every retry. Increasing page size alone is insufficient. Sources: [GitHub checks REST contract](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference), [combined-status REST contract](https://docs.github.com/en/rest/commits/statuses#get-the-combined-status-for-a-specific-reference).

[evaluateRequiredChecks, lines 102–135](https://github.com/OhOkThisIsFine/audit-tools/blob/bfa8cb3665972abf02292e66cdc7d5076fab24c4/scripts/shared/landThroughPullRequest.mjs#L102-L135) already gives authority to the highest run ID matching context and pinned app. An unpinned context falls back to the first matching combined-status entry only when there is no matching check run. Preserve this policy; pagination is not permission to select whichever green result appears first, substitute another app, favor statuses over checks, or reinterpret passing conclusions.

The existing [tests](https://github.com/OhOkThisIsFine/audit-tools/blob/bfa8cb3665972abf02292e66cdc7d5076fab24c4/tests/shared/land-through-pull-request.test.ts) inject command/clock seams and already characterize app identity, reruns, legacy fallback, retry limits, exact-SHA fast-forward, no-status calls and pending timeout. Extend that real landing harness, not a separate mock algorithm.

## Ordered, isolated commits

### 0. Planning/status documentation only

If the approved plan is persisted in the repository, use a documentation-only commit at the existing review-plan location or its established dated successor. Mark all six PR45 units complete, retain deferrals, record current version versus publication status, and record the active dependency work separately. Do not include production code or a version bump. This document itself is the deliverable of the current planning pass, not authorization to publish a repository commit.

### 1. `fix(land): evaluate complete paginated check evidence`

One atomic script/test commit. Primary files only:
- `scripts/shared/landThroughPullRequest.mjs`
- `tests/shared/land-through-pull-request.test.ts`

Update generated citation/guard declarations only if ordinary repository generators require it. No dependency, release-policy, CLI public-contract, graph, remediation or filesystem changes.

#### Mechanical implementation contract

1. Keep `needsCommitStatuses = required.some(check => check.appId === null)` and keep check-run polling even for empty requirements. For all-app-pinned requirements, issue zero status queries on every outcome, including retries.
2. Use the existing command seam and GitHub CLI's all-page transport: `gh api <exact-sha-endpoint>?per_page=100 --paginate --slurp` for check runs and, only when needed, combined status. Retain the existing check-run filter semantics; do not silently switch to another endpoint or `filter=all`. The [CLI contract](https://cli.github.com/manual/gh_api) defines sequential page traversal and an outer JSON array wrapping page responses. Confirm the supported installed CLI has both flags before qualification. An unsupported flag is an explicit failure, never a single-page fallback.
3. Introduce only a local page-envelope decoder/collector sufficient for these two object-shaped responses. Require a nonempty outer array; every page must be an object containing the expected array. Validate nonnegative integer `total_count` and consistency across pages; require the collected count to match the declared total. Empty results are one valid page with an empty inner array and total zero, not empty/missing output. Validate identities needed to detect duplicated pages and contradictory records. Reject repeated check-run IDs, conflicting duplicated status contexts, a wrong returned status SHA, malformed records relevant to verdict authority, mismatched totals, truncated JSON or absent arrays rather than dropping them. Treat changing totals/duplicates during traversal as an inconclusive failed collection and retry, never invent missing records. Preserve status page and entry order. Do not deduplicate by check name or app before evaluation.
4. Construct fresh arrays per collection attempt. Evaluate only after all necessary endpoint collections have completed and passed validation. Never evaluate a partial stdout stream, page one, or cached prior green evidence. A failed status collection invalidates that round's check-run snapshot as well; restart both needed collections on retry so a newer rerun can be observed. A subsequent ordinary pending round also starts from scratch. GitHub pagination is not an atomic server snapshot; retain branch protection as final authority and do not claim concurrency is eliminated.
5. Retain the existing ten-consecutive-failure bound, linear/capped failure backoff, pending interval, wait duration and red-check fail-fast behavior. Count consecutive failures at the whole evidence-collection boundary: only a complete, validated round resets the counter. Otherwise a repeatedly failed second page or second endpoint can be hidden by a successful first request forever. A nonzero CLI exit, including partial stdout followed by later-page failure, must discard the entire collection before parsing/evaluation. Invalid JSON/envelopes must either consume the same bounded retry budget or terminate explicitly; they must never become empty evidence or success. Prefer the same bounded collection-retry path for uniform diagnostics.
6. Leave `evaluateRequiredChecks`'s authority and result shape unchanged. Feed it the complete arrays. Its maximum-run-ID comparison applies across all pages and only after pinned-app filtering. An unpinned matching check still outranks combined status, including when the check is on page two. Any uncertainty refuses the default-branch push; an error names the endpoint/collection and PR.
7. Leave initial SHA validation, branch-protection read/refusal, PR reuse, landing-branch push, exact-SHA fast-forward, already-landed shortcut and separate cleanup unchanged. Do not use permissive catches, ad hoc pushes, status caches, incremental green accumulation, a general retry abstraction or arbitrary page-count limits. Existing process-output limits may refuse large collections; surface that explicitly, never truncate and evaluate.

#### Required tests in the existing test file

Adapt the fake to model complete page envelopes and failed collections, not merely arrays of verdict records. Preserve command-call assertions while recognizing `/status?per_page=100` and the added CLI flags. Distinguish logical `gh` invocations from underlying HTTP page requests.

A. Required check on page two after 100 irrelevant checks lands only after the full collection; missing page two on baseline fails. Required unpinned status on page two likewise succeeds; include at least 101 contexts to prove pagination rather than just raising the old default page size.

B. A wrong-app same-name success anywhere never satisfies a pinned requirement. A valid pinned result on page two remains authoritative despite a higher-ID wrong-app record. Cross-page old success/new failure and old failure/new success use highest matching run ID. Reverse page placement to prevent accidental last-page or first-page selection. A newer in-progress rerun remains pending.

C. Mixed requirements collect both endpoints. A page-two matching check failure beats a green legacy status. All pinned green/red/pending/missing/wrong-app cases still make zero status calls. Empty requirements retain one check collection and zero status calls.

D. A later-page failure after apparent green page-one output never pushes main. Transient failure restarts the whole collection and eventually succeeds; ten consecutive failed complete collections refuse with the existing backoff bound even when page one succeeds each time. For a failed status collection, change the check result to a newer failure on retry and prove old green is not retained.

E. Malformed JSON, null/empty outer output, malformed later-page arrays/records, declared totals larger or smaller than collected rows, changing totals, duplicated pages and wrong status SHA all refuse or bounded-retry without a main push. Zero-total well-formed envelopes remain valid. An exact 100-record terminal response is accepted according to complete transport plus total, without inventing another required record.

F. Across rounds, an earlier context's success must not survive its disappearance or newer failure while another context was pending. Preserve legacy fallback when a matching check disappears on a later complete round.

G. Add an independently assembled all-page oracle: for deterministic fixtures, flatten all fixture pages in page order and run the unchanged evaluator; assert the real landing harness makes the same green/red/pending decision and exact push/no-push result. Cover several page boundaries, mixed apps, reruns and status fallback. The oracle must not reuse the new production collector. Malformed/incomplete collections have a separate refusal oracle.

H. Retain existing 30-minute fake-clock pending regression: 361 logical check collection invocations, zero status invocations for pinned-only requirements, no forward push. Underlying HTTP request count is page-dependent. Preserve exact judged-SHA, protection failure, already-landed, PR reuse, branch cleanup and CLI qualification tests.

Negative controls: remove `--paginate`; consume only the first slurped page; select first matching run; remove app matching; treat failed partial output as success; retain prior-round arrays; reset the failure budget on each successful first endpoint. Each corresponding regression must fail, then restore the exact source before final qualification. Do not land intentionally red test-only commits; capture baseline-red evidence locally and include tests with the atomic repair.

### 2. Qualification/status evidence, if repository convention requires a separate commit

Record the exact tested tree, actual command outcomes and independent review. No production changes. If documentation changes affect the suite stamp, rerun required exact-tree qualification afterward. Integrate dependency-owner work only after independent ownership reconciliation; do not fold that patch into the pagination commit.

## Gates, release and rollback

In the authorized implementation checkout, first reconcile main/dirty tree/open PRs and the active dependency branch. Run normal installation and fresh baseline checks using the repository's pinned toolchain. Never modify the user's other checkout implicitly.

Focused after a fresh build:
`npm run build`
`node scripts/shared/run-vitest-gate.mjs tests/shared/land-through-pull-request.test.ts tests/audit/release-ci-gate.test.ts tests/audit/release-contract.test.ts`

Final exact candidate, sequentially: `npm run build`, `npm run check`, `npm run check:tests`, `npm run check:scripts`, `npm test`, `npm run verify:checks`, `npm run verify:release`. Run `npm run staged:legs` for each actual commit and verify the final suite stamp through `scripts/shared/suite-green-status.mjs` using its repository-supported invocation. Keep hooks, generated-artifact/citation guards and required independent attestation. Do not overlap suites, rebuild dist during a suite, suppress failures through pipelines, or equate a content hash with CI. Preserve actual logs and report any platform-specific skip. No real GitHub mutation is necessary for the hermetic regression suite.

Before landing, independent review must verify complete collection, retry-budget behavior, app/run authority, zero-status pinned optimization and no stale green across rounds. Use the repository's normal landing workflow and protected exact-SHA qualification. If main changes, reconcile/rebase and requalify the resulting exact tree. Do not weaken branch protection or bypass a stuck gate.

Release is a separate authorized stage. Keep 0.55.7 until the normal version policy creates the next release; do not preselect or claim a published successor. Verify remote landing SHA, release workflow success and registry version separately, plus an installed-bin target only if specifically authorized. The active dependency fix may affect the eventual release composition; record that explicitly.

Rollback: before shipping, revert script and tests together. After shipping, prefer a corrective fail-closed patch; if reverting the collector, stop automated landing for large/incomplete evidence rather than silently reintroducing page-one authority. No stored state migration, artifact deletion, snapshot cleanup, tag rewrite, old-audit validity claim or unpublish operation follows from this repair. Reverting code cannot undo a release already published.

## Explicitly excluded

No broad architecture split, generic path/error normalizer, public-runner policy change, new source memoization, top-eight selection, binary-response limit policy, npm cache redesign, affinity redesign or repeated PR45 work. Prior public-runner and other compatibility/security deferrals remain recorded in the existing plan; absence of new findings does not close them. Held snapshot/artifact-write authority work stays held. No old report is retroactively qualified and no live audit rerun is implied.
