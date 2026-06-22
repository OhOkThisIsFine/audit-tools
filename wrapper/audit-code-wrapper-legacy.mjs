import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { readTextIfExists } from './audit-code-wrapper-io.mjs';

function normalizeNewlines(value) {
  return value.replace(/\r\n/g, '\n');
}

function looksLikeAuditCodeSkill(content) {
  const normalized = normalizeNewlines(content);
  return (
    /^name:\s*audit-code\b/mu.test(normalized)
    || normalized.includes('Conversation-first autonomous code auditing workflow for the /audit-code command.')
    || normalized.includes('The canonical entrypoint is `/audit-code` in conversation.')
  );
}

function looksLikeAuditCodePrompt(content) {
  const normalized = normalizeNewlines(content);
  return (
    normalized.includes('# `/audit-code`')
    && (
      normalized.includes('audit-code orchestrator')
      || normalized.includes('Autonomous local loop code auditing')
      || normalized.includes('Conversation-first autonomous code auditing workflow')
    )
  );
}

function looksLikeAuditCodeInterfaceMetadata(content) {
  const normalized = normalizeNewlines(content);
  return (
    normalized.includes('audit-code')
    && (
      normalized.includes('display_name:')
      || normalized.includes('short_description:')
      || normalized.includes('default_prompt:')
    )
    && (
      normalized.includes('/audit-code')
      || normalized.includes('Start /audit-code')
    )
  );
}

export async function buildLegacyAuditCodeSurfaceTargets(root) {
  const targets = [
    {
      host: 'codex',
      surface: 'skill',
      path: join(root, '.codex', 'skills', 'audit-code', 'SKILL.md'),
      matches: looksLikeAuditCodeSkill,
    },
    {
      host: 'codex',
      surface: 'prompt',
      path: join(root, '.codex', 'skills', 'audit-code', 'audit-code.prompt.md'),
      matches: looksLikeAuditCodePrompt,
    },
    {
      host: 'opencode',
      surface: 'command',
      path: join(root, '.opencode', 'commands', 'audit-code.md'),
      matches: looksLikeAuditCodePrompt,
    },
    {
      host: 'opencode',
      surface: 'skill',
      path: join(root, '.opencode', 'skills', 'audit-code', 'SKILL.md'),
      matches: looksLikeAuditCodeSkill,
    },
    {
      host: 'opencode',
      surface: 'prompt',
      path: join(root, '.opencode', 'skills', 'audit-code', 'audit-code.prompt.md'),
      matches: looksLikeAuditCodePrompt,
    },
    {
      host: 'claude',
      surface: 'command',
      path: join(root, '.claude', 'commands', 'audit-code.md'),
      matches: looksLikeAuditCodePrompt,
    },
  ];

  const codexAgentDir = join(root, '.codex', 'skills', 'audit-code', 'agents');
  const codexAgentEntries = await readdir(codexAgentDir).catch(() => []);
  for (const entry of codexAgentEntries) {
    targets.push({
      host: 'codex',
      surface: 'interface-metadata',
      path: join(codexAgentDir, entry),
      matches: looksLikeAuditCodeInterfaceMetadata,
    });
  }

  return targets;
}

export async function findLegacyAuditCodeSurfaceFiles(root) {
  const matches = [];
  for (const target of await buildLegacyAuditCodeSurfaceTargets(root)) {
    const existing = await readTextIfExists(target.path);
    if (existing !== null && target.matches(existing)) {
      matches.push(target.path);
    }
  }
  return matches;
}

export async function removeLegacyAuditCodeSurfaceFiles(root) {
  const removed = [];
  for (const target of await buildLegacyAuditCodeSurfaceTargets(root)) {
    const existing = await readTextIfExists(target.path);
    if (existing === null || !target.matches(existing)) {
      continue;
    }
    await unlink(target.path);
    removed.push({
      path: target.path,
      mode: 'removed',
    });
  }
  return removed;
}
