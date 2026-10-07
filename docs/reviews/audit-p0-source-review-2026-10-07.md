# Audit P0 + P6.0 independent source review

<!-- review-routing: deferred -->

## Publication status and evidence limits

This is an archival source-review record for the P0 parser patch and P6.0 test-safety prerequisite in the [mechanical implementation plan](mechanical-implementation-plan-2026-10-07.md). Remaining execution and package qualification are [deferred work](../backlog/deferred.md).

- The independently reviewed draft tree was `184c6bcfd638e46f6f208067c2c727c25125af27`. The implementation environment subsequently reported a full-suite result of 595 files, 7,095 passed tests, 12 skips and zero failures/errors for that tree. The source reviewer did not rerun it.
- The single sites-pinned comment changed the draft tree to `f2f2def9fa9817dbb3939435db66f67b4016bf7c`. That annotation was independently source-reviewed, but a fresh final full-suite result and genuine exact-tree stamp remain unconfirmed after the execution environment reached its quota. The previous green result does not qualify this changed tree.
- No code commit, code pull request, merge, release, packed install or installed update is verified by this record. Publishing this Markdown does not publish the reviewed implementation patch.
- The original plan's stopped W6 branch and working-tree uncertainty remain unchanged. No W6 state was resumed or altered for publication.
- The owner approved documentation-only publication through GitHub without local pre-commit tests. No product gate, review ledger, green stamp or attestation is fabricated or bypassed by this exception.

The review findings and byte/tree identifiers below are preserved as reported evidence. The patch bytes, reconstruction files, detailed binding JSON and execution logs are not included in this repository publication and have no verified repository URL. Their identifiers are therefore evidence references, not downloadable attachments or independently reproduced execution results. The pinned source links resolve to the original base, not to the unpublished candidate trees.

## Verdict

**Source approval, with no blocking source findings in the reviewed six-file patch.** This is an independent source-contract verdict for P0 and the P6.0 prerequisite only. It is not a full-suite, package-install, platform-lifecycle, release, commit, or merge approval.

Review attribution: an independent AI source reviewer, separate from the implementer, on 2026-10-07 UTC. The source reviewer did not implement the patch, run product code/tests/builds, use the owner's computer, commit, or push. Its method was pinned GitHub reads, source inspection, and text/hash verification of review copies. This record does not represent human review.

## Exact binding, independently verified

- Base commit: `2f268f019523d87ba02d8ac6821224d468ca2182`
- Base Git tree: `3ce4919abc7254775d777ae201ab1057cb1e8deb`
- Reviewed patch: `audit-p0-actual.patch`, 15,882 bytes
- Patch SHA-256: `f493934859076a80a242d216e23c28bf92c7a0a848a7eaa7d9cb6f91db2b1220`
- **Recomputed reviewed Git tree: `184c6bcfd638e46f6f208067c2c727c25125af27`**

The tree binding is not merely the implementer's supplied value. The reviewer fetched the base commit and affected parent trees from GitHub at the exact pin, verified fetched source blobs against their Git SHA-1s, applied every patch hunk as text with exact original-line matching, verified all six resulting blob IDs against the diff indexes, then recomputed the affected trees bottom-up while retaining every unchanged entry. The resulting root exactly matches the supplied staged tree. The detailed tree-binding record and reconstructed review copies are not included in this publication; no repository link to them is available.

Changed blobs:

- `package-lock.json`: `9bbd7b72d22fe4757b9e2f1ba66895894513ce81`
- `package.json`: `016d9b94ba40ac128babdcc5a3c75cdc21420705`
- `src/audit/orchestrator/runtimeCommand.ts`: `bf43c4d48fbde4c3b9eb8921588131ccdd113363`
- `tests/audit/graph-manifest-edges.test.ts`: `4797b8012710140725642b5a17fa2128661e7d16`
- `tests/audit/graph-manifest-toml.test.ts`: `e8a9ca0dc548d72a77a65a494e3eb12fb00f32fb`
- `tests/audit/runtime-command-bounded-wait.test.ts`: `b8dd2fb581e70f5133df829892493f7f5251e538`

## Reviewed source invariants

Line references for changed files below refer to the reconstructed reviewed tree.

1. **Dependency scope is exact.** Structural JSON comparison finds only `package.json.dependencies.smol-toml` changing from `^1.6.1` to `^1.9.0`; the lock's root requirement changes identically, and only the `node_modules/smol-toml` version, registry tarball URL, and integrity change. The lock resolves `1.9.0` at `https://registry.npmjs.org/smol-toml/-/smol-toml-1.9.0.tgz`. There is no other dependency, engine, build, scripts, or package-files delta. This validates lock contents and scope; it does not independently authenticate the downloaded tarball.

2. **Existing safe parser/accessor semantics remain intact.** Pinned `parseTomlSafe`, `asTomlTable`, and `tomlTable` are unchanged. They use structural object/array checks, not prototype instance methods. Cargo and pyproject still call these existing shared helpers. The added `parseTomlSafe`, `asTomlTable` and `tomlTable` fixtures in `tests/audit/graph-manifest-toml.test.ts` assert null prototypes for successful tables, data keys named `__proto__`, `constructor`, and `hasOwnProperty`, unchanged `Object.prototype` descriptors, ordinary-object empty fallback for malformed input, and rejection of non-table values.

3. **Valid graph compatibility fixtures have concrete oracles.** The `extractCargoWorkspaceMemberEdges` and `extractPyprojectTestpathLinks` fixture matrix in `tests/audit/graph-manifest-edges.test.ts` covers Cargo dotted, inline, quoted, and multiline member/exclude spellings and pyproject table/dotted/inline scalar/array spellings. Expected tuples include exact source, destination, kind, direction, and confidence (`0.87` / `0.85`); they also exercise excluded and unrelated lookup entries. This is materially stronger than a nonempty-output check.

4. **Advisory/scaling inputs run outside the test worker.** `parserChild` in `tests/audit/graph-manifest-toml.test.ts` uses the existing `spawnSyncHidden` wrapper, the actual Node executable, an absolute file URL for the built parser, a 30-second external timeout, and bounded captured output. The child bodies parse fixed synthetic strings and do not spawn descendants or install signal handlers. Timeout/spawn errors, signals, and nonzero exits all fail before JSON output is accepted. The EOF fixtures at lines 63–67 cover incomplete array, inline table, and nested array EOF-comment cases and require `{}` for each.

5. **Scaling assertions follow the selected contract.** Lines 69–97 parse dot-free 8k/16k/32k-key documents for six rounds, verify every result's key count and endpoint values, discard the first timing round, compare five-sample medians with a small timing floor, and record raw samples plus process maximum RSS. The 4x-input ratio must be below 8 and the last doubling below 4. This is a bounded repeated-sample regression oracle, not a claim of a formal complexity proof or a per-document memory cap.

6. **P6.0 removes the fabricated-PID OS path without changing native behavior.** `RuntimeCommandProcessControl`, `nativeProcessControl`, and `killRuntimeCommandTree` in `src/audit/orchestrator/runtimeCommand.ts` add the narrow injection boundary. Default behavior remains: Windows with a PID spawns `taskkill /pid <pid> /T /F` with hidden/ignored stdio and falls back to `SIGKILL` on the reaper's error event; Windows without a PID sends `SIGTERM`; other platforms send `SIGTERM`. `runCommand` and its timers remain otherwise unchanged. In the "fail-2: injected process control requests platform operations without OS lookup" fixture in `tests/audit/runtime-command-bounded-wait.test.ts`, the fake has an opaque Symbol identity, no PID, an explicitly throwing `kill`, and an injected adapter that records only requested operations. Both platform branches are exercised without any fake numeric process identity reaching native lookup or termination. The old assertion treating the direct POSIX child as the entire tree is removed.

7. **Timer fixture observes actual exit.** The "fail-1: an early-exit fixture actually exits after its deadline is cleared" fixture in `tests/audit/runtime-command-bounded-wait.test.ts` launches an external Node fixture that calls built `runCommand` with a 60-second deadline and a naturally exiting owned child, then requires the fixture itself to exit normally before a 3-second external watchdog. It no longer counts undocumented active timer handles. The existing eventual-timeout regressions remain. The fixture explicitly limits its claim to early-exit timer cleanup; neither it nor the existing 60-second test ceiling proves the later P6 tree-cleanup protocol.

8. **Source/dist and test visibility are coherent, conditional on a fresh isolated build.** Ordinary tests import source; adversarial/timer children import the exact corresponding absolute `dist` file URL. Pinned `package.json` runs a clean TypeScript build before `npm test`, and its prebuild hook checks for live suite holders. `tsconfig.json` maps `src` to `dist`; package exports resolve the child's shared import to `dist/shared`. The new `tests/audit/*.test.ts` is included by `TEST_FILE_RULES` and by `tsconfig.test.json`. Focused runs must retain the contract's one fresh build before the gate and no concurrent rebuild. No runtime artifact freshness is independently established by this source review.

## Qualification and gate boundary at the initial review

- The implementer's reported 109 focused passes on Node 26.7 and 22.14, plus type/lint/dependency checks, are reported execution evidence, not tests rerun by this reviewer. They do not establish a full-suite pass.
- At the initial review, the supplied preceding-tree full-suite result, **6,938 passed / 26 failed / 13 skipped / 7 errors**, was not accepted as green and could not qualify the reviewed tree. The continuation below records the later green result for tree `184c6bcfd638e46f6f208067c2c727c25125af27` only. Obtain the genuine full-suite gate result and suite-green stamp bound to `184c6bcfd638e46f6f208067c2c727c25125af27`, or to a subsequently reviewed final tree if the source changes. Do not manufacture or copy a stamp. Pinned `suiteGreenStamp.isFullSuiteRun` requires an unfiltered invocation, and `suiteGreenVerdict` checks the source-tree identity.
- Verify the P0 packed-install requirement: the packaged installed parser actually resolves to 1.9.0 and both graph adapters work on the minimum supported Node 22 runtime. Focused source tests alone are not packed-install evidence. Record the trusted package-manager version, install/lock evidence, commands, versions, outcomes, and relevant logs. The registry metadata URL was unavailable through the review web tool; no independent downloaded-tarball integrity claim is made here.
- Complete the applicable checks/release and isolation prerequisites from the contract before claiming final package acceptance. Native Windows/POSIX lifecycle qualification beyond the P6.0 test-harness repair remains outside this patch and this verdict.
- This actual independent review may support an attributable source-review attestation for the exact reviewed tree. It must not be represented as human review, an execution pass, or authorization to bypass repository gates.

## Pinned source references

- [Base commit and tree](https://github.com/OhOkThisIsFine/audit-tools/commit/2f268f019523d87ba02d8ac6821224d468ca2182)
- [Parser helpers](https://github.com/OhOkThisIsFine/audit-tools/blob/2f268f019523d87ba02d8ac6821224d468ca2182/src/audit/extractors/graphManifestEdges/toml.ts)
- [Cargo adapter](https://github.com/OhOkThisIsFine/audit-tools/blob/2f268f019523d87ba02d8ac6821224d468ca2182/src/audit/extractors/graphManifestEdges/cargo.ts)
- [Pyproject adapter](https://github.com/OhOkThisIsFine/audit-tools/blob/2f268f019523d87ba02d8ac6821224d468ca2182/src/audit/extractors/graphManifestEdges/pyproject.ts)
- [Original runtime termination/timer context](https://github.com/OhOkThisIsFine/audit-tools/blob/2f268f019523d87ba02d8ac6821224d468ca2182/src/audit/orchestrator/runtimeCommand.ts#L215-L355)
- [Tracked spawn wrapper](https://github.com/OhOkThisIsFine/audit-tools/blob/2f268f019523d87ba02d8ac6821224d468ca2182/tests/helpers/trackedSpawn.ts#L325-L358)
- [Production spawnSync wrapper](https://github.com/OhOkThisIsFine/audit-tools/blob/2f268f019523d87ba02d8ac6821224d468ca2182/src/shared/tooling/exec.ts#L853-L872)
- [Package build and test scripts](https://github.com/OhOkThisIsFine/audit-tools/blob/2f268f019523d87ba02d8ac6821224d468ca2182/package.json#L43-L54)
- [Test inclusion contract](https://github.com/OhOkThisIsFine/audit-tools/blob/2f268f019523d87ba02d8ac6821224d468ca2182/tests/helpers/testFileContract.ts)
- [Full-suite stamp contract](https://github.com/OhOkThisIsFine/audit-tools/blob/2f268f019523d87ba02d8ac6821224d468ca2182/scripts/shared/suiteGreenStamp.mjs)
- [Repository review and green-at-every-commit requirement](https://github.com/OhOkThisIsFine/audit-tools/blob/2f268f019523d87ba02d8ac6821224d468ca2182/CLAUDE.md#L248-L250)

## Continuation: annotation-only recheck, 2026-10-07 00:53 UTC

**Source-approved for the single-comment delta; no new source finding.** The earlier P0/P6.0 review therefore extends to tree `f2f2def9fa9817dbb3939435db66f67b4016bf7c`, subject to the unchanged execution qualifications.

The sole addition is `// sites-pinned: tests/audit/runtime-command-bounded-wait.test.ts` in `src/audit/orchestrator/runtimeCommand.ts`, immediately before `RuntimeCommandChild`. Removing that line restores the previously reviewed runtime blob byte-for-byte. All five other changed blobs remain identical.

Independent reconstruction verified:

- Previous tree: `184c6bcfd638e46f6f208067c2c727c25125af27`
- New runtime blob: `161e189cde3fabe5a2a62a90b54e5a7d9eef12a3`
- New root tree: `f2f2def9fa9817dbb3939435db66f67b4016bf7c`
- Full patch, 15,949 bytes, SHA-256: `2c1705907fe6fe1fa110a47def44bbe5fdbab2737fb48380e8c762a41c87769e`
- Annotation-only patch SHA-256: `6a1e37bac76b47a20e955b5eabeab936726be1ede1cbce1e6a3f507c083a53a3`

The reviewer reconstructed the amended file and both patch byte streams from the previously verified review copy, then recomputed the changed Git parent trees using the retained pinned GitHub tree objects. These values independently match the supplied continuation identifiers. The annotation/full patch bytes and amended runtime review copy are not included in this publication; no repository links to those artifacts are available.

The annotation is an honest binding under pinned [`check-sites-pinned.mjs`](https://github.com/OhOkThisIsFine/audit-tools/blob/2f268f019523d87ba02d8ac6821224d468ca2182/scripts/check-sites-pinned.mjs): its declaration parser accepts this existing tracked test path, and the nearest-above rule places the changed process-control sites under it. The named, previously reviewed test file directly imports `killRuntimeCommandTree`, `RuntimeCommandProcessControl`, and `runCommand`. Its lines 101–116 assert both injected platform operations with an opaque identity and throwing fake kill; lines 81–99 observe actual early-exit fixture termination; earlier cases exercise owned real-child timeout and success. This is relevant test ownership, not an unrelated test named merely to clear a gate. No executable behavior or assertion changes in this delta.

The gate explicitly says its author-supplied name binding is **not independently sufficient attestation evidence** and does not establish that a behavioral mutation went red. This continuation makes no such claim. The genuine source inspection documented above is the review evidence. The pinned [`attest-loop-core-review.mjs`](https://github.com/OhOkThisIsFine/audit-tools/blob/2f268f019523d87ba02d8ac6821224d468ca2182/.claude/hooks/attest-loop-core-review.mjs) also performs derived-file preflight before writing review/ledger evidence, consistent with the reported refusal leaving no evidence behind.

Execution update supplied to the reviewer: the implementation environment subsequently reported a genuine full-suite pass on the **previous** tree `184c6bcfd638e46f6f208067c2c727c25125af27`, reporting 595 files, 7,095 tests, 12 skips, and zero failures/errors. The source reviewer did not rerun that suite. That pass supersedes the earlier red result for its own tree only. **A fresh full-suite pass and exact-tree stamp for `f2f2def9fa9817dbb3939435db66f67b4016bf7c` remain required; neither is asserted here.** No product code, test, build, attestation writer, commit, or push was executed during this recheck.
