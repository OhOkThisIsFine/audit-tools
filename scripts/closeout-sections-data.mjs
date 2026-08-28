// Closeout section registry — the canonical declaration of every section of the
// end-of-sprint hand-back, and which ones may fall silent.
//
// WHY THIS IS DATA. The hand-back used to write "none" under every empty heading
// so that a DROPPED obligation could not hide as silence. That made every
// closeout long, and the long ones are the ones nobody reads. Deleting the
// "none" lines alone would have traded a parsing cost for a correctness one:
// silence and omission become indistinguishable.
//
// So the disposition moves off the rendered page and into an input the renderer
// REFUSES to guess. `scripts/render-closeout.mjs` demands an explicit value for
// every id below — content, or the literal "none" — and then omits the silent
// ones from the output. Silence in the rendered report is therefore always a
// stated decision, never a skipped step, and the report stays short.
//
// `required: true` = the section always renders, because there an absence is
// itself the message: a closeout with no Verification line is not reporting
// "nothing to verify", it is reporting that nobody looked.

import { FRICTION_CATEGORIES } from "audit-tools/shared";

// Labels for the REAL friction categories. The IDS are the single-sourced
// vocabulary (src/shared/friction/frictionRecord.ts, via the shared barrel);
// only the presentation label lives here, keyed by that vocabulary. A category
// added there without a label here throws at load, so the two cannot drift
// silently; a category removed there drops out of the bullets automatically.
const FRICTION_CATEGORY_LABELS = {
  ambiguous_direction:
    'ambiguous_direction (instructions/docs/specs pointed the wrong way, or contradicted each other)',
  tool_should_decide:
    'tool_should_decide (a human/agent had to remember, notice, or decide something the tool should enforce)',
  inefficient_feeding:
    'inefficient_feeding (context/tokens wasted moving information in or out — re-derivation, dumps, re-loops)',
};

const frictionCategoryBullets = FRICTION_CATEGORIES.map((id) => {
  const label = FRICTION_CATEGORY_LABELS[id];
  if (!label) {
    throw new Error(
      `closeout-sections-data: no bullet label for friction category '${id}' — add one to FRICTION_CATEGORY_LABELS.`,
    );
  }
  return { id, label };
});

/**
 * @typedef {object} Bullet
 * @property {string} id
 * @property {string} label rendered lead-in, before the value
 * @property {boolean} [required] this bullet may not be "none"
 */

/**
 * @typedef {object} Section
 * @property {string} id
 * @property {string} heading rendered as `### <heading>`
 * @property {boolean} [required] section always renders; may not be "none"
 * @property {Bullet[]} [bullets] when present, the value is an object keyed by
 *   bullet id; the heading renders only if at least one bullet has content
 * @property {string} prompt what this section is for — shown in --help and in
 *   the refusal when its value is missing
 * @property {string} [requiresQuestion] a non-silent value here must contain a
 *   question mark, and this string is the refusal shown when it does not. The
 *   prompt alone was not enough: it is shown only when a value is MISSING, so a
 *   section filled with the WRONG KIND of content sailed through. Declared here
 *   rather than special-cased in the renderer, so the contract and its refusal
 *   have one home.
 */

/**
 * Order is the RENDER order, and it is bottom-weighted on purpose: chat shows
 * the end of a long message first, so mechanics come first and the sections the
 * owner must act on come last.
 * @type {Section[]}
 */
export const CLOSEOUT_SECTIONS = [
  {
    id: 'verification',
    heading: 'Verification',
    required: true,
    prompt: 'what was run, what it returned, and the clean pushed commit it ran on',
  },
  {
    id: 'cleanup',
    heading: 'Cleanup',
    prompt:
      'dead code / orphaned helpers / stray debug·TODO removed, and any DELIBERATE intermediate ' +
      'state called out so it does not read as a bug',
  },
  {
    id: 'friction',
    heading: 'Friction this sprint',
    prompt: 'friction hit this sprint, by category',
    bullets: [
      ...frictionCategoryBullets,
      {
        id: 'open_ended',
        label: '**Open-ended (anything else that caused friction, fit no category above)**',
      },
      { id: 'logged_to', label: 'Logged to' },
    ],
  },
  {
    id: 'docs',
    heading: 'Docs synced',
    prompt: 'HANDOFF / backlog / memory + index — only the ones that actually changed',
  },
  {
    id: 'landed',
    heading: 'Landed this sprint',
    required: true,
    prompt:
      'what this sprint did and its outcome, with commits/versions — "nothing — investigation/docs ' +
      'only" is a real answer, an empty section is not',
  },
  {
    id: 'decisions',
    heading: 'Decisions needed from you',
    prompt:
      'every decision still OPEN that only the owner can make, ASKED as an answerable question ' +
      'with its options spelled out — a pointer to a queue or a command is not a question, and a ' +
      'decision already made is not open. If nothing is open, the value is "none"',
    requiresQuestion:
      'this section is what the owner must still ANSWER, and its value contains no question. A ' +
      'decision that was already taken belongs in "landed" (or its own backlog entry), not here — ' +
      'under this heading it reads as a demand for something the owner has already given. If ' +
      'every decision is settled, the correct value is the literal "none", and the section is ' +
      'then omitted from the report.',
  },
  {
    id: 'next_steps',
    heading: 'Remaining next steps, and where each lives',
    prompt:
      'every remaining step WITH the document that will hold it once this session ends — a step ' +
      'living only in chat is lost',
  },
];
