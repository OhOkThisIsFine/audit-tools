#!/usr/bin/env python3
"""Future reviewed host orchestration. Fixed synthetic roles only; no product import."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import runpy
import shutil
import signal
import subprocess
import sys
import time
import urllib.request

REPOSITORY='OhOkThisIsFine/audit-tools'
BRANCH='probe/r05-native-synthetic-20261007-01'
PACKET_PATH='docs/reviews/audit-tools-native-confinement-proposal-2026-10-07'
IMAGE='docker.io/library/node@sha256:c4d5523090a817b7aa86d2111241fdd4f66d1e27782b44160e6aa63b357ecb2d'
ARCHIVE='node-v22.23.3-linux-x64.tar.xz'
ARCHIVE_SHA='df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de'
KEY_FINGERPRINT='5BE8A3F6C8A5C01D106C0AD820B1A390B168D356'
KEY_SHA='5115095e2f8010c75da052ecb1cfb3af630e084f0f8daa93a863557b01b0f90a'
SIGNED_SHA='e82087fe2cf383fce187b0789eb5ea50fd92f9b68afb4f4e174d65ec59acba4a'

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs): raise RuntimeError('redirect refused')

def require(ok,message):
    if not ok: raise RuntimeError(message)

def fetch(url,path,limit,expected):
    # No ambient proxy credentials, request Authorization header or cross-origin redirect.
    require(url.startswith(('https://raw.githubusercontent.com/','https://nodejs.org/dist/v22.23.3/')),
            'unapproved source origin')
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    digest=hashlib.sha256(); total=0; deadline=time.monotonic()+90
    with opener.open(url,timeout=15) as response,Path(path).open('xb') as target:
        while True:
            require(time.monotonic()<deadline,'download time bound exceeded')
            chunk=response.read(65536)
            if not chunk: break
            total+=len(chunk); require(total<=limit,'download size bound exceeded')
            digest.update(chunk); target.write(chunk)
    require(digest.hexdigest()==expected,'download hash mismatch')

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--stage',required=True)
    parser.add_argument('--packet-commit',required=True);parser.add_argument('--manifest-sha',required=True)
    args=parser.parse_args()
    require(platform.system()=='Linux' and platform.machine()=='x86_64' and os.getuid()>0,
            'observed non-root Linux x64 required')
    require(os.environ.get('GITHUB_REPOSITORY')==REPOSITORY and
            os.environ.get('GITHUB_REF')=='refs/heads/'+BRANCH and
            os.environ.get('GITHUB_EVENT_NAME')=='push','exact bounded push route required')
    require(re.fullmatch(r'[0-9a-f]{40}',args.packet_commit) is not None and
            re.fullmatch(r'[0-9a-f]{64}',args.manifest_sha) is not None,'exact reviewed packet revision required')
    stage=Path(args.stage);temp=Path(os.environ['RUNNER_TEMP']).resolve(strict=True)
    require(stage.is_relative_to(temp) and stage!=temp and stage.resolve(strict=True)==stage and
            stage.stat().st_uid==os.getuid(),'owned stage required')
    require(json.loads((stage/'workflow-fetch.json').read_text())==
            {'packet_commit':args.packet_commit,'manifest_sha':args.manifest_sha},'workflow pin mismatch')
    evidence=stage/'evidence';evidence.mkdir(exist_ok=True)
    packet=stage/'packet';packet.mkdir()
    client_home=stage/'client-home';client_home.mkdir()
    docker_config=stage/'docker-config';docker_config.mkdir()
    env={'PATH':'/usr/bin:/bin','HOME':str(client_home),'DOCKER_CONFIG':str(docker_config),
         'RUNNER_TEMP':str(temp)}
    config_path=None;task_root=None;failure=None;cleanup_failed=False
    def record_command(name,argv,timeout=30):
        require(re.fullmatch(r'[a-z0-9-]+',name) is not None,'invalid evidence name')
        try:
            result=subprocess.run(argv,env=env,stdin=subprocess.DEVNULL,capture_output=True,
                                  timeout=timeout,check=False)
            (evidence/(name+'.stdout')).write_bytes(result.stdout)
            (evidence/(name+'.stderr')).write_bytes(result.stderr)
            (evidence/(name+'-exit.json')).write_text(json.dumps({'exit':result.returncode})+'\n')
            require(len(result.stdout)<=1048576 and len(result.stderr)<=1048576,'transport bound exceeded')
            require(result.returncode==0,name+' failed: observe retained transport/exit')
            return result.stdout.decode('utf-8')
        except subprocess.TimeoutExpired as error:
            for suffix,value in [('stdout',error.stdout),('stderr',error.stderr)]:
                (evidence/(name+'.'+suffix)).write_bytes(value or b'')
            (evidence/(name+'-exit.json')).write_text(json.dumps({'exit':None,'timed_out':True})+'\n')
            raise RuntimeError(name+' timed out; not a pass') from error
    docker_sequence=0
    def observed_docker(*values,timeout=15):
        nonlocal docker_sequence
        docker_sequence+=1
        return record_command('docker-'+str(docker_sequence),
            ['/usr/bin/docker','--host=unix:///var/run/docker.sock',*values],timeout)
    def watchdog(signum,frame): raise RuntimeError('600s bootstrap/probe watchdog; qualification failed')
    signal.signal(signal.SIGALRM,watchdog);signal.signal(signal.SIGTERM,watchdog);signal.alarm(600)
    try:
        require(shutil.disk_usage(temp).free>=4*1024**3,'less than 4GiB free; no cache/tool deletion')
        for tool in ['/usr/bin/docker','/usr/bin/python3','/usr/bin/gpg']:
            require(Path(tool).is_file(),'missing preinstalled tool '+tool)
        version=json.loads(observed_docker('version','--format','{{json .}}'))
        require(version['Server']['Version']=='28.0.4' and version['Server']['Os']=='linux' and
                version['Server']['Arch']=='amd64','daemon mismatch requires bounded source comparison')
        inventory={'kernel':platform.release(),'uid':os.getuid(),'gid':os.getgid(),
                   'image_os':os.environ.get('ImageOS'),'image_version':os.environ.get('ImageVersion'),
                   'packet_commit':args.packet_commit,'python':sys.version,
                   'storage_driver':observed_docker('info','--format','{{json .Driver}}').strip(),
                   'free_bytes':shutil.disk_usage(temp).free,'product_executed':False}
        (evidence/'inventory.json').write_text(json.dumps(inventory,indent=2)+'\n')
        base='https://raw.githubusercontent.com/'+REPOSITORY+'/'+args.packet_commit+'/'
        fetch(base+PACKET_PATH+'/packet-files.json',packet/'packet-files.json',65536,args.manifest_sha)
        manifest=json.loads((packet/'packet-files.json').read_text())
        require(0<len(manifest['sha256'])<=32,'packet file count bound')
        for name,digest in manifest['sha256'].items():
            require(re.fullmatch(r'[A-Za-z0-9._-]+',name) is not None and
                    re.fullmatch(r'[0-9a-f]{64}',digest) is not None,'unsafe packet entry')
            fetch(base+PACKET_PATH+'/'+name,packet/name,2*1024*1024,digest)
        require(manifest['sha256']['synthetic-bootstrap.py']==hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                'executed bootstrap differs from reviewed packet')
        require(manifest['canonical_plan_path']=='docs/reviews/audit-tools-canonical-implementation-plan-2026-10-07.md',
                'canonical path drift')
        fetch(base+manifest['canonical_plan_path'],packet/'canonical-plan.md',2*1024*1024,
              manifest['canonical_plan_raw_sha256'])
        (evidence/'packet-binding.json').write_text(json.dumps({'commit':args.packet_commit,
            'manifest_sha256':args.manifest_sha,'source_hashes':manifest['sha256'],
            'plan_sha256':manifest['canonical_plan_raw_sha256']},indent=2)+'\n')
        require(hashlib.sha256((packet/'node-release-key.asc').read_bytes()).hexdigest()==KEY_SHA and
                hashlib.sha256((packet/'node-SHASUMS256.txt.asc').read_bytes()).hexdigest()==SIGNED_SHA,
                'retained official signature metadata drift')
        signed=stage/'SHASUMS256.txt.asc'
        fetch('https://nodejs.org/dist/v22.23.3/SHASUMS256.txt.asc',signed,65536,SIGNED_SHA)
        gnupg=stage/'gnupg';gnupg.mkdir(mode=0o700)
        gpg=['/usr/bin/gpg','--no-options','--homedir',str(gnupg),'--batch','--no-autostart',
             '--no-auto-key-retrieve','--no-auto-key-import']
        shown=record_command('public-key-fingerprint',gpg+['--with-colons','--import-options','show-only',
                              '--import',str(packet/'node-release-key.asc')])
        primary=next(line.split(':')[9] for line in shown.splitlines() if line.startswith('fpr:'))
        require(primary==KEY_FINGERPRINT,'official Node signer fingerprint mismatch')
        record_command('public-key-import',gpg+['--import',str(packet/'node-release-key.asc')])
        verified=stage/'verified-SHASUMS256.txt'
        status=record_command('signed-checksum-verification',gpg+['--status-fd','1','--output',str(verified),
                              '--decrypt',str(signed)])
        require(any(line.startswith('[GNUPG:] VALIDSIG '+KEY_FINGERPRINT+' ') for line in status.splitlines()),
                'valid expected Node release signature required')
        require((ARCHIVE_SHA+'  '+ARCHIVE) in verified.read_text().splitlines(),'signed archive entry mismatch')
        archive=stage/ARCHIVE
        fetch('https://nodejs.org/dist/v22.23.3/'+ARCHIVE,archive,64*1024*1024,ARCHIVE_SHA)
        observed_docker('pull','--platform=linux/amd64',IMAGE,timeout=240)
        require(shutil.disk_usage(temp).free>=1024**3,'less than 1GiB free after immutable staging')
        prepared=json.loads(record_command('prepare-owned-layout',['/usr/bin/python3','-I',
            str(packet/'prepare-owned-layout.py'),'--packet',str(packet),'--archive',str(archive)]))
        prepared_root=Path(prepared['task_root']);prepared_config=Path(prepared['config'])
        require(prepared_root.is_relative_to(temp) and prepared_root.resolve(strict=True)==prepared_root and
                prepared_config==prepared_root/'config.json','prepared task path mismatch')
        task_root=prepared_root;config_path=prepared_config
        (stage/'prepared-config.json').write_text(json.dumps({'config':str(config_path)})+'\n')
        cfg=json.loads(config_path.read_text());canary=task_root/'host-canary/credential-canary.txt'
        before=hashlib.sha256(canary.read_bytes()).hexdigest()
        def launch(role):
            return record_command('launcher-'+role,['/usr/bin/python3','-I',str(packet/'r05-launcher.py'),
                         '--config',str(config_path),'--role',role,'--execute'],timeout=90)
        launch('compiler')
        network=observed_docker('network','create','--driver','bridge','--internal','--ipv6',
                     '--label','r05.task='+cfg['task_id'],'r05-fixture-'+cfg['task_id']).strip()
        require(re.fullmatch(r'[0-9a-f]{64}',network) is not None,'network immutable ID unavailable')
        server=json.loads(launch('server'))['container_id']
        ready=False
        for attempt in range(10):
            if 'R05_FIXTURE_READY' in observed_docker('logs',server):ready=True;break
            time.sleep(0.5)
        require(ready,'owned echo server readiness unavailable')
        record_command('bind-owned-fixture',['/usr/bin/python3','-I',str(packet/'bind-owned-fixture.py'),
                       '--config',str(config_path),'--server-id',server])
        launch('control');launch('probe')
        require(hashlib.sha256(canary.read_bytes()).hexdigest()==before,'synthetic credential changed')
        for outside in (task_root/'workspace-sibling',task_root/'workspace'/'repo-sibling'):
            require(not outside.exists(),'unexpected sibling host mutation')
        (evidence/'native-result.json').write_text(json.dumps({'preliminary_native_canaries':True,
           'full_R05':False,'R6':False,'P0':False,'product_executed':False})+'\n')
    except BaseException as error:
        failure=type(error).__name__+': '+str(error)
        (evidence/'bootstrap-failure.json').write_text(json.dumps({'failure':failure,'qualification':False})+'\n')
    finally:
        signal.alarm(0)
        # Cleanup gets its own bounded command calls; never bulk prune/kill/delete files.
        if config_path is not None:
            try:
                module=runpy.run_path(str(packet/'owned-teardown.py'),run_name='owned_cleanup_import')
                root,cfg=module['checked_root'](config_path)
                module['teardown'](root,cfg,observed_docker)
            except BaseException as error:
                cleanup_failed=True
                (evidence/'cleanup-failure.json').write_text(json.dumps({'failure':type(error).__name__+': '+str(error),
                                                                       'complete':False})+'\n')
        if task_root is not None:
            for file in sorted((task_root/'evidence').glob('*')):
                require(file.is_file() and not file.is_symlink(),'nonregular task evidence')
                shutil.copyfile(file,evidence/('task-'+file.name))
            for role in ('control','probe'):
                file=task_root/'workspace/probe'/(role+'-results.json')
                if file.is_file() and not file.is_symlink():shutil.copyfile(file,evidence/(role+'-results.json'))
        outcome={'preliminary_native_canaries_completed':failure is None and not cleanup_failed,
                 'cleanup_failed':cleanup_failed,'failure':failure,'full_R05_R6_P0_acceptance':False,
                 'product_executed':False,'uploaded_artifact_bytes':0}
        (evidence/'outcome.json').write_text(json.dumps(outcome,indent=2)+'\n')
        print(json.dumps(outcome))
    return 1 if failure is not None or cleanup_failed else 0

if __name__=='__main__': sys.exit(main())
