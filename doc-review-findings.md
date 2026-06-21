# Doc-review findings — 2026-06-21

Run against main HEAD `aca57eb` (after applying fixes — see FYI below).

---

## FYI — auto-applied this run

Four commits pushed to main (each discrete and revertible):

| Commit | Summary |
|---|---|
| `d1b9e90` | `docs/NEW-MACHINE-SETUP.md` — fix package name (`auditor-lambda,remediator-lambda` → `audit-tools`), version (`0.27.1` → `0.28.10`), build command (drop defunct `-w @audit-tools/shared` workspace flag) |
| `7126cd5` | `README.remediate.md` — fix artifact dir (`.remediation-artifacts/` → `.audit-tools/remediation/`), output filename (`remediation-report.json` → `remediation-outcomes.json`), intake path, workspace dev section |
| `41fe0a9` | `docs/glossary-ids.md` — fix guard test path, glob, all INV-*/CE-*/SEAM-* "Site" paths (package-style prefixes → actual `src/` paths), SEAM-ACL site (consumer→owner: `src/shared/tooling/exec.ts`) |
| `aca57eb` | `README.audit.md` — fix 5 Key Docs paths (`docs/X.md` → `docs/audit-pkg/X.md`), session-config path (`.audit-artifacts/` → `.audit-tools/audit/`), inline `docs/release.md` ref |

Note: version was bumped to `0.28.11` by a concurrent release during this run — the fix landed as `0.28.10`; next run will catch the remaining delta.

---

<!-- DOC-REVIEW-OPEN:START -->
### Proposed instruction-file edits (approve to apply)

- [CLAUDE-1] `CLAUDE.md` Layout table — entire table describes `packages/shared`, `packages/audit-code`, `packages/remediate-code` with workspaces; no `packages/` directory exists; single package `audit-tools`. Proposed: rewrite Layout table to show `src/shared`, `src/audit`, `src/remediate` as source directories, npm package `audit-tools`, bins `audit-code`/`remediate-code`. Evidence: `ls packages/ → NOT FOUND`; `package.json "name": "audit-tools"`, no `workspaces` field.

- [CLAUDE-2] `CLAUDE.md` Commands section — `npm run build -w @audit-tools/shared && npm run build` and `npm test -w packages/audit-code`, `cd packages/remediate-code && npx vitest run` don't work. Proposed: `npm run build`; `npm run test:audit`; `npm run test:remediate`. Evidence: no workspaces, no `packages/` dir.

- [CLAUDE-3] `CLAUDE.md` audit-code architecture — wrong paths: `src/providers/` → `src/audit/providers/`; `tests/*.test.mjs` → `tests/audit/*.test.mjs`; `packages/audit-code/spec/dependency-map.md` → `spec/audit/dependency-map.md`; `src/orchestrator/staleness.ts` → `src/audit/orchestrator/staleness.ts`; `src/orchestrator/artifactMetadata.ts` → `src/audit/orchestrator/artifactMetadata.ts`. Evidence: filesystem confirms all actual paths.

- [CLAUDE-4] `CLAUDE.md` remediate-code state machine diagram — includes `documenting` state (`pending → planning → documenting → implementing → closing → complete`) but that phase was dissolved (N-R13). Current states (from `src/remediate/state/store.ts` KNOWN_STATUSES): `pending, planning, waiting_for_clarification, implementing, triage, waiting_for_triage, closing, complete`. Proposed: remove `documenting` from the diagram.

- [CLAUDE-5] `CLAUDE.md` remediate-code phases list — lists `document.ts` and `implement.ts`; neither exists. Current phases in `src/remediate/phases/`: `close.ts`, `constants.ts`, `grounding.ts`, `plan.ts`, `triage.ts`, `workerTasks.ts`. Implementation dispatch lives in `src/remediate/steps/dispatch.ts`. Proposed: remove `document.ts`/`implement.ts`, add `workerTasks.ts`; note dispatch in `steps/dispatch.ts`.

- [CLAUDE-6] `CLAUDE.md` remediate-code dispatch — claims `src/steps/dispatch.ts` contains `prepareDocumentDispatch / mergeDocumentResults / prepareImplementDispatch / mergeImplementResults`; the first two don't exist anywhere. Only `prepareImplementDispatch` and `mergeImplementResults` remain. Proposed: remove the two dissolved symbols.

- [CLAUDE-7] `CLAUDE.md` remediate-code — `src/steps/waveScheduler.ts` no longer exists (types/functions inlined into `dispatch.ts`, shim deleted). Proposed: remove the reference.

- [CLAUDE-8] `CLAUDE.md` Release & publish — "Triggered by GitHub Release tag `audit-code-v*`, `remediate-code-v*`, or `shared-v*`" is wrong. `.github/workflows/publish-package.yml` (line 38-41) explicitly says "Single package `audit-tools`: release tags are plain `vX.Y.Z`" and checks `startsWith(github.ref_name, 'v')`. Proposed: update to "plain `vX.Y.Z` tags".

- [CLAUDE-9] `CLAUDE.md` Release & publish — "CI: `npm ci` → build shared → `verify:release` → publish" has no "build shared" step (single-package repo, `verify:release` calls `npm run check && npm test` which builds). Proposed: remove "build shared →" from the CI description.

- [CLAUDE-10] `CLAUDE.md` throughout — `@audit-tools/shared` used as the import/package name, but actual import in source is `"audit-tools/shared"` (`src/remediate/index.ts:29`; `package.json "name": "audit-tools"`). This affects the layout table, "Dispatch" section, architecture descriptions, and `@audit-tools/shared` everywhere it's written as a literal package name.

- [CLAUDE-11] `CLAUDE.md` remediate-code abbreviated paths — `src/state/types.ts`, `src/dedup/crossLensDedup.ts`, `src/intake.ts` missing the `remediate/` infix. No top-level `src/state/` exists. Proposed: qualify as `src/remediate/state/types.ts`, `src/remediate/dedup/crossLensDedup.ts`, `src/remediate/intake.ts`.

- [CLAUDE-12] `CLAUDE.md` Layout table test path column — "Tests: `node --test` (`tests/*.test.mjs`)" and "Tests: vitest (`tests/*.test.ts`)" are wrong paths. Actual: `tests/audit/*.test.mjs`, `tests/remediate/*.test.ts`, `tests/shared/*.test.mjs`. Proposed: correct all three.

- [AGENTS-1] `AGENTS.audit.md` — `[CLAUDE.md](../../CLAUDE.md)` link broken: file is at repo root, `../../CLAUDE.md` resolves two levels up (`/home/user/CLAUDE.md`, doesn't exist). `AGENTS.md` correctly uses `[CLAUDE.md](CLAUDE.md)`. Proposed: `../../CLAUDE.md` → `CLAUDE.md`.

- [AGENTS-2] `AGENTS.remediate.md` — same broken `../../CLAUDE.md` link. Proposed: same fix.

### Design decisions for you

- [D-1] `docs/NEW-MACHINE-SETUP.md` L42 — `"git fetch audit-tools slice-2b-wip  # the in-flight branch (see step 5)"` — no step 5 exists (doc has sections 0–4 only); HANDOFF.md has no ⚠️ block; HANDOFF says "In flight: nothing". The `slice-2b-wip` branch exists on remote but appears stale. Remove these lines? Or is there other active in-flight work that should replace them?

- [D-2] `docs/NEW-MACHINE-SETUP.md` intro box L32 — `"see docs/HANDOFF.md ⚠️ block"` — no ⚠️ block in HANDOFF.md. The box describes a Linux-specific in-flight bug that appears to have shipped in v0.28.11. Should the intro box be updated or removed?

- [D-3] `docs/NEW-MACHINE-SETUP.md` L54-56 — workspace test commands broken:
  ```bash
  ( unset CLAUDECODE; npm test -w @audit-tools/shared )
  ( cd packages/audit-code   && unset CLAUDECODE && npm test )
  ( cd packages/remediate-code && unset CLAUDECODE && npx vitest run )
  ```
  No workspaces, no `packages/` dir. Correct commands per `package.json` scripts are `npm run test:shared`, `npm run test:audit`, `npm run test:remediate`. What pass counts should the comments show (need a live run to capture)?

- [D-4] `README.audit.md` Key Docs — `docs/history.md` referenced but file doesn't exist (not at `docs/history.md` or `docs/audit-pkg/history.md`). Remove the reference, or create the file?

- [D-5] `README.audit.md` L210-211 — workspace language still stale: "Missing workspace links can look like stale `@audit-tools/shared` export or type errors." Not evaluated by both agents; flagging for awareness. No workspaces exist.

- [D-6] `README.audit.md` title/install — `# auditor-lambda` title and `npm install -g auditor-lambda` install command use the old package name. Not auto-applied (Reviewer+Adversary did not fully evaluate); flagging for awareness.

- [D-7] `README.remediate.md` title/install — `# remediator-lambda` title, `npm install -g remediator-lambda` install command, and link text `[auditor-lambda](...)` all use old package names. Not auto-applied; flagging for awareness.
<!-- DOC-REVIEW-OPEN:END -->
