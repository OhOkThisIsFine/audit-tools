# P32 — The two fields that make an item answerable are unenforced, beside four refusals that enforce the one that makes it closable

## The problem

`docs/nightly-routine.md` declares two item fields mandatory, in the strongest
language the contract uses anywhere:

- `options[]` — "**Every item carries them.** They are the whole point of the
  answerable surface: a click on a named choice IS the decision, so answering
  costs a press instead of an essay."
- `eli5` — "Every item gets one; do not substitute internal IDs or symbol-name
  shorthand."

`writeOpenItems()` (`scripts/nightly/items.mjs:514`) enforces neither. It refuses
a batch **four separate ways** over `premise_probes` — no probes at all
(`:528`), only-negative probes (`:539`), an `auto_close:false` flag on a
non-record probe (`:552`), and any probe that does not pass at HEAD (`:567`) —
and then writes the payload (`:609-616`) without ever reading `item.options` or
`item.eli5`.

The renderer degrades silently rather than failing: `render-inbox.mjs:78`
defaults missing options to `[]`, and `:90-95` renders the plain-terms block only
when `eli5` is truthy. So an item missing both renders as a bare text box with no
explanation — which is exactly the failure the contract paragraph was written to
record:

> An item without them degrades to a bare text box — which is what happened on
> 2026-07-29, when 18 items shipped with no `options` because this contract did
> not list the field the renderer already supported.

The contract was amended to *name* the field. Naming it is what failed the first
time. Per `CLAUDE.md`'s auditor-agnostic-robustness rule — whatever CAN be
enforced in tooling must be — the fix is the refusal, not the sentence.

## Why this is the same shape as the probe refusals

The probe rules and these two fields protect the two different halves of an
item's job:

| Field | What it guarantees | Enforced? |
|---|---|---|
| `premise_probes` | the item can CLOSE when the tree moves | yes — four refusals |
| `options` / `eli5` | the item can be ANSWERED when the owner reads it | **no** |

A queue whose items cannot close silently grows. A queue whose items cannot be
answered silently grows *in exactly the same way*, and the second failure is
harder to see because the item looks fine in JSON. Tonight's queue carries 20
items unanswered across 2+ nights, which is the condition under which an
unanswerable item is most costly.

## Recurrence

- **2026-07-29** — 18 items shipped with no `options`; recorded verbatim in the
  routine's own machine-output contract as the reason the field is listed.
- **2026-07-28** — the sibling class in the decisions ledger: twelve answers were
  invisible because ANSWERED was conflated with DONE. That one WAS fixed
  mechanically (`answeredNotDone`, `--done`, `COMPLETION_TRACKING_SINCE`), which
  is the precedent for fixing this one the same way rather than by instruction.
- **2026-08-15** (tonight) — found by the independent codex lane reading
  `items.mjs` against `nightly-routine.md`; verified directly against
  `scripts/nightly/items.mjs:514-618`.

## The mechanism

Two refusals in `writeOpenItems`, placed with the existing four, before the
merge-and-write block.

```js
    // The two fields that make an item ANSWERABLE, enforced beside the probe
    // rules that make it CLOSABLE. The contract calls both mandatory
    // ("Every item carries them", "Every item gets one"); on 2026-07-29 18 items
    // shipped with neither, because the contract only NAMED the fields and the
    // renderer degrades silently (render-inbox.mjs:78 defaults options to [],
    // :90-95 renders eli5 only when truthy). A named requirement is not a
    // refusal — CLAUDE.md, auditor-agnostic robustness.
    const options = Array.isArray(item?.options) ? item.options : [];
    const malformed = options.filter(
      (o) => typeof o?.label !== 'string' || !o.label.trim() ||
             typeof o?.answer !== 'string' || !o.answer.trim(),
    );
    if (options.length === 0 || malformed.length > 0) {
      throw new Error(
        `writeOpenItems: item "${item?.id ?? '(no id)'}" carries no usable options[] ` +
          `(need [{label, answer}, ...] with non-empty strings; ` +
          `${options.length === 0 ? 'none were supplied' : `${malformed.length} are malformed`}). ` +
          `Without them the item renders as a bare text box and answering costs an essay ` +
          `instead of a press. Offer the real alternatives including the do-nothing one.`,
      );
    }
    if (typeof item?.eli5 !== 'string' || item.eli5.trim().length < 80) {
      throw new Error(
        `writeOpenItems: item "${item?.id ?? '(no id)'}" carries no usable eli5 ` +
          `(need full sentences for a non-expert reader: what the doc/backlog claims, ` +
          `what the code does, why they diverge, and what each answer means going forward — ` +
          `not an internal id or symbol-name shorthand).`,
      );
    }
```

The 80-character floor is deliberate and is the one arguable constant: it is
short enough that no genuine plain-language explanation trips it, and long enough
to refuse a symbol name or an id pasted in to satisfy the check — the documented
substitution ("do not substitute internal IDs or symbol-name shorthand").

## Red-green tests

Belongs at `tests/shared/nightly-items-mandatory-fields.test.ts` — under
`tests/`, because Vitest excludes `.claude/**` and a test beside a hook never
runs. Each test is RED before the patch and GREEN after; the last is green in
both directions and pins that the refusal did not over-reach.

1. an item with valid probes and `options: []` → `writeOpenItems` throws, message
   names `options`.
2. an item whose `options` entries have an empty `label` (or a missing `answer`)
   → throws, message names the malformed count.
3. an item with valid probes and no `eli5` → throws, message names `eli5`.
4. an item with `eli5: "docs-4"` (an id pasted in) → throws on the length floor.
5. a fully-formed item with passing probes, two well-formed options and a real
   plain-terms paragraph → does NOT throw, and the payload round-trips through
   `readOpenItems` with both fields intact.

## False-positive surface

Small and bounded, but state it honestly:

- **Any caller that legitimately writes an option-less item breaks.** There is no
  such caller today — the routine is the only producer — but a future
  informational item ("nothing to decide, just telling you") would now be
  refused. That is arguably correct: the inbox is an *answering* surface, and an
  item with nothing to answer belongs in the run summary, not the queue. If the
  owner wants that class, it wants its own field, not a silent exemption.
- **The 80-character floor is a heuristic.** A genuinely terse but adequate
  explanation could trip it. The failure is loud and the fix is one sentence, so
  the cost is a retry, not lost work — the same trade the probe refusals already
  make.
- **Carried-forward items** are re-validated on every write, so any legacy item
  in the current queue lacking either field would fail the next run. Tonight's 20
  all carry both (verified), so the patch lands clean; a future prune must not
  reintroduce one.

## What it would have caught

The 2026-07-29 batch, at write time, before 18 unanswerable items reached the
owner — instead of after, as a contract amendment that named a field.
