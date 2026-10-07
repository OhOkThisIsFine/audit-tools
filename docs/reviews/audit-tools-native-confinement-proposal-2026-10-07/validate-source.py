import ast, hashlib, json, pathlib, runpy
root=pathlib.Path(__file__).resolve().parent
for name in ("r05-launcher.py","prepare-owned-layout.py","bind-owned-fixture.py"):
    ast.parse((root/name).read_text())
scope=runpy.run_path(str(root/"r05-launcher.py"),run_name="source_review_only")
upstream=json.loads((root/"docker-28.0.4-default-seccomp.json").read_text())
profile=json.loads((root/"r05-seccomp.json").read_text())
assert profile==scope["derivative"](upstream)
assert profile["defaultAction"]=="SCMP_ACT_ERRNO"
sockets=[r for r in profile["syscalls"] if "socket" in r["names"] and r["action"]=="SCMP_ACT_ALLOW"]
assert {r["args"][0]["value"] for r in sockets}=={1,2,10}
assert not any("socketcall" in r["names"] and r["action"]=="SCMP_ACT_ALLOW" for r in profile["syscalls"])
cfg={"task_root":"/home/runner/work/_temp/r05-owned-example",
     "task_id":"11111111-1111-4111-8111-111111111111",
     "uid":1001,"gid":1001,"token":"0"*32,"endpoint4":"172.28.0.2",
     "endpoint6":"fd00:1::2","server_id":"0"*64}
rendered={}
for role in ("compiler","server","control","probe"):
    argv,mounts,network=scope["build"](cfg,role)
    assert "--read-only" in argv and "--cap-drop=ALL" in argv and "--pull=never" in argv
    assert "--privileged" not in argv and not any("docker.sock" in src for src,_,_ in mounts)
    assert [dst for _,dst,ro in mounts if not ro]==["/work"]
    assert network==("none" if role in ("compiler","probe") else "r05-fixture-"+cfg["task_id"])
    assert sum(dst=="/host-secret" for _,dst,_ in mounts)==(1 if role=="control" else 0)
    assert not any("NODE_NO_WARNINGS" in arg or "GITHUB_TOKEN" in arg for arg in argv)
    rendered[role]={"example_argv":argv,"not_runtime_evidence":True}
try:
    scope["build"]({**cfg,"uid":0},"probe")
    raise AssertionError("root identity accepted")
except RuntimeError:
    pass
print("Source validation PASS: Python AST, unchanged base policy plus socket tightening, four bounded launch roles, root identity refusal. No Docker/native/product execution.")