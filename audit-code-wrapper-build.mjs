import { open, stat, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileExists, newestMtimeMs } from './audit-code-wrapper-io.mjs';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const distEntry = join(repoRoot, 'dist', 'audit', 'index.js');
const tsconfigPath = join(repoRoot, 'tsconfig.json');
const sourceRoot = join(repoRoot, 'src');
const buildLockPath = join(repoRoot, '.audit-code-build.lock');
const BUILD_LOCK_MAX_AGE_MS = 5 * 60 * 1000;
const BUILD_LOCK_WAIT_TIMEOUT_MS = 2 * 60 * 1000;
const BUILD_LOCK_WAIT_INTERVAL_MS = 200;

function npmExecutable() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function resolveSpawn(command, args) {
  if (!(process.platform === 'win32' && /\.(cmd|bat)$/i.test(command))) {
    return { command, args };
  }
  return {
    command: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', [command, ...args].map((arg) => {
      if (arg.length === 0) return '""';
      if (!/[\s"]/u.test(arg)) return arg;
      return `"${arg.replace(/"/g, '""')}"`;
    }).join(' ')],
  };
}

function runBuild(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const resolved = resolveSpawn(command, args);
    const child = spawn(resolved.command, resolved.args, {
      cwd: repoRoot,
      // Auto-rebuild output is diagnostic — route both child streams to the
      // parent's stderr (fd 2) so npm's `> auditor-lambda@… build` banner can
      // never pollute the wrapper's stdout JSON channel when a caller captures it.
      stdio: ['ignore', 2, 2],
      env: process.env,
    });
    child.on('error', rejectPromise);
    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`Command failed with exit code ${code}.`));
    });
  });
}

export async function shouldBuildDistForPaths({
  distEntryPath,
  sourceRootPath,
  tsconfigPath: tsconfigPathValue,
}) {
  if (!(await fileExists(distEntryPath))) {
    if (!(await fileExists(sourceRootPath)) || !(await fileExists(tsconfigPathValue))) {
      throw new Error(
        'Bundled dist is missing and source files are unavailable for rebuild.',
      );
    }
    return true;
  }

  if (!(await fileExists(sourceRootPath)) || !(await fileExists(tsconfigPathValue))) {
    return false;
  }

  const distMtime = (await stat(distEntryPath)).mtimeMs;
  const sourceMtime = await newestMtimeMs(sourceRootPath);
  const tsconfigMtime = (await stat(tsconfigPathValue)).mtimeMs;
  const newestInput = Math.max(sourceMtime, tsconfigMtime);
  return distMtime < newestInput;
}

async function shouldBuildDist() {
  return await shouldBuildDistForPaths({
    distEntryPath: distEntry,
    sourceRootPath: sourceRoot,
    tsconfigPath,
  });
}

async function releaseBuildLock(handle) {
  try {
    await handle?.close();
  } finally {
    await unlink(buildLockPath).catch(() => {});
    process.stderr.write(JSON.stringify({ event: "build_lock_released", pid: process.pid, lock: buildLockPath, released_at: new Date().toISOString() }) + '\n');
  }
}

async function waitForPeerBuild() {
  const start = Date.now();

  while (true) {
    if (!(await fileExists(buildLockPath))) {
      return;
    }

    if (Date.now() - start > BUILD_LOCK_WAIT_TIMEOUT_MS) {
      throw new Error(`Timed out waiting for build lock ${buildLockPath}.`);
    }

    await new Promise((r) => setTimeout(r, BUILD_LOCK_WAIT_INTERVAL_MS));
  }
}

async function acquireBuildLock() {
  while (true) {
    try {
      const handle = await open(buildLockPath, 'wx');
      const acquiredAt = new Date().toISOString();
      await handle.writeFile(JSON.stringify({ pid: process.pid, acquired_at: acquiredAt }));
      process.stderr.write(JSON.stringify({ event: "build_lock_acquired", pid: process.pid, lock: buildLockPath, acquired_at: acquiredAt }) + '\n');
      return handle;
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        try {
          const lockStats = await stat(buildLockPath);
          if (Date.now() - lockStats.mtimeMs > BUILD_LOCK_MAX_AGE_MS) {
            await unlink(buildLockPath).catch(() => {});
            continue;
          }
        } catch {
          continue;
        }

        await waitForPeerBuild();
        if (!(await shouldBuildDist())) {
          return null;
        }
        continue;
      }
      throw error;
    }
  }
}

export function assertWorkspaceInstalled({ checkoutRoot, sharedManifestPath }) {
  if (!sharedManifestPath) {
    throw new Error(
      'Dependencies are not installed for this checkout. Run `npm install` from ' +
        'the repository root, then retry — building from source needs node_modules ' +
        '(including the audit-tools/shared workspace link).',
    );
  }

  const relToCheckout = relative(checkoutRoot, sharedManifestPath);
  if (relToCheckout.startsWith('..') || isAbsolute(relToCheckout)) {
    throw new Error(
      `audit-tools/shared resolved to ${sharedManifestPath}, outside this ` +
        `checkout (${checkoutRoot}). node_modules was never installed here — ` +
        'common in a fresh git worktree — so building would typecheck against ' +
        "another checkout's stale dist and report phantom \"missing export\" " +
        "errors. Run `npm install` from this checkout's root.",
    );
  }
}

export async function ensureBuilt() {
  if (!(await shouldBuildDist())) {
    return;
  }

  const lockHandle = await acquireBuildLock();
  if (!lockHandle) {
    return;
  }

  try {
    if (!(await shouldBuildDist())) {
      return;
    }
    await runBuild(npmExecutable(), ['run', 'build']);
  } finally {
    await releaseBuildLock(lockHandle);
  }
}
