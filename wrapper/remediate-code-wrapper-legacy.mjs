import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { readTextIfExists } from './remediate-code-wrapper-io.mjs';

function normalizeNewlines(value) {
  return value.replace(/\r\n/g, '\n');
}

function looksLikeRemediateCodeSkill(content) {
  const normalized = normalizeNewlines(content);
  return (
    /^name:\s*remediate-code\b/mu.test(normalized)
    || normalized.includes('Conversation-first remediation of audit findings or feedback.')
    || normalized.includes('The canonical entrypoint is `/remediate-code` in conversation.')
  );
}

function looksLikeRemediateCodePrompt(content) {
  const normalized = normalizeNewlines(content);
  return (
    normalized.includes('# `/remediate-code`')
    && (
      normalized.includes('remediate-code orchestrator')
      || normalized.includes('Autonomous local-loop remediation')
      || normalized.includes('Conversation-first remediation')
    )
  );
}

function looksLikeRemediateCodeInterfaceMetadata(content) {
  const normalized = normalizeNewlines(content);
  return (
    normalized.includes('remediate-code')
    && (
      normalized.includes('display_name:')
      || normalized.includes('short_description:')
      || normalized.includes('default_prompt:')
    )
    && (
      normalized.includes('/remediate-code')
      || normalized.includes('Start /remediate-code')
    )
  );
}

export async function buildLegacyRemediateCodeSurfaceTargets(root) {
  const targets = [
    {
      host: 'codex',
      surface: 'skill',
      path: join(root, '.codex', 'skills', 'remediate-code', 'SKILL.md'),
      matches: looksLikeRemediateCodeSkill,
    },
    {
      host: 'codex',
      surface: 'prompt',
      path: join(root, '.codex', 'skills', 'remediate-code', 'remediate-code.prompt.md'),
      matches: looksLikeRemediateCodePrompt,
    },
    {
      host: 'opencode',
      surface: 'command',
      path: join(root, '.opencode', 'commands', 'remediate-code.md'),
      matches: looksLikeRemediateCodePrompt,
    },
    {
      host: 'opencode',
      surface: 'skill',
      path: join(root, '.opencode', 'skills', 'remediate-code', 'SKILL.md'),
      matches: looksLikeRemediateCodeSkill,
    },
    {
      host: 'opencode',
      surface: 'prompt',
      path: join(root, '.opencode', 'skills', 'remediate-code', 'remediate-code.prompt.md'),
      matches: looksLikeRemediateCodePrompt,
    },
    {
      host: 'claude',
      surface: 'command',
      path: join(root, '.claude', 'commands', 'remediate-code.md'),
      matches: looksLikeRemediateCodePrompt,
    },
  ];

  const codexAgentDir = join(root, '.codex', 'skills', 'remediate-code', 'agents');
  const codexAgentEntries = await readdir(codexAgentDir).catch(() => []);
  for (const entry of codexAgentEntries) {
    targets.push({
      host: 'codex',
      surface: 'interface-metadata',
      path: join(codexAgentDir, entry),
      matches: looksLikeRemediateCodeInterfaceMetadata,
    });
  }

  return targets;
}

export async function findLegacyRemediateCodeSurfaceFiles(root) {
  const matches = [];
  for (const target of await buildLegacyRemediateCodeSurfaceTargets(root)) {
    const existing = await readTextIfExists(target.path);
    if (existing !== null && target.matches(existing)) {
      matches.push(target.path);
    }
  }
  return matches;
}

export async function removeLegacyRemediateCodeSurfaceFiles(root) {
  const removed = [];
  for (const target of await buildLegacyRemediateCodeSurfaceTargets(root)) {
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
