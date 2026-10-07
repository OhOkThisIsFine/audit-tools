#!/usr/bin/env python3
"""Review-only Docker launcher. Default renders argv; --execute is separate.
No arbitrary Docker flags/product command are accepted in this bounded packet.
"""
import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import stat
import subprocess
import tarfile
import uuid

IMAGE = "docker.io/library/node@sha256:c4d5523090a817b7aa86d2111241fdd4f66d1e27782b44160e6aa63b357ecb2d"
ARCHIVE_SHA = "df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de"
UPSTREAM_SHA = "9c1025c88ccaa517b648da571961838744ea2137f176bfe6a48b21294cae9c76"
PROFILE_SHA = "fca8efb7120a8a8eb6c0a1c1efce139f0c6f663c77dcad7bb0e5d1e264b16bb2"
NODE_ROOT = "node-v22.23.3-linux-x64"
DOCKER = "/usr/bin/docker"

def sha(path):
    with open(path, "rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()

def require(ok, message):
    if not ok:
        raise RuntimeError(message)

def derivative(profile):
    result = json.loads(json.dumps(profile))
    rules = []
    for rule in result["syscalls"]:
        rule["names"] = [n for n in rule["names"] if n not in ("socket", "socketpair", "socketcall")]
        if rule["names"]:
            rules.append(rule)
    for family in (1, 2, 10):
        rules.append({"names":["socket"],"action":"SCMP_ACT_ALLOW",
                      "args":[{"index":0,"value":family,"op":"SCMP_CMP_EQ"}]})
    rules.append({"names":["socketpair"],"action":"SCMP_ACT_ALLOW",
                  "args":[{"index":0,"value":1,"op":"SCMP_CMP_EQ"}]})
    result["syscalls"] = rules
    return result

def build(cfg, role):
    root = PurePosixPath(cfg["task_root"])
    require(root.is_absolute() and ".." not in root.parts and "," not in str(root),
            "task root must be an absolute Linux path without parent/comma syntax")
    task_id = str(uuid.UUID(cfg["task_id"]))
    require(cfg["uid"] > 0 and cfg["gid"] > 0, "root identity forbidden")
    workspace, harness = str(root/"workspace"), str(root/"harness")
    tools = str(root/"runtime"/NODE_ROOT)
    mounts = [
        (workspace,"/work",False),
        (harness,"/harness",True),
        (tools,"/tools",True),
        (harness+"/empty-shm","/dev/shm",True),
        (harness+"/passwd","/etc/passwd",True),
        (harness+"/group","/etc/group",True),
    ]
    network = "none"
    if role in ("server","control"):
        network = "r05-fixture-"+task_id
    if role == "control":
        mounts.append((str(root/"host-canary"),"/host-secret",True))
    env = {
        "PATH":"/tools/bin:/usr/bin:/bin",
        "HOME":"/work/home/profile","USERPROFILE":"/work/home/profile",
        "TEMP":"/work/home/profile/temp","TMP":"/work/home/profile/temp",
        "TMPDIR":"/work/home/profile/temp",
        "GIT_CONFIG_NOSYSTEM":"1","GIT_CONFIG_GLOBAL":"/work/home/profile/gitconfig",
        "npm_config_userconfig":"/work/home/profile/user.npmrc",
        "npm_config_globalconfig":"/work/home/profile/global.npmrc",
        "npm_config_cache":"/work/home/profile/npm-cache",
        "npm_config_prefix":"/work/home/profile/npm-prefix",
        "npm_config_ignore_scripts":"true","npm_config_audit":"false",
        "npm_config_fund":"false","npm_config_update_notifier":"false",
        "AUDIT_CODE_STATE_DIR":"/work/home/profile/state",
        "AUDIT_TOOLS_ANALYZER_CACHE":"/work/home/profile/analyzers",
        "AUDIT_TOOLS_BINARY_CACHE":"/work/home/profile/binaries",
        "AGENT_DISPATCH_REPO":"/work/home/profile/absent-agent-dispatch",
        "VITEST_MAX_FORKS":"4","R05_ROLE":role,"R05_TASK_ID":task_id,
        "R05_HOST_CANARY_PATH":str(root/"host-canary"/"credential-canary.txt"),
    }
    # Server is a controlled echo fixture; only it intentionally opens listeners.
    if role != "server":
        env["NODE_OPTIONS"] = " ".join([
            "--permission","--allow-fs-read=/work","--allow-fs-read=/harness",
            "--allow-fs-read=/tools","--allow-fs-read=/usr","--allow-fs-read=/bin",
            "--allow-fs-read=/etc/passwd","--allow-fs-read=/etc/group",
            "--allow-fs-read=/proc/self/status","--allow-fs-write=/work",
            "--allow-child-process","--allow-worker","--allow-addons",
            "--disable-warning=SecurityWarning",
        ])
    if role in ("probe","control"):
        require(re.fullmatch(r"[0-9a-f]{32}",cfg["token"]), "invalid synthetic token")
        for key, version in (("endpoint4",4),("endpoint6",6)):
            require(ipaddress.ip_address(cfg[key]).version == version, "wrong endpoint family")
        env.update(R05_ENDPOINT4=cfg["endpoint4"],R05_ENDPOINT6=cfg["endpoint6"],
                   R05_TOKEN=cfg["token"])
    args = [DOCKER,"--host=unix:///var/run/docker.sock","create",
            "--name=r05-"+task_id+"-"+role,"--label=r05.task="+task_id,
            "--label=r05.role="+role,"--platform=linux/amd64","--pull=never",
            "--read-only","--network="+network,"--ipc=private","--cgroupns=private",
            "--cap-drop=ALL","--security-opt=no-new-privileges=true",
            "--security-opt=seccomp="+harness+"/r05-seccomp.json",
            "--user="+str(cfg["uid"])+":"+str(cfg["gid"]),
            "--pids-limit=512","--memory=12g","--cpus=4",
            "--workdir=/work/repo","--entrypoint=/usr/bin/env"]
    for source,dest,readonly in mounts:
        value = "type=bind,src="+source+",dst="+dest+",bind-propagation=rprivate,bind-recursive=disabled"
        if readonly:
            value += ",readonly"
        args += ["--mount",value]
    # env -i strips image default variables too. Never inherit a host env file.
    command = ["/usr/bin/env","-i"]+[k+"="+v for k,v in sorted(env.items())]
    if role == "compiler":
        command += ["/usr/bin/gcc","-std=c11","-O2","-Wall","-Wextra","-Werror",
                    "/harness/native-probe.c","-o","/work/probe/native-probe"]
    elif role == "server":
        command += ["/tools/bin/node","/harness/fixture-server.mjs"]
    else:
        command += ["/tools/bin/node","/harness/probe.mjs"]
    # --entrypoint /usr/bin/env receives -i directly.
    return args+[IMAGE]+command[1:], mounts, network

def execute(cfg, role, args, mounts, network):
    require(platform.system()=="Linux" and platform.machine()=="x86_64", "Linux x64 only")
    require(os.getuid()==cfg["uid"] and os.getgid()==cfg["gid"], "observed UID/GID mismatch")
    root = Path(cfg["task_root"])
    approved_temp = Path(os.environ["RUNNER_TEMP"]).resolve(strict=True)
    require(root.is_relative_to(approved_temp) and root != approved_temp, "outside owned runner temp")
    require(root.resolve(strict=True)==root, "task root alias refused")
    marker = json.loads((root/"owned-task.json").read_text())
    require(marker=={"task_id":cfg["task_id"]}, "owned-task marker mismatch")
    for source,_,_ in mounts:
        require(Path(source).resolve(strict=True)==Path(source), "bind root alias refused")
    for top in (root/"workspace",root/"harness",root/"runtime"):
        for folder, dirs, names in os.walk(top,followlinks=False):
            for name in dirs+names:
                mode = os.lstat(Path(folder)/name).st_mode
                require(not (stat.S_ISSOCK(mode) or stat.S_ISCHR(mode) or stat.S_ISBLK(mode)),
                        "host IPC/device object inside grant")
    archive = root/"runtime"/(NODE_ROOT+".tar.xz")
    require(sha(archive)==ARCHIVE_SHA, "official Node archive hash mismatch")
    with tarfile.open(archive,"r:xz") as tar:
        for relative in ("bin/node","lib/node_modules/npm/bin/npm-cli.js"):
            member=tar.extractfile(NODE_ROOT+"/"+relative)
            require(member is not None, "tool archive member absent")
            require(hashlib.file_digest(member,"sha256").hexdigest()==sha(root/"runtime"/NODE_ROOT/relative),
                    "extracted tool bytes mismatch")
    source_manifest=json.loads((root/"source-manifest.json").read_text())
    for name in ("native-probe.c","fixture-server.mjs","probe.mjs"):
        require(sha(root/"harness"/name)==source_manifest["sha256"][name],
                "reviewed probe source drift")
    upstream = root/"harness"/"docker-28.0.4-default-seccomp.json"
    profile = root/"harness"/"r05-seccomp.json"
    require(sha(upstream)==UPSTREAM_SHA and sha(profile)==PROFILE_SHA, "policy byte mismatch")
    require(json.loads(profile.read_text())==derivative(json.loads(upstream.read_text())),
            "seccomp derivative has other changes")
    home=root/"workspace/home/profile"
    require(not os.path.lexists(home/"absent-agent-dispatch"), "dispatch path must be absent")
    require((root/"harness/empty-shm").is_dir() and not any((root/"harness/empty-shm").iterdir()),
            "empty read-only shared-memory mount required")
    for name in ("user.npmrc","global.npmrc","gitconfig"):
        require((home/name).is_file() and (home/name).stat().st_size==0, "non-empty inherited config")
    expected_passwd="root:x:0:0:root:/root:/bin/false\nr05:x:"+str(cfg["uid"])+":"+str(cfg["gid"])+":R05:/work/home/profile:/bin/bash\n"
    expected_group="root:x:0:\nr05:x:"+str(cfg["gid"])+":\n"
    require((root/"harness/passwd").read_text()==expected_passwd, "profile identity mismatch")
    require((root/"harness/group").read_text()==expected_group, "group identity mismatch")
    evidence=root/"evidence"; evidence.mkdir(exist_ok=True)
    require(not (evidence/(role+"-created.json")).exists(), "role already launched; use fresh owned task")
    client_env={"PATH":"/usr/bin:/bin","HOME":str(root/"client-home"),"DOCKER_CONFIG":str(root/"docker-config")}
    def docker(*values, timeout=15):
        return subprocess.run([DOCKER,"--host=unix:///var/run/docker.sock",*values],
                              env=client_env,stdin=subprocess.DEVNULL,capture_output=True,
                              text=True,timeout=timeout,check=True).stdout
    version=json.loads(docker("version","--format","{{json .}}"))
    require(version["Server"]["Os"]=="linux" and version["Server"]["Arch"]=="amd64",
            "unsupported daemon platform")
    require(version["Server"]["Version"]=="28.0.4", "different daemon needs bounded source comparison")
    image=json.loads(docker("image","inspect",IMAGE))[0]
    require(image["Architecture"]=="amd64" and image["Os"]=="linux" and not image["Config"].get("Volumes"),
            "unexpected image platform/anonymous volumes")
    (evidence/"image.json").write_text(json.dumps(image,indent=2)+"\n")
    if network!="none":
        n=json.loads(docker("network","inspect",network))[0]
        require(n["Internal"] and n["Driver"]=="bridge" and
                n["Labels"].get("r05.task")==cfg["task_id"], "network not owned/internal")
    if role in ("control","probe"):
        require(re.fullmatch(r"[0-9a-f]{64}",cfg["server_id"]), "fixture CID required")
        server=json.loads(docker("inspect",cfg["server_id"]))[0]
        require(server["Config"]["Labels"].get("r05.task")==cfg["task_id"] and
                server["Config"]["Labels"].get("r05.role")=="server" and server["State"]["Running"],
                "owned running fixture missing")
        net_config=server["NetworkSettings"]["Networks"]["r05-fixture-"+cfg["task_id"]]
        require(cfg["endpoint4"]==net_config["IPAddress"] and
                cfg["endpoint6"]==net_config["GlobalIPv6Address"], "fixture endpoint mismatch")
        require("R05_FIXTURE_READY" in docker("logs",cfg["server_id"]), "fixture not ready")
    if role=="probe":
        controls=json.loads((root/"workspace/probe/control-results.json").read_text())
        require(controls["role"]=="control" and controls["passed"] and len(controls["outcomes"])>=7 and
                controls["taskId"]==cfg["task_id"] and controls["endpoint4"]==cfg["endpoint4"] and
                controls["endpoint6"]==cfg["endpoint6"] and controls["token"]==cfg["token"],
                "matching real positive controls required; not an attestation")
        control_spec=json.loads((evidence/"control-created.json").read_text())
        current_control=json.loads(docker("inspect",control_spec["Id"]))[0]
        require(current_control["Config"]["Labels"].get("r05.task")==cfg["task_id"] and
                current_control["Config"]["Labels"].get("r05.role")=="control" and
                not current_control["State"]["Running"] and current_control["State"]["ExitCode"]==0,
                "positive control terminal identity/outcome missing")
        control_exit=json.loads((evidence/"control-exit.json").read_text())
        require(control_exit["cli_exit"]==0 and control_exit["container_exit"]==0 and
                not control_exit["running"], "positive control terminal transport failed")
    created=subprocess.run(args,env=client_env,stdin=subprocess.DEVNULL,capture_output=True,
                           text=True,timeout=15,check=True).stdout.strip()
    require(re.fullmatch(r"[0-9a-f]{64}",created), "invalid created container id")
    spec=json.loads(docker("inspect",created))[0]
    (evidence/(role+"-created.json")).write_text(json.dumps(spec,indent=2)+"\n")
    host=spec["HostConfig"]
    actual_mounts={(m["Source"],m["Destination"],not m["RW"]) for m in spec["Mounts"]}
    require(actual_mounts==set(mounts), "unexpected host mount")
    require(host["NetworkMode"]==network and host["ReadonlyRootfs"] and
            not host["Privileged"] and not host.get("CapAdd") and
            set(host["CapDrop"])=={"ALL"} and host["IpcMode"]=="private" and
            host["CgroupnsMode"]=="private" and not host.get("PidMode") and
            not host.get("Devices") and not host.get("PortBindings"),
            "created container grant mismatch; preserve stopped container")
    require(spec["Config"]["User"]==str(cfg["uid"])+":"+str(cfg["gid"]), "container user mismatch")
    require(any("no-new-privileges" in v for v in host["SecurityOpt"]) and
            any(v.startswith("seccomp=") for v in host["SecurityOpt"]), "security settings absent")
    if role=="server":
        docker("start",created)
        print(json.dumps({"role":role,"container_id":created,"qualification":False}))
        return
    exitcode=None
    try:
        result=subprocess.run([DOCKER,"--host=unix:///var/run/docker.sock","start","--attach",created],
                              env=client_env,stdin=subprocess.DEVNULL,capture_output=True,
                              text=True,timeout=60)
        (evidence/(role+".stdout")).write_text(result.stdout)
        (evidence/(role+".stderr")).write_text(result.stderr)
        exitcode=result.returncode
        if role in ("control","probe"):
            require("R05_ORDINARY_WARNING_SENTINEL" in result.stderr, "ordinary warning hidden")
        require(exitcode==0, "qualification process failed; product remains blocked")
    except subprocess.TimeoutExpired as error:
        # Never target names/PIDs or other containers: immutable created CID + label.
        current=json.loads(docker("inspect",created))[0]
        require(current["Config"]["Labels"].get("r05.task")==cfg["task_id"],
                "cleanup ownership uncertain")
        if current["State"]["Running"]:
            docker("kill",created)
        (evidence/(role+"-timeout.json")).write_text(json.dumps({"timed_out":True,"container_id":created})+"\n")
        raise RuntimeError("owned qualification watchdog fired; preserve evidence") from error
    finally:
        terminal=json.loads(docker("inspect",created))[0]
        (evidence/(role+"-terminal.json")).write_text(json.dumps(terminal,indent=2)+"\n")
        (evidence/(role+"-exit.json")).write_text(json.dumps({"cli_exit":exitcode,
            "container_exit":terminal["State"]["ExitCode"],"running":terminal["State"]["Running"]})+"\n")
    require(not terminal["State"]["Running"] and terminal["State"]["ExitCode"]==0,
            "terminal container outcome mismatch")
    print(json.dumps({"role":role,"container_id":created,"native_canaries_completed":True,
                      "full_R05_R6_P0_acceptance":False}))

if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--config",required=True)
    parser.add_argument("--role",choices=("compiler","server","control","probe"),required=True)
    parser.add_argument("--execute",action="store_true")
    options=parser.parse_args()
    cfg=json.loads(Path(options.config).read_text())
    args,mounts,network=build(cfg,options.role)
    if options.execute:
        execute(cfg,options.role,args,mounts,network)
    else:
        print(json.dumps({"argv":args,"host_mounts":mounts,
                          "network":network,"executed":False},indent=2))
