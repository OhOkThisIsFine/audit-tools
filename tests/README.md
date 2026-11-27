# Audit Tools contract tests

Run `npm test` to build and exercise the default suite. Both CI and the package
release run this same suite. `npm run test:built` reuses an existing build.
For a focused test after a build, use `node --test tests/<name>.test.mjs`.

The suite uses tiny fixtures for real audit and remediation boundaries and
quick assertions for deterministic behavior. It replaces the old Vitest tree;
historical cases remain in Git history. It does not claim case-for-case parity.

| Contract | Current witness | Not covered |
| --- | --- | --- |
| Audit continuity and truthful completion | Recorded stop survives a new CLI process; accepted binding persists in both reports; duplicate replay and stale/changed review refusals; skipped analyzer cannot be credited | Coverage reporting under partial execution and analyzer recovery after retry |
| Remediation provenance and verification | Pending request survives restart; real close rejects an unapproved revision and a failing verification; a verified Git edit resumes after an interrupted report write without repeating verification, then promotes matching reports and completed state | Prove dispatch and worker evidence admission independently |
| Git path fidelity | Real index and dirty working tree; nested-root refusal; original index unchanged | Owned worktree/snapshot cleanup across a restart and failed Git probe |
| Shipped product behavior | Real checkout wrappers; offline npm tarball contents and its audit prompt; actual timeout reaps the tool-owned child | Fresh install and generated host assets; cancellation with a subprocess tree, not just one child |
| Release and development checks | Both CI and publishing call the default suite; the separate package checks still run | Not a live OIDC publication or GUI host test |

Recent functional regressions covered directly: false route evidence from comments or a tag prefix (2490e40); Make test discovery must remain advisory and honor the first active Makefile (e8685a3).
