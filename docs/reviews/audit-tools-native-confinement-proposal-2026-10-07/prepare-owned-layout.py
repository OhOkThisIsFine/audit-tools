#!/usr/bin/env python3
"""Source-only owned-layout preparation, runnable only after remote review."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import secrets
import shutil
import tarfile
import uuid

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--packet",required=True)
    parser.add_argument("--archive",required=True)
    options=parser.parse_args()
    if platform.system()!="Linux" or platform.machine()!="x86_64" or os.getuid()==0:
        raise RuntimeError("requires observed non-root Linux x64 runner")
    packet=Path(options.packet).resolve(strict=True)
    archive=Path(options.archive).resolve(strict=True)
    with archive.open("rb") as f:
        digest=hashlib.file_digest(f,"sha256").hexdigest()
    if digest!="df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de":
        raise RuntimeError("official Node archive checksum mismatch")
    manifest=json.loads((packet/"packet-files.json").read_text())
    for name,expected in manifest["sha256"].items():
        path=packet/name
        if path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest()!=expected:
            raise RuntimeError("reviewed source differs: "+name)
    task_id=str(uuid.uuid4())
    parent=Path(os.environ["RUNNER_TEMP"]).resolve(strict=True)
    root=parent/("r05-owned-"+task_id)
    root.mkdir(mode=0o700)  # no reuse/reset of any existing task
    for folder in ("workspace/repo","workspace/probe","runtime","harness/empty-shm",
                   "host-canary","evidence","client-home","docker-config"):
        (root/folder).mkdir(parents=True,exist_ok=True,mode=0o700)
    shutil.copyfile(packet/"packet-files.json",root/"source-manifest.json")
    home=root/"workspace/home/profile"
    for folder in ("temp","npm-cache","npm-prefix","state","analyzers","binaries"):
        (home/folder).mkdir(parents=True,exist_ok=True,mode=0o700)
    for name in ("user.npmrc","global.npmrc","gitconfig"):
        (home/name).write_text("")
    for name in ("r05-seccomp.json","docker-28.0.4-default-seccomp.json",
                 "native-probe.c","fixture-server.mjs","probe.mjs"):
        shutil.copyfile(packet/name,root/"harness"/name)
    uid,gid=os.getuid(),os.getgid()
    (root/"harness/passwd").write_text(
        "root:x:0:0:root:/root:/bin/false\nr05:x:"+str(uid)+":"+str(gid)+
        ":R05:/work/home/profile:/bin/bash\n")
    (root/"harness/group").write_text("root:x:0:\nr05:x:"+str(gid)+":\n")
    shutil.copyfile(archive,root/"runtime"/archive.name)
    with tarfile.open(archive,"r:xz") as tar:
        tar.extractall(root/"runtime",filter="data")
    (root/"host-canary/credential-canary.txt").write_text("SYNTHETIC_R05_"+secrets.token_hex(16)+"\n")
    (root/"owned-task.json").write_text(json.dumps({"task_id":task_id})+"\n")
    config={"task_root":str(root),"task_id":task_id,"uid":uid,"gid":gid,
            "token":secrets.token_hex(16),"endpoint4":"0.0.0.0","endpoint6":"::",
            "server_id":""}
    (root/"config.json").write_text(json.dumps(config,indent=2)+"\n")
    print(json.dumps({"task_root":str(root),"config":str(root/"config.json"),
                      "task_id":task_id,"executed_product":False}))
if __name__=="__main__":
    main()
