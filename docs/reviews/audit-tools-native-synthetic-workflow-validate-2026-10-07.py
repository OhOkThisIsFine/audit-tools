"""Pure exact-source validator for the inactive workflow; never invoke its run scripts."""
import ast
import fnmatch
import hashlib
import json
from pathlib import Path
import subprocess
import yaml

REPO=Path(__file__).resolve().parents[2]
WORKFLOW=REPO/'docs/reviews/audit-tools-native-synthetic-workflow-2026-10-07.yml.inactive'
PACKET='docs/reviews/audit-tools-native-confinement-proposal-2026-10-07/'
BRANCH='probe/r05-native-synthetic-20261007-01'

def blob(commit,path):
    return subprocess.run(['git','show',commit+':'+path],cwd=REPO,capture_output=True,check=True).stdout

def validate():
    source=WORKFLOW.read_text(encoding='utf-8')
    candidate=yaml.safe_load(source)
    assert candidate['on']=={'push':{'branches':[BRANCH]}}
    assert set(candidate)=={'name','on','permissions','concurrency','jobs'}
    assert candidate['permissions']=={}
    assert candidate['concurrency']=={'group':'r05-native-synthetic-20261007-01','cancel-in-progress':False}
    assert set(candidate['jobs'])=={'synthetic'}
    job=candidate['jobs']['synthetic']
    assert job['runs-on']=='ubuntu-24.04' and job['timeout-minutes']==18
    assert job['if']==("github.repository == 'OhOkThisIsFine/audit-tools' && "
                       "github.ref == 'refs/heads/"+BRANCH+"' && "
                       "github.event_name == 'push' && github.event.repository.private == false")
    assert job['defaults']=={'run':{'shell':'bash'}}
    assert set(job)=={'if','runs-on','timeout-minutes','defaults','env','steps'}
    assert all('uses' not in step and set(step)<= {'name','timeout-minutes','if','run'} for step in job['steps'])
    assert len(job['steps'])==4
    assert job['steps'][1]['run']==('/usr/bin/python3 -I "$R05_STAGE/synthetic-bootstrap.py" --stage "$R05_STAGE" --packet-commit "$PACKET_COMMIT" --manifest-sha "$MANIFEST_SHA"\n')
    assert [step['timeout-minutes'] for step in job['steps']]==[2,12,2,1]
    assert [step.get('if') for step in job['steps']]==[None,None,'always()','always()']
    assert not any(value in source for value in ('secrets.','github.token','GITHUB_TOKEN','id-token:',
                     'workflow_dispatch:','pull_request:','release:','actions/checkout','upload-artifact','actions/cache'))
    assert '${{' not in source  # job if uses fixed context; no shell expression interpolation
    env=job['env'];commit=env['PACKET_COMMIT']
    assert set(env)=={'PACKET_COMMIT','MANIFEST_SHA','BOOTSTRAP_SHA','BUNDLE_SHA'}
    manifest_bytes=blob(commit,PACKET+'packet-files.json');manifest=json.loads(manifest_bytes)
    assert hashlib.sha256(manifest_bytes).hexdigest()==env['MANIFEST_SHA']
    for name,digest in manifest['sha256'].items():assert hashlib.sha256(blob(commit,PACKET+name)).hexdigest()==digest,name
    assert hashlib.sha256(blob(commit,manifest['canonical_plan_path'])).hexdigest()==manifest['canonical_plan_raw_sha256']
    for variable,name in [('BOOTSTRAP_SHA','synthetic-bootstrap.py'),('BUNDLE_SHA','evidence-log-bundle.py')]:
        assert hashlib.sha256(blob(commit,PACKET+name)).hexdigest()==env[variable]
    for index in (0,2,3):
        script=job['steps'][index]['run'];assert script.startswith("python3 -I - <<'PY'\n") and script.endswith('PY\n')
        ast.parse(script.split('\n',1)[1].rsplit('\nPY\n',1)[0])
    inherited=[]
    for path in sorted((REPO/'.github/workflows').glob('*')):
        spec=yaml.load(path.read_text(encoding='utf-8'),Loader=yaml.BaseLoader)
        assert set(spec['on'])<= {'push','pull_request','workflow_dispatch','release'},path
        inherited.append((path,spec))
    assert len(inherited)==3
    matched=[]
    for path,spec in inherited:
        push=spec['on'].get('push')
        if push and any(fnmatch.fnmatchcase(BRANCH,pattern) for pattern in push.get('branches',[])):
            matched.append(path.name)
    assert matched==[],matched
    # Independent trigger negatives: main, proposal branch, PR, release and dispatch are excluded.
    for event,branch,expected in [('push',BRANCH,True),('push','main',False),
          ('push','docs/native-confinement-proposal-20261007',False),('pull_request',BRANCH,False),
          ('release',BRANCH,False),('workflow_dispatch',BRANCH,False)]:
        result=(event in candidate['on'] and branch in candidate['on'][event]['branches'])
        assert result==expected,(event,branch)
    print('PASS: inactive YAML + 3 embedded Python ASTs, exact packet/25 hashes/plan/bootstrap bindings, one public standard runner job, bounded 4 steps, no secret/write/OIDC/product/action/artifact/cache path, six trigger cases and zero inherited workflow matches. No workflow/Docker/product execution.')
    return {'kind':'inactive_source_workflow_binding_not_runtime_attestation','packet_commit':commit,
            'packet_tree':subprocess.run(['git','rev-parse',commit+'^{tree}'],cwd=REPO,capture_output=True,text=True,check=True).stdout.strip(),
            'workflow_path':str(WORKFLOW.relative_to(REPO)).replace('\\','/'),
            'workflow_sha256':hashlib.sha256(WORKFLOW.read_bytes()).hexdigest(),
            'manifest_sha256':env['MANIFEST_SHA'],'bootstrap_sha256':env['BOOTSTRAP_SHA'],
            'bundle_sha256':env['BUNDLE_SHA'],'canonical_plan_sha256':manifest['canonical_plan_raw_sha256'],
            'trigger_branch':BRANCH,'runner':'ubuntu-24.04','source_checks':'passed',
            'source_hash_count':len(manifest['sha256']),'inherited_workflow_matches':0,
            'uploaded_artifact_cache_bytes':0,'bundle_max_compressed_bytes':4194304,
            'bundle_max_input_bytes':8388608,'job_max_minutes':18,
            'actual_runtime_or_workflow_execution':'not_run','independent_review':'pending',
            'full_R05_R6_P0_acceptance':False,'P0_trees':{'original':'f2f2def9fa9817dbb3939435db66f67b4016bf7c',
                                                      'current':'a19d72f79a0d47ef0ddc0c0cca4d09635992b38e'}}

if __name__=='__main__':
    print(json.dumps(validate(),indent=2))
