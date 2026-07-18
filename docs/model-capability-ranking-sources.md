# Capability-rank sources for the dispatch router — market survey

**As-of 2026-07-18. This is a dated survey, not a durable concept doc** — it feeds the ranker-contract
decision. Once a source is chosen, the durable part (the seam shape) belongs in memory/design; this file
can be re-run or retired.

**Question.** The router consumes models.dev for PRICE + CONTEXT WINDOW. It needs the QUALITY/CAPABILITY
axis, ideally an AGENTIC/TOOL-USE signal specifically (workers run Read/Edit/Bash loops), from a
machine-readable, someone-else-maintained source.

**Verification method.** Every claim below was checked against a live endpoint on 2026-07-18 — the
OpenRouter and LMArena numbers come from payloads actually fetched and parsed, not from a summarizer.

---

## Verdict up front

**Nothing cleanly satisfies all five criteria.** The blocker is criterion 4, not criterion 1: the only
source with a real per-model agentic score across the open roster is Artificial Analysis, whose free/Pro
tiers are *internal use only, no redistribution*. Everything that IS freely redistributable (LMArena,
Epoch) uses free-text display names and covers less of the roster.

The split that resolves it: **treat the AA-derived rank as runtime-fetched, never vendored** — which is a
different consumption pattern than models.dev, and the one real design consequence of this survey.

---

## Ranked shortlist

### 1. OpenRouter `/api/v1/models` — RECOMMEND (primary signal, runtime-fetch only)

| | |
|---|---|
| Endpoint | `https://openrouter.ai/api/v1/models` — no auth, no key, edge-cached, documented |
| Payload | 344 models, ~530 KB |
| Id scheme | `provider/model` — **the exact strings the router dispatches on** |
| Agentic signal | **`benchmarks.artificial_analysis.agentic_index`** — present on 104/344 models |
| Also carries | `intelligence_index` (103), `coding_index` (112), `design_arena` elo |
| Liveness | Continuous; a commercial company's core product surface |

**Roster coverage: 9/9, every one with an agentic score.** Verified by parsing the live payload:

| Target | Resolves to | Join | agentic_index |
|---|---|---|---|
| `z-ai/glm-5.2` | `z-ai/glm-5.2` | exact id | 43.1 |
| `deepseek-ai/deepseek-v4-pro` | `deepseek/deepseek-v4-pro` | `hugging_face_id` | 36.4 |
| `deepseek-ai/deepseek-v4-flash` | `deepseek/deepseek-v4-flash` | `hugging_face_id` | 31.1 |
| `qwen/qwen3.5-397b-a17b` | `qwen/qwen3.5-397b-a17b` | exact id | 19.8 |
| `moonshotai/kimi-k2.6` | `moonshotai/kimi-k2.6` | exact id | 30.3 |
| `minimaxai/minimax-m3` | `minimax/minimax-m3` | `hugging_face_id` | 35.4 |
| `nvidia/nemotron-3-super-120b-a12b` | (exact) | exact id | 8.7 |
| `openai/gpt-oss-120b` | (exact) | exact id | 13.2 |
| `stepfun-ai/step-3.7-flash` | `stepfun/step-3.7-flash` | `hugging_face_id` | 21.5 |

**Criterion 3 is fully solved — no fuzzy matching.** A two-key deterministic join covers all nine:
exact `id`, else case-insensitive `hugging_face_id` (present on 156/344). The NIM-style namespaces the
roster uses (`deepseek-ai/`, `minimaxai/`, `stepfun-ai/`) differ from OpenRouter's (`deepseek/`,
`minimax/`, `stepfun/`), and `hugging_face_id` bridges exactly that gap. No string-distance heuristics.

The scores discriminate the way a router needs: `gpt-oss-120b` at 13.2 vs `glm-5.2` at 43.1 vs
`kimi-k3` at 50.1 is precisely the "don't send hard work to a weak model" axis, and the agentic spread is
*wider* than the intelligence spread (agentic 1.5→50 vs intelligence 15→57), so it separates better.

**The catch — read this before designing around it.** The valuable fields are Artificial Analysis data
re-served by OpenRouter. AA's free tier is "internal use only; no redistribution." Reading at runtime is
fine. **Committing a snapshot of the AA-derived fields into this repo is redistribution of AA's data via
a third party** — the models.dev vendoring pattern does NOT transfer here. Also: OpenRouter's ToS
prohibits *scraping*, but this is a documented public JSON API, not scraping — the anti-scrape clause
targets the site, not the API. Separately, `agentic_index` is undocumented in OpenRouter's own schema
docs, so it is a field that could disappear without notice → the consumer must degrade cleanly on absence.

**Verdict: RECOMMEND** as the primary signal, with a hard constraint — runtime-fetch + short-TTL cache,
never a vendored snapshot of the AA sub-fields.

### 2. Epoch AI Benchmarking Hub — RECOMMEND (the cacheable layer)

| | |
|---|---|
| Access | `https://epoch.ai/data/benchmark_data.zip`; also `pip install epochai` (Airtable-backed) |
| License | **Creative Commons Attribution — free to use, distribute, reproduce with credit** |
| Liveness | **Updated 2026-07-18 — today.** Funded org, not a solo maintainer |
| Agentic signal | Yes, aggregated — Terminal-Bench 2.0, SWE-bench Verified, Aider Polyglot |
| Id scheme | Free-text display names → **needs a mapping layer** |

This is the **only source that is both fresh and cleanly vendorable**, which makes it the answer to
OpenRouter's licensing constraint rather than a competitor to it. It also legitimately relays
Terminal-Bench, whose own site is scrape-only.

The **Epoch Capabilities Index (ECI)** is a composite over 50+ benchmarks yielding a single calibrated
capability scale — literally the "one capability rank per model" primitive the router wants. Caveats:
inclusion requires ≥4 benchmark evals and targets plausibly-frontier models, so the long-tail open models
(nemotron-super, gpt-oss-20b, step-3.7) may be missing; and ECI's data (vs. its code) placement was not
confirmed on the page.

**Verdict: RECOMMEND** as the cacheable/vendorable layer. Costs a name-mapping layer that OpenRouter
doesn't.

### 3. LMArena `lmarena-ai/leaderboard-dataset` — VIABLE-WITH-CAVEATS

| | |
|---|---|
| Access | HF dataset, parquet; rows API works: `datasets-server.huggingface.co/rows?dataset=lmarena-ai%2Fleaderboard-dataset&config=agent&split=latest` (note **split is `latest`/`full`, not `train`**) |
| License | **CC-BY-4.0 — redistribution permitted** |
| Liveness | `leaderboard_publish_date` 2026-07-13, five days old |
| Agentic signal | **Yes, and unusually well-targeted** — an Agent Arena live since 2026-06-04 |

The agentic decomposition is the best-aimed signal found anywhere for this specific use case: subsets for
`agent_bash_recovery_steps`, `agent_tool_hallucination`, `agent_steerability`,
`agent_task_outcome_explicit`. "Recovers from a failed bash command" and "doesn't hallucinate tools" are
*exactly* the failure modes of a Read/Edit/Bash worker loop — a closer match to the actual workload than
AA's single blended `agentic_index`.

**But coverage and identity are both weak.** Verified against the live `agent`/`latest` split: only
**34 models total**, free-text names (`"GLM 5.2 (Max)"`, `"DeepSeek V4 Pro"`, `"Nemotron 3 Ultra"`).
Roster hits: GLM 5.2 ✓, DeepSeek V4 Pro/Flash ✓, Kimi K2.6 ✓, Minimax M3 ✓, Nemotron 3 Ultra (not the
Super the roster names) — but **no gpt-oss, no stepfun, no qwen3.5-397b**. So ~6/9, requiring fuzzy
matching, on a scale where scores are signed Bradley-Terry coefficients (Claude Fable 5 at 0.139 down to
Nemotron at -0.137) rather than an intuitive 0-100.

**Verdict: VIABLE-WITH-CAVEATS.** Best-shaped agentic signal + a redistributable license, undermined by
34-model coverage and free-text ids. Good as a *corroborating* signal on the models it does cover.

### 4. llm-stats.com — VIABLE-WITH-CAVEATS (best license, worst trust)

ToS is the most permissive found: *"view, copy, modify, share, and republish... including for commercial
purposes"* with attribution. But: the API is served from `api.zeroeval.com/stats/v1/` — **a different
commercial entity than the one whose ToS you are relying on**; it requires auth despite being "free";
and it is an *aggregator that re-publishes other benchmarks' numbers*, so **its permissive ToS cannot
cure AA's no-redistribution terms on AA-derived scores** — you can't license out what you don't own.
Its freshness labels were also observed to be wrong (a page claiming a July 2026 update while showing a
2025-era result). **VIABLE-WITH-CAVEATS**, but the trust problems make it a poor primary.

### 5. SWE-rebench (Nebius) — VIABLE-WITH-CAVEATS

HF `nebius/SWE-rebench-leaderboard`, **CC-BY-4.0**, continuously updated, and the **best open-model
coverage of any benchmark here** (added GLM 5.2, DeepSeek-V4 Pro/Flash, MiniMax M3, Qwen3.6 variants in
2026). Agent-confounded (measures scaffold+model) and single-vendor maintained. Useful to fill the
open-model tail Epoch's frontier bias leaves.

---

## Rejected — with the specific reason

| Source | Verdict | Reason |
|---|---|---|
| **Artificial Analysis direct** | REJECT for caching | Has the right data (Intelligence/Coding/**Agentic** indices, stable ids, v4.1 explicitly reweighted toward agentic). Free tier = **"internal use only; no redistribution"**; redistribution is a Commercial-tier license. Fails criterion 4 outright. Free tier is also only 100 req/day. |
| **models.dev** | N/A — confirmed gap | Re-verified `api.json` field set: `id, name, attachment, reasoning, tool_call, interleaved, temperature, knowledge, release_date, last_updated, modalities, open_weights, limit, cost`. **No quality/benchmark/rank field has been added.** Capability is only implied via boolean flags + cost tier. The gap is real. |
| **LiveBench** | REJECT | Repo alive (pushed 2026-07-17) and has a genuine *Agentic Coding* category — but **no published results file**; HF datasets are raw per-question judgments last touched Mar 2025. Site is a JS-rendered SPA → scrape-only → disqualifying. Best signal, no tap. |
| **Aider polyglot** | REJECT | Clean machine-readable YAML at a stable raw-GitHub URL, Apache-2.0 — but **the data is dead**: last touched 2025-10-04, zero roster models. Sole maintainer visibly gone dark (issue #4613). Bus factor 1. |
| **SWE-bench / Verified** | REJECT | `leaderboards.json` exists (note branch is `master`, not `main`) but repo license is unresolved "Other" → redistribution not granted. **Fatal: rows are agent-scaffold+model pairs**, not models — can't derive a per-model rank without confounding the scaffold. |
| **Terminal-Bench** | REJECT direct | No official API; leaderboards are web pages. The "Terminal-Bench API" on parse.bot is a **third-party scraper wrapper** — exactly the undocumented-middleman trap. Get Terminal-Bench via Epoch instead. |
| **HELM** | REJECT | **Entered maintenance mode 2026-06-01** (stated in repo README). Never had a clean JSON export; two export-request issues went unresolved. |
| **HF Open LLM Leaderboard** | REJECT | **Dead.** Space retitled "Archived"; HF explicitly declined to name a successor. |
| **BFCL v4** | REJECT as a feed | The benchmark is live and relevant (updated July 2026, function-calling + agentic). But the HF dataset ships **evaluation inputs, not leaderboard results** — results live on the Gorilla HTML leaderboard, and it covers only ~13 models. Wrong artifact for a router. |

---

## Recommended combination

Two layers, because no single source clears all five criteria:

1. **OpenRouter `/api/v1/models` — primary, runtime-fetched, never vendored.** Right id scheme (zero
   fuzzy matching via the id + `hugging_face_id` two-key join), no auth, 9/9 roster coverage with a real
   agentic score. The licensing constraint is a *consumption-pattern* constraint, not a disqualifier.
2. **Epoch AI (CC-BY) — the vendorable snapshot layer**, for a durable legally-clean rank that survives
   an OpenRouter outage or an `agentic_index` field removal. Costs a name-mapping layer.
   **SWE-rebench (CC-BY)** fills the open-model tail Epoch's frontier bias misses.

**The consequence worth flagging to the design:** the capability axis cannot be handled the way
models.dev is handled. Price/context are vendorable; the capability rank is not. That asymmetry — one
axis vendored, one axis runtime-fetched with a cached fallback — is the actual contract shape this survey
implies, and it is a genuine design decision rather than a lookup detail.

This does not violate the never-hand-maintain-a-table rule: both layers are someone-else-maintained, and
the two-key join map is a mechanical alias bridge, not a curated capability table.
