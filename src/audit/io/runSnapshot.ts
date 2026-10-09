// sites-pinned: tests/audit/run-snapshot.test.ts, tests/audit/frozen-snapshot.test.ts
/**
 * The frozen snapshot an audit run reads (docs/backlog/forward-tracks.md, the
 * frozen-snapshot track; design record docs/reviews/frozen-snapshot-design-2026-10-08.md).
 *
 * PROPERTY: no edit to the live tree during a run changes that run's inputs. At
 * run start the repository's working tree — uncommitted and untracked work
 * included — is copied BYTE-EXACT into a directory OUTSIDE the repository root.
 * Every content read and every repo-local spawn of the run uses that directory
 * (the SOURCE root); identity (consent, policy, artifacts dir, re-issued
 * commands) stays on the LIVE root.
 *
 * A GIT root becomes a detached `git worktree` whose `HEAD` is the live `HEAD`
 * at run start (the BASE — unborn when the repository has no commit), whose
 * index is the live INDEX at run start, and whose files are the live bytes. So
 * git inside the snapshot answers exactly as it did in the live tree when the
 * run started: the same commit, the same tracked and staged set, the same dirty
 * and untracked paths, the same history — `audit_read` keeps its meaning, and no
 * synthetic commit reaches history mining, the report, or a ref anybody else
 * reads. A content PIN (a commit of the copied bytes) is kept only under this
 * run's own ref, so a checkout that went missing can be restored; the run end
 * deletes it. Each populated submodule is snapshotted the same way inside its
 * parent's checkout, so `ls-files --recurse-submodules` still recurses.
 *
 * A NON-GIT root is frozen by a COPY. A missing copy fails closed: the frozen
 * content is gone, and re-copying the live tree would break the property.
 *
 * Git-ignored entries (dependency directories, build output, local config) are
 * not snapshot content: a directory is LINKED from the live root (so repo-local
 * tools resolve as they do there), a symlink is re-created, and a file is
 * COPIED — never hard-linked, so a tool writing an ignored file in the snapshot
 * (a build cache) can never write into the user's file. One entry that cannot
 * be placed is reported, never fatal. A `.audit-tools` path at any depth and
 * `.git` are never placed.
 *
 * RESIDUAL: git discovery inside a COPY snapshot is fenced for this process
 * (`GIT_CEILING_DIRECTORIES`), not for a host lane's own git; host lanes are
 * told only to read files there.
 *
 * Location: `<state dir>/snapshots/<key>` (the machine-global state dir,
 * `resolveAuditCodeStateDir`), `<key>` derived from the live root and the
 * artifacts dir. Outside the root, so the target's own test runner never
 * discovers the copy and the node-worktree CLI guard never fires on it; short,
 * so `git worktree add` stays clear of the Windows long-path failure; not under
 * the OS temp dir, so no temp cleaner removes it mid-run; deterministic, so a
 * snapshot leaked by a crashed run is replaced, never accumulated.
 */
import { constants as fsConstants, existsSync } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, rmdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { z } from "zod";
import { compareCodeUnits, hashContent, readOptionalJsonFile, resolveAuditCodeStateDir, resolveWithinRoot, toPosixPath, writeJsonFile } from "audit-tools/shared";
import { headCommit, isGitRepo, workingTreeTree } from "../../shared/git.js";
import { runTrackedAsync, TRACKED_CHILD_DEADLINE_MS } from "../../shared/tooling/exec.js";
import { AUDIT_TOOLS_DIRNAME } from "../../shared/io/auditToolsPaths.js";
import { isIntakeIgnored } from "../extractors/fsIntake.js";
import { loadIgnoreFile } from "../extractors/ignore.js";

const GitPinSchema = z.object({
  /** realpath of the live repository directory that owns this pin's objects. */
  repository: z.string(),
  /** The checkout inside the snapshot. */
  path: z.string(),
  /** The live `HEAD` at run start — the checkout's `HEAD`; `null` when unborn. */
  base: z.string().nullable(),
  /** The tree of the live INDEX at run start — the checkout's index. */
  index: z.string(),
  /** The copied bytes as a commit, kept only to restore the checkout. */
  commit: z.string(),
  /** This run's own ref holding `commit`. */
  ref: z.string(),
}).strict();
type GitPin = z.infer<typeof GitPinSchema>;

const RunSnapshotSchema = z.object({
  schema_version: z.literal("audit-run-snapshot/v1"),
  repository_root: z.string(),
  source_root: z.string(),
  kind: z.enum(["git", "copy"]),
  /** Root repository first, then each submodule after its parent. Empty for `copy`. */
  pins: z.array(GitPinSchema),
  /** Snapshot-relative (POSIX) paths of the directory links the snapshot placed. */
  linked: z.array(z.string()),
  /** Each `--since` ref this run was given, resolved ONCE against the live root. */
  since: z.record(z.string(), z.string()),
}).strict();
export type RunSnapshot = z.infer<typeof RunSnapshotSchema>;

export const runSnapshotPath = (artifactsDir: string): string => join(artifactsDir, "run-snapshot.json");

/** The branch an unborn checkout's `HEAD` names; it is never created. */
const UNBORN_BRANCH = "refs/heads/audit-tools-unborn-snapshot";

const SNAPSHOT_COMMIT_ENV = {
  GIT_AUTHOR_NAME: "audit-tools",
  GIT_AUTHOR_EMAIL: "audit-tools@localhost",
  GIT_COMMITTER_NAME: "audit-tools",
  GIT_COMMITTER_EMAIL: "audit-tools@localhost",
};

/**
 * Every git call of this module runs with `core.fsmonitor` off: a monitor
 * daemon started inside a snapshot checkout would hold it open and block its
 * removal.
 */
async function git(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  const result = await runTrackedAsync(["git", "-c", "core.fsmonitor=false", ...args], {
    cwd,
    encoding: "utf8",
    timeout: TRACKED_CHILD_DEADLINE_MS,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  if (result.status !== 0) {
    throw new Error(`audit snapshot: git ${args.join(" ")} failed in ${cwd}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

const snapshotsRoot = (): string => join(resolveAuditCodeStateDir(), "snapshots");

/**
 * Stop git discovery at the snapshots dir. A COPY snapshot has no `.git`, and
 * without this fence git run inside it would climb to whatever repository holds
 * the state dir (a home directory under version control) and answer for that
 * one. A git snapshot's own `.git` sits below the fence, so it is unaffected.
 * Process-wide, so every git child of the run inherits it.
 */
function fenceSnapshotsFromParentRepositories(): void {
  const fence = resolve(snapshotsRoot());
  const current = process.env.GIT_CEILING_DIRECTORIES ?? "";
  if (current.split(delimiter).includes(fence)) return;
  process.env.GIT_CEILING_DIRECTORIES = current.length > 0 ? `${current}${delimiter}${fence}` : fence;
}

/**
 * Unlink every link inside `dir` without following it: each one points INTO THE
 * LIVE TREE (a linked dependency directory), so nothing may recurse through it.
 */
async function unlinkPlacedLinks(dir: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink() || (await lstat(path)).isSymbolicLink()) {
      // A win32 junction refuses `unlink` on some versions; `rmdir` removes the
      // link itself, never its target.
      await unlink(path).catch(() => rmdir(path));
    } else if (entry.isDirectory()) {
      await unlinkPlacedLinks(path);
    }
  }
}

/** Remove `dir`: its links first, then the remainder. */
async function removeSnapshotDir(dir: string): Promise<void> {
  await unlinkPlacedLinks(dir);
  await rm(dir, { recursive: true, force: true });
}

/**
 * `git worktree add --detach --force --no-checkout` with hooks off (a user's
 * post-checkout hook must not run in the snapshot). `--force` re-registers the
 * deterministic path when an earlier run's registration outlived its
 * directory, so nothing here ever prunes the user's OTHER worktrees.
 */
async function addEmptyWorktree(repository: string, path: string, commit: string): Promise<void> {
  await removeSnapshotDir(path);
  await mkdir(dirname(path), { recursive: true });
  await git(repository, [
    "-c", `core.hooksPath=${join(dirname(path), ".no-hooks")}`,
    "worktree", "add", "--detach", "--force", "--no-checkout", path, commit,
  ]);
}

async function commitTree(repository: string, tree: string, parent: string | null): Promise<string> {
  return (await git(repository, ["commit-tree", tree, ...(parent === null ? [] : ["-p", parent]), "-m", "audit-tools run snapshot"],
    SNAPSHOT_COMMIT_ENV)).trim();
}

async function emptyTree(repository: string): Promise<string> {
  return (await git(repository, ["mktree"])).trim();
}

/**
 * The checkout's `HEAD` and index: the base commit (or unborn) and the live
 * index tree. An unborn checkout is first added at a throwaway empty commit (a
 * worktree needs one) and then pointed at a branch that is never created.
 */
async function setCheckoutState(pin: GitPin): Promise<void> {
  if (pin.base === null) await git(pin.path, ["symbolic-ref", "HEAD", UNBORN_BRANCH]);
  await git(pin.path, ["read-tree", pin.index]);
  await git(pin.path, ["update-index", "-q", "--refresh"]).catch(() => undefined);
}

async function addCheckout(pin: Pick<GitPin, "repository" | "path" | "base">): Promise<void> {
  const start = pin.base ?? await commitTree(pin.repository, await emptyTree(pin.repository), null);
  await addEmptyWorktree(pin.repository, pin.path, start);
}

/** A live directory and the snapshot directory that mirrors it. */
type TreeMapping = { live: string; snap: string };

/**
 * Re-create a symlink as a symlink; `false` when the platform refuses (win32
 * without the privilege). A target inside `mapping.live` — relative or absolute
 * — is mapped onto the snapshot, so it resolves there and never reaches the live
 * tree; one outside points at its absolute live path. A win32 junction needs an
 * absolute target, so it gets the snapshot-side one; any other link a relative one.
 */
async function copySymlink(source: string, dest: string, mapping: TreeMapping): Promise<boolean> {
  const absolute = resolve(dirname(source), await readlink(source));
  const inside = resolveWithinRoot(mapping.live, absolute) !== null;
  const pointsAtDirectory = await stat(source).then((info) => info.isDirectory(), () => false);
  const junction = pointsAtDirectory && process.platform === "win32";
  const snapTarget = join(mapping.snap, relative(mapping.live, absolute));
  const linkTarget = !inside ? absolute : junction ? snapTarget : relative(dirname(dest), snapTarget) || ".";
  try {
    await symlink(linkTarget, dest, pointsAtDirectory ? (junction ? "junction" : "dir") : "file");
    return true;
  } catch {
    return false;
  }
}

/**
 * True for a path the snapshot never places when it is NOT tracked: `.git`, and
 * a `.audit-tools` segment at any depth (this tool's own state). A TRACKED path
 * is snapshot content wherever it sits.
 */
function isNeverPlaced(relativePath: string): boolean {
  const segments = toPosixPath(relativePath).split("/");
  return segments[0] === ".git" || segments.includes(AUDIT_TOOLS_DIRNAME);
}

const splitNul = (out: string): string[] => out.split("\0").filter((entry) => entry.length > 0);
const withoutTrailingSlash = (path: string): string => (path.endsWith("/") ? path.slice(0, -1) : path);

/**
 * Copy the files git lists in `liveDir` (tracked, plus untracked and not
 * ignored) into `snapDir`, byte-exact. `skip` names the populated submodules,
 * each snapshotted as its own checkout. An untracked NESTED repository (listed
 * as one directory) is copied the same way through its own listing — so its
 * ignored content (dependency and build output) is never copied — and is
 * returned so its ignored entries are placed with the others.
 */
async function copyListedFiles(
  liveDir: string,
  snapDir: string,
  mapping: TreeMapping,
  skip: readonly string[],
  warnings: string[],
  nested: TreeMapping[],
): Promise<void> {
  const tracked = new Set(splitNul(await git(liveDir, ["ls-files", "-z", "--cached"])));
  const paths = new Set(tracked);
  for (const raw of splitNul(await git(liveDir, ["ls-files", "-z", "--others", "--exclude-standard"]))) {
    if (!isNeverPlaced(withoutTrailingSlash(raw))) paths.add(raw);
  }
  for (const raw of [...paths].sort(compareCodeUnits)) {
    const path = withoutTrailingSlash(raw);
    if (skip.includes(path)) continue;
    const source = join(liveDir, path);
    const dest = join(snapDir, path);
    const info = await lstat(source).catch(() => undefined);
    // A deleted-but-tracked file is absent from the snapshot, as from the live tree.
    if (info === undefined) continue;
    await mkdir(dirname(dest), { recursive: true });
    if (info.isSymbolicLink()) {
      if (!(await copySymlink(source, dest, mapping))) warnings.push(`could not re-create the symlink ${source}`);
    } else if (info.isDirectory()) {
      // A tracked directory is a submodule that is not checked out: empty, as live.
      if (tracked.has(raw)) {
        await mkdir(dest, { recursive: true });
        continue;
      }
      try {
        await copyListedFiles(source, dest, mapping, [], warnings, nested);
        nested.push({ live: source, snap: dest });
      } catch (error) {
        warnings.push(`could not copy the nested repository ${source}: ${(error as Error).message}`);
      }
    } else if (info.isFile()) {
      await copyFile(source, dest);
    }
  }
}

/**
 * Place one entry the snapshot does not own by its own type. Never throws: an
 * entry that cannot be placed is returned as a warning.
 */
async function placeEntry(
  source: string,
  dest: string,
  mapping: TreeMapping,
  linked: Set<string>,
  linkKey: string,
): Promise<string | null> {
  if (existsSync(dest)) return null;
  try {
    const info = await lstat(source);
    await mkdir(dirname(dest), { recursive: true });
    if (info.isSymbolicLink()) {
      return (await copySymlink(source, dest, mapping)) ? null : `could not re-create the symlink ${source}`;
    }
    if (info.isDirectory()) {
      await symlink(source, dest, process.platform === "win32" ? "junction" : "dir");
      linked.add(linkKey);
      return null;
    }
    // A copy, never a hard link: a hard link is the SAME file, so a tool that
    // rewrites it in the snapshot would rewrite the user's. FICLONE makes it a
    // free reflink where the filesystem supports one.
    if (info.isFile()) await copyFile(source, dest, fsConstants.COPYFILE_FICLONE);
    return null;
  } catch (error) {
    return `could not place ${source}: ${(error as Error).message}`;
  }
}

/**
 * Place each git-ignored entry of `repository` into `snapDir`; symlink targets
 * map through `mapping` (the enclosing checkout's live and snapshot dirs).
 */
async function placeIgnoredEntries(
  repository: string,
  snapDir: string,
  mapping: TreeMapping,
  linked: Set<string>,
  linkPrefix: string,
  warnings: string[],
): Promise<void> {
  const out = await git(repository, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]);
  for (const raw of splitNul(out).sort(compareCodeUnits)) {
    const relativePath = withoutTrailingSlash(raw);
    if (isNeverPlaced(relativePath)) continue;
    const warning = await placeEntry(
      join(repository, relativePath),
      join(snapDir, relativePath),
      mapping,
      linked,
      `${linkPrefix}${toPosixPath(relativePath)}`,
    );
    if (warning !== null) warnings.push(warning);
  }
}

/** Place the ignored entries of each untracked nested repository `copyListedFiles` copied. */
async function placeNestedIgnoredEntries(
  nested: readonly TreeMapping[],
  mapping: TreeMapping,
  linked: Set<string>,
  linkPrefix: string,
  warnings: string[],
): Promise<void> {
  for (const repository of nested) {
    const prefix = `${linkPrefix}${toPosixPath(relative(mapping.snap, repository.snap))}/`;
    try {
      await placeIgnoredEntries(repository.live, repository.snap, mapping, linked, prefix, warnings);
    } catch (error) {
      warnings.push(`could not place the ignored entries of ${repository.live}: ${(error as Error).message}`);
    }
  }
}

/** Paths of `repository`'s submodules whose live directory is a checked-out repository. */
async function populatedSubmodules(repository: string): Promise<string[]> {
  const out = await git(repository, ["ls-files", "-z", "--stage"]);
  return out.split("\0")
    .filter((line) => line.startsWith("160000 "))
    .map((line) => line.slice(line.indexOf("\t") + 1))
    .filter((path) => existsSync(join(repository, path, ".git")))
    .sort(compareCodeUnits);
}

/**
 * The tree of `repository`'s live index, written from a COPY of the index file:
 * `write-tree` on the live index would take the user's `index.lock` (failing
 * beside an editor's background `git status`, or failing the user's own commit)
 * and rewrite the user's index. `write-tree` refuses an index with unmerged
 * entries; only then does the checkout take the base's tree (or the empty tree),
 * with a warning. Any other failure is thrown.
 */
async function liveIndexTree(repository: string, base: string | null, warnings: string[]): Promise<string> {
  const liveIndex = resolve(repository, (await git(repository, ["rev-parse", "--git-path", "index"])).trim());
  const scratch = await mkdtemp(join(tmpdir(), "audit-snapshot-index-"));
  try {
    const env = { GIT_INDEX_FILE: join(scratch, "index") };
    if (existsSync(liveIndex)) await copyFile(liveIndex, env.GIT_INDEX_FILE);
    try {
      return (await git(repository, ["write-tree"], env)).trim();
    } catch (error) {
      if ((await git(repository, ["ls-files", "--unmerged"], env)).trim().length === 0) throw error;
      warnings.push(`${repository} has unmerged index entries; the snapshot's index is its HEAD tree`);
      return base === null ? emptyTree(repository) : (await git(repository, ["rev-parse", `${base}^{tree}`])).trim();
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Snapshot `liveDir` at `snapDir`, each populated submodule inside it. The
 * checkout is added EMPTY and filled with the live bytes (a normal checkout
 * would re-apply line-ending and other filters), so the run reads exactly what
 * was on disk; the content pin is computed FROM the copy.
 */
async function snapshotRepository(
  liveDir: string,
  snapDir: string,
  ref: string,
  pins: GitPin[],
  linked: Set<string>,
  linkPrefix: string,
  warnings: string[],
): Promise<void> {
  const repository = await realpath(liveDir);
  const mapping = { live: repository, snap: snapDir };
  const base = await headCommit(repository);
  const indexTree = await liveIndexTree(repository, base, warnings);
  await addCheckout({ repository, path: snapDir, base });
  const slot = pins.length;
  pins.push({ repository, path: snapDir, base, index: indexTree, commit: indexTree, ref });

  const submodules = await populatedSubmodules(repository);
  const nested: TreeMapping[] = [];
  await copyListedFiles(repository, snapDir, mapping, submodules, warnings, nested);
  for (const sub of submodules) {
    await snapshotRepository(join(repository, sub), join(snapDir, sub), ref, pins, linked, `${linkPrefix}${sub}/`, warnings);
  }

  const pin = pins[slot];
  await setCheckoutState(pin);
  const tree = await workingTreeTree(snapDir);
  if (tree === null) throw new Error(`audit snapshot: cannot read the copied working tree of ${repository}`);
  const commit = await commitTree(repository, tree, base);
  await git(repository, ["update-ref", ref, commit]);
  pins[slot] = { ...pin, commit };
  await placeIgnoredEntries(repository, snapDir, mapping, linked, linkPrefix, warnings);
  await placeNestedIgnoredEntries(nested, mapping, linked, linkPrefix, warnings);
}

/** Copy a non-git root, placing what intake ignores instead of copying it. */
async function copyTree(
  liveRoot: string,
  snapRoot: string,
  ignores: readonly string[],
  skip: string,
  linked: Set<string>,
  warnings: string[],
  relativeDir = "",
): Promise<void> {
  const entries = await readdir(join(liveRoot, relativeDir), { withFileTypes: true });
  await mkdir(join(snapRoot, relativeDir), { recursive: true });
  for (const entry of entries.sort((a, b) => compareCodeUnits(a.name, b.name))) {
    const relativePath = relativeDir ? join(relativeDir, entry.name) : entry.name;
    const source = join(liveRoot, relativePath);
    // The state dir holds the snapshot being written; copying it would recurse.
    if (isNeverPlaced(relativePath) || resolve(source) === skip) continue;
    const dest = join(snapRoot, relativePath);
    if (isIntakeIgnored(relativePath, ignores) || entry.isSymbolicLink()) {
      const warning = await placeEntry(source, dest, { live: liveRoot, snap: snapRoot }, linked, toPosixPath(relativePath));
      if (warning !== null) warnings.push(warning);
    } else if (entry.isDirectory()) {
      await copyTree(liveRoot, snapRoot, ignores, skip, linked, warnings, relativePath);
    } else if (entry.isFile()) {
      await copyFile(source, dest);
    }
  }
}

async function readRunSnapshot(artifactsDir: string): Promise<RunSnapshot | undefined> {
  const raw = await readOptionalJsonFile<unknown>(runSnapshotPath(artifactsDir));
  return raw === undefined || raw === null ? undefined : RunSnapshotSchema.parse(raw);
}

/**
 * True when the checkout is still a checkout (its `.git` link is present) and
 * sits at its base — an unborn one on the unborn branch. `headCommit` answers
 * `null` on ANY failure, so an unborn pin is checked by the branch its `HEAD`
 * names, never by a `null` head.
 */
async function pinIntact(pin: GitPin): Promise<boolean> {
  if (!existsSync(join(pin.path, ".git"))) return false;
  if (pin.base !== null) return (await headCommit(pin.path)) === pin.base;
  return (await git(pin.path, ["symbolic-ref", "HEAD"]).then((out) => out.trim(), () => "")) === UNBORN_BRANCH;
}

async function pinsIntact(pins: readonly GitPin[]): Promise<boolean> {
  for (const pin of pins) {
    if (!(await pinIntact(pin))) return false;
  }
  return true;
}

/**
 * Re-create every checkout of a git snapshot from its pins, root first, and
 * persist the links it placed. The content comes from the pin through
 * `checkout-index`, so on a repository with line-ending filters it can differ
 * in bytes from the original copy; the fold's integrity re-check then refreshes
 * intake over the restored checkout. The ignored entries of an untracked nested
 * repository are not re-placed (the record does not name nested repositories);
 * intake skips most of them anyway.
 */
async function restoreSnapshot(record: RunSnapshot, artifactsDir: string): Promise<RunSnapshot> {
  const warnings: string[] = [];
  const linked = new Set<string>();
  for (const pin of record.pins) {
    await addCheckout(pin);
    await git(pin.path, ["read-tree", pin.commit]);
    await git(pin.path, ["checkout-index", "-a", "-f"]);
    await setCheckoutState(pin);
    const prefix = toPosixPath(relative(record.pins[0].path, pin.path));
    await placeIgnoredEntries(
      pin.repository, pin.path, { live: pin.repository, snap: pin.path }, linked, prefix ? `${prefix}/` : "", warnings,
    );
  }
  reportWarnings(warnings);
  const restored = { ...record, linked: [...linked].sort(compareCodeUnits) };
  await writeJsonFile(runSnapshotPath(artifactsDir), restored);
  return restored;
}

function reportWarnings(warnings: readonly string[]): void {
  for (const warning of warnings) process.stderr.write(`[audit-code] run snapshot: ${warning}\n`);
}

function snapshotKey(repositoryRoot: string, artifactsDir: string): string {
  return hashContent(`${repositoryRoot}\0${artifactsDir}`).slice(0, 12);
}

async function createRunSnapshot(root: string, artifactsDir: string): Promise<RunSnapshot> {
  const repositoryRoot = await realpath(root);
  const key = snapshotKey(repositoryRoot, await realpath(artifactsDir).catch(() => resolve(artifactsDir)));
  const dir = join(snapshotsRoot(), key);
  await removeSnapshotDir(dir);
  const linked = new Set<string>();
  const warnings: string[] = [];
  let record: RunSnapshot;
  if (await isGitRepo(repositoryRoot)) {
    const toplevel = (await git(repositoryRoot, ["rev-parse", "--show-toplevel"])).trim();
    const prefix = (await git(repositoryRoot, ["rev-parse", "--show-prefix"])).trim();
    const pins: GitPin[] = [];
    await snapshotRepository(toplevel, join(dir, "tree"), `refs/audit-tools/snapshots/${key}`, pins, linked, "", warnings);
    record = {
      schema_version: "audit-run-snapshot/v1",
      repository_root: repositoryRoot,
      source_root: prefix ? join(dir, "tree", prefix) : join(dir, "tree"),
      kind: "git",
      pins,
      linked: [...linked].sort(compareCodeUnits),
      since: {},
    };
  } else {
    const skip = resolve(await realpath(resolveAuditCodeStateDir()).catch(() => resolveAuditCodeStateDir()));
    await copyTree(repositoryRoot, join(dir, "tree"), await loadIgnoreFile(repositoryRoot), skip, linked, warnings);
    record = {
      schema_version: "audit-run-snapshot/v1",
      repository_root: repositoryRoot,
      source_root: join(dir, "tree"),
      kind: "copy",
      pins: [],
      linked: [...linked].sort(compareCodeUnits),
      since: {},
    };
  }
  reportWarnings(warnings);
  return record;
}

/**
 * The run's snapshot: created at run start, its checkouts restored when they
 * went missing, refused when a copy went missing.
 *
 * The caller holds the artifact-tree lock (the snapshot is run state, created
 * once per run). Callers on a run path go through {@link ensureRunSourceRoot},
 * which owns the "a complete run reads nothing" rule.
 */
export async function ensureRunSnapshot(root: string, artifactsDir: string): Promise<RunSnapshot> {
  fenceSnapshotsFromParentRepositories();
  const existing = await readRunSnapshot(artifactsDir);
  if (existing !== undefined) {
    if (existing.repository_root !== (await realpath(root))) {
      throw new Error("Audit run snapshot belongs to another repository");
    }
    if (existing.kind === "copy") {
      if (!existsSync(existing.source_root)) {
        throw new Error(
          `The frozen copy this audit run reads (${existing.source_root}) is gone, so the run's inputs cannot be ` +
          "recovered. Run `audit-code cleanup --force` to discard the run, then start a new one.",
        );
      }
      return existing;
    }
    return (await pinsIntact(existing.pins)) ? existing : restoreSnapshot(existing, artifactsDir);
  }
  const created = await createRunSnapshot(root, artifactsDir);
  await writeJsonFile(runSnapshotPath(artifactsDir), created);
  return created;
}

/**
 * The root a run's content reads use — THE one decision every run path shares
 * (the next-step fold and every standalone step command). A COMPLETE run reads
 * nothing more: it is given no snapshot (promotion removed it, and a new one
 * would freeze a tree the run never read), and its terminal step needs only the
 * live root. Any other run reads its frozen snapshot. The caller holds the
 * artifact-tree lock.
 */
export async function ensureRunSourceRoot(root: string, artifactsDir: string): Promise<string> {
  const status = (await readOptionalJsonFile<{ status?: unknown }>(join(artifactsDir, "audit_state.json")))?.status;
  if (status === "complete") return root;
  return (await ensureRunSnapshot(root, artifactsDir)).source_root;
}

/**
 * The commit a `--since` ref named when this run first saw it, resolved against
 * the LIVE root (a pseudo-ref such as the branch upstream @{u} or ORIG_HEAD does
 * not resolve in the detached snapshot) and persisted, so a moving HEAD cannot move the
 * delta mid-run. An unresolvable ref is returned unchanged, for the scope
 * resolver's own full-audit fallback. The caller holds the artifact-tree lock.
 */
export async function resolveRunSince(root: string, artifactsDir: string, since: string): Promise<string> {
  const record = await readRunSnapshot(artifactsDir);
  const known = record?.since[since];
  if (known !== undefined) return known;
  const result = await runTrackedAsync(["git", "rev-parse", "--verify", "--quiet", `${since}^{commit}`], {
    cwd: root,
    encoding: "utf8",
    timeout: TRACKED_CHILD_DEADLINE_MS,
  });
  const sha = result.status === 0 ? result.stdout.trim() : "";
  if (sha.length === 0) return since;
  if (record !== undefined) {
    await writeJsonFile(runSnapshotPath(artifactsDir), { ...record, since: { ...record.since, [since]: sha } });
  }
  return sha;
}

/** The `--since` resolution this run recorded, without resolving anything (no lock). */
export async function lookupRunSince(artifactsDir: string, since: string): Promise<string> {
  return (await readRunSnapshot(artifactsDir))?.since[since] ?? since;
}

/**
 * The source root of the run in `artifactsDir`, WITHOUT creating a snapshot —
 * for a read-only command that holds no lock. With no run started there is no
 * frozen tree, and the live root is the only content there is.
 */
export async function readRunSourceRoot(root: string, artifactsDir: string): Promise<string> {
  fenceSnapshotsFromParentRepositories();
  return (await readRunSnapshot(artifactsDir))?.source_root ?? root;
}

/** The directory links the run's snapshot placed — never audit input (see `readAuditReadState`). */
export async function readRunSnapshotLinks(artifactsDir: string): Promise<readonly string[]> {
  return (await readRunSnapshot(artifactsDir))?.linked ?? [];
}

/**
 * The one statement of where a host lane reads repository source during a run:
 * the frozen snapshot, never its own working directory or the live repository,
 * which may have moved since the run started. Single-sourced so the work-item
 * prompts and every materialized lane prompt say it identically.
 */
export function sourceTreeInstruction(sourceRoot: string): string {
  return "Read repository source from this directory — the audit run's frozen snapshot — and resolve every " +
    `repository path against it, not against your working directory or the live repository: ${toPosixPath(sourceRoot)}`;
}

/**
 * Carry the tool's own edits of the snapshot (the opted-in auto-fix phase) back
 * to the live tree. A file is written only when its live bytes still hash to
 * `startHashes` — the content the run started from — so a user's concurrent
 * edit is never overwritten; such a file is returned as skipped.
 */
export async function writeBackSnapshotEdits(params: {
  sourceRoot: string;
  repositoryRoot: string;
  paths: readonly string[];
  startHashes: ReadonlyMap<string, string>;
}): Promise<{ written: string[]; skipped: string[] }> {
  const written: string[] = [];
  const skipped: string[] = [];
  for (const path of [...new Set(params.paths)].sort(compareCodeUnits)) {
    const edited = await readFile(join(params.sourceRoot, path)).catch(() => undefined);
    if (edited === undefined) continue;
    const live = await readFile(join(params.repositoryRoot, path)).catch(() => undefined);
    // A file intake did not hash (oversized) has no recorded start: identical
    // bytes mean nothing was edited; different bytes cannot be attributed.
    const start = params.startHashes.get(path)
      ?? (live !== undefined && live.equals(edited) ? hashContent(edited) : undefined);
    if (start !== undefined && hashContent(edited) === start) continue;
    if (start === undefined || live === undefined || hashContent(live) !== start) {
      skipped.push(path);
      continue;
    }
    await writeFile(join(params.repositoryRoot, path), edited);
    written.push(path);
  }
  return { written, skipped };
}

/**
 * Re-pin the run's snapshot after the tool edited it (deepest checkout first),
 * so a checkout restored later holds the edited bytes. The checkouts' `HEAD`
 * and index are unchanged: the edit is the run's, not a commit's. The placed
 * links are subtracted — on POSIX a dir-only ignore pattern does not match a
 * symlink, and a pinned link would be restored as a file.
 */
export async function repinRunSnapshot(artifactsDir: string): Promise<void> {
  const record = await readRunSnapshot(artifactsDir);
  if (record === undefined || record.kind !== "git") return;
  const pins = [...record.pins];
  for (let index = pins.length - 1; index >= 0; index--) {
    const pin = pins[index];
    const prefix = toPosixPath(relative(record.pins[0].path, pin.path));
    const own = record.linked
      .filter((path) => (prefix ? path.startsWith(`${prefix}/`) : true))
      .map((path) => (prefix ? path.slice(prefix.length + 1) : path));
    const tree = await workingTreeTree(pin.path, { excludePaths: own });
    if (tree === null) throw new Error(`audit snapshot: cannot read the edited checkout ${pin.path}`);
    if ((await git(pin.repository, ["rev-parse", `${pin.commit}^{tree}`])).trim() === tree) continue;
    const commit = await commitTree(pin.repository, tree, pin.base);
    await git(pin.repository, ["update-ref", pin.ref, commit]);
    pins[index] = { ...pin, commit };
  }
  await writeJsonFile(runSnapshotPath(artifactsDir), { ...record, pins });
}

/**
 * Remove the run's snapshot: its links first (each points into the live tree),
 * then the directory, then each checkout's own registration and ref (deepest
 * first), then the record. Never throws — a cleanup must not fail on the
 * scratch it is reclaiming; each problem is returned for the caller to report.
 * The record goes last and only on a clean removal, so a failed one can be
 * retried and a second call is a no-op.
 */
export async function removeRunSnapshot(artifactsDir: string): Promise<string[]> {
  const problems: string[] = [];
  let record: RunSnapshot | undefined;
  try {
    record = await readRunSnapshot(artifactsDir);
  } catch (error) {
    return [`unreadable ${runSnapshotPath(artifactsDir)}: ${(error as Error).message}`];
  }
  if (record === undefined) return problems;
  const dir = record.pins.length > 0 ? dirname(record.pins[0].path) : dirname(record.source_root);
  try {
    await removeSnapshotDir(dir);
  } catch (error) {
    problems.push(`could not remove ${dir}: ${(error as Error).message}`);
    return problems;
  }
  for (const pin of [...record.pins].reverse()) {
    // The directory is gone, so `worktree remove` only drops this checkout's
    // own registration; a registration git no longer lists is not an error.
    await git(pin.repository, ["worktree", "remove", "--force", "--force", pin.path]).catch(async (error: unknown) => {
      const listed = await git(pin.repository, ["worktree", "list", "--porcelain"]).catch(() => "");
      if (listed.includes(toPosixPath(pin.path))) problems.push((error as Error).message);
    });
    await git(pin.repository, ["update-ref", "-d", pin.ref])
      .catch((error: unknown) => problems.push((error as Error).message));
  }
  if (problems.length === 0) await rm(runSnapshotPath(artifactsDir), { force: true });
  return problems;
}
