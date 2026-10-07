# audit-tools: selected implementation support, 7 October 2026

<!-- review-routing: deferred -->

Start with the [canonical plan](audit-tools-canonical-implementation-plan-2026-10-07.md), then its [finite checklist](audit-tools-closure-evidence-checklist-2026-10-07.md). These fixtures and navigation support that contract; they are source only, unexecuted, and confer no suite, stamp, attestation or release result. Implementation/platform qualification remains [deferred](../backlog/deferred.md).

## Installed-parser fixtures

For canonical R7, materialize the two complete fenced blocks as files in the task-owned fixture preparation area, preserving UTF-8 bytes, LF line endings and final newlines. Verify the SHA-256 before use. Copy the candidate tarball to `audit-tools-candidate.tgz` and follow R7's separate setup/offline-install legs. Run the script with its cwd equal to the installed consumer fixture; do not run it during documentation publication.

### p0-installed-toml.mjs

SHA-256: `1ad8a2d9b09f7cda6892682a1bf553bf4c53b8b0a1c27797d04147796966003b`. Length: 3960 bytes.

```javascript
// Source-only qualification fixture. Run only in the authorized installed fixture.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
const fixtureRoot = realpathSync(process.cwd());
const contained = (root,path) => { const rel = relative(root,path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..'+(process.platform==='win32'?'\\':'/'))); };
const fixtureRequire = createRequire(join(fixtureRoot,'package.json'));
const auditManifestPath = realpathSync(fixtureRequire.resolve('audit-tools/package.json'));
const auditRoot = dirname(auditManifestPath);
assert(contained(fixtureRoot,auditRoot), 'audit-tools resolved outside the owned fixture');
const auditRequire = createRequire(auditManifestPath);
const parserEntry = realpathSync(auditRequire.resolve('smol-toml'));
assert(contained(fixtureRoot,parserEntry), 'smol-toml resolved outside the owned fixture');
let parserRoot = dirname(parserEntry), parserManifest;
for (;;) {
  const file = join(parserRoot,'package.json');
  if (existsSync(file)) { const value = JSON.parse(readFileSync(file,'utf8')); if(value.name==='smol-toml'){ parserManifest=value; break; } }
  const parent = dirname(parserRoot); assert(parent!==parserRoot && contained(fixtureRoot,parent),'no contained smol-toml manifest'); parserRoot=parent;
}
assert.equal(parserManifest.version,'1.9.0');
const adapter = async name => { const path=realpathSync(join(auditRoot,'dist','audit','extractors','graphManifestEdges',name+'.js')); assert(contained(auditRoot,path)); return import(pathToFileURL(path).href); };
const { extractCargoWorkspaceMemberEdges } = await adapter('cargo');
const { extractPyprojectTestpathLinks } = await adapter('pyproject');
const tuples = edges => edges.map(({from,to,kind,direction,confidence})=>[from,to,kind,direction,confidence]).sort();
const cargoInputs = [
  "workspace.members = [\"crates/*\"]\nworkspace.exclude = [\"crates/y\"]",
  "workspace = { members = [\"crates/*\"], exclude = [\"crates/y\"] }",
  "[\"workspace\"]\n\"members\" = [\"crates/*\"]\n\"exclude\" = [\"crates/y\"]",
  "[workspace]\nmembers = [\n \"\"\"crates/*\"\"\",\n]\nexclude = [\n '''crates/y''',\n]"
];
const pyprojectInputs = [
  "[tool.pytest.ini_options]\ntestpaths = [\"tests\"]",
  "[tool.pytest.ini_options]\ntestpaths = \"tests\"",
  "tool.pytest.ini_options.testpaths = [\"tests\"]",
  "tool.pytest.ini_options.testpaths = \"tests\"",
  "tool = { pytest = { ini_options = { testpaths = [\"tests\"] } } }",
  "tool = { pytest = { ini_options = { testpaths = \"tests\" } } }",
  "[\"tool\".\"pytest\".\"ini_options\"]\n\"testpaths\" = [\n \"\"\"tests\"\"\",\n]"
];
const cargoLookup=new Map(['crates/z/Cargo.toml','crates/y/Cargo.toml','crates/x/Cargo.toml','Cargo.toml','other/Cargo.toml'].map(path=>[path,path]));
const cargoExpected=[['Cargo.toml','crates/x/Cargo.toml','cargo-workspace-member-link','directed',0.87],['Cargo.toml','crates/z/Cargo.toml','cargo-workspace-member-link','directed',0.87]];
for(const input of cargoInputs) assert.deepEqual(tuples(extractCargoWorkspaceMemberEdges('Cargo.toml',input,cargoLookup)),cargoExpected);
const pyLookup=new Map(['pkg/tests/conftest.py','tests/conftest.py','pkg/other/conftest.py'].map(path=>[path,path]));
const pyExpected=[['pkg/pyproject.toml','pkg/tests/conftest.py','pyproject-testpaths-link','directed',0.85]];
for(const input of pyprojectInputs) assert.deepEqual(tuples(extractPyprojectTestpathLinks('pkg/pyproject.toml',input,pyLookup)),pyExpected);
console.log(JSON.stringify({node:process.version,auditPackage:JSON.parse(readFileSync(auditManifestPath,'utf8')).version,auditRoot,parserEntry,parserVersion:parserManifest.version,cargoCases:cargoInputs.length,pyprojectCases:pyprojectInputs.length,result:'pass'},null,2));
```

### p0-lower-bound-package.json

SHA-256: `f6eb585d47e37263178d1bfc4dccfa65df0b74def4c8fecab3fde0d824ce5d5a`. Length: 230 bytes.

```json
{
  "name": "audit-tools-p0-lower-bound",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "audit-tools": "file:./audit-tools-candidate.tgz"
  },
  "overrides": {
    "smol-toml": "1.9.0"
  }
}
```

## Source caller navigation

The following are selected file-level navigation for the canonical helper contracts, not a new authority registry or an assertion that every textual mention executes. Follow the named symbols and exact caller changes in P2–P6 and D1/D2; import/comment mentions are not additional mutation boundaries. All links bind the current reconciled source. The source comparison verifies that files unaffected by the seven commits retain their earlier reviewed bytes.

### P3 all lock imports and calls

- [scripts/shared/load-flake-record.mjs](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/scripts/shared/load-flake-record.mjs)
- [src/audit/cli/auditStep.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/audit/cli/auditStep.ts)
- [src/audit/cli/dispatch/hostHandoff.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/audit/cli/dispatch/hostHandoff.ts)
- [src/audit/cli/fanoutLanes.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/audit/cli/fanoutLanes.ts)
- [src/audit/cli/functionalPreflight.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/audit/cli/functionalPreflight.ts)
- [src/audit/cli/nextStepHelpers.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/audit/cli/nextStepHelpers.ts)
- [src/audit/cli/reviewRun.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/audit/cli/reviewRun.ts)
- [src/remediate/state/store.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/remediate/state/store.ts)
- [src/remediate/steps/nextStep.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/remediate/steps/nextStep.ts)
- [src/shared/analyzerPolicy.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/shared/analyzerPolicy.ts)
- [src/shared/friction/captureFrictionEvent.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/shared/friction/captureFrictionEvent.ts)
- [src/shared/friction/frictionRecord.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/shared/friction/frictionRecord.ts)
- [src/shared/index.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/shared/index.ts)
- [src/shared/io/artifactTreeHold.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/shared/io/artifactTreeHold.ts)
- [src/shared/io/fileLock.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/shared/io/fileLock.ts)
- [src/shared/io/lockedJsonStore.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/shared/io/lockedJsonStore.ts)
- [src/shared/submission/submissionLedger.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/shared/submission/submissionLedger.ts)

### P2 final command identity

- [scripts/remediate/smoke-remediate-gate.mjs](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/scripts/remediate/smoke-remediate-gate.mjs)
- [src/remediate/phases/close.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/remediate/phases/close.ts)
- [src/remediate/phases/closeAcceptance.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/remediate/phases/closeAcceptance.ts)
- [src/remediate/state/types.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/remediate/state/types.ts)
- [src/remediate/steps/finalGate.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/remediate/steps/finalGate.ts)
- [src/remediate/steps/nextStep.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/remediate/steps/nextStep.ts)

### P4 recovery and acceptance

- [scripts/guard-reach-data.mjs](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/scripts/guard-reach-data.mjs)
- [scripts/shared/executor-write-sites.mjs](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/scripts/shared/executor-write-sites.mjs)
- [scripts/shared/loopCoreClosure.mjs](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/scripts/shared/loopCoreClosure.mjs)
- [src/audit/cli/foldTransaction.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/audit/cli/foldTransaction.ts)
- [src/audit/cli/laneSubmissions.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/audit/cli/laneSubmissions.ts)
- [src/audit/cli/nextStepHelpers.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/audit/cli/nextStepHelpers.ts)
- [src/audit/cli/recoverSubmissionCommand.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/audit/cli/recoverSubmissionCommand.ts)
- [src/remediate/index.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/remediate/index.ts)
- [src/remediate/steps/dispatch/hostCorroboration.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/remediate/steps/dispatch/hostCorroboration.ts)
- [src/remediate/steps/dispatch/hostHandoff.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/remediate/steps/dispatch/hostHandoff.ts)
- [src/remediate/steps/nextStep.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/remediate/steps/nextStep.ts)
- [src/remediate/steps/recoverIngest.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/remediate/steps/recoverIngest.ts)
- [src/shared/index.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/shared/index.ts)
- [src/shared/loopCorePaths.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/shared/loopCorePaths.ts)
- [src/shared/submission/handRecovery.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/shared/submission/handRecovery.ts)

### P5 publication and intake

- [scripts/audit/smoke-audit-flow.mjs](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/scripts/audit/smoke-audit-flow.mjs)
- [src/audit/cli/nextStepCommand.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/audit/cli/nextStepCommand.ts)
- [src/audit/cli/nextStepHelpers.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/audit/cli/nextStepHelpers.ts)
- [src/audit/io/artifacts.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/audit/io/artifacts.ts)
- [src/remediate/index.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/remediate/index.ts)
- [src/remediate/intake.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/remediate/intake.ts)
- [src/remediate/phases/close.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/remediate/phases/close.ts)
- [src/remediate/steps/contractPipeline.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/remediate/steps/contractPipeline.ts)
- [src/remediate/steps/intakeResolver.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/remediate/steps/intakeResolver.ts)
- [src/remediate/steps/nextStep.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/remediate/steps/nextStep.ts)

### P6 analyzer and install chains

- [scripts/shared/executor-write-sites.mjs](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/scripts/shared/executor-write-sites.mjs)
- [src/audit/extractors/analyzers/registry.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/audit/extractors/analyzers/registry.ts)
- [src/audit/orchestrator/acquisitionExecutor.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/audit/orchestrator/acquisitionExecutor.ts)
- [src/audit/orchestrator/executorRunners.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/audit/orchestrator/executorRunners.ts)
- [src/audit/orchestrator/graphEnrichmentExecutor.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/audit/orchestrator/graphEnrichmentExecutor.ts)
- [src/remediate/phases/close.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/remediate/phases/close.ts)
- [src/remediate/phases/closeVerifyAnalyzerLeads.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/remediate/phases/closeVerifyAnalyzerLeads.ts)
- [src/remediate/phases/closeVerifyLandingGates.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/remediate/phases/closeVerifyLandingGates.ts)
- [src/shared/analyzers/acquisitionEngine.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/shared/analyzers/acquisitionEngine.ts)
- [src/shared/analyzers/candidates.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/shared/analyzers/candidates.ts)
- [src/shared/index.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/shared/index.ts)
- [src/shared/tooling/analyzerDeps.ts](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/src/shared/tooling/analyzerDeps.ts)

### R6 failure dispatch

- [scripts/shared/dispatch-load-flake-investigation.mjs](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/scripts/shared/dispatch-load-flake-investigation.mjs)
- [scripts/shared/load-flake-record.mjs](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/scripts/shared/load-flake-record.mjs)
- [scripts/shared/mcp-dispatch-lane.mjs](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/scripts/shared/mcp-dispatch-lane.mjs)
- [scripts/shared/retired-infrastructure-data.mjs](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/scripts/shared/retired-infrastructure-data.mjs)
- [scripts/shared/run-vitest-gate.mjs](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/scripts/shared/run-vitest-gate.mjs)
- [scripts/shared/triage-backlog.mjs](https://github.com/OhOkThisIsFine/audit-tools/blob/5756602bad536b145f2ec43d13b7ed032c71c922/scripts/shared/triage-backlog.mjs)

The current delta adds `executorRunners.planning_executor → readPublishedAuditTaskIds → withAcceptedResultsLock`, relocates `toAuditHostTask` into the host boundary, adds the pre-binding `evictInvalidatedEntries → writeAcceptedResults` persistence path, and supplies required pendingTaskIds from `ingestAvailableInspectionResults`. The canonical D1/D2 contracts and barriers cover these paths explicitly.

For quarantine navigation in nextStepHelpers, follow all calls to quarantineSubmissionFile in the existing source and the shared consumeArraySubmission/consumeObjectSubmission/consumeConceptualSubmission helpers; P4 requires an OwnedSubmission at every such call, including recovery and catch paths. Their roles and exact no-clobber algorithm remain in P4; this navigation does not license a weaker string-path overload.
