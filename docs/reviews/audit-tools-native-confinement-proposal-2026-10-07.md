# audit-tools: native-confinement source proposal, 7 October 2026

<!-- review-routing: deferred -->

**Independent source review pending.** This dedicated proposal branch contains documentation and inactive reference sources only. No workflow, production module, package/dependency or implementation attestation is changed. Product source starts at main 38bba3cf410b2deaba54d837429c11a2d512a7a9. The six-file P0 candidate remains in its separate preserved checkout; it is not part of this publication.

Review the [proposed canonical R0.3a selection](audit-tools-canonical-implementation-plan-2026-10-07.md#r03a-selected-linux-native-confinement-qualification-path) and these inactive sources:

- [Fixed-role launcher](audit-tools-native-confinement-proposal-2026-10-07/r05-launcher.py)
- [Owned layout preparation](audit-tools-native-confinement-proposal-2026-10-07/prepare-owned-layout.py) and [actual fixture binding](audit-tools-native-confinement-proposal-2026-10-07/bind-owned-fixture.py)
- [Native syscall probes](audit-tools-native-confinement-proposal-2026-10-07/native-probe.c), [Node/native probe entry](audit-tools-native-confinement-proposal-2026-10-07/probe.mjs) and [owned echo fixture](audit-tools-native-confinement-proposal-2026-10-07/fixture-server.mjs)
- [Restrictive seccomp policy](audit-tools-native-confinement-proposal-2026-10-07/r05-seccomp.json) and [original stock policy](audit-tools-native-confinement-proposal-2026-10-07/docker-28.0.4-default-seccomp.json)
- [Source hashes](audit-tools-native-confinement-proposal-2026-10-07/packet-files.json), [illustrative argv](audit-tools-native-confinement-proposal-2026-10-07/rendered-launches.json) and [portable pure-source validator](audit-tools-native-confinement-proposal-2026-10-07/validate-source.py)

All sources live under docs/reviews; no registry/entrypoint/workflow imports them. Publication does not authorize running them. The local preparation packet is preserved separately; normal repository files are the review deliverable.

## Outcome

Resolved the missing launcher specification at source level: select the **existing Docker28.0.4 runtime on an ordinary ephemeral GitHub-hosted ubuntu-24.04/Linux amd64 runner**, with explicit task-only grants and native denial probes. This is a review proposal, not an already-qualified environment or runtime acceptance. No Docker/WSL service, image layer, compiler, native probe, product import, npm install, stamp, attestation, workflow or PR executed. This branch publishes source-only plans for review; it carries no implementation commit or runtime acceptance.

The six-file P0 candidate remains unchanged at source 38bba3cf410b2deaba54d837429c11a2d512a7a9, staged tree a19d72f79a0d47ef0ddc0c0cca4d09635992b38e. Its original pin 2f268f019523d87ba02d8ac6821224d468ca2182 and original checkout are preserved. Stopped W6 work, installed baseline and stopped WSL2 Ubuntu are untouched. The failed Windows native-child proof remains valid and blocks fresh product execution there.

## Evidence for selection

The official Ubuntu24.04 runner inventory (image20260927.320.1) lists Docker client/server28.0.4 and Node22.23.3/npm10.9.9. Previous read-only GitHub job metadata confirms ordinary hosted Ubuntu jobs actually ran for current source. This is evidence of a documented preinstalled route, not observed capability of a new job; the launcher refuses a different actual daemon/platform and does not install/start/upgrade one.

Resolved official anonymous registry metadata, not an assumed tag:
- Tag22.23.3-bookworm index: sha256:0e5f906573693feaa1e21057ebdcfdb5bd5021f050b2dc7c9deceb629c7da2a8
- Selected Linux amd64 manifest: sha256:c4d5523090a817b7aa86d2111241fdd4f66d1e27782b44160e6aa63b357ecb2d
- Config: sha256:8f3dff4193637723b9f3f4ded64cccf28c7b35dc1c96d3320b1f5a64ff41e76d
Each registry response was byte-hashed against its digest. Public config says linux/amd64, NODE_VERSION22.23.3, no anonymous volumes. No layer was downloaded or image run. Docker official Node recipe derives from buildpack-deps bookworm, whose primary source includes Git/native compiler support.

Native Node used by qualification remains the separately checked canonical Linux archive, mounted read-only at /tools; bootstrap must check sha256 df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de and published signed SHASUMS, then record actual Node/npm versions. Windows Node qualification cannot supply that Linux evidence. Source-registry TLS/digest checks are not signature/provenance attestation.

Stock seccomp pinned to Moby commit6430e49a55babd9b8f4d08e70ecb2b68900770fe (v28.0.4):
- stock bytes SHA2569c1025c88ccaa517b648da571961838744ea2137f176bfe6a48b21294cae9c76
- restrictive derivative SHA256fca8efb7120a8a8eb6c0a1c1efce139f0c6f663c77dcad7bb0e5d1e264b16bb2
Immutable commit bytes independently matched the retained stock profile. The GitHub tag signature was not verified; do not claim it was. Original Apache license is retained as moby-LICENSE.

Official sources:
https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md
https://github.com/nodejs/docker-node/blob/main/22/bookworm/Dockerfile
https://github.com/docker-library/buildpack-deps/blob/master/debian/bookworm/Dockerfile
https://github.com/moby/moby/blob/6430e49a55babd9b8f4d08e70ecb2b68900770fe/profiles/seccomp/default.json

## Exact grants and fixed launcher roles

r05-launcher.py renders Docker argv by default; --execute is explicit and admitted only on observed non-root Linux x64 under RUNNER_TEMP in a fresh marked task. It accepts only compiler/server/control/probe roles; there is no arbitrary product-command/Docker-option passthrough.

All roles use the pinned image and owned Node archive, non-root observed UID/GID, private PID/default mount/IPC/cgroup namespaces, read-only image rootfs, ALL capabilities dropped and no-new-privileges. The per-container seccomp derivative preserves stock defaults and every nonsocket rule; removes socket/socketpair/socketcall grants; grants only AF_UNIX/AF_INET/AF_INET6 sockets and AF_UNIX socketpairs. Native AF_PACKET17, AF_ALG38 and AF_VSOCK40 must fail EPERM, rather than fail because a transport happens to be absent.

Persistent host mounts:
- task/workspace -> /work, sole read/write bind
- task/runtime/node-v22.23.3-linux-x64 -> /tools, read-only
- task/harness -> /harness, read-only
- task/harness/empty-shm -> /dev/shm, read-only
- task-owned passwd/group -> /etc/passwd and /etc/group, read-only
All nonrecursive/rprivate, no socket/device object admitted at startup. Evidence, task parent, host home, real credentials and Docker socket are unmounted. Only trusted host orchestration has daemon authority; no runtime process receives it. Docker's isolated kernel/process/device/IPC facilities are not a writable host-directory grant.

Native filesystem helper asserts allowed in-root writes and denied synthetic credential reads, including its real unmounted host-absolute path; denied sibling-directory creation/sibling-prefix writes, /tmp writes, read-only shm/tool/harness writes; shell grandchildren. Actual native Git archive/tar extraction must work inside /work, while tar outside-write/outside-read attempts fail. Fixtures contain synthetic bytes only, no real credential contents.

Networks:
- Compiler and denial probe: network none, only loopback; no published ports, host networking, network joins or service endpoints.
- Echo server and positive control: one UUID-labelled task-owned internal dual-stack Docker bridge, no external route/published ports. These contain only trusted synthetic fixture code, not product code. The source includes no outbound/provider call.
- Docker internal networks can reach their gateway host services; this control lane runs only the hash-bound fixed synthetic clients and must never run product/diagnostic code. It is not claimed as the product egress boundary. The denial/product boundary is network none.
- Positive control alone also receives task/host-canary -> /host-secret read-only, deliberately granting a synthetic read. The denial probe receives no such mount.
- Native helper verifies IPv4/IPv6 TCP/UDP echo on the observed fixture addresses under the positive grant, then denies native connect/send to those same addresses in network none. UDP denial requires connect/send failure, not a missing reply. No DNS/tool/endpoint absence is called a pass.
- Launcher binds the denial run to the same actual task/token/addresses and real successful stopped control container, plus exit sidecar. Created container grants are inspected before start. Ordinary warning sentinel must remain visible.
- A missing IPv6 address, compiler, usable seccomp/capability/native route, or failed positive control leaves the relevant leg unavailable/failed and blocks this selected full native gate. Never silently omit it or relax security.

Creating/removing the labelled disposable Docker fixture network uses the existing runtime's task-scoped object API; no persistent daemon/OS/firewall setting is edited. These future container/network operations remain subject to review/remote-execution authorization.

Policy sources:
https://docs.docker.com/reference/cli/docker/container/run/
https://docs.docker.com/engine/network/drivers/none/
https://docs.docker.com/engine/storage/bind-mounts/
https://docs.docker.com/reference/cli/docker/network/create/
https://docs.docker.com/engine/security/seccomp/

## Concrete post-review execution sequence (not run)

Use a parent-approved ephemeral ubuntu-24.04 probe job with only this packet; no inherited product CI or secret/write/OIDC grant. The packet deliberately includes no executing remote workflow. The earlier capability-inventory draft remains optional and is not the launcher gate.

1. Observe uname/architecture, actual Docker client/server version/kernel/storage, runner image, UID/GID, and official registry origin. Stage the exact pinned image via the existing daemon using an empty task-owned Docker client config. Fetch official Node22.23.3 Linux archive and signed checksum manifest to a task-owned download area and verify. Do not install any runtime/global tool or alter runner security.
2. Prepare fresh task layout:
   python3 prepare-owned-layout.py --packet <reviewed-packet-directory> --archive <owned>/node-v22.23.3-linux-x64.tar.xz
   This verifies packet-files.json and archive SHA before creating a new UUID subtree under RUNNER_TEMP. It copies files privately, extracts only the verified archive with Python data filter, creates empty synthetic configs/caches and a task-only account profile, and reports its real config path. It does not copy/run product source.
3. Use that reported config:
   python3 r05-launcher.py --config <reported-config> --role compiler --execute
   This compiles only native-probe.c in the no-network boundary. A compile failure is a real blocker; no precompiled or fake replacement is accepted.
4. Create exactly one task-labelled fixture network with the existing daemon:
   /usr/bin/docker --host=unix:///var/run/docker.sock network create --driver bridge --internal --ipv6 --label r05.task=<reported-task-uuid> r05-fixture-<reported-task-uuid>
   Use a clean task-owned Docker client environment/config as the launcher does. If denied/unavailable, stop rather than change host network/security settings.
5. Start only the source-owned echo fixture:
   python3 r05-launcher.py --config <reported-config> --role server --execute
   Retain its real returned immutable container ID. Observe its exact logs for R05_FIXTURE_READY; no server name/PID guessing.
6. Bind real observed endpoints (no manufactured addresses):
   python3 bind-owned-fixture.py --config <reported-config> --server-id <actual-owned-server-CID>
   This requires matching task/role labels, Running=true, readiness and actual IPv4/IPv6 addresses.
7. Real positive controls, then denial:
   python3 r05-launcher.py --config <reported-config> --role control --execute
   python3 r05-launcher.py --config <reported-config> --role probe --execute
   Retain native outcomes, warning stderr, Docker specs/image descriptor, real CLI/container exits and terminal records. A60s owned watchdog kills only its verified immutable created CID if necessary; timeout is a failed gate. No product executes in any role.
8. Read the resulting evidence; compare original synthetic canary unchanged and outside paths absent from host. Finish owned teardown: inspect the four saved immutable CIDs and matching task labels, stop only the owned echo server, observe all containers terminal, then remove only those stopped owned containers and the exact empty labelled internal network. Never prune, kill all containers/processes, remove another task, or erase evidence. Missing terminal/cleanup proof blocks full R05; no automatic broad cleanup.
9. These probes close only preliminary Linux native-child filesystem/network assertions. Complete remaining R05 worker/state/npm/Git/warning/analyzer/acquisition sentinels and teardown, then canonical R6 detached repeated-load-failure fixture. Only after R05/R6 prerequisites pass proceed to the safe baseline/current P0 install/focused/full/stamp/R7 private packed-install chain. No arbitrary product-command mode is present in this packet; its later invocation must retain these inspected grants and canonical gate order.

All angle-bracket values above are real observed future outputs or explicit owner-selected locations; none is current execution evidence.

## Canonical correction and review boundary

The canonical plan diff inserts R0.3a and replaces the unspecified already-qualified launcher reference in R6. It leaves package scope, six P0 blobs, baseline source, native denial requirements, R6 semantics and release hold unchanged. The amendment is present only on this proposal branch for review; the repository diff records the complete change against main. Nothing has landed on main. Existing independent approval of the six P0 blobs remains scoped to them; it does not review this new launcher/profile/design. Independent exact-source review of this packet and plan amendment must precede remote execution.

packet-files.json binds the inactive source/policy/reference bytes in the adjacent directory; this commit binds the canonical amendment and this review document. prepare-owned-layout.py copies that record outside /work; r05-launcher.py refuses harness-source or policy drift. rendered-launches.json contains illustrative argv only and explicitly labels it not runtime evidence. No actual receipt, stamp or attestation was fabricated.

## Gate/platform table

| Path | Current result | Gates potentially closed after actual execution |
|---|---|---|
| Reviewed Windows shell + Node flags | R05 failed; native child escaped Node filesystem grant | None until independently corrected; native Windows tests remain blocked |
| Existing stopped WSL2 Ubuntu | Observed stopped/version2, not started | None from listing; no Linux/Windows inference |
| Ordinary existing unconfined hosted CI | Historical current-source CI success only | No R05/native proof; no candidate final-tree stamp |
| Proposed preinstalled Docker Linux lane | Source prepared/validated; runtime not run | Preliminary Linux native assertions; full R05 only after all sentinels/teardown; R6 actual detached archive/refusal/cleanup after fixture implementation; Linux P0 focused/unfiltered genuine stamp and exact1.9.0 installed smoke after prerequisites |
| Native Windows / other runtime/OS/filesystem lanes | Not run in this packet | Only their own real execution can close them; Linux proof does not qualify PowerShell/.NET/Windows native tar or runtime matrix |

P0 may qualify independently of the rest of P6. Account-profile scaffolding here is source preparation, not post-P6 actual production-root/packed acceptance. No release/installed update/paused-dogfood activation is permitted by this proof; frozen-snapshot release hold remains.

## Actual checks and blockers

Passed source-only checks:
- Anonymous official image index/amd64 manifest/config byte hashes matched immutable digests; config reported expected platform/version and no volumes.
- Immutable Moby source hash matched retained upstream; derivative preserves every nonsocket restriction with only the declared socket tightening.
- Trusted Python3.13 pure source validation: AST for all three Python helpers, four rendered roles, sole writable bind, namespace/network split, no daemon mount/privileged grant/host-token forwarding, and root-identity refusal. It called no Docker/native/product code.
- Task-local Windows Node22.23.3 --check probe.mjs and --check fixture-server.mjs: exit0, parsing only.
- git apply --check canonical-plan-confinement.patch: exit0 after correcting Windows UTF-8/LF artifact formatting.
- git diff --cached --check: exit0; git write-tree still a19d72f79a0d47ef0ddc0c0cca4d09635992b38e.

Not run: C compilation (no current Linux compiler/runtime; local command lookup returned no clang/gcc), Linux Node/archive extraction, Docker launch/inspect/namespace/socket controls, remote workflow, actual native probes/teardown, complete R05, new R6 fixture, baseline/current P0 install/focused/full/packed gates, stamps/review attestation/commits/PRs. No skipped check is a pass. Initial registry decoding, patch encoding/line endings and the first heading insertion failed during preparation. Publication inspection caught the omitted R0.3a section; this branch includes the corrected complete insertion and reference. Corrected source checks pass. Those failures involved source metadata/formatting only and never product execution.

## Exact new owner action, separate from source design authority

Source research/design is complete within existing authorization. What remains genuinely new is remote execution/publication scope: parent must review this exact packet/amendment and designate/authorize **one ephemeral Linux probe job or existing isolated probe repository**, including the concrete packet publication/workflow trigger if needed. Its allowed execution consists only of anonymous official image/Node staging, this task's fresh private container/internal fixture network and native synthetic probes/owned teardown, without secrets/write/OIDC or inherited unconfined product CI. No blanket implementation approval, workstation service resumption, privileged runtime install or global security change is needed.

If such remote account/repository access is unavailable, the same packet can run on an already-authorized ephemeral Linux x64 runner with the observed existing Docker28.0.4 capability; otherwise that exact runtime access is the remaining blocker. Do not push a P0 commit to obtain CI while current gates are blocked.

Rollback: no tracked implementation/plan changes occurred. Discontinue these outside-checkout source artifacts if not approved. Future disposable objects may be removed only by verified ownership after terminal observation; preserve failed evidence. Original P0 work/baseline remain intact.
## Publication-trigger and hook assessment

The baseline was freshly verified as main 38bba3cf410b2deaba54d837429c11a2d512a7a9. Its .github/workflows directory contains exactly ci.yml, audit-code-test-suite.yml and publish-package.yml. Workflow blobs were compared with remote at that exact commit.

- ci.yml: push.branches is only main; pull_request targets main. A pull request has no path filter and executes product checks.
- audit-code-test-suite.yml: push.branches is only main; pull_request targets main with paths including docs/**. A proposal PR would execute product tests.
- publish-package.yml: only workflow_dispatch or release.published; no branchpush trigger.
- A branch-only push of this docs/native-confinement-proposal-20261007 proposal starts none of these workflows. No PR, dispatch, release or main update is authorized by this publication.
- The fresh isolated proposal clone has no configured custom hooksPath and no active default hooks. No hook setting, Git security setting or CI configuration was changed, and no --no-verify or gate override was used. Local repository product/doc-contract tests remain not run; no green stamp or review attestation is claimed.
- Existing hooks, if independently installed, would run npm checks/doc-contract tests; those remain blocked under the failed Windows R05 route. This branch publication is source-only planning for independent Chat review, not a runtime-verified implementation landing.
