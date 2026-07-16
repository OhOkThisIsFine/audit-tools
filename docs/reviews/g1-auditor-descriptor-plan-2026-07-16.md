# G1 — collapse the `--host-*` flag-bag into one `--auditor <json>` (execution plan + recon)

First code commit of the greenfield unified-dispatch rework
([`spec/unified-dispatch-worker-model.md`](../../spec/unified-dispatch-worker-model.md) → "Greenfield
endpoint" + Decomposition; synthesis
[`docs/reviews/dispatch-inventory-greenfield-design-2026-07-16.md`](dispatch-inventory-greenfield-design-2026-07-16.md)).
Loop-core → green-at-every-commit + independent review + attestation. This doc captures the crystallized
scope + the full handshake-surface recon so the next agent does NOT re-run the recon.

## Scope (deliberately bounded — pure transport collapse, no semantic re-slice)

G1 changes the TRANSPORT of the existing `HostDispatchDescriptor` fields from N `--host-*` flags to ONE
`--auditor <json>`, grouping the host-emitted scalars under `self`. It does NOT re-slice inventory into
capability, does NOT touch `--host-provider`, does NOT touch remediate. Those are later commits:
- inventory → `sources` reslice + delete repo dispatch fields = **G2** (the type split).
- `--host-provider` fold into `self.provider` + retire the `persistHostProvider` seam = **G2** (that
  seam exists only because `semanticReviewStep` re-reads disk, which G2 changes).
- remediate `--auditor` round-trip = **G6**.

## Target shape (G1)

```ts
// NEW shared type (src/shared/types/auditorDescriptor.ts), exported from audit-tools/shared.
export interface AuditorSelf {
  model_id?: string;                     // was --host-model-id
  roster?: HostModelRosterEntry[];       // was --host-models
  context_tokens?: number;               // was --host-context-tokens
  output_tokens?: number;                // was --host-output-tokens
  max_active_subagents?: number;         // was --host-max-active-subagents (operator override)
  can_dispatch_subagents?: boolean;      // was --host-can-dispatch-subagents (tristate)
  can_restrict_subagent_tools?: boolean; // was --host-can-restrict-subagent-tools
  can_select_subagent_model?: boolean;   // was --host-can-select-subagent-model
}
export interface AuditorDescriptor {
  auditor_id?: string;                   // optional in G1; the never-inherit STAMP is wired in G5
  resolved_at?: number;                  // optional in G1; wired in G5
  self: AuditorSelf;
  inventory?: HostDispatchInventory | null;  // UNCHANGED bag (resliced to `sources` in G2);
                                             // applyDispatchInventory(sessionConfig, descriptor.inventory) stays as-is
}
```
Replace `HostDispatchDescriptor` with `AuditorDescriptor` outright (ideal-code, no back-compat / no dual shape).

## Handshake surface map (from recon — the exhaustive replace set)

### Flag parsers — `src/audit/cli/args.ts` (RETIRE all listed; add one `getAuditorDescriptor`)
| Flag | Parser (args.ts) | → AuditorDescriptor |
|---|---|---|
| `--host-max-active-subagents` | getHostMaxActiveSubagents:249 | self.max_active_subagents |
| `--host-context-tokens` | getHostContextTokens:259 | self.context_tokens |
| `--host-output-tokens` | getHostOutputTokens:264 | self.output_tokens |
| `--host-models` | getHostModelRoster:277 (→ shared parseHostModelRoster, scheduler.ts:72) | self.roster |
| `--host-model-id` | getHostModelId:290 | self.model_id |
| `--host-inventory` | getHostInventory:303 (JSON, throws on non-object) | descriptor.inventory |
| `--host-can-dispatch-subagents` (bare/`--no-`/`=`) | parseHostBooleanFlag (nextStepCommand.ts:1156) | self.can_dispatch_subagents |
| `--host-can-restrict-subagent-tools` | getOptionalBooleanFlag (args.ts:52) | self.can_restrict_subagent_tools |
| `--host-can-select-subagent-model` | getOptionalBooleanFlag | self.can_select_subagent_model |
| `--host-model` | getHostModel:245 | **DEAD on audit path — delete, no caller** |
| `--host-provider` | getHostProvider:238 | **LEAVE (persist seam, folds to self.provider in G2)** |

`getAuditorDescriptor(argv): AuditorDescriptor | null` — parse `--auditor <json>`, validate object, throw
loudly on malformed (mirror getHostInventory). `resolveHostDispatchCapability` (args.ts:75) still folds
`self.can_dispatch_subagents ?? sessionConfig ?? env AUDIT_CODE_HOST_CAN_DISPATCH`.

### Type + renderer — `src/audit/cli/prompts.ts`
- `HostDispatchDescriptor` (54-70) → import `AuditorDescriptor` from shared.
- `renderHostDescriptorFlags` (80-117) → `renderAuditorDescriptor(d)`: return `[]` when `d` is
  undefined OR (`self` empty AND `inventory == null`), else `["--auditor", JSON.stringify(d)]`. KEEP the
  2a-ii semantic: `inventory: {}` (empty, host-only) is distinct from absent — so emit whenever `self`
  has any field OR `inventory != null`.
- `nextStepCommand` (119-133) uses `renderAuditorDescriptor`.

### Construction sites (2, both) + the 14 continue-command emitters
- `nextStepCommand.ts:295-305` (cmdNextStep) — parse one `getAuditorDescriptor`; build `AuditorDescriptor`;
  source `hostCanDispatch` from `descriptor.self.can_dispatch_subagents`; `effectiveConfig =
  applyDispatchInventory(sessionConfig, descriptor.inventory)`. Locals to collapse: nextStepCommand.ts
  236,240,243,245-250 (the getHost* results). Keep passing individual fields to runDeterministic /
  renderSemanticReviewStep (minimal downstream churn), sourced from `descriptor.self.*`.
- `semanticReviewStep.ts:139-154` — build an `AuditorDescriptor` from its `params.*` for the continue-command.
- 14 `nextStepCommand(root,artifactsDir,hostDescriptor)` emitters in nextStepCommand.ts (399,454,563,621,
  695,731,766,802,856,902,939,969,1048,1092) + prompts.ts:203,382 + semanticReviewStep.ts:155 — unchanged
  (they pass the descriptor; only its type/rendering changed).

### Host prompt assets (host constructs the FIRST `--auditor` call from these — LOAD-BEARING)
- CANONICAL source: `skills/audit-code/audit-code.prompt.md` (handshake at lines ~29-73, 104-106) — rewrite
  the `--host-models` / `--host-context-tokens` / `--host-output-tokens` instruction + the two bash examples
  to `--auditor '{"self":{"roster":[...]}}'` / `--auditor '{"self":{"context_tokens":N,"output_tokens":N}}'`.
- Regen mechanism: **NOT yet confirmed** (recon was offloaded to the free `llm` lane which was DOWN — see
  below). `npm run` has `scripts/shared/install-host-assets.mjs` wired into a script (package.json:34) and
  `src/shared/hostAssets.ts` embeds the canonical body via `canonicalBody(opts.promptBody)`. Derived assets:
  `.github/prompts/*.prompt.md`, `.github/agents/*.agent.md`, `.agent/skills/audit-code/SKILL.md`,
  `skills/audit-code/SKILL.md`. **First step for the next agent: read `scripts/shared/install-host-assets.mjs`
  + `src/shared/hostAssets.ts` to confirm whether assets are GENERATED (edit source + regen) or hand-maintained
  + drift-guarded, then update source + regen/guards together.** Drift guards: `tests/audit/host-asset-renderer-drift.test.mjs`, `tests/shared/hostAssets.test.mjs`, and wrapper `throw` guards in
  `wrapper/audit-code-wrapper-install-hosts.mjs` (~:292 asserts `--host-models`).

### Tests to rewrite (~12)
- `tests/audit/host-descriptor-roundtrip.test.mjs` (the primary — constructs descriptors, asserts render+reparse; covers inventory null-vs-`{}`).
- `tests/audit/prompt-invocation.test.mjs`, `working-directory-prompts.test.mjs` (nextStepCommand shape),
  `host-model-roster.test.mjs`, `host-bootstrap-descriptors.test.mjs`, `host-asset-renderer-drift.test.mjs`,
  `different-auditor-resume-no-inherit.test.mjs` (continue-command carries the handshake), `tests/shared/hostAssets.test.mjs`.
- `tests/remediate/cli-host-capability-flags.test.ts` — the cross-tool drift guard SCANS audit source for
  `--host-*` literals; audit loses them in G1 → **rework this test** (it currently enforces audit↔remediate flag parity; post-G1 they diverge until G6).

## Verify + ship (loop-core)
`npm run build && npm run check`; run the rewritten audit + shared suites + the remediate drift-guard test;
independent adversarial review of the diff; `node .claude/hooks/attest-loop-core-review.mjs --reviewed-by <id>
--checked "<...>"` (orchestrator dirs are loop-core); commit; push HEAD:main. Do NOT release mid-rework
(inert intermediate — matches 2a-i/2a-ii cadence).

## Blocker noted this session
Free-worker offload (to conserve Claude quota) is currently DOWN both ways: `ANTHROPIC_BASE_URL` is real
Anthropic (repair-proxy not fronting subagents — needs operator env setup), and the `llm`/NIM completion
endpoint times out / returns empty even on a trivial prompt. So the greenfield recon/impl/review can't be
offloaded right now; do it in-Claude frugally (no subagent panels) or wait for the free lane.
