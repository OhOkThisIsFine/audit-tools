#!/usr/bin/env node
//
// Render the nightly routine's open items as a single self-contained HTML file.
//
// This is the STATIC snapshot — a read-only record the 2am run writes and can
// open for a glance. Answering items with BUTTONS happens in the interactive
// review (`serve.mjs`), which reuses the item rendering exported here; a
// file:// page cannot persist a click without a server, so the two modes share
// the item body and differ only in the answer affordance.
//
// WHY HTML AND NOT THE OLD MARKDOWN TABLES. The previous channel put a full
// paragraph of evidence inside one markdown table cell and printed it into the
// terminal at every session start — unreadable in a terminal, large enough to
// need its own clip budget, and it arrived whether or not the owner could act.
//
// Self-contained: inline CSS, no fonts, no scripts fetched. Opens from a
// file:// path with no network.
//
// Usage:
//   node scripts/nightly/render-digest.mjs [--root <repo>] [--open]
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { readOpenItems, readDecisions, partitionBySettled, LEGS, LEG_TITLES, DIGEST_RELPATH } from './items.mjs';

export const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// Minimal inline markdown: `code`, **bold**, and bare newlines. Deliberately not
// a markdown engine — item text is prose written by the routine, and an
// unescaped-HTML path through a full renderer is not worth the surface.
export function inline(text) {
  return esc(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
}

export const STYLE = `
:root { color-scheme: light dark; --bg:#fbfbfa; --fg:#1c1b19; --muted:#6b6a67; --line:#e3e1dd;
        --card:#fff; --accent:#7c5cff; --warn:#b4541a; --ok:#2f7d4f; --field:#fff; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#181715; --fg:#eceae6; --muted:#9c9891; --line:#302e2b; --card:#211f1d;
          --accent:#a48bff; --warn:#e08a4e; --ok:#63b98a; --field:#2a2825; }
}
* { box-sizing: border-box; }
body { margin:0; padding:2rem 1.25rem 4rem; background:var(--bg); color:var(--fg);
       font:16px/1.6 ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif; }
main { max-width: 60rem; margin: 0 auto; }
h1 { font-size:1.6rem; margin:0 0 .25rem; letter-spacing:-.01em; }
h2 { font-size:1.15rem; margin:2.5rem 0 .75rem; padding-bottom:.4rem; border-bottom:1px solid var(--line); }
.sub { color:var(--muted); margin:0 0 1.5rem; font-size:.9rem; }
.summary { display:flex; flex-wrap:wrap; gap:.5rem; margin:0 0 1.5rem; }
.pill { border:1px solid var(--line); border-radius:999px; padding:.2rem .7rem; font-size:.82rem;
        background:var(--card); color:var(--muted); }
.pill strong { color:var(--fg); }
.item { background:var(--card); border:1px solid var(--line); border-left:3px solid var(--accent);
        border-radius:6px; padding:1rem 1.1rem; margin:0 0 .9rem; transition:opacity .2s; }
.item.stale { border-left-color:var(--warn); }
.item.settled { opacity:.5; border-left-color:var(--ok); }
.item h3 { font-size:1rem; margin:0 0 .35rem; font-weight:600; }
.id { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.8rem; color:var(--accent);
      margin-right:.5rem; }
.meta { color:var(--muted); font-size:.8rem; margin:0 0 .6rem; }
.q { margin:.5rem 0; }
details { margin:.5rem 0 0; }
summary { cursor:pointer; color:var(--muted); font-size:.85rem; user-select:none; }
details.eli5 > summary { color:var(--accent); font-weight:500; }
.eli5 .body { margin:.5rem 0 0; padding:.6rem .8rem; background:color-mix(in srgb, var(--accent) 7%, transparent);
      border-radius:5px; font-size:.95rem; }
.evidence { margin:.5rem 0 0; padding-left:1.1rem; color:var(--muted); font-size:.9rem; }
code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.85em;
       background:color-mix(in srgb, var(--fg) 8%, transparent); padding:.1em .35em; border-radius:3px; }
pre { background:color-mix(in srgb, var(--fg) 6%, transparent); border:1px solid var(--line);
      border-radius:5px; padding:.7rem .8rem; overflow-x:auto; font-size:.85rem; margin:.6rem 0 0; }
.answer { margin-top:.75rem; padding-top:.6rem; border-top:1px dashed var(--line); font-size:.85rem; }
.answer code { user-select:all; }
.answer-form textarea { width:100%; min-height:3.2rem; margin:.4rem 0; padding:.5rem .6rem; resize:vertical;
      background:var(--field); color:var(--fg); border:1px solid var(--line); border-radius:5px;
      font:inherit; font-size:.9rem; }
.btn { border:1px solid var(--line); border-radius:5px; padding:.4rem .9rem; font:inherit; font-size:.85rem;
      cursor:pointer; background:var(--card); color:var(--fg); }
.btn.primary { background:var(--accent); color:#fff; border-color:transparent; }
.btn.ghost { color:var(--muted); }
.btn:disabled { opacity:.5; cursor:default; }
.btn-row { display:flex; gap:.5rem; align-items:center; flex-wrap:wrap; }
.status { color:var(--muted); font-size:.82rem; }
.status.err { color:var(--warn); }
.settled-note { color:var(--ok); font-size:.9rem; margin:.4rem 0 0; }
.empty { color:var(--muted); font-style:italic; }
.applied li { color:var(--muted); font-size:.9rem; }
.banner { background:color-mix(in srgb, var(--accent) 10%, transparent); border:1px solid var(--line);
      border-radius:6px; padding:.7rem 1rem; margin:0 0 1.5rem; font-size:.9rem; }
footer { margin-top:3rem; padding-top:1rem; border-top:1px solid var(--line);
         color:var(--muted); font-size:.82rem; }
`;

// The item body shared by BOTH modes: everything except the answer affordance.
// The one-line title stays the summary; the ELI5 is an expandable plain-language
// explanation (the routine writes it deliberately for a non-expert reader), and
// the technical question + evidence sit below it for when the plain version is
// not enough.
export function renderItemCore(item) {
  const parts = [];
  parts.push(`<h3><span class="id">${esc(item.id)}</span>${inline(item.title)}</h3>`);

  const meta = [];
  if (item.path) meta.push(`<code>${esc(item.path)}</code>`);
  meta.push(
    Number(item.nights_open) > 1
      ? `open <strong>${esc(item.nights_open)} nights</strong> (since ${esc(item.first_seen)})`
      : 'new tonight',
  );
  parts.push(`<p class="meta">${meta.join(' &middot; ')}</p>`);

  if (item.eli5) {
    parts.push(
      `<details class="eli5" open><summary>In plain terms</summary><div class="body">${inline(item.eli5)}</div></details>`,
    );
  }
  if (item.question) parts.push(`<div class="q">${inline(item.question)}</div>`);
  if (item.proposal) parts.push(`<pre>${esc(item.proposal)}</pre>`);
  if (item.patch_path) parts.push(`<p class="meta">Ready-to-apply patch: <code>${esc(item.patch_path)}</code></p>`);

  const evidence = Array.isArray(item.evidence) ? item.evidence.filter(Boolean) : [];
  if (evidence.length > 0) {
    parts.push('<details><summary>Technical evidence</summary><ul class="evidence">');
    for (const e of evidence) parts.push(`<li>${inline(e)}</li>`);
    parts.push('</ul></details>');
  }
  return parts.join('\n');
}

export function itemClass(item, extra = '') {
  const stale = Number(item.nights_open) >= 5;
  return `item${stale ? ' stale' : ''}${extra ? ' ' + extra : ''}`;
}

// Static-mode item: the shared core plus a copy-ready command, kept only as the
// zero-process fallback. The primary, buttoned path is the interactive review.
function renderStaticItem(item) {
  return (
    `<article class="${itemClass(item)}" id="item-${esc(item.id)}">\n` +
    renderItemCore(item) +
    `\n<div class="answer">To answer with buttons, launch the review (below). Or from a shell: ` +
    `<code>node scripts/nightly/answer.mjs ${esc(item.id)} "your answer"</code></div>\n` +
    `</article>`
  );
}

export function renderShell(title, inner) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style></head>
<body><main>
${inner}
</main></body></html>
`;
}

// The header shared by both modes: title, per-leg counts, and the stuck-item
// call-out. `answerHint` is the mode-specific line about HOW to answer.
export function renderHeader({ generated_at, run, items, applied }, answerHint) {
  const byLeg = new Map(LEGS.map((leg) => [leg, 0]));
  for (const it of items) byLeg.set(it.leg, (byLeg.get(it.leg) || 0) + 1);
  const stuck = items.filter((it) => Number(it.nights_open) >= 5);
  const when = generated_at ? new Date(generated_at) : new Date();
  const dateLabel = when.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

  const head = [];
  head.push(`<h1>Nightly maintenance &mdash; ${items.length} open item${items.length === 1 ? '' : 's'}</h1>`);
  head.push(`<p class="sub">Run ${esc(dateLabel)}${run ? ` &middot; ${esc(run)}` : ''}</p>`);
  if (answerHint) head.push(`<div class="banner">${answerHint}</div>`);
  head.push('<div class="summary">');
  for (const leg of LEGS) head.push(`<span class="pill">${esc(LEG_TITLES[leg])}: <strong>${byLeg.get(leg) || 0}</strong></span>`);
  head.push(`<span class="pill">auto-applied: <strong>${(applied || []).length}</strong></span>`);
  if (stuck.length > 0) head.push(`<span class="pill">open 5+ nights: <strong>${stuck.length}</strong></span>`);
  head.push('</div>');
  if (stuck.length > 0) {
    head.push(
      `<p class="sub"><strong>${stuck.length} item${stuck.length === 1 ? ' has' : 's have'} been open 5+ nights.</strong> ` +
        'If one is not answerable as posed, settle it with a note saying so &mdash; that is a valid answer and stops the re-ask.</p>',
    );
  }
  return head.join('\n');
}

// The per-leg body + the FYI/skipped tails, given a function that renders one
// item (so the two modes supply their own item markup).
export function renderBody({ items, applied, skipped }, renderOne) {
  const byLeg = new Map(LEGS.map((leg) => [leg, []]));
  for (const it of items) {
    if (!byLeg.has(it.leg)) byLeg.set(it.leg, []);
    byLeg.get(it.leg).push(it);
  }

  const body = [];
  for (const leg of LEGS) {
    const legItems = byLeg.get(leg) || [];
    body.push(`<h2>${esc(LEG_TITLES[leg])}</h2>`);
    if (legItems.length === 0) body.push('<p class="empty">Nothing open.</p>');
    else for (const item of legItems) body.push(renderOne(item));
  }
  if ((applied || []).length > 0) {
    body.push('<h2>Applied automatically (FYI)</h2><ul class="applied">');
    for (const a of applied) body.push(`<li>${inline(typeof a === 'string' ? a : a.summary)}</li>`);
    body.push('</ul>');
  }
  if ((skipped || []).length > 0) {
    // Never silent: a leg that could not run must say so, or a quiet digest
    // reads as "all clear" when it means "did not look".
    body.push('<h2>Not covered this run</h2><ul class="applied">');
    for (const s of skipped) body.push(`<li>${inline(typeof s === 'string' ? s : s.reason)}</li>`);
    body.push('</ul>');
  }
  return body.join('\n');
}

export function renderDigest(state) {
  const hint =
    'This is a read-only snapshot. To answer with buttons and a text box, launch the interactive review: ' +
    '<code>npm run nightly:review</code>';
  const head = renderHeader(state, state.items.length > 0 ? hint : '');
  const body = renderBody(state, renderStaticItem);
  const footer = `<footer>
Answers are recorded in <code>.claude/nightly-decisions.json</code> against the subject, so a settled
question is never asked again (a later edit to that prose legitimately re-opens it).<br>
Interactive review with buttons: <code>npm run nightly:review</code> &middot; contract: <code>docs/nightly-routine.md</code>.
</footer>`;
  return renderShell('Nightly maintenance — audit-tools', `${head}\n${body}\n${footer}`);
}

// Opening the digest is what replaces the every-conversation interrupt.
export function openInBrowser(target) {
  const cmd =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', target]]
      : process.platform === 'darwin'
        ? ['open', [target]]
        : ['xdg-open', [target]];
  try {
    spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    /* opening is a convenience — never fail over it */
  }
}

// CLI entry (not when imported by tests / serve.mjs).
if (process.argv[1] && process.argv[1].endsWith('render-digest.mjs')) {
  const args = process.argv.slice(2);
  const rootFlag = args.indexOf('--root');
  const root = rootFlag !== -1 ? args[rootFlag + 1] : process.env.CLAUDE_PROJECT_DIR || process.cwd();

  const state = readOpenItems(root);
  const { open, settled } = partitionBySettled(state.items, readDecisions(root));
  const html = renderDigest({ ...state, items: open });

  const out = join(root, DIGEST_RELPATH);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html, 'utf8');

  console.log(`nightly digest: ${open.length} open item(s) → ${DIGEST_RELPATH}`);
  if (settled.length > 0) console.log(`  (${settled.length} suppressed: already settled in .claude/nightly-decisions.json)`);
  if (args.includes('--open')) openInBrowser(out);
}
