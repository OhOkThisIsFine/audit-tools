# Audit Tools clean-slate suite trial

This is an isolated experiment, not a replacement or an existing release check. It takes the product goals as the coverage map; source is consulted to locate the real interfaces. It does not read, copy, or run the legacy assertions.

- Default lane: deterministic test cases using tiny inputs, no subprocess or filesystem unless the outcome depends on that boundary.
- One composed audit lifecycle: real CLI startup, bounded review, accepted work that survives resume, final machine/Markdown pair; assert representative incomplete/refused transitions at their own seam.
- One composed remediation lifecycle: request intake, checkpoint/revision approval, real small edit and verification, resume, accurately distinguished outcomes. Verify protected state and no partial promotion without dialing up repeated fixtures.
- A few real seam checks: Git/worktree isolation and cleanup, process cancellation on Windows, packaged command discovery and host integration. Keep these independent from repeated contract examples.
- Development or release gates are a different concern. Existing release checks and the canonical suite remain unchanged until the owner sees a coverage and timing comparison and chooses a rollout.
- Finish criteria: under 60s end-to-end including build on the user's normal Windows setup; record cold/warm times with no network, list contract coverage and deliberate gaps, demonstrate that representative regressions really fail, then compare with past production failures before replacing anything. Do not count a gated or intentionally excluded check as passed.

Initial pilot covers only restart/gating and evidence semantics; it is not qualification of an entire product.

## Run the prototype

From the repository root:

    npm run build
    node --test experiments/contract-tests/pilot.mjs experiments/contract-tests/audit-smoke.mjs experiments/contract-tests/remediation-smoke.mjs experiments/contract-tests/git-boundary.mjs experiments/contract-tests/delivery-boundaries.mjs experiments/contract-tests/plan-authority.mjs

The Windows build and prototype took 26.97 seconds: eight passed, no skips.
This does not qualify untested behavior or replace the existing release gate.

| Contract | Current witness | Still needed for rollout |
| --- | --- | --- |
| Audit continuity and truthful completion | Recorded stop survives a new CLI process; one accepted binding persists in both promoted reports | Incorrect binding, duplicate admission, and incomplete coverage checks with inputs that can actually fail |
| Remediation provenance and verification | Pending request survives restart; valid plan replays without change but cannot close unapproved; real fixture test goes red then green and report reflects the gate | Approved revision, a verified edit, resume after an interrupted write, and terminal report promotion |
| Git path fidelity | Real index and dirty working tree; nested-root refusal; original index unchanged | Owned worktree/snapshot cleanup across a restart and failed Git probe |
| Shipped product behavior | Real checkout wrappers; offline npm tarball contents and its audit prompt; actual timeout reaps the tool-owned child | Fresh install and generated host assets; cancellation with a subprocess tree, not just one child |
| Release and development checks | Unchanged and still run through the current documented entry points | Explicit inventory and comparison before any default or release change |
