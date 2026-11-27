import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isScriptEntry } from "./primitives.mjs";

// ci.yml and publish-package.yml share the Linux verify:checks recipe. Bump this
// namespace if the recipe changes incompatibly; older artifacts then miss.
const recipe = "qualified-ci-npm-v1-node22.14.0";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const json = text => JSON.parse(text.toString());
const positiveId = n => Number.isSafeInteger(n) && n > 0;
const readGit = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const success = item => item?.status === "completed" && item.conclusion === "success";

export function preparedTitle(title, version, previous) {
  return /^\d+\.\d+\.\d+$/u.test(version) && title === "release: prepare v" + version && version !== previous;
}

function prefix(sha, attempt) {
  return recipe + "-" + sha + "-" + attempt + "-";
}

function verifyPackageBytes(bytes, digest, source, readPackedPackage) {
  if (sha256(bytes) !== digest) throw new Error("CI tarball SHA-256 mismatch");
  const packed = readPackedPackage();
  if (packed.name !== source.name || packed.version !== source.version) {
    throw new Error("CI tarball does not match the verified package name and version");
  }
}

export async function retrieveQualification({
  request, repo, branch, sha, source, outputDir, now = Date.now(),
}) {
  const query = new URLSearchParams({ event: "push", branch, head_sha: sha, per_page: "100" });
  const endpoint = "/actions/workflows/ci.yml/runs?" + query;
  const matchesRun = run => run.event === "push" && run.head_branch === branch && run.head_sha === sha
    && run.repository?.full_name === repo && run.head_repository?.full_name === repo
    && run.path?.split("@")[0] === ".github/workflows/ci.yml";
  async function latest() {
    const listing = await request(endpoint);
    if (listing.total_count !== listing.workflow_runs.length || listing.workflow_runs.length === 100) {
      throw new Error("CI workflow run lookup was incomplete");
    }
    const matching = listing.workflow_runs.filter(matchesRun);
    if (matching.some(run => !positiveId(run.id) || !positiveId(run.run_number) || !positiveId(run.run_attempt))) {
      throw new Error("Invalid CI workflow run identity");
    }
    return matching.sort((a, b) => b.run_number - a.run_number)[0];
  }
  const run = await latest();
  if (!run || run.status !== "completed") return null;
  if (run.conclusion === "skipped" || run.conclusion === "cancelled") return null;
  if (!success(run)) throw new Error("The latest exact-commit CI push did not succeed");

  const { id: runId, run_attempt: attempt } = run;
  const base = "/actions/runs/" + runId;
  const jobList = await request(base + "/attempts/" + attempt + "/jobs?per_page=100");
  if (jobList.total_count !== jobList.jobs.length || jobList.jobs.length === 100) {
    throw new Error("CI workflow jobs lookup was incomplete");
  }
  const checks = jobList.jobs.filter(job => job.name === "checks");
  if (checks.length === 0) return null;
  if (checks.length !== 1 || checks[0].run_id !== runId || checks[0].head_sha !== sha) {
    throw new Error("The exact-commit CI checks job did not qualify");
  }

  if (checks[0].conclusion === "skipped") return null;
  if (!success(checks[0])) throw new Error("The exact-commit CI checks job did not succeed");

  const inventory = await request(base + "/artifacts?per_page=100");
  if (inventory.total_count !== inventory.artifacts.length || inventory.artifacts.length === 100) {
    throw new Error("CI artifact lookup was incomplete");
  }
  const marker = prefix(sha, attempt);
  const candidates = inventory.artifacts.filter(artifact => artifact.name.startsWith(marker));
  if (!candidates.length) return null;
  if (candidates.length !== 1) throw new Error("Duplicate CI qualification artifacts");
  const [artifact] = candidates;
  const packedSha = artifact.name.slice(marker.length);
  if (!positiveId(artifact.id) || !/^[a-f0-9]{64}$/u.test(packedSha)
    || artifact.workflow_run?.id !== runId || artifact.workflow_run?.head_sha !== sha
    || artifact.workflow_run?.head_branch !== branch
    || artifact.workflow_run?.repository_id !== run.repository.id
    || artifact.workflow_run?.head_repository_id !== run.head_repository.id
    || !Number.isFinite(Date.parse(artifact.expires_at))
    || !checks[0].steps?.some(step => step.name === "Verify release checks (non-test gate)" && success(step))
    || !checks[0].steps?.some(step => step.name === "Upload the CI-qualified tarball" && success(step))) {
    throw new Error("CI artifact does not match the qualified run and attempt");
  }
  if (artifact.expired === true || Date.parse(artifact.expires_at) <= now) return null;
  if (artifact.expired !== false) throw new Error("Missing CI artifact expiry state");
  // Older GitHub archives without SHA-256 do not provide positive evidence.
  if (artifact.digest == null) return null;
  if (!/^sha256:[a-f0-9]{64}$/u.test(artifact.digest)) throw new Error("Invalid CI artifact digest");
  const zip = await request("/actions/artifacts/" + artifact.id + "/zip", { archive: true });
  if (!zip) return null; // GitHub may expire/delete the artifact during download.
  if (zip.length !== artifact.size_in_bytes || "sha256:" + sha256(zip) !== artifact.digest) {
    throw new Error("CI artifact archive bytes do not match GitHub's digest");
  }

  const path = unpack(zip, outputDir, source, packedSha);
  // A new same-SHA push/rerun must not accidentally inherit an old attempt's green.
  const confirmed = await latest();
  if (confirmed?.id !== runId || confirmed.run_attempt !== attempt || !success(confirmed)) {
    throw new Error("The latest exact-commit CI attempt changed during qualification");
  }
  return { path, digest: packedSha, runId, attempt };
}

function unpack(zip, outputDir, source, digest) {
  if (source.name !== "audit-tools" || !/^\d+\.\d+\.\d+$/u.test(source.version)) {
    throw new Error("Unexpected package identity for CI qualification");
  }
  const filename = source.name + "-" + source.version + ".tgz";
  const archivePath = join(outputDir, "qualification.zip");
  writeFileSync(archivePath, zip, { flag: "wx" });
  // Windows' bsdtar reads ZIP; Linux's GNU tar does not.
  const windows = process.platform === "win32";
  const archiveTool = windows ? "tar" : "unzip";
  const entries = execFileSync(archiveTool, [windows ? "-tf" : "-Z1", archivePath], { encoding: "utf8" });
  if (entries.replace(/\r\n/gu, "\n") !== filename + "\n") throw new Error("Expected one intact npm tarball in CI artifact");
  const buffer = execFileSync(archiveTool, [windows ? "-xOf" : "-p", archivePath, filename], { maxBuffer: 128 * 1024 * 1024 });
  const path = join(outputDir, filename);
  writeFileSync(path, buffer, { flag: "wx" });
  verifyPackageBytes(buffer, digest, source, () => json(execFileSync("tar", ["-xOzf", path, "package/package.json"])));
  return path;
}

function githubRequest(api, repo, token) {
  return async (relative, { archive = false } = {}) => {
    const res = await fetch(api + "/repos/" + repo + relative, {
      headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      redirect: "manual",
      signal: AbortSignal.timeout(25_000),
    });
    if (archive && (res.status === 404 || res.status === 410)) return null;
    if (!archive && res.ok) return res.json();
    if (!archive || res.status !== 302) throw new Error("GitHub qualification lookup returned HTTP " + res.status);
    const location = res.headers.get("location");
    if (!location) throw new Error("Missing CI artifact download URL");
    const url = new URL(location);
    if (url.protocol !== "https:") throw new Error("Invalid CI artifact download URL");
    // Do not forward the GitHub bearer token to signed artifact storage.
    const download = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(25_000) });
    if (download.status === 404 || download.status === 410) return null;
    if (!download.ok) throw new Error("CI artifact download returned HTTP " + download.status);
    return Buffer.from(await download.arrayBuffer());
  };
}

async function main() {
  const [mode, input] = process.argv.slice(2);
  const source = json(readFileSync("package.json"));
  const sha = readGit("rev-parse", "HEAD");
  const { GITHUB_OUTPUT: output, GITHUB_RUN_ATTEMPT: runAttempt } = process.env;
  if (!output) throw new Error("Missing GitHub output path");
  const write = (key, value) => appendFileSync(output, key + "=" + value + "\n");
  const title = readGit("show", "-s", "--format=%s", sha);
  const candidate = title === "release: prepare v" + source.version
    && preparedTitle(title, source.version, json(readGit("show", sha + "^1:package.json")).version);
  if (mode === "--candidate") {
    if (candidate) write("candidate", "true");
    return;
  }
  if (process.version !== "v22.14.0") throw new Error("CI qualification requires Node.js 22.14.0");
  if (!input) throw new Error("Missing CI qualification path");
  if (mode === "--emit" && candidate && sha === process.env.GITHUB_SHA && positiveId(Number(runAttempt))) {
    write("name", prefix(sha, runAttempt) + sha256(readFileSync(input)));
    return;
  }
  if (mode !== "--retrieve" || sha !== process.env.VERIFIED_RELEASE_SHA) {
    throw new Error("CI qualification command does not match the verified commit");
  }
  if (!candidate) return;
  const { GITHUB_REPOSITORY: repo, GITHUB_API_URL: api, GH_TOKEN: token, RELEASE_DEFAULT_BRANCH: branch } = process.env;
  if (!repo || !api || !token || !branch) throw new Error("Missing GitHub qualification context");
  const result = await retrieveQualification({
    request: githubRequest(api, repo, token), repo, branch, sha, source, outputDir: input,
  });
  if (!result) {
    console.log("No compatible CI-qualified artifact; running the full release gate.");
    return;
  }
  write("path", result.path);
  write("sha256", result.digest);
  console.log("Reusing the tarball from exact-commit CI run " + result.runId + " attempt " + result.attempt + ".");
}

if (isScriptEntry(import.meta.url, process.argv)) {
  // Do not include signed download URLs from fetch errors in workflow logs.
  await main().catch(error => {
    console.error(error instanceof TypeError ? "CI qualification request or response was unusable." : error.message);
    process.exitCode = 1;
  });
}
