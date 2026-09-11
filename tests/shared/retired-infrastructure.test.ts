// Contract test for `scripts/check-retired-infrastructure.mjs` — the gate that
// ties a RETIREMENT to the trap entries still naming the retired thing.
//
// Why the mechanism exists, in one line: eight `durable-traps.md` entries
// documented the FreeLLMAPI router as though it were live for twelve days after
// it was retired, and the file is a standing REFERENCE a session reads to
// decide what to RUN — so a stale entry there costs a wrong action (the
// machine-wide `CLAUDE.md` warns that one of them would RESTART the retired
// service). They were found by an incidental scope audit, which is the defect:
// the property is "an entry naming infrastructure that no longer exists is
// deleted or dated when that infrastructure RETIRES, driven by the retirement
// rather than by someone later noticing."
//
// These live under tests/shared (not beside the script) for the same reason the
// other gate contracts do: the registry's `forms` fixtures are driven over the
// REAL recognizer by tests/shared/guard-form-reach.test.ts, and a test placed
// outside tests/ never runs in CI.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { spawnSyncHidden } from '../helpers/spawn.mjs';
import {
  EXEMPT_MARKER,
  SCANNED_DOCS,
  findRetiredMentions,
} from '../../scripts/check-retired-infrastructure.mjs';
import { RETIRED_INFRASTRUCTURE } from '../../scripts/shared/retired-infrastructure-data.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'check-retired-infrastructure.mjs');

describe('retired-infrastructure — the register is well-formed data', () => {
  it('every row carries a stable id, a retirement date, a replacement and ≥1 pattern', () => {
    expect(RETIRED_INFRASTRUCTURE.length).toBeGreaterThan(0);
    const ids = RETIRED_INFRASTRUCTURE.map((r) => r.id);
    expect(new Set(ids).size, 'ids double as the exemption marker key, so they must be unique').toBe(
      ids.length,
    );
    for (const row of RETIRED_INFRASTRUCTURE) {
      expect(row.id, JSON.stringify(row)).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(row.retired, `${row.id} must carry the ISO date it went`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // The replacement is the load-bearing field: an entry naming dead
      // infrastructure and no successor still sends the reader to a wrong action.
      expect(row.replacedBy.length, `${row.id} must say what replaced it`).toBeGreaterThan(0);
      expect(row.patterns.length).toBeGreaterThan(0);
      for (const { name, pattern } of row.patterns) {
        expect(pattern, `${row.id}/${name}`).toBeInstanceOf(RegExp);
        expect(name.length).toBeGreaterThan(0);
      }
    }
  });

  it('matches the retired identifiers and nothing else', () => {
    // The live replacement must NOT trip the register, or the gate reds every
    // doc that documents the thing that replaced the retired one.
    expect(findRetiredMentions('llm-relay on `127.0.0.1:8791` serves the lanes')).toEqual([]);
    expect(findRetiredMentions('Post to https://example.invalid/3001/x')).toEqual([]);

    const found = findRetiredMentions('Probe 127.0.0.1:3001 before the fan-out');
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe('freellmapi');
    expect(found[0].pointer).toContain('127.0.0.1:3001');
  });

  it('reports ONE mention per row per line, not one per pattern', () => {
    // A line naming both the launcher and the port is one finding, or the
    // refusal list triples in length and buries the line it is about.
    expect(findRetiredMentions('run claude.ps1 against 127.0.0.1:3001 now')).toHaveLength(1);
  });
});

describe('retired-infrastructure — the exemption is explicit and keyed', () => {
  it('a marker on the line above or the same line exempts that line — and exactly that line', () => {
    const marker = '<!-- retired-infrastructure-exempt: freellmapi — llm-relay on 8791 replaced it -->';
    // The line BELOW the marker (which is how a wrapped paragraph carries it):
    expect(findRetiredMentions('Requests went to 127.0.0.1:3001', marker)).toEqual([]);
    // …and the marker's own line:
    expect(findRetiredMentions(`claude.ps1 is retired ${marker}`)).toEqual([]);
    // Two lines below is OUT of reach: the gate passes only the immediately
    // preceding line, so one retirement statement cannot cover a later mention
    // that happens to fall in the same paragraph.
    expect(findRetiredMentions('run claude.ps1 now', 'the line between')).toHaveLength(1);
  });

  it('an exemption naming an id the register does not hold is reported, not ignored', () => {
    // A typo in a hand-written marker must not read as an exemption — that is
    // the whole reason the marker is keyed by id rather than being a boolean.
    const found = findRetiredMentions(
      'Requests went to 127.0.0.1:3001 <!-- retired-infrastructure-exempt: freelmapi — typo -->',
    );
    expect(found.map((f) => f.id)).toContain('freelmapi');
    expect(found.some((f) => f.label.includes('UNKNOWN'))).toBe(true);
  });

  it('the marker pattern is the one the refusal text teaches', () => {
    // The refusal prints the syntax; if the two drift, following the message
    // stops working. Pin the exact shape the refusal shows.
    expect('<!-- retired-infrastructure-exempt: freellmapi — llm-relay on 8791 -->').toMatch(
      EXEMPT_MARKER,
    );
  });
});

describe('retired-infrastructure — the live tree', () => {
  it('the gate is green on the committed tree', () => {
    const r = spawnSyncHidden(process.execPath, [SCRIPT], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
    });
    expect(r.status, `${r.stdout ?? ''}${r.stderr ?? ''}`).toBe(0);
    expect(r.stdout).toMatch(/no mention without a retirement statement/);
  });

  it('the enforcement half is not vacuous — the register would fire on the tree it was written for', () => {
    // The gate passed on this tree the moment it was written, which by itself
    // proves nothing: a register with no pattern that matches anything would
    // also pass. This is the recognition half asserted against the REAL text
    // the retirement was about — every line below is verbatim `durable-traps.md`
    // content from before the correction (2026-09-10), so the gate would have
    // found each of them.
    const preCorrection = [
      'There is no Startup entry for it (only `freellmapi.vbs` and `headroom.vbs`).',
      'nine numbered claims through `claude.ps1 -p "<payload>"`; the lane received the framing sentence',
      '`claude.ps1`/`start.ps1` would START it again; do not run them.',
      "call: the external lanes are reachable only through the `mcp__freellmapi__offload_*` tools, driven",
      'with the `freellmapi-…` key returned `invalid x-api-key` carrying an **Anthropic-shaped `request_id`',
    ];
    for (const line of preCorrection) {
      expect(findRetiredMentions(line), line).not.toEqual([]);
    }
    // …and the same lines, once the replacement is stated, are exempt — which
    // is the answer the refusal teaches and the one the tree now uses.
    for (const line of preCorrection) {
      expect(findRetiredMentions(`${line} <!-- retired-infrastructure-exempt: freellmapi — llm-relay on 127.0.0.1:8791 -->`)).toEqual([]);
    }
  });

  it('every declared scan target exists — a renamed doc must not go green over nothing', () => {
    // A hardcoded scan list is most prone to exactly this: the file moves, the
    // gate scans zero files, and "no mentions found" reads as a pass.
    for (const doc of SCANNED_DOCS) {
      expect(() => readFileSync(join(REPO_ROOT, doc), 'utf8'), doc).not.toThrow();
    }
  });

  it('the scanned doc is genuinely clean — no unexempted mention survives', () => {
    // Keeps HEAD demonstrably green under plain `npm test`, not only in
    // verify:checks: the drift this gate exists to catch is a HAND edit, and an
    // author meets a broken test immediately while meeting a CI-only gate late.
    for (const doc of SCANNED_DOCS) {
      const lines = readFileSync(join(REPO_ROOT, doc), 'utf8').split(/\r?\n/);
      const offenders = lines.flatMap((line, i) =>
        findRetiredMentions(line, i > 0 ? lines[i - 1] : '').map((m) => `${doc}:${i + 1} ${m.pointer}`),
      );
      expect(offenders).toEqual([]);
    }
  });
});
