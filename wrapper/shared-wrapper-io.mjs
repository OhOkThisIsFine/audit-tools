// sites-pinned: tests/shared/wrapper-io-parity.test.ts
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname } from 'node:path';

export async function fileExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function newestMtimeMs(path) {
  const stats = await stat(path);
  if (!stats.isDirectory()) {
    return stats.mtimeMs;
  }

  let newest = stats.mtimeMs;
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const childPath = `${path}/${entry.name}`;
    if (entry.isDirectory()) {
      newest = Math.max(newest, await newestMtimeMs(childPath));
      continue;
    }
    if (entry.isFile()) {
      newest = Math.max(newest, (await stat(childPath)).mtimeMs);
    }
  }
  return newest;
}

export async function readTextIfExists(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

export async function readJson(path, description) {
  const content = await readFile(path, 'utf8');
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(
      `${description} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function writeGeneratedMarkdown(targetPath, content) {
  const existed = await fileExists(targetPath);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, 'utf8');
  return {
    path: targetPath,
    mode: existed ? 'updated' : 'created',
  };
}

export async function writeGeneratedJson(targetPath, value) {
  const existed = await fileExists(targetPath);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, JSON.stringify(value, null, 2) + '\n', 'utf8');
  return {
    path: targetPath,
    mode: existed ? 'updated' : 'created',
  };
}

async function readJsonObjectIfExists(targetPath, description) {
  if (!(await fileExists(targetPath))) {
    return {};
  }

  let parsed;
  try {
    parsed = JSON.parse(await readFile(targetPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `${description} exists but is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${description} must be a JSON object when it already exists.`);
  }

  return parsed;
}

export async function writeMergedGeneratedJson(targetPath, description, buildValue) {
  const existed = await fileExists(targetPath);
  const existing = await readJsonObjectIfExists(targetPath, description);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(
    targetPath,
    JSON.stringify(buildValue(existing), null, 2) + '\n',
    'utf8',
  );
  return {
    path: targetPath,
    mode: existed ? 'updated' : 'created',
  };
}
