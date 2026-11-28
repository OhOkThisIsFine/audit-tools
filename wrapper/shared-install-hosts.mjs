// sites-pinned: tests/shared/installer-host-compatibility.test.ts
import { readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

export function hasFlag(argv, name) {
  return argv.includes(name);
}

export function getFlag(argv, name) {
  const index = argv.findIndex(argument => argument === name || argument.startsWith(name + '='));
  if (index < 0) return undefined;
  const flag = argv[index];
  const value = flag === name ? argv[index + 1] : flag.slice(name.length + 1);
  if (!value || (flag === name && value.startsWith('--'))) throw new Error(`${name} requires a value.`);
  return value;
}

export function requireFlagValue(argv, name) {
  const value = getFlag(argv, name);
  if (!value) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

export function normalizeNewlines(value) {
  return value.replace(/\r\n/g, '\n');
}

export async function legacySkillOwnershipMatcher(toolName) {
  const source = await readFile(join(import.meta.dirname, '..', 'skills', toolName, 'SKILL.md'), 'utf8');
  const expected = normalizeNewlines(source);
  // A name or stock phrase can survive user edits; only the complete shipped
  // skill is evidence that this legacy file is safe to clean up.
  return (content) => normalizeNewlines(content) === expected;
}

export function splitFrontmatter(markdown) {
  const normalized = normalizeNewlines(markdown);
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?/u);
  if (!match) {
    return { frontmatter: null, body: normalized };
  }

  return {
    frontmatter: match[1],
    body: normalized.slice(match[0].length),
  };
}

function renderFrontmatter(fields) {
  const entries = Object.entries(fields).filter(([, value]) => {
    if (value === undefined || value === null) {
      return false;
    }

    if (typeof value === 'string') {
      return value.length > 0;
    }

    return true;
  });
  if (entries.length === 0) {
    return '';
  }

  return [
    '---',
    ...entries.map(([key, value]) => `${key}: ${value}`),
    '---',
    '',
  ].join('\n');
}

export function renderPromptFile(fields, body) {
  return `${renderFrontmatter(fields)}${body.trimStart()}`;
}

export function toRepoRelativePath(root, targetPath) {
  const value = relative(root, targetPath).replace(/\\/g, '/');
  return value.length > 0 ? value : '.';
}

export async function assertDirectoryExists(path, description) {
  let stats;
  try {
    stats = await stat(path);
  } catch {
    throw new Error(`${description} does not exist: ${path}`);
  }

  if (!stats.isDirectory()) {
    throw new Error(`${description} is not a directory: ${path}`);
  }
}

export async function collectVerifyCheck(target, id, fn) {
  try {
    const details = await fn();
    target.push({
      id,
      status: 'ok',
      ...(details ?? {}),
    });
  } catch (error) {
    target.push({
      id,
      status: 'error',
      summary: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function ensureFile(path, description) {
  let stats;
  try {
    stats = await stat(path);
  } catch {
    throw new Error(`${description} does not exist: ${path}`);
  }

  if (!stats.isFile()) {
    throw new Error(`${description} is not a file: ${path}`);
  }

  return stats;
}
