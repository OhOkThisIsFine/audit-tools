import type {
  ConfirmedPoolEntry,
  SourcePoolDisplayEntry,
  NewlyReachableBackend,
} from "audit-tools/shared";
import { PROVIDER_CONFIRMATION_INPUT_VERSION } from "audit-tools/shared";

/**
 * Render the host-facing prompt for the interactive `provider_confirmation` step
 * (Gate-0, cost-first routing — spec/cost-first-routing.md). Shows the priced,
 * suggested provider pool (ascending cost) and asks the host to confirm it, or to
 * submit an operator reorder / exclusion / host-model roster by writing
 * `provider-confirmation.input.json`. Writing that file (even to accept the
 * suggestion verbatim) is what lets the run proceed — its presence is the
 * "operator has acted" signal the gate consumes.
 *
 * The tool owns discovery + the cost annotation: the host supplies only ordering
 * intent + its model roster, and the tool promotes that into both canonical
 * artifacts. So this prompt never asks the host to hand-author prices or
 * capability flags.
 */
export function renderProviderConfirmationPrompt(opts: {
  /** The tool's suggested pool, already annotated with model_id/price/cost_order. */
  providerPool: ConfirmedPoolEntry[];
  /**
   * Every configured `sessionConfig.sources[]` pool (backlog follow-up a) —
   * display-only, derived by `deriveSourcePoolDisplay`. These are NOT part of
   * `providerPool` / its `cost_order` sequence, but `collectDispatchableSources`
   * (apiPool.ts) folds every one of them into dispatch, so they must be visible
   * here or the operator is confirming an ordering that omits pools that WILL
   * route. Omit/empty when no `sources[]` are configured.
   */
  sourcePools?: SourcePoolDisplayEntry[];
  /** Absolute path the host writes its operator input to. */
  inputPath: string;
  /** The exact command to re-invoke once the input is written. */
  continueCommand: string;
  /**
   * The G3 reconciliation delta: backends reachable now that the operator's prior
   * confirmation never mentioned. Non-empty ⇒ this is a RE-confirmation and the
   * prompt leads with the delta, so the operator answers the new question instead
   * of re-reading a whole table they already approved. Empty/absent ⇒ the ordinary
   * first-time gate.
   */
  newlyReachable?: readonly NewlyReachableBackend[];
}): string {
  const sorted = [...opts.providerPool].sort(
    (a, b) => (a.cost_order ?? Number.MAX_SAFE_INTEGER) - (b.cost_order ?? Number.MAX_SAFE_INTEGER),
  );
  const sourcePools = opts.sourcePools ?? [];

  const priceCell = (entry: ConfirmedPoolEntry): string => {
    if (entry.blended_price_usd_per_mtok == null) {
      return entry.model_id ? "price unknown" : "resolved at dispatch";
    }
    return `$${entry.blended_price_usd_per_mtok.toFixed(2)}`;
  };
  const statusCell = (entry: ConfirmedPoolEntry): string => {
    if (entry.self_spawn_blocked) return "excluded (self-spawn blocked)";
    if (entry.excluded) return "excluded";
    return "included";
  };

  const rows = sorted.map((entry) => {
    const order = entry.cost_order ?? "—";
    const model = entry.model_id ?? "—";
    return `| ${order} | ${entry.name} | ${model} | ${priceCell(entry)} | ${entry.capability_tier} | ${statusCell(entry)} |`;
  });

  const sourcePriceCell = (entry: SourcePoolDisplayEntry): string => {
    if (entry.declared_cost_per_mtok !== undefined) {
      return `$${entry.declared_cost_per_mtok.toFixed(2)} (declared)`;
    }
    if (entry.blended_price_usd_per_mtok == null) {
      return entry.model ? "price unknown" : "resolved at dispatch";
    }
    return `$${entry.blended_price_usd_per_mtok.toFixed(2)}`;
  };
  const sourceRows = sourcePools.map(
    (entry) =>
      `| ${entry.id} | ${entry.provider} | ${entry.model ?? "—"} | ${sourcePriceCell(entry)} |`,
  );

  const hasLegacyOpenAiCompatible = sorted.some((e) => e.name === "openai-compatible");
  const hasCodex = sorted.some((e) => e.name === "codex");

  const newlyReachable = opts.newlyReachable ?? [];

  return [
    ...(newlyReachable.length > 0
      ? [
          "# Reconcile Newly-Reachable Backends (Gate-0)",
          "",
          "**This is a re-confirmation, not a fresh gate.** You already confirmed a",
          "route decision for this session. Since then, these backends became",
          "reachable and your decision says nothing about them — so they are NOT",
          "dispatchable until you decide:",
          "",
          ...newlyReachable.map((b) => `  - **${b.key}**  (provider: ${b.provider})`),
          "",
          "Ask the user about **just these** — do not re-litigate the ordering they",
          "already approved. To accept them into the pool at their suggested",
          "positions, accept verbatim (write just the `schema_version`). To keep one",
          "out, name its provider in `exclude`.",
          "",
          "> Note: any submission clears this delta — the tool rebuilds the whole",
          "> confirmation from your input. The list above tells you what changed; it",
          "> is not a per-backend checklist the tool enforces.",
          "",
          "The full pool follows for reference.",
          "",
          "---",
          "",
        ]
      : []),
    "# Confirm Provider Cost Ordering (Gate-0)",
    "",
    "Dispatch routes work to the cheapest capable provider first. Below is the",
    "tool's **suggested** cost ordering — ascending real price (models.dev), with",
    "capability as the tiebreak and unpriceable pools last. Review it, then confirm,",
    "reorder, exclude, or **add a provider that wasn't auto-detected**.",
    "",
    "| # | Provider | Model | $/Mtok (blended) | Tier | Status |",
    "|---|----------|-------|------------------|------|--------|",
    ...rows,
    "",
    "- **$/Mtok (blended)** is `input·0.75 + output·0.25` from the vendored",
    "  models.dev dataset — advisory; the confirmed order is what routes.",
    '- "resolved at dispatch" = the concrete model is not knowable until dispatch',
    "  (e.g. a CLI backend); it is ordered by capability tier for now.",
    "- A host-native provider (the agent you are) has no model row until you report",
    "  your roster below — do that so your own tiers are priced + ordered here too.",
    ...(hasLegacyOpenAiCompatible
      ? [
          "- **`openai_compatible` has no cost override**: this legacy block has no",
          "  `cost_per_mtok` field, so it prices at the models.dev list price for its",
          "  model — a genuinely free/discounted endpoint (e.g. a free NIM deployment)",
          "  will price WRONG here. To declare its real cost, move it to a `sources[]`",
          "  entry instead (`{ provider: \"openai-compatible\", base_url, model,",
          '  cost_per_mtok }` — set `0` for free) — see the table below.',
        ]
      : []),
    ...(hasCodex
      ? [
          '- **codex shows "resolved at dispatch"**: its model/effort roster is not',
          "  enumerable here from the legacy `codex` block (single `model` field, no",
          "  roster). To pin + price specific codex models/efforts at this gate, add",
          '  them as `sources[]` entries (`{ provider: "codex", model, parameters:',
          '  { extra_args: [...] } }`, one per model/effort) — see the table below.',
        ]
      : []),
    "",
    ...(sourceRows.length > 0
      ? [
          "## Configured `sources[]` pools (also route)",
          "",
          "Every entry below is folded into dispatch alongside the pool above",
          "(`collectDispatchableSources`) — this is what actually routes, not just",
          "the legacy/host/CLI entries in the table above.",
          "",
          "| Source id | Provider | Model | $/Mtok |",
          "|-----------|----------|-------|--------|",
          ...sourceRows,
          "",
          "- **`$/Mtok`** marked `(declared)` is the operator's own `cost_per_mtok`",
          "  on that source — authoritative over the models.dev catalog price.",
          "",
        ]
      : []),
    "## What to do",
    "",
    "Ask the user whether the suggested ordering is right (a single, brief round).",
    "Then write the operator's decision to:",
    "",
    `  ${opts.inputPath}`,
    "",
    "Use this shape — **every field is optional beyond `schema_version`**. To accept",
    "the suggestion verbatim, write just the version:",
    "",
    "```json",
    "{",
    `  "schema_version": "${PROVIDER_CONFIRMATION_INPUT_VERSION}",`,
    '  "cost_order": ["<provider-or-model-key>", "..."],',
    '  "exclude": ["<provider-name>"],',
    '  "include": ["<self-spawn-blocked provider to opt back in>"],',
    '  "host_models": [{ "model_id": "<your model id>", "tier": "frontier|capable|fast" }],',
    '  "dispatch_bias": 0',
    "}",
    "```",
    "",
    "- `cost_order` is the confirmed ordering, cheapest first, as a list of keys —",
    "  a **provider name** (as shown above) and/or a **host `model_id`** you report",
    "  in `host_models`. Its index becomes each pool's `cost_order`. Keys you omit",
    "  keep their suggested relative order, appended after the ones you name; keys",
    "  the tool doesn't recognize are ignored. Omit `cost_order` to accept the",
    "  suggestion.",
    "- `host_models` reports YOUR (the host agent's) model roster so those tiers are",
    "  priced from models.dev and confirmable here — otherwise they are priced only",
    "  at dispatch. Each reported `model_id` can appear in `cost_order`.",
    "- `exclude` drops a provider from the dispatchable pool; `include` opts a",
    "  self-spawn-blocked provider back in (advanced — normally leave it excluded).",
    "- `dispatch_bias` (λ ∈ [0,1]) is the cost↔speed operating point: **0 (default) =",
    "  cheapest-first**; **1 = fastest-first** (route to the highest-throughput capable",
    "  pool regardless of price); values between blend the two. Capability is always a",
    "  hard floor. Omit to keep cheapest-first.",
    "- **Missing a provider you use?** If it isn't listed, it wasn't auto-detected.",
    "  Add its config to session config and it joins the pool: an OpenAI-compatible",
    "  endpoint via `openai_compatible.{base_url,model,api_key_env}`, or a CLI",
    "  backend via its `<name>.command`. A provider detected but self-spawn-blocked",
    "  can be re-included with `include`. Then re-run this step.",
    "- The tool owns pricing, discovery, and the capability flags — you",
    "  supply only ordering intent + your model roster.",
    "",
    `Then run: ${opts.continueCommand}`,
    "",
  ].join("\n");
}
