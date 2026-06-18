# audit-tools

Portable, hybrid code **auditing** + **remediation** orchestrators for arbitrary repositories,
shipped as one package exposing two CLIs / slash workflows:

- **`audit-code`** (`/audit-code`) — audits a codebase one bounded, backend-rendered step at a time
  and produces a findings report (`audit-findings.json` + `audit-report.md`).
- **`remediate-code`** (`/remediate-code`) — consumes that report (or free-form feedback) and applies
  fixes step by step, emitting `remediation-outcomes.json` + `remediation-report.md`.

Both are **conversation-first**: the product is the slash workflow inside a host agent; the CLI is the
backend/fallback. Each `next-step` call returns one prompt contract (JSON + markdown); the host agent
executes it and calls back for the next. State persists to an artifact directory, so runs are resumable.

## Install

```bash
npm install -g audit-tools
```

This installs both the `audit-code` and `remediate-code` bins and deploys the host slash-command assets
(Claude Code, Codex, OpenCode, Antigravity) via the package postinstall.

## Usage

```bash
audit-code next-step        # advance the audit one step
remediate-code next-step    # advance a remediation one step
```

In a host agent, drive the workflow with `/audit-code` then `/remediate-code`.

## Concepts

One pipeline, two halves: audit → findings contract; remediate → consumes + fixes. The JSON contract is
the source of truth; the markdown is its human render. Neither tool runs to completion in a single call —
each derives state, does one bounded unit of work, persists, and returns. See `CLAUDE.md` for the full
design concepts and standing decisions.

## License

ISC
