// sites-pinned: tests/shared/philosophy-brief-gate.test.ts, tests/shared/hook-session-gates.test.ts
export const BRIEF_BEGIN = '<!-- BEGIN philosophy-brief';
export const BRIEF_END = '<!-- END philosophy-brief -->';

/** Return the trimmed marker body, or null if the markers are missing or reversed. */
export function markedPhilosophyBrief(text) {
  const begin = text.indexOf(BRIEF_BEGIN);
  const end = text.indexOf(BRIEF_END);
  if (begin === -1 || end === -1 || end < begin) return null;
  const afterPrefix = begin + BRIEF_BEGIN.length;
  const terminator = text.indexOf('-->', afterPrefix);
  const nextComment = text.indexOf('<!--', afterPrefix);
  if (terminator === -1 || terminator + 3 > end || (nextComment !== -1 && nextComment < terminator)) return null;
  return text.slice(terminator + 3, end).trim();
}
