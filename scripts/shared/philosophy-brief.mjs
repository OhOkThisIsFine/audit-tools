// sites-pinned: tests/shared/philosophy-brief-gate.test.ts, tests/shared/hook-session-gates.test.ts
export const BRIEF_BEGIN = '<!-- BEGIN philosophy-brief';
export const BRIEF_END = '<!-- END philosophy-brief -->';

/** Return the trimmed marker body, or null if the markers are missing or reversed. */
export function markedPhilosophyBrief(text) {
  const begin = text.indexOf(BRIEF_BEGIN);
  const end = text.indexOf(BRIEF_END);
  if (begin === -1 || end === -1 || end < begin) return null;
  return text.slice(text.indexOf('-->', begin) + 3, end).trim();
}
