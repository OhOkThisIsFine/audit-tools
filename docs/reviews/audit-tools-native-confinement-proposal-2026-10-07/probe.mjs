// Runs before product import/collection. Native descendants carry the OS boundary.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, lstatSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import os from 'node:os';
const control = process.env.R05_ROLE === 'control';
const root = '/work/probe';
const outcomes = [];
function run(file, args, want = 0) {
  const result = spawnSync(file, args, {encoding:'utf8', timeout:12000,
    stdio:['ignore','pipe','pipe'], env:process.env});
  outcomes.push({file,args,status:result.status,signal:result.signal,
    error:result.error?.code ?? null, stdout:result.stdout,stderr:result.stderr});
  assert.equal(result.error, undefined, file + ': process error');
  assert.equal(result.signal, null, file + ': process signal');
  if (want === 'deny') assert.notEqual(result.status, 0, file + ': unexpected success');
  else assert.equal(result.status, want, file + ': unexpected status');
  return result.stdout.trim();
}
const native = args => run(root+'/native-probe', args);
const ip4 = process.env.R05_ENDPOINT4;
const ip6 = process.env.R05_ENDPOINT6;
const token = process.env.R05_TOKEN;
assert(ip4 && ip6 && /^[0-9a-f]{32}$/.test(token ?? ''), 'missing owned fixture identity');
assert.equal(process.version, 'v22.23.3');
assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'x64');
const npmCli = '/tools/lib/node_modules/npm/bin/npm-cli.js';
assert.equal(run('/tools/bin/node', [npmCli,'--version']), '10.9.9');
for (const name of ['HOME','USERPROFILE','TEMP','TMP','TMPDIR'])
  assert(resolve(process.env[name]).startsWith('/work/home/'), name+': outside private home');
assert.equal(os.userInfo().homedir, '/work/home/profile');
assert.equal(os.tmpdir(), '/work/home/profile/temp');
const absent = process.env.AGENT_DISPATCH_REPO;
assert.equal(absent, '/work/home/profile/absent-agent-dispatch');
assert.equal(existsSync(absent), false);
assert.equal(existsSync(join(absent, 'bridge')), false);
for (const name of ['GIT_CONFIG_GLOBAL','npm_config_userconfig','npm_config_globalconfig'])
  assert(resolve(process.env[name]).startsWith('/work/home/'));
assert.equal(process.env.NODE_NO_WARNINGS, undefined);
const expected = control ? 'allow' : 'deny';
native(['read','/host-secret/credential-canary.txt',expected]);
native(['write',root+'/inside-'+process.env.R05_ROLE,'allow']);
for (const [family,ip] of [['4',ip4],['6',ip6]])
  for (const [transport,port] of [['tcp','8090'],['udp','8091']])
    native(['net',family,transport,ip,port,token,expected]);
if (!control) {
  native(['read',process.env.R05_HOST_CANARY_PATH,'deny']);
  run('/bin/mkdir',['/work-sibling'],'deny');
  const status = readFileSync('/proc/self/status','utf8');
  assert.match(status, /^CapEff:\s*0+$/m);
  assert.match(status, /^NoNewPrivs:\s*1$/m);
  assert.match(status, /^Seccomp:\s*2$/m);
  assert.deepEqual(run('/bin/ls',['/sys/class/net']).split(/\s+/), ['lo']);
  for (const path of ['/work-sibling/marker','/tmp/r05-marker',
    '/dev/shm/r05-marker','/tools/r05-marker','/harness/r05-marker'])
    native(['write',path,'deny']);
  for (const family of ['17','38','40'])
    native(['family',family,'deny']); // packet, kernel crypto, VM sockets
  run('/usr/bin/git',['--version']);
  run('/bin/tar',['--version']);
  run('/usr/bin/git',['init','--quiet',root+'/repo']);
  writeFileSync(root+'/repo/sample.txt','synthetic archive fixture\n');
  run('/usr/bin/git',['-C',root+'/repo','add','sample.txt']);
  const tree = run('/usr/bin/git',['-C',root+'/repo','write-tree']);
  run('/usr/bin/git',['-C',root+'/repo','archive','--format=tar',
    '--output='+root+'/source.tar',tree]);
  run('/bin/mkdir',[root+'/extracted']);
  run('/bin/tar',['-xf',root+'/source.tar','-C',root+'/extracted']);
  assert.equal(readFileSync(root+'/extracted/sample.txt','utf8'),'synthetic archive fixture\n');
  run('/bin/tar',['-cf','/work-sibling/outside.tar','-C',root+'/repo','sample.txt'],'deny');
  run('/bin/tar',['-cf',root+'/denied-read.tar','-C','/host-secret',
    'credential-canary.txt'],'deny');
  // Exercise a native shell grandchild, beyond immediate Node children.
  run('/bin/bash',['-c','/bin/cat /host-secret/credential-canary.txt >/work/probe/denied-shell-read'],'deny');
  run('/bin/bash',['-c','echo synthetic >/work-sibling/shell-marker'],'deny');
}
process.emitWarning('R05_ORDINARY_WARNING_SENTINEL', {type:'QualificationWarning'});
writeFileSync(root+'/'+process.env.R05_ROLE+'-results.json',
  JSON.stringify({role:process.env.R05_ROLE,taskId:process.env.R05_TASK_ID,
    endpoint4:ip4,endpoint6:ip6,token,node:process.version,
    execPath:process.execPath,platform:process.platform,arch:process.arch,
    outcomes,passed:true},null,2)+'\n');
console.log('R05_'+process.env.R05_ROLE.toUpperCase()+'_NATIVE_PROBES_PASSED');
// This only qualifies preliminary native canaries. R05/R6/product acceptance
// remains open until worker/config/analyzer/diagnostic/final-tree gates run.
