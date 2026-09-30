// sites-pinned: none — manual diagnostic; assertions and output reproducibility were checked by direct invocation, not an automated importing test
// Run: TSX_TSCONFIG_PATH=tsconfig.test.json node --import tsx/esm scripts/profiling/staleness-cascade.mjs
// Bounded production-path microprofile, not a host/LLM benchmark or a cache proposal.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashContent as sha } from '../shared/primitives.mjs';
import { performance } from 'node:perf_hooks';
import { computeArtifactMetadata } from '../../src/audit/orchestrator/artifactMetadata.ts';
import { computeStaleArtifacts } from '../../src/audit/orchestrator/staleness.ts';
import { ARTIFACT_DEPENDS_ON_MAP } from '../../src/audit/orchestrator/dependencyMap.ts';
import { deriveIntentEquivalenceStatus, runIntentEquivalenceResolve } from '../../src/audit/orchestrator/intentEquivalenceExecutor.ts';
import { emptyCharterRegister } from '../../src/audit/orchestrator/charterExtractionExecutor.ts';
import { runCharterClarificationExecutor } from '../../src/audit/orchestrator/charterClarificationExecutor.ts';
import { runSystemicChallengeExecutor } from '../../src/audit/orchestrator/systemicChallengeExecutor.ts';
import { materializeCharterPacket } from '../../src/audit/orchestrator/charterPackets.ts';

const root = await mkdtemp(join(tmpdir(), 'audit-staleness-profile-'));
const prose = Array.from({ length: 400 }, (_, i) => `Requirement ${i + 1}: authentication must preserve tenant isolation, explicit access boundaries, and observable failure recovery.\n`).join('');
const contents = { 'README.md': prose, 'src/auth.ts': '// Own authentication and tenant boundaries.\nexport function authenticate() { return true; }\n', 'src/other.ts': 'export const unrelated = 1;\n' };
const bytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value));
/** @param {import('../../src/audit/io/artifacts.js').ArtifactBundle} bundle */
function stamp(bundle, names = []) {
  return { ...bundle, artifact_metadata: computeArtifactMetadata(bundle, bundle.artifact_metadata, names) };
}
try {
  await mkdir(join(root, 'src'));
  for (const [path, content] of Object.entries(contents)) await writeFile(join(root, path), content);
  /** @type {import('../../src/audit/io/artifacts.js').ArtifactBundle} */
  let base = {
    repo_manifest: { repository: { name: 'prose-heavy-microprofile' }, generated_at: '2026-09-30T00:00:00Z', files: Object.entries(contents).map(([path, content]) => ({ path, language: path.endsWith('.md') ? 'md' : 'ts', size_bytes: bytes(content), hash: sha(content) })) },
    file_disposition: { files: Object.keys(contents).map(path => ({ path, status: path.endsWith('.md') ? 'doc_only' : 'included' })) },
    graph_bundle: { graphs: {} },
    intent_checkpoint: { schema_version: 'intent-checkpoint/v1', confirmed_by: 'host', confirmed_at: '2026-09-30T00:00:00Z', scope_summary: 'Audit the authentication subsystem and its documented guarantees.', intent_summary: prose, design_review: { ceiling: { rung: 'deep' } } },
    structure_decomposition: { generated_at: '2026-09-30T00:00:00Z', target: 'structure', node_universe_size: 2, source_ids: ['fixture'], consensus: [{ node_id: 'auth', members: ['src/auth.ts'], agreed_across_source: 1, stable_across_scale: 1, contested: false }], contested: [], findings: [] },
    charter_register: emptyCharterRegister({ rung: 'deep' }, '2026-09-30T00:00:00Z', undefined),
  };
  base = stamp(base);
  base = stamp(runIntentEquivalenceResolve(base).updated, ['intent_checkpoint.json']);
  base = runCharterClarificationExecutor(base).updated;
  base = runSystemicChallengeExecutor(base).updated;
  base = stamp(base, ['charter_clarification.json', 'systemic_challenge.json']);
  assert.equal(computeStaleArtifacts(base).size, 0, 'baseline must be fresh');
  const cases = [
    { name: 'provenance-only', field: 'intent_checkpoint.confirmed_at', edit: b => { b.intent_checkpoint.confirmed_at = '2026-10-01T00:00:00Z'; } },
    { name: 'equivalent-prose', field: 'intent_checkpoint.scope_summary', verdict: 'equivalent', edit: b => { b.intent_checkpoint.scope_summary = 'Review authentication and the guarantees stated in its documentation.'; } },
    { name: 'changed-prose', field: 'intent_checkpoint.scope_summary', verdict: 'changed', edit: b => { b.intent_checkpoint.scope_summary = 'Audit only authentication availability; tenant isolation is excluded.'; } },
    { name: 'document-content', field: 'repo_manifest.files[README.md].hash/size_bytes', edit: b => { b.repo_manifest.files[0].hash = sha(prose + 'Require revocation within one second.\n'); b.repo_manifest.files[0].size_bytes = bytes(prose + 'Require revocation within one second.\n'); } },
    { name: 'unrelated-code-content', field: 'repo_manifest.files[src/other.ts].hash', edit: b => { b.repo_manifest.files[2].hash = sha('export const unrelated = 2;\n'); } },
  ];
  const rows = [];
  for (const scenario of cases) {
    let bundle = structuredClone(base);
    scenario.edit(bundle);
    await writeFile(join(root, 'README.md'), scenario.name === 'document-content' ? prose + 'Require revocation within one second.\n' : prose);
    await writeFile(join(root, 'src/other.ts'), scenario.name === 'unrelated-code-content' ? 'export const unrelated = 2;\n' : contents['src/other.ts']);
    const started = performance.now();
    const status = deriveIntentEquivalenceStatus(bundle);
    if (scenario.verdict) {
      assert.equal(status.kind, 'prose_judgment_pending');
      if (status.kind !== 'prose_judgment_pending') throw new Error('missing bound prose judgment');
      bundle = runIntentEquivalenceResolve(bundle, { verdict: scenario.verdict === 'equivalent' ? 'equivalent' : 'changed', judged_pair: { prior_hash: status.prior_hash, new_hash: status.new_hash } }).updated;
    }
    bundle = stamp(bundle);
    const stale = computeStaleArtifacts(bundle);
    const detectionMs = performance.now() - started;
    const upstream = scenario.field.startsWith('intent') ? 'intent_checkpoint.json' : 'repo_manifest.json';
    const directEdges = Object.entries(ARTIFACT_DEPENDS_ON_MAP).filter(([, deps]) => /** @type {readonly string[]} */ (deps).includes(upstream)).map(([downstream]) => [upstream, downstream]);
    // Actually rerun two deterministic producers only. Other stale artifacts remain outstanding;
    // neither a metadata restamp nor a manufactured host answer is called a rederivation.
    const rederived = [];
    const rederiveStart = performance.now();
    for (const [name, executor] of /** @type {const} */ ([['charter_clarification.json', runCharterClarificationExecutor], ['systemic_challenge.json', runSystemicChallengeExecutor]])) {
      if (!stale.has(name)) continue;
      const run = executor(bundle);
      rederived.push(...run.artifacts_written);
      bundle = stamp(run.updated, run.artifacts_written);
    }
    const rederiveMs = performance.now() - rederiveStart;
    const packetStart = performance.now();
    const packet = await materializeCharterPacket({ root, bundle, kind: 'stated' });
    const packetMs = performance.now() - packetStart;
    rows.push({ scenario: scenario.name, changed_field: scenario.field, judgment: scenario.verdict ?? 'none', direct_dependency_edges: directEdges, stale: [...stale].sort(), deferred: [...stale.deferred].sort(), actually_rederived: rederived, remaining_stale: [...computeStaleArtifacts(bundle)].sort(), measured_ms: { detection_and_metadata: detectionMs, deterministic_producers: rederiveMs, stated_packet_materialization: packetMs }, materialized_context_utf8_bytes: bytes(packet.markdown), input_bundle_json_bytes: bytes(bundle), supplied_to_host_bytes: 0, actual_llm_tokens: null, estimated_tokens: null });
  }
  assert.deepEqual(rows[0].stale, []);
  assert.deepEqual(rows[1].stale, []);
  assert(rows[2].stale.includes('charter_register.json'));
  assert(rows[3].stale.includes('charter_register.json'));
  assert(!rows[4].stale.includes('charter_register.json'));
  assert(rows[4].stale.includes('systemic_challenge.json'), 'whole-manifest challenge authority must remain');
  console.log(JSON.stringify({ schema_version: 'staleness-cascade-profile/v1', node: process.version, fixture: { doc_lines: 400, doc_bytes: bytes(prose), source_files: 2, charter_members: 1 }, limits: 'Single deterministic fixture. Bound prose verdicts are synthetic test inputs. No host or LLM is invoked; packet bytes are materialized, not delivered. Metadata timing and two producer reruns exclude remaining cascade/host cost. No repository-wide invalidation conclusion.', rows }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
