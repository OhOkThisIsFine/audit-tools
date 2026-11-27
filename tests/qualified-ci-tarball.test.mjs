import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import YAML from "yaml";
import { preparedTitle, retrieveQualification } from "../scripts/shared/qualified-ci-tarball.mjs";

// Deterministic ZIP fixtures. Each .tgz holds a synthetic package/package.json.
const good = Buffer.from("UEsDBBQAAAAAAAAAIQDPsnoLkgAAAJIAAAAVAAAAYXVkaXQtdG9vbHMtMi4wLjEudGd6H4sIAAAAAAAC/+3NTQ7CIBBAYY5CWCtCxS68DVFi6g80hXZjvLtUFyaujTHxfZs3mVlM73cnfwir/ll9zCmKDzNV69yj1XuN2axf87y3tm2ckEZ8wZiLH+p78Z+uKvpLUFup/LjvyrKkdM5qIdUUhtylOF8abbRVNwEAAAAAAAAAAAAAAAAA+B13zHcyWgAoAABQSwECFAAUAAAAAAAAACEAz7J6C5IAAACSAAAAFQAAAAAAAAAAAAAAgAEAAAAAYXVkaXQtdG9vbHMtMi4wLjEudGd6UEsFBgAAAAABAAEAQwAAAMUAAAAAAA==", "base64");
const goodSha = "537176f6ba45a119c856e33086d0ed4f18485df318d000de3aaa89470a5c1f08";
const wrongVersion = Buffer.from("UEsDBBQAAAAAAAAAIQCJwJIokgAAAJIAAAAVAAAAYXVkaXQtdG9vbHMtMi4wLjEudGd6H4sIAAAAAAAC/+3NTQrCMBBA4RwlZK1xWmsX3iZokPqTlCbtRry7qS4E1yKC79u8YWYxvdud3MGv+mftMcWgPkyKtmkeLd4rslm/5nlfVW3dKC3qC8aU3VDeq/90NcFdvNlq48Z9l5c5xnMyC20mP6QuhvlSW7FibgoAAAAAAAAAAAAAAAAA8DvuoSBVGwAoAABQSwECFAAUAAAAAAAAACEAicCSKJIAAACSAAAAFQAAAAAAAAAAAAAAgAEAAAAAYXVkaXQtdG9vbHMtMi4wLjEudGd6UEsFBgAAAAABAAEAQwAAAMUAAAAAAA==", "base64");
const wrongVersionSha = "082a1486b4a54c21733b364ccb8746bc7e0ab37ac4f059796c468bed89af6f76";
const extraFile = Buffer.from("UEsDBBQAAAAAAAAAIQDPsnoLkgAAAJIAAAAVAAAAYXVkaXQtdG9vbHMtMi4wLjEudGd6H4sIAAAAAAAC/+3NTQ7CIBBAYY5CWCtCxS68DVFi6g80hXZjvLtUFyaujTHxfZs3mVlM73cnfwir/ll9zCmKDzNV69yj1XuN2axf87y3tm2ckEZ8wZiLH+p78Z+uKvpLUFup/LjvyrKkdM5qIdUUhtylOF8abbRVNwEAAAAAAAAAAAAAAAAA+B13zHcyWgAoAABQSwMEFAAAAAAAAAAhAM+yeguSAAAAkgAAAAsAAABhbm90aGVyLnRneh+LCAAAAAAAAv/tzU0OwiAQQGGOQlgrQsUuvA1RYuoPNIV2Y7y7VBcmro0x8X2bN5lZTO93J38Iq/5Zfcwpig8zVevco9V7jdmsX/O8t7ZtnJBGfMGYix/qe/Gfrir6S1Bbqfy478qypHTOaiHVFIbcpThfGm20VTcBAAAAAAAAAAAAAAAAAPgdd8x3MloAKAAAUEsBAhQAFAAAAAAAAAAhAM+yeguSAAAAkgAAABUAAAAAAAAAAAAAAIABAAAAAGF1ZGl0LXRvb2xzLTIuMC4xLnRnelBLAQIUABQAAAAAAAAAIQDPsnoLkgAAAJIAAAALAAAAAAAAAAAAAACAAcUAAABhbm90aGVyLnRnelBLBQYAAAAAAgACAHwAAACAAQAAAAA=", "base64");

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const sha = "a".repeat(40);
const repo = "owner/repo";
const branch = "main";
const source = { name: "audit-tools", version: "2.0.1" };
const green = { status: "completed", conclusion: "success" };
const main = { id: 11, full_name: repo };
const record = (list, ...entries) => ({ total_count: entries.length, [list]: entries });

function fixture(t, bytes = good, tarballSha = goodSha) {
  const outputDir = mkdtempSync(join(tmpdir(), "release-ci-fixture-"));
  t.after(() => rmSync(outputDir, { recursive: true, force: true }));
  const run = { ...green, id: 216, run_number: 38, run_attempt: 2, event: "push", head_sha: sha,
    head_branch: branch, repository: main, head_repository: main, path: ".github/workflows/ci.yml@main" };
  const job = { ...green, name: "checks", run_id: run.id, head_sha: sha, steps: [
    { name: "Verify release checks (non-test gate)", ...green },
    { name: "Upload the CI-qualified tarball", ...green },
  ] };
  const artifact = { id: 19, size_in_bytes: bytes.length, digest: "sha256:" + digest(bytes), expired: false,
    expires_at: "2030-01-02T00:00:00Z", name: "qualified-ci-npm-v1-node22.14.0-" + sha + "-2-" + tarballSha,
    workflow_run: { id: run.id, repository_id: main.id, head_repository_id: main.id, head_branch: branch, head_sha: sha } };
  const runs = [run];
  const calls = [];
  const request = async (path, options) => {
    calls.push(path);
    if (path.startsWith("/actions/workflows/ci.yml/runs?")) {
      const query = new URLSearchParams(path.split("?")[1]);
      assert.deepEqual([...query.entries()], [["event", "push"], ["branch", branch], ["head_sha", sha], ["per_page", "100"]]);
      return record("workflow_runs", ...runs);
    }
    if (path === "/actions/runs/216/attempts/2/jobs?per_page=100") return record("jobs", job);
    if (path === "/actions/runs/216/artifacts?per_page=100") return record("artifacts", artifact);
    if (path === "/actions/artifacts/19/zip") {
      assert.deepEqual(options, { archive: true });
      return bytes;
    }
    assert.fail("Unexpected API request: " + path);
  };
  return { run, job, artifact, runs, calls, input: { request, repo, branch, sha, source, outputDir, now: Date.parse("2030-01-01T00:00:00Z") } };
}

test("prepared releases require the exact new version, not a prefix or comment", () => {
  assert.equal(preparedTitle("release: prepare v2.0.1", "2.0.1", "2.0.0"), true);
  assert.equal(preparedTitle("release: v2.0.1", "2.0.1", "2.0.0"), false);
  assert.equal(preparedTitle("release: prepare v2.0.1 extras", "2.0.1", "2.0.0"), false);
  assert.equal(preparedTitle("release: prepare v2.0.1", "2.0.1", "2.0.1"), false);
  assert.equal(preparedTitle("release: prepare v2.0.0", "2.0.1", "2.0.0"), false);
});

test("retrieves exactly one intact tarball from the authoritative latest attempt", async t => {
  const { input, runs, run, calls } = fixture(t);
  runs.unshift({ ...run, id: 210, run_number: 30 });
  const result = await retrieveQualification(input);
  assert.equal(result.runId, 216);
  assert.equal(result.attempt, 2);
  assert.equal(result.digest, goodSha);
  assert.equal(digest(readFileSync(result.path)), goodSha);
  assert.equal(calls[0], calls.at(-1));
});

test("fork, PR, pending, skipped, expired, incomplete and earlier-attempt artifacts cannot skip a fresh gate", async t => {
  const changes = [
    ({ run }) => { run.event = "pull_request"; },
    ({ run }) => { run.head_repository = { full_name: "fork/repo" }; },
    ({ run }) => { run.head_sha = "b".repeat(40); },
    ({ run }) => { run.status = "in_progress"; },
    ({ job }) => { job.conclusion = "skipped"; },
    ({ artifact }) => { artifact.expired = true; },
    ({ input }) => { input.now = Date.parse("2030-02-01T00:00:00Z"); },
    ({ artifact }) => { artifact.name = artifact.name.replace("-2-", "-1-"); },
    ({ artifact }) => { delete artifact.digest; },
    ({ artifact }) => { delete artifact.workflow_run; },
  ];
  for (const change of changes) {
    const data = fixture(t);
    change(data);
    assert.equal(await retrieveQualification(data.input), null);
    assert.ok(data.calls.every(path => !path.endsWith("/zip")));
  }
});

test("new failure and contradictory evidence cannot inherit an older green", async t => {
  const failed = fixture(t);
  failed.runs.push({ ...failed.run, id: 220, run_number: 39, conclusion: "failure" });
  await assert.rejects(retrieveQualification(failed.input), /latest exact-commit CI push did not succeed/);
  const red = fixture(t);
  red.job.conclusion = "failure";
  await assert.rejects(retrieveQualification(red.input), /checks job did not succeed/);
  const skippedStep = fixture(t);
  skippedStep.job.steps[0].conclusion = "skipped";
  await assert.rejects(retrieveQualification(skippedStep.input), /does not match the qualified run and attempt/);
  const wrongOrigin = fixture(t);
  wrongOrigin.artifact.workflow_run.id = 210;
  await assert.rejects(retrieveQualification(wrongOrigin.input), /does not match the qualified run and attempt/);
  const malformedOrigin = fixture(t);
  malformedOrigin.artifact.workflow_run = null;
  await assert.rejects(retrieveQualification(malformedOrigin.input), /does not match the qualified run and attempt/);
  const tampered = fixture(t);
  tampered.artifact.digest = "sha256:" + "0".repeat(64);
  await assert.rejects(retrieveQualification(tampered.input), /archive bytes do not match/);
  await assert.rejects(retrieveQualification(fixture(t, good, "0".repeat(64)).input), /tarball SHA-256 mismatch/);
  await assert.rejects(retrieveQualification(fixture(t, wrongVersion, wrongVersionSha).input), /package name and version/);
  await assert.rejects(retrieveQualification(fixture(t, extraFile).input), /one intact npm tarball/);
});

test("a newly started attempt cannot race reuse of an older artifact", async t => {
  const data = fixture(t);
  const request = data.input.request;
  data.input.request = async (path, options) => {
    const response = await request(path, options);
    if (path.endsWith("/zip")) data.run.run_attempt += 1;
    return response;
  };
  await assert.rejects(retrieveQualification(data.input), /latest exact-commit CI attempt changed/);
});


test("protected push produces qualification; only the existing upload job has OIDC", () => {
  const workflow = name => YAML.parse(readFileSync(new URL("../.github/workflows/" + name + ".yml", import.meta.url), "utf8"));
  const ci = workflow("ci");
  const checks = ci.jobs.checks.steps;
  assert.match(checks.find(step => step.id === "candidate").if, /event_name == 'push'.*ref_protected.*default_branch/u);
  assert.doesNotMatch(ci.jobs.checks.if, /release: prepare/u);
  assert.equal(ci.env.CI_NODE_VERSION, "22.14.0");
  assert.ok(checks.findIndex(step => step.run?.includes("npm run verify:checks")) <
    checks.findIndex(step => step.name === "Upload the CI-qualified tarball"));
  const publish = workflow("publish-package");
  const gate = publish.jobs.gate;
  assert.deepEqual(gate.permissions, { contents: "read", actions: "read" });
  assert.match(gate.steps.find(step => step.id === "reuse").env.VERIFIED_RELEASE_SHA, /needs\.validate-source\.outputs\.commit/u);
  assert.match(gate.steps.find(step => step.id === "upload").with.path, /steps\.reuse\.outputs\.path \|\| steps\.tarball\.outputs\.path/u);
  assert.ok(gate.steps.find(step => step.run?.includes("npm run verify:checks")).if.includes("steps.reuse.outputs.path == ''"));
  assert.deepEqual(publish.jobs.publish.needs, ["validate-source", "gate", "test"]);
  assert.deepEqual(Object.entries(publish.jobs).filter(([, job]) => job.permissions?.["id-token"] === "write").map(([name]) => name), ["publish"]);
  assert.ok(publish.jobs.publish.steps.find(step => step.run?.includes("sha256sum --check --strict")));
  assert.ok(publish.jobs.test.steps.find(step => step.run === "npm test"));
  const readback = publish.jobs.publish.steps.find(step => step.name.startsWith("Confirm qualified"));
  assert.match(readback.run, /SECONDS \+ 10 >= readback_deadline/u);
  assert.doesNotMatch(readback.run, /attempt.*24|npm publish/u);
});
