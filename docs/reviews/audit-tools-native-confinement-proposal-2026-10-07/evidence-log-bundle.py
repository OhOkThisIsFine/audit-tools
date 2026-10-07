#!/usr/bin/env python3
"""Bounded synthetic evidence only: local bundle -> workflow logs, zero uploaded artifacts."""
import gzip
import hashlib
import io
import json
from pathlib import Path
import stat
import tarfile

MAX_FILES=256
MAX_FILE_BYTES=1024*1024
MAX_TOTAL_BYTES=8*1024*1024
MAX_BUNDLE_BYTES=4*1024*1024

def evidence_bundle(root):
    root=Path(root)
    files=[]; total=0
    for path in sorted(root.rglob('*')):
        mode=path.lstat().st_mode
        if stat.S_ISDIR(mode): continue
        if not stat.S_ISREG(mode) or path.is_symlink(): raise RuntimeError('nonregular evidence refused')
        size=path.stat().st_size
        if size>MAX_FILE_BYTES: raise RuntimeError('evidence file exceeds bound; preserve local, no false pass')
        total+=size; files.append(path)
    if len(files)>MAX_FILES or total>MAX_TOTAL_BYTES: raise RuntimeError('evidence total exceeds bound')
    raw=io.BytesIO(); actual_total=0
    with tarfile.open(fileobj=raw,mode='w') as archive:
        for path in files:
            data=path.read_bytes()
            actual_total+=len(data)
            if len(data)>MAX_FILE_BYTES or actual_total>MAX_TOTAL_BYTES:
                raise RuntimeError('evidence grew beyond bound')
            member=tarfile.TarInfo(path.relative_to(root).as_posix());member.size=len(data);member.mode=0o600
            archive.addfile(member,io.BytesIO(data))
    payload=gzip.compress(raw.getvalue(),mtime=0)
    if len(payload)>MAX_BUNDLE_BYTES: raise RuntimeError('compressed evidence exceeds bound')
    return payload,{'kind':'synthetic_preliminary_native_evidence_not_R05_R6_P0_acceptance',
                    'files':len(files),'input_bytes':actual_total,'bundle_bytes':len(payload),
                    'sha256':hashlib.sha256(payload).hexdigest(),'uploaded_artifact_bytes':0}

if __name__=='__main__':
    import argparse,base64
    parser=argparse.ArgumentParser();parser.add_argument('--evidence',required=True);args=parser.parse_args()
    payload,record=evidence_bundle(args.evidence)
    print('R05_EVIDENCE_BEGIN '+json.dumps(record,sort_keys=True))
    encoded=base64.b64encode(payload).decode('ascii')
    for offset in range(0,len(encoded),3072): print('R05_EVIDENCE_DATA '+encoded[offset:offset+3072])
    print('R05_EVIDENCE_END '+record['sha256'])
