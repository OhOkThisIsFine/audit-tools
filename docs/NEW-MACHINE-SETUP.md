# New-machine setup — audit-tools

> **Hand this to a fresh Claude Code agent on the new machine.** Once you've cloned the repo it lives at
> `docs/NEW-MACHINE-SETUP.md`, so the only thing you paste manually is the clone command in Tier 1; after that
> the agent can read the rest from here. Same Claude login = same agent. This restores the repo **and** the
> machine-local bits that don't travel with `git clone`.
>
> Verified against the source machine (Windows, Node 26, npm 11, gh 2.90). Adapt shell syntax to the new box —
> commands below are bash/Git-Bash; PowerShell equivalents are noted where they differ.

---

## 0. What you (the human) bring / have ready

Git, the repo, and `.claude/hooks` + `.claude/skills` all travel with the clone. These do **not**:

- **Node 20+**, **git**, and the **`gh` CLI** installed on the new machine.
- **Same Claude Desktop login** (you said you'll do this) → the agent's auth.
- **From the OLD machine's `~/.claude/` (machine-local, outside the repo):**
  - `~/.claude/CLAUDE.md` — your global instructions (caveman mode, the `llm` tools, pipeline-ownership).
  - `~/.claude/projects/C--Code-audit-tools/memory/` — the **persistent project memory** (cross-session context;
    `MEMORY.md` + the per-fact `*.md` files). *Optional but recommended* — the in-repo `docs/HANDOFF.md` already
    carries the essential state, so you continue fine without it, just with less richness.
- **Secret values** to set as env vars on the new box (never in a file): `NVIDIA_API_KEY` (only for the NIM
  provider). gh uses its own login, not a committed token.
- **(Optional, Tier 3)** the `headroom` binary for the new OS, if you want headroom.

> **OS note up front.** The source machine is Windows. If the new box is Linux/macOS: `npm install` rebuilds
> `node_modules` fine; the **`headroom` binary and the global CLI bins need the matching-platform build**; mind
> CRLF (the repo is LF-normalized) and make `.claude/hooks/*` executable (`chmod +x`). A **Linux** new machine is
> the *ideal* place to fix the in-flight slice-2b bug — it lacks the `~/.audit-tools/analyzer-cache` that masks
> the failure on Windows (see `docs/HANDOFF.md` ⚠️ block).

---

## 1. Clone + build + verify (agent runs this) — enough to continue the work

```bash
# Clone with the remote named `audit-tools` (NOT origin), default branch main:
git clone -o audit-tools https://github.com/OhOkThisIsFine/audit-tools.git
cd audit-tools
git fetch audit-tools slice-2b-wip        # the in-flight branch (see step 5)

# Install + build + typecheck:
npm install
npm run build
npm run check                              # zero errors expected
```

Verify green — **CLAUDECODE must be unset** for a true-green run (one provider test fails with it set). Git-Bash:
`( unset CLAUDECODE; <cmd> )`; PowerShell: `$env:CLAUDECODE=$null` before the command.

```bash
( unset CLAUDECODE; npm run test:shared )   # shared
( unset CLAUDECODE; npm run test:audit )    # audit
( unset CLAUDECODE; npm run test:remediate )  # remediate
```

GitHub access for PRs / releases / CI:

```bash
gh auth login        # same account: OhOkThisIsFine/audit-tools
```

**At this point you can continue the work.** No further setup is required to write code, run tests, or ship.

---

## 2. Restore the Claude working environment (memory + global instructions)

Copy from the old machine into the same paths under the new user's home (USB / cloud / scp):

```bash
# global instructions:
cp  <old>/.claude/CLAUDE.md                                   ~/.claude/CLAUDE.md
# persistent project memory (the whole dir):
cp -r <old>/.claude/projects/C--Code-audit-tools/memory       ~/.claude/projects/C--Code-audit-tools/memory
```

That's it for continuity — same Claude login (done) + these two restore your global prefs and the cross-session
memory. (`.claude/settings.local.json` — permissions allow-list — is gitignored and machine-local; you'll just
re-approve a few permission prompts on the new box. No work is lost.)

---

## 3. Optional infra — "headroom etc." (only if you use these)

### `llm` worker tools (`llm read` / `llm write`, referenced in your global CLAUDE.md)
```bash
npm i -g llm-worker-tools          # provides the `llm` bin
llm models                         # sanity-check it resolves a backend
```
The backend is your local LLM, configured via env/flags (no config file on the source box) — point it at the same
backend you use on the old machine.

### headroom
`headroom` on the source machine is a **standalone native binary** at `~/.local/bin/headroom` (not npm/pip), wired
in two ways:
- **headroom MCP server** — the active piece (`mcp__headroom__*` tools). Put the matching-OS `headroom` binary on
  PATH, then register its MCP entry with Claude (re-add the same MCP server you had, or copy the headroom block
  from the old `~/.claude.json` / `~/.claude/mcp.json` and fix the binary path). The MCP config is machine-local
  and may contain machine-specific paths/tokens — prefer re-registering over a blind copy.
- **headroom proxy** — currently **OFF**: on the source box `ANTHROPIC_BASE_URL=https://api.anthropic.com` (the
  real API), so the proxy on `127.0.0.1:8787` is not in the loop. **Leave `ANTHROPIC_BASE_URL` unset / at the
  default** unless you deliberately turn the proxy on. (If you do: start the headroom proxy and set
  `ANTHROPIC_BASE_URL=http://127.0.0.1:8787`.)

> `opentoken` / `@mrgray17/opentoken-mcp` are also globally installed on the old box but are **legacy** (headroom
> superseded them) — do **not** reinstall them.

### NIM provider (optional)
```bash
export NVIDIA_API_KEY=<your key>   # PowerShell: $env:NVIDIA_API_KEY="<your key>"  — never commit it
```

### Global slash-command bins (to run `/audit-code` · `/remediate-code` and the CLIs)
```bash
npm i -g --allow-scripts=audit-tools audit-tools
audit-code --version && remediate-code --version     # expect 0.30.0
```
The **`--allow-scripts` flag is required** — npm silently defers the postinstall (host-integration deploy) on a
`-g` install otherwise.

---

## 4. Continue the in-flight work

For the current state, read **[`docs/HANDOFF.md`](HANDOFF.md)** — it always carries the live HEAD, the
published version, and the immediate next steps. (This file is the durable *setup procedure* only; it
deliberately holds no point-in-time state snapshot, which would just go stale next to the handoff.)

`docs/backlog.md` is the program of record; `CLAUDE.md` holds the durable conventions (green-at-every-commit,
build-shared-first, the `/ship` flow).
