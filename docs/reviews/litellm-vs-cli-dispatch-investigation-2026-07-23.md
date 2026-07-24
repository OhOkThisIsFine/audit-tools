# Why Codex & AGY don't go through LiteLLM — investigation (2026-07-23)

Owner question: "I went 9router → repair-proxy → LiteLLM to coordinate dispatching other
providers' agents (Codex, AGY). But we're not using LiteLLM for Codex and AGY. Why? How would
9router do it? What might we change?"

Short answer: **LiteLLM fronts *models*; Codex and AGY are *harnesses*.** A proxy can multiplex an
HTTP chat/completions endpoint — it cannot carry a CLI's agentic tool-loop, because there is no raw
HTTP request to intercept. So Codex/AGY are dispatched as CLI subprocesses by audit-tools' own
provider layer, and LiteLLM correctly sits underneath only the *model* lanes (single-shot NIM, and
the `claude-worker` proxy overlay). This is the already-shipped design, not a gap.

---

## 1. What we actually do today (verified against HEAD)

`~/.audit-code/sources-declared.json` declares:

| id | transport | endpoint | kind | routed via LiteLLM? |
|---|---|---|---|---|
| `codex-cli` | `codex` | `codex` | agentic | **No** — spawns `codex exec` |
| `agy-cli` | `agy` | `agy` | agentic | **No** — spawns `agy`/`gemini` |
| `nim-{glm,deepseek,minimax}-single-shot` | `openai-compatible` | `http://127.0.0.1:4000` | single_shot | **Yes** |
| `opencode-free` | `openai-compatible` | `opencode.ai/zen` | single_shot | No (its own HTTP endpoint) |
| `proxy` block | — | `http://127.0.0.1:4000` | burst_limited | Yes |

The LiteLLM config (`~/.audit-code/litellm-config.yaml`) has **zero** codex/agy/gemini entries —
`grep -i` returns nothing. It fronts NIM HTTP models only.

Confirmed by the provider code (NIM/deepseek recon over `codexProvider.ts`, `agyProvider.ts`,
`claudeWorkerProvider.ts`):

- **CodexProvider** spawns `codex exec --sandbox workspace-write --skip-git-repo-check --cd <repo>
  --add-dir <resultDir> [--model …]`, prompt piped via stdin. Direct subprocess, no HTTP, no
  base-url indirection.
- **AgyProvider** spawns `agy` (or legacy `gemini`) with `--model/--effort`, prompt via stdin. Same —
  no proxy.
- **ClaudeWorkerProvider** is the *only* provider that touches a proxy: it overlays
  `ANTHROPIC_BASE_URL=<proxy>` so a spawned `claude -p` harness runs its full agentic loop while its
  underlying model calls route onto a free backend.

## 2. Why LiteLLM can't front Codex/AGY

A LiteLLM-style proxy is an OpenAI/Anthropic-compatible **model endpoint** multiplexer: request in,
one model completion out. Codex and AGY are not model endpoints — they are **agents**: given a
prompt + a repo, they self-execute Read/Edit/Bash in a tool loop and hand back applied edits. There
is no single `chat/completions` call to proxy; the whole point of the lane is the loop the CLI runs
locally. Fronting the CLI through LiteLLM would mean *discarding the agentic loop* — i.e. throwing
away the exact capability we route to Codex/AGY for.

This is the settled architecture boundary (memory `repair-proxy-registry-and-codex-tos`): *CLI
agents can't be fronted; they are themselves harnesses.* The proxy sits **under** harnesses
(`claude-worker`'s base-url overlay), never **in front of** them.

## 3. How 9router does it (and why it's a different thing)

9router (the `open-sse` engine) *does* expose "Codex" and "Gemini CLI" as HTTP endpoints — but it
never runs the CLI binaries. It **replays the CLI's OAuth subscription credentials against the
vendor's raw model API** (NIM/deepseek recon over `open-sse/executors/codex.js`,
`gemini-cli.js`, `services/oauthCredentialManager.js`):

- Credentials are imported once from the CLI's on-disk OAuth token files (`~/.codex/auth.json`,
  gemini creds) into 9router's account store — then replayed at request time as
  `Authorization: Bearer <accessToken>` (+ `ChatGPT-Account-ID` for Codex).
- Codex → **OpenAI Responses API** (`api.openai.com/v1/responses`, `stream=true`);
  Gemini CLI → **Cloud Code Assist** (`…:streamGenerateContent`, body wrapped `{project, model,
  request}`).
- Token refresh hits the vendor OAuth token endpoint with a `refresh_token` grant; capacity errors
  rotate across imported accounts (`CODEX_SSE_ACCOUNT_FALLBACK_PATTERNS`, "selected model is at
  capacity").

So 9router fronts the **subscription's underlying model**, not the CLI's harness. It gets you a
cheap/free model channel — but the same thing we lose above: no agentic tool loop, just raw
completions. For our purposes that is functionally the *single-shot* lane, which we already have via
NIM. 9router would only add Codex/Gemini *models* as extra single-shot pools, not agentic Codex/AGY.

## 4. The ToS wall (already decided, still standing)

The 9router approach for Codex is explicitly **ruled out** by owner decision (2026-07-14, memory
`repair-proxy-registry-and-codex-tos`): using the ChatGPT/Codex *subscription* OAuth from a
non-OpenAI client violates OpenAI ToS — "don't cross it." Gemini CLI OAuth replay against Cloud Code
Assist has the same shape. ToS-clean ways to get those models are OpenRouter (paid) or free NIM
(`gpt-oss-120b`), which is already how we reach that class. **Nothing here reopens that.**

## 5. What (if anything) to change

**The core design is correct and needs no change.** The recurring "why isn't Codex on LiteLLM"
confusion comes from an implicit premise — that LiteLLM was meant to dispatch *agents*. It was
always only ever a **model transport**. Two concrete, optional follow-ups:

1. **Document the boundary so the question stops recurring** (recommended, cheap). One line in the
   sources-declared example / CLAUDE.md: *LiteLLM fronts model endpoints (single-shot NIM lanes +
   the `claude-worker` base-url overlay); agentic CLI lanes (codex/agy) are spawned directly and by
   design never route through it.* This is the real deliverable — an architecture note, not code.

2. **If the actual want is "an agentic worker on a free backend"** (which is the thing LiteLLM
   *looked* like it should give but can't), the lever is **`claude-worker`, not Codex/AGY-via-proxy**:
   declare a `claude-worker` lane whose `proxy` overlay points `ANTHROPIC_BASE_URL` at LiteLLM →
   a full Read/Edit/Bash `claude -p` loop whose model calls land on free NIM. That is the
   ToS-clean, architecturally-correct version of "route an agent through the proxy." Caveat: NIM is
   `burst_limited` and agentic loops storm 429s — which is exactly why the live config runs NIM
   single-shot only and the worker-kind × pool-class rule (v0.34.23) refuses agentic lanes on
   burst-limited backends. So this lane is viable only against a NIM tier with real burst headroom,
   or a different free backend. Track as a live-validation item, don't build speculatively.

**Not recommended:** adopting 9router's OAuth-replay engine. It's a heavy Next.js product, it buys
us only *model* channels we already have via NIM, and its Codex/Gemini channels are the ToS-blocked
path. The one idea worth stealing conceptually is **account-rotation on capacity errors** — but our
equivalent is the LiteLLM `router_settings.fallbacks` + the burst-limited refusal rule, which fit
our single-endpoint model better than importing multi-account OAuth state.

---

## Bottom line

We're "not using LiteLLM for Codex and AGY" because that's structurally impossible and undesired:
LiteLLM carries models, Codex/AGY are agents. 9router *appears* to front them only by replaying
their subscription OAuth against the vendor model API — dropping the agentic loop and (for Codex)
crossing the ToS line the owner declined. The proxy's correct scope is model transport for
single-shot NIM lanes and the `claude-worker` overlay, which is exactly where it sits today. The
only change worth making is documenting that boundary; the only latent capability worth a live test
is a burst-headroom `claude-worker`-on-proxy agentic lane.
