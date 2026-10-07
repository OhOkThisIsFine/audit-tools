#!/usr/bin/env python3
"""Bind config to this task's real already-started fixture; no fabricated addresses."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess

p=argparse.ArgumentParser()
p.add_argument("--config",required=True)
p.add_argument("--server-id",required=True)
a=p.parse_args()
if not re.fullmatch(r"[0-9a-f]{64}",a.server_id):
    raise RuntimeError("immutable container ID required")
path=Path(a.config)
cfg=json.loads(path.read_text())
root=Path(cfg["task_root"])
env={"PATH":"/usr/bin:/bin","HOME":str(root/"client-home"),
     "DOCKER_CONFIG":str(root/"docker-config")}
def docker(*args):
    return subprocess.run(["/usr/bin/docker","--host=unix:///var/run/docker.sock",*args],
        env=env,stdin=subprocess.DEVNULL,capture_output=True,text=True,
        timeout=15,check=True).stdout
server=json.loads(docker("inspect",a.server_id))[0]
if server["Config"]["Labels"].get("r05.task")!=cfg["task_id"] or \
   server["Config"]["Labels"].get("r05.role")!="server" or not server["State"]["Running"]:
    raise RuntimeError("owned running server missing")
if "R05_FIXTURE_READY" not in docker("logs",a.server_id):
    raise RuntimeError("fixture not ready: observe exact owned CID, do not assume readiness")
network=server["NetworkSettings"]["Networks"]["r05-fixture-"+cfg["task_id"]]
if not network["IPAddress"] or not network["GlobalIPv6Address"]:
    raise RuntimeError("dual-stack native control lane unavailable")
cfg.update(server_id=a.server_id,endpoint4=network["IPAddress"],
           endpoint6=network["GlobalIPv6Address"])
path.write_text(json.dumps(cfg,indent=2)+"\n")
(root/"evidence/server-running.json").write_text(json.dumps(server,indent=2)+"\n")
print("Bound configuration to observed owned dual-stack fixture.")
