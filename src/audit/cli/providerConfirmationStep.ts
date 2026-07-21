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
  /**
   * The capability-evidence delta: dispatchable models with no resolvable capability
   * rank. Non-empty ⇒ the prompt additionally asks for a most-capable-first ordering
   * over exactly these models, which persists as `capability_rank` and stops them
   * fail-opening at the admission capability floor.
   */
  unevidencedCapability?: readonly string[];
  /**
   * A BOUNDED, spread sample of the already-confirmed capability ordering
   * (`selectCapabilityAnchors`), most-capable-first — the fixed reference points the
   * operator ranks the unevidenced models against.
   *
   * Without them the capability ask is unanswerable without livelocking: the prompt is
   * delta-scoped, so an answer over the new models alone used to REPLACE the confirmed
   * ordering and the models it dropped came straight back as the next delta. Rendering
   * the whole ordering instead is not an option — the roster may be hundreds of models
   * and this prompt must stay O(new + constant). Empty on a first-ever ranking.
   */
  capabilityAnchors?: readonly string[];
  /**
   * True ⇒ a prior confirmation exists on disk, i.e. this is a RE-confirmation.
   *
   * Drives the do-not-re-litigate guardrail INDEPENDENTLY of the reach delta. It used to
   * ride on `newlyReachable`, so a capability-only re-prompt rendered the full table with
   * no warning at all — while also telling the operator that an omitted field keeps its
   * confirmed value. An operator transcribing the displayed ordering into `cost_order`
   * then silently reverted their own confirmed order.
   */
  hasPriorConfirmation?: boolean;
  /**
   * R3-3: true on an autonomous (no-operator) run. Only changes rendering when
   * `unevidencedCapability` is non-empty — addresses that section to the HOST LLM
   * (an autonomous run has no operator to ask, but the CLI's `next-step` prompt is
   * always executed by a host agent, so THAT is who ranks) instead of an operator,
   * and OMITS the reach-reconciliation section entirely: reach is never an LLM's
   * call to make (`intakeExecutors.ts`'s executor fails it closed regardless of
   * what an LLM-authored submission says), so the prompt must not ask one to answer
   * a question it must not answer. Absent/false renders the ordinary operator
   * variant, unchanged.
   */
  autonomous?: boolean;
  /**
   * R3-3: anchor ids whose current position is LLM-authored rather than
   * operator-authored (`ConfirmedDispatchPolicy.capability_order_llm_ranked`).
   * Drives the ATTENDED variant's anchor marker only — an operator sees
   * "(LLM-ranked — restate it in your order to reposition it)" instead of
   * "(already ranked)" for these, since (unlike a genuinely operator-ranked
   * anchor) they may freely reposition one without restating the whole roster.
   * Has no effect on the autonomous variant (the LLM must not reorder ANY anchor,
   * regardless of who ranked it) or when the id is not among `capabilityAnchors`.
   */
  capabilityOrderLlmRanked?: readonly string[];
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
      `| ${entry.id} | ${entry.transport} | ${entry.model ?? "—"} | ${sourcePriceCell(entry)} |`,
  );

  const hasLegacyOpenAiCompatible = sorted.some((e) => e.name === "openai-compatible");
  const hasCodex = sorted.some((e) => e.name === "codex");

  const newlyReachable = opts.newlyReachable ?? [];
  const unevidencedCapability = opts.unevidencedCapability ?? [];
  const autonomous = opts.autonomous === true;
  const llmRankedAnchors = new Set(opts.capabilityOrderLlmRanked ?? []);
  // Anchors must be disjoint from the models under question — one cannot be both a
  // settled reference point and the thing being ranked.
  const unevidencedSet = new Set(unevidencedCapability);
  const capabilityAnchors = (opts.capabilityAnchors ?? []).filter(
    (model) => !unevidencedSet.has(model),
  );
  // The combined set the operator returns ONE ordering over. Anchors first, in their
  // confirmed order, with the new models appended: a complete, acceptable file that a
  // host may copy verbatim, defaulting the unranked models to LEAST capable — the
  // conservative direction if the host does not move them.
  const capabilityAnswerExample = [...capabilityAnchors, ...unevidencedCapability];
  // R3-3: the ATTENDED variant marks an LLM-ranked anchor distinctly — an operator
  // may freely reposition one without restating the whole roster, unlike a
  // genuinely operator-ranked anchor. The autonomous variant never marks it: the
  // LLM must not reorder ANY anchor, regardless of who ranked it.
  const anchorLine = (model: string): string =>
    !autonomous && llmRankedAnchors.has(model)
      ? `  - \`${model}\`  (LLM-ranked — restate it in your order to reposition it)`
      : `  - \`${model}\`  (already ranked)`;

  // The capability block is ADDITIVE to whatever gate section follows — a run can owe
  // both a reach reconciliation and a capability ordering, and folding them into one
  // prompt is what keeps this a single operator round-trip.
  const capabilitySection =
    unevidencedCapability.length > 0
      ? [
          "## Rank these models by capability",
          "",
          ...(autonomous
            ? [
                "**You (the host agent) must rank these models by capability for agentic",
                "code-audit work** — an autonomous run has no operator to ask. This is LLM",
                "judgment, recorded as provenance; a later operator confirmation can",
                "reorder anything you rank. Rank on what you know of each model's",
                "demonstrated coding/agentic capability; if you genuinely do not know a",
                "model, place it conservatively LOW and note that in the ordering (an",
                "explicit recorded judgment, never a silent guess).",
                "",
              ]
            : [
                "No rank source covers these dispatchable models, so the admission",
                "capability floor currently **fails open** on them — they are eligible for",
                "`deep` work they may be entirely unfit for:",
                "",
              ]),
          ...unevidencedCapability.map((model) => `  - \`${model}\``),
          "",
          ...(capabilityAnchors.length > 0
            ? [
                "These models are **already ranked** — they are FIXED REFERENCE POINTS,",
                "shown in their confirmed order (most capable first) so you can place the",
                "models above relative to them. They are a bounded sample spread across the",
                "full ranking, not the whole ranking:",
                "",
                ...capabilityAnchors.map(anchorLine),
                "",
                "Answer with `capability_order`: **one ordering over the combined set**,",
                "most capable first — the unranked models interleaved among the reference",
                "points wherever they belong.",
                "",
                "> Reordering the reference points against each other has no effect: they",
                "> anchor a ranking you are only seeing a sample of, so a swap between two",
                "> of them carries no information about the models in between. Move the",
                "> **unranked** models; leave the anchors where they are.",
                "",
                "> Models you do not mention keep the rank they already have — you never",
                "> need to restate the whole ranking, and omitting one never clears it.",
                "",
              ]
            : [
                "Answer with `capability_order`: these model ids, **most capable first**.",
                "",
              ]),
          // `schema_version` is NOT optional here even though every other field is:
          // `parseProviderConfirmationInput` rejects the whole file without it, the
          // rejection is indistinguishable from "no submission", and this same prompt
          // then re-emits — the infinite-re-prompt livelock, reintroduced by a host
          // that did exactly what the prompt showed it. A fragment a host may copy
          // verbatim must be a COMPLETE, acceptable file.
          "```json",
          "{",
          `  "schema_version": "${PROVIDER_CONFIRMATION_INPUT_VERSION}",`,
          `  "capability_order": [${capabilityAnswerExample
            .map((m) => JSON.stringify(m))
            .join(", ")}]`,
          "}",
          "```",
          "",
          "Write it to the same file as the ordering below — one submission answers",
          "both. Any field you omit keeps the value you confirmed previously; it is",
          "not reset.",
          "",
          "This is a **relative ordering only** — rank them against each other. Do not",
          "invent an absolute score or a tier; there is no field for one. If you",
          "genuinely cannot rank a model, still place it (a considered guess beats a",
          "fail-open) and say so to the user.",
          "",
          "> Ordering is not inclusion. To keep a model OUT of the pool entirely, use",
          "> `exclude` — `capability_order` only decides what it is trusted with.",
          "",
        ]
      : [];

  return [
    ...capabilitySection,
    // R3-3: OMITTED entirely on the autonomous variant, regardless of the reach
    // delta's actual content — reach is never an LLM's call to make (see
    // `intakeExecutors.ts`'s executor, which fails it closed no matter what an
    // LLM-authored submission says), so the prompt must not invite an answer to a
    // question it must not answer. It is not deferred or summarized here; the
    // reach delta simply waits for a later ATTENDED re-confirmation.
    ...(newlyReachable.length > 0 && !autonomous
      ? [
          "# Reconcile Newly-Reachable Backends (Gate-0)",
          "",
          "**This is a re-confirmation, not a fresh gate.** You already confirmed a",
          "route decision for this session. Since then, these backends became",
          "reachable and your decision says nothing about them — so they are NOT",
          "dispatchable until you decide:",
          "",
          // The exclusion RULE is rendered beside each backend, not left for the
          // operator to compose: the grammar is model-granular, so a hand-written
          // rule is exactly where an operator (or a host relaying for them) drops
          // the model and rules out the whole provider by accident.
          ...newlyReachable.map(
            (b) =>
              `  - **${b.key}**  (provider: ${b.provider}` +
              ` — to keep it out: \`"exclude": ["${b.exclusion_pattern}"]\`)`,
          ),
          "",
          "Ask the user about **just these** — do not re-litigate the ordering they",
          "already approved. To accept them into the pool at their suggested",
          "positions, accept verbatim (write just the `schema_version`). To keep one",
          "out, name its **exclusion rule** (shown beside it) in `exclude` — that",
          "rules out exactly that backend, not its siblings.",
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
    // The SAME guardrail, on the branch that used to go without one. It rode on
    // `newlyReachable`, so a capability-only re-prompt rendered the full table with no
    // warning — while the capability block newly promises that an omitted field keeps
    // its confirmed value. An operator transcribing the displayed ordering back into
    // `cost_order` then reverted their own confirmed order, silently. Enforced here in
    // the tool rather than left to the operator noticing.
    ...(opts.hasPriorConfirmation === true && newlyReachable.length === 0
      ? [
          "# This is a RE-confirmation",
          "",
          "You already confirmed a route decision for this session. The table below",
          "reflects **what you confirmed** — do not re-litigate it. Answer only the",
          "question(s) above.",
          "",
          "**Every field you omit keeps the value you confirmed previously.** Do not",
          "transcribe the table back into `cost_order` to \"keep\" it: restating an",
          "ordering you are not changing is how a confirmed order gets reverted by",
          "accident. To change nothing but the answer above, write just that field.",
          "",
          "---",
          "",
        ]
      : []),
    "# Confirm Provider Cost Ordering (Gate-0)",
    "",
    "Dispatch routes work to the cheapest capable provider first.",
    "",
    ...(opts.hasPriorConfirmation === true
      ? [
          "Below is the ordering **as you confirmed it** (the table is rendered from your",
          "persisted decision, not from a fresh suggestion). Leave it alone unless you",
          "actually want to change it.",
        ]
      : [
          "Below is the tool's **suggested** cost ordering — ascending real price",
          "(models.dev), with capability as the tiebreak and unpriceable pools last.",
          "Review it, then confirm, reorder, exclude, or **add a provider that wasn't",
          "auto-detected**.",
        ]),
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
    // R3-3: the autonomous variant documents ONLY the field the executor will read.
    // The executor strips everything else from an LLM-authored submission (see
    // `runProviderConfirmationAutoComplete`'s sanitize step) — documenting the full
    // operator field set here would invite answers to questions the LLM was not
    // asked (an `include` "fixing" an exclusion whose reach-section rationale this
    // variant deliberately omits), which the tool would then have to loudly drop.
    ...(autonomous
      ? [
          "Write your capability ranking to:",
          "",
          `  ${opts.inputPath}`,
          "",
          "```json",
          "{",
          `  "schema_version": "${PROVIDER_CONFIRMATION_INPUT_VERSION}",`,
          '  "capability_order": ["<model-id, most capable first>", "..."]',
          "}",
          "```",
          "",
          "`capability_order` is the ONLY field read from an autonomous submission —",
          "exclude/include/cost_order/host_models/dispatch_bias are operator decisions",
          "and are stripped (and reported) if present.",
          "",
          `Then run: ${opts.continueCommand}`,
          "",
        ]
      : [
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
    '  "capability_order": ["<model-id>", "..."],',
    '  "exclude": ["<provider>:<model>", "<provider>", "<endpoint-host>"],',
    '  "include": ["<self-spawn-blocked provider to opt back in>"],',
    '  "host_models": [{ "model_id": "<your model id>" }],',
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
    "- `exclude` drops backends from the dispatchable pool. Each entry is a rule, at",
    "  whatever granularity you mean: `openai-compatible:gpt-oss-120b` rules out that",
    "  **model** (leaving the provider's other models routable — prefer this, you are",
    "  confirming model choices); a bare `codex` rules out the whole **provider**; a",
    "  bare `integrate.api.nvidia.com` (or `localhost:8000`) rules out every source at",
    "  that **endpoint host**. A rule that matches nothing is inert.",
    "  `include` opts a self-spawn-blocked provider back in (advanced — normally",
    "  leave it excluded).",
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
        ]),
  ].join("\n");
}
