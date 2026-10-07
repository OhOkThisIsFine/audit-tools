#!/usr/bin/env python3
"""Reviewed future synthetic-only teardown; immutable IDs plus exact task ownership."""
import json
import os
from pathlib import Path
import re
import subprocess

ROLES={'compiler','server','control','probe'}
class DockerTransport(str):
    def __new__(cls,stdout,stderr):
        value=super().__new__(cls,stdout.decode('utf-8',errors='replace'))
        value.stdout_bytes=stdout;value.stderr_bytes=stderr
        return value
def require(ok,message):
    if not ok: raise RuntimeError(message)

def container_identity(spec,task):
    cid=spec.get('Id',''); labels=spec.get('Config',{}).get('Labels',{}) or {}
    role=labels.get('r05.role')
    require(re.fullmatch(r'[0-9a-f]{64}',cid) is not None and role in ROLES and
            labels.get('r05.task')==task and spec.get('Name')=='/r05-'+task+'-'+role,
            'container ownership uncertain; preserve')
    return cid,role

def network_identity(spec,task):
    nid=spec.get('Id','')
    require(re.fullmatch(r'[0-9a-f]{64}',nid) is not None and
            spec.get('Name')=='r05-fixture-'+task and
            (spec.get('Labels') or {}).get('r05.task')==task and
            spec.get('Driver')=='bridge' and spec.get('Internal') is True and
            spec.get('EnableIPv6') is True,
            'network ownership uncertain; preserve')
    return nid

def teardown(root,cfg,docker):
    task=cfg['task_id']; evidence=root/'evidence'
    ids=docker('ps','--all','--quiet','--no-trunc','--filter','label=r05.task='+task).split()
    require(len(ids)<=4 and len(set(ids))==len(ids),'unexpected owned container set')
    owned=[]; roles=set()
    # Validate the whole discovered set before the first mutation.
    for cid in ids:
        require(re.fullmatch(r'[0-9a-f]{64}',cid) is not None,'invalid discovered CID')
        spec=json.loads(docker('inspect',cid))[0]
        observed,role=container_identity(spec,task)
        require(observed==cid and role not in roles,'duplicate/mismatched role')
        roles.add(role); owned.append((cid,role))
        (evidence/(role+'-cleanup-before.json')).write_text(json.dumps(spec,indent=2)+'\n')
    networks=docker('network','ls','--quiet','--no-trunc','--filter','label=r05.task='+task).split()
    require(len(networks)<=1,'unexpected owned network set')
    for nid in networks:
        spec=json.loads(docker('network','inspect',nid))[0]
        require(network_identity(spec,task)==nid,'network ID mismatch')
    result={'task_id':task,'containers':[],'networks':[],'complete':False}
    for cid,role in owned:
        current=json.loads(docker('inspect',cid))[0]
        require(container_identity(current,task)==(cid,role),'changed container identity')
        if current['State']['Running']:
            docker('stop','--time','5',cid)
        terminal=json.loads(docker('inspect',cid))[0]
        require(container_identity(terminal,task)==(cid,role) and
                terminal['State']['Running'] is False,'owned container not terminal')
        (evidence/(role+'-cleanup-terminal.json')).write_text(json.dumps(terminal,indent=2)+'\n')
        logs=docker('logs',cid)
        (evidence/(role+'-cleanup.stdout')).write_bytes(getattr(logs,'stdout_bytes',logs.encode('utf-8')))
        (evidence/(role+'-cleanup.stderr')).write_bytes(getattr(logs,'stderr_bytes',b''))
        docker('rm',cid)  # terminal identity and final transport saved before removal
        result['containers'].append({'id':cid,'role':role,'terminal_exit':terminal['State']['ExitCode'],'removed':True})
    for nid in networks:
        current=json.loads(docker('network','inspect',nid))[0]
        require(network_identity(current,task)==nid and not current.get('Containers'),
                'network attached/changed; preserve')
        (evidence/'network-cleanup-terminal.json').write_text(json.dumps(current,indent=2)+'\n')
        docker('network','rm',nid)
        result['networks'].append({'id':nid,'removed':True})
    require(not docker('ps','--all','--quiet','--no-trunc','--filter','label=r05.task='+task).split(),
            'owned containers remain')
    require(not docker('network','ls','--quiet','--no-trunc','--filter','label=r05.task='+task).split(),
            'owned network remains')
    result['complete']=True
    (evidence/'owned-teardown.json').write_text(json.dumps(result,indent=2)+'\n')
    return result

def checked_root(config_path):
    path=Path(config_path); cfg=json.loads(path.read_text()); root=Path(cfg['task_root'])
    temp=Path(os.environ['RUNNER_TEMP']).resolve(strict=True)
    require(root.is_relative_to(temp) and root!=temp and root.resolve(strict=True)==root and
            path.resolve(strict=True)==root/'config.json','outside owned task')
    require(json.loads((root/'owned-task.json').read_text())=={'task_id':cfg['task_id']},'marker mismatch')
    require((root/'evidence').resolve(strict=True)==root/'evidence','evidence alias')
    return root,cfg

if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('--config',required=True);args=parser.parse_args()
    root,cfg=checked_root(args.config)
    env={'PATH':'/usr/bin:/bin','HOME':str(root/'client-home'),'DOCKER_CONFIG':str(root/'docker-config')}
    def docker(*values):
        result=subprocess.run(['/usr/bin/docker','--host=unix:///var/run/docker.sock',*values],
                              env=env,stdin=subprocess.DEVNULL,capture_output=True,
                              timeout=15,check=True)
        return DockerTransport(result.stdout,result.stderr)
    print(json.dumps(teardown(root,cfg,docker)))
