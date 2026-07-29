#!/usr/bin/env node
//
// Interactive nightly review — the BUTTONED surface.
//
// A file:// digest cannot persist a click; a click has to reach something that
// writes the decisions ledger. So the review is a tiny local server: it renders
// the same items as the static digest, but each carries a text box and Settle /
// Won't-fix buttons that POST to it, and it records the answer against the
// subject key exactly as `answer.mjs` does. Bound to 127.0.0.1 only — never
// exposed to the network — and it exits when the owner is done (Ctrl-C).
//
// Launch:  npm run nightly:review   (or: node scripts/nightly/serve.mjs)
import { createServer } from 'node:http';
import {
  readOpenItems,
  readDecisions,
  recordDecision,
  partitionBySettled,
  LEG_TITLES,
} from './items.mjs';
import { esc, renderItemCore, renderOptions, itemClass, renderShell, renderHeader, renderBody, openInBrowser } from './render-digest.mjs';

// One item, interactive: the shared core plus a text box and two buttons wired
// to POST /answer. `data-*` carries the id to the handler; no inline handlers,
// so a doc quote in the item text can never smuggle script.
function renderInteractiveItem(item) {
  const hasOptions = Array.isArray(item.options) && item.options.length > 0;
  return (
    `<article class="${itemClass(item)}" id="item-${esc(item.id)}" data-id="${esc(item.id)}">\n` +
    renderItemCore(item) +
    renderOptions(item) +
    `\n<div class="btn-row" style="margin-top:.6rem">` +
    (hasOptions ? `<button class="btn ghost" data-act="reveal">Something else…</button>` : '') +
    `<button class="btn ghost" data-act="wontfix-quick">Won't fix</button>` +
    `<span class="status" id="status-${esc(item.id)}"></span>` +
    `</div>` +
    `<div class="answer answer-form${hasOptions ? ' hidden' : ''}" id="form-${esc(item.id)}">` +
    `<textarea id="ans-${esc(item.id)}" placeholder="Your answer — including &quot;keep it as is&quot;, which is a real answer and stops the re-ask."></textarea>` +
    `<div class="btn-row">` +
    `<button class="btn primary" data-act="settled">Settle</button>` +
    `<button class="btn ghost" data-act="wontfix">Won't fix</button>` +
    `</div></div>\n</article>`
  );
}

// The client script. No external fetches; served same-origin from this server.
// Kept free of any character below 0x20 — a raw control byte would turn this
// source file binary (the trap the repo's control-byte gate exists for).
const CLIENT_SCRIPT = `
<script>
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const card = btn.closest('.item');
  const id = card.getAttribute('data-id');
  const act = btn.getAttribute('data-act');
  const status = document.getElementById('status-' + id);

  // "Something else" only reveals the free-text box; it records nothing.
  if (act === 'reveal') {
    const form = document.getElementById('form-' + id);
    if (form) { form.classList.remove('hidden'); const t = document.getElementById('ans-' + id); if (t) t.focus(); }
    return;
  }

  // An option button carries the exact answer it records, so one click is a
  // complete decision. Everything else falls back to the text box.
  const preset = btn.getAttribute('data-answer');
  let answer, disposition;
  if (preset) {
    answer = preset; disposition = 'settled';
  } else if (act === 'wontfix-quick') {
    answer = "Won't fix."; disposition = 'wontfix';
  } else {
    const ta = document.getElementById('ans-' + id);
    answer = ((ta && ta.value) || '').trim();
    disposition = act === 'wontfix' ? 'wontfix' : 'settled';
    if (!answer) { status.textContent = 'An answer is required.'; status.className = 'status err'; return; }
  }
  status.textContent = 'Saving...'; status.className = 'status';
  card.querySelectorAll('button').forEach((b) => (b.disabled = true));
  try {
    const r = await fetch('/answer', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, answer, disposition }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed to save.');
    const form = card.querySelector('.answer-form');
    if (form) form.remove();
    const opts = card.querySelector('.options');
    if (opts) opts.remove();
    const rows = card.querySelectorAll('.btn-row');
    rows.forEach((r) => r.remove());
    const note = document.createElement('p');
    note.className = 'settled-note';
    note.textContent = 'Settled (' + disposition + '): ' + answer;
    card.appendChild(note);
    card.classList.add('settled');
    const pill = document.getElementById('open-count');
    if (pill) pill.textContent = String(data.open_count);
    if (data.open_count === 0) {
      const done = document.getElementById('all-done');
      if (done) done.style.display = 'block';
    }
  } catch (err) {
    status.textContent = err.message; status.className = 'status err';
    card.querySelectorAll('button').forEach((b) => (b.disabled = false));
  }
});
</script>
`;

function renderReviewPage(root) {
  const state = readOpenItems(root);
  const { open, resolved } = partitionBySettled(state.items, readDecisions(root), root);
  const hint =
    'Press the option you want &mdash; each button records that exact answer and the item collapses. ' +
    '<strong>Something else…</strong> opens a text box, and <strong>Won’t fix</strong> closes an item as not-doing. ' +
    'Either way the subject is settled for good. Open items remaining: <strong id="open-count">' +
    open.length +
    '</strong>.' +
    (resolved.length > 0
      ? ` (${resolved.length} auto-closed &mdash; the code each one quoted is no longer in the tree.)`
      : '');
  const head = renderHeader({ ...state, items: open }, hint);
  const doneBanner =
    `<p class="sub" id="all-done" style="display:${open.length === 0 ? 'block' : 'none'}">` +
    'Everything is answered. Just close this tab &mdash; the review shuts itself down when idle.</p>';
  const body = renderBody({ ...state, items: open }, renderInteractiveItem);
  const footer = `<footer>
Answers are recorded against the SUBJECT, so a settled question is never asked again (a later edit to
that prose legitimately re-opens it).<br>
Served locally on 127.0.0.1; it shuts itself down once you stop using it. Close the tab when you are done.
</footer>`;
  return renderShell('Nightly review — audit-tools', `${head}\n${doneBanner}\n${body}\n${footer}${CLIENT_SCRIPT}`);
}

async function readJsonBody(req, limitBytes = 64 * 1024) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limitBytes) throw new Error('request body too large');
  }
  return JSON.parse(raw);
}

// The request handler, exported so tests can drive it without opening a browser.
export function createNightlyReviewServer(root) {
  return createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(renderReviewPage(root));
        return;
      }

      if (req.method === 'POST' && req.url === '/answer') {
        let payload;
        try {
          payload = await readJsonBody(req);
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'malformed request' }));
          return;
        }
        const { id, answer, disposition } = payload || {};
        // Same guards as answer.mjs — an id must match a currently-open item, an
        // answer is mandatory (an empty settle records nothing but suppresses a
        // question, which is exactly the untrustworthy-ledger shape), and the
        // disposition is constrained.
        const state = readOpenItems(root);
        const { open, resolved } = partitionBySettled(state.items, readDecisions(root), root);
        const item = open.find((it) => it.id === id);
        if (!item) {
          const wasResolved = resolved.some((it) => it.id === id);
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error: wasResolved
                ? `item "${id}" auto-closed — its premise is no longer in the tree`
                : `unknown or already-settled item "${id}"`,
            }),
          );
          return;
        }
        if (typeof answer !== 'string' || !answer.trim()) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'an answer is required' }));
          return;
        }
        const disp = disposition === 'wontfix' ? 'wontfix' : 'settled';
        recordDecision(root, item.subject_key, {
          answer: answer.trim(),
          disposition: disp,
          subject: item.title,
          path: item.path,
        });
        const remaining = partitionBySettled(readOpenItems(root).items, readDecisions(root), root).open.length;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, disposition: disp, open_count: remaining }));
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(err && err.message ? err.message : err) }));
    }
  });
}

// CLI entry.
if (process.argv[1] && process.argv[1].endsWith('serve.mjs')) {
  const args = process.argv.slice(2);
  const rootFlag = args.indexOf('--root');
  const root = rootFlag !== -1 ? args[rootFlag + 1] : process.env.CLAUDE_PROJECT_DIR || process.cwd();

  const { open, resolved } = partitionBySettled(readOpenItems(root).items, readDecisions(root), root);
  if (open.length === 0) {
    console.log(
      `No open nightly items to review.${resolved.length > 0 ? ` (${resolved.length} auto-closed — premise gone.)` : ''}`,
    );
    process.exit(0);
  }

  const server = createNightlyReviewServer(root);

  // Idle shutdown. The nightly run launches this DETACHED, so there is no
  // terminal to Ctrl-C — a server that only stopped on a keystroke would be a
  // process the owner has no way to reach. Every request resets the clock, so it
  // survives a long read and exits once the tab is closed.
  const IDLE_MS = Number(process.env.NIGHTLY_REVIEW_IDLE_MS || 4 * 60 * 60 * 1000);
  let idleTimer;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => server.close(() => process.exit(0)), IDLE_MS);
    idleTimer.unref?.();
  };
  server.on('request', resetIdle);

  // Port 0 → an ephemeral free port; 127.0.0.1 → never network-exposed.
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/`;
    console.log(`Nightly review: ${open.length} open item(s) → ${url}`);
    resetIdle();
    if (!args.includes('--no-open')) openInBrowser(url);
  });
}
