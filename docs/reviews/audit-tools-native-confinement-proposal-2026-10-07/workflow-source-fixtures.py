#!/usr/bin/env python3
"""Pure orchestration fixtures, using fake inspect transports and isolated scratch state."""
import copy
import io
import json
from pathlib import Path
import runpy
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parent
CLEAN=runpy.run_path(str(ROOT/'owned-teardown.py'),run_name='fixture_cleanup_import')
BUNDLE=runpy.run_path(str(ROOT/'evidence-log-bundle.py'),run_name='fixture_bundle_import')
BOOT=runpy.run_path(str(ROOT/'synthetic-bootstrap.py'),run_name='fixture_bootstrap_import')
TASK='11111111-1111-4111-8111-111111111111'
CID='a'*64;NID='b'*64
CONTAINER={'Id':CID,'Name':'/r05-'+TASK+'-server',
           'Config':{'Labels':{'r05.task':TASK,'r05.role':'server'}},
           'State':{'Running':True,'ExitCode':0}}
NETWORK={'Id':NID,'Name':'r05-fixture-'+TASK,'Labels':{'r05.task':TASK},
         'Driver':'bridge','Internal':True,'EnableIPv6':True,'Containers':{}}

class FakeDocker:
    def __init__(self):
        self.container=copy.deepcopy(CONTAINER);self.network=copy.deepcopy(NETWORK)
        self.calls=[];self.container_present=True;self.network_present=True
    def __call__(self,*args):
        self.calls.append(args)
        if args[0]=='ps':return CID if self.container_present else ''
        if args[:2]==('network','ls'):return NID if self.network_present else ''
        if args[0]=='inspect':return json.dumps([self.container])
        if args[:2]==('network','inspect'):return json.dumps([self.network])
        if args==('stop','--time','5',CID):self.container['State']['Running']=False;return CID
        if args==('rm',CID):self.container_present=False;return CID
        if args==('network','rm',NID):self.network_present=False;return NID
        raise AssertionError('unexpected fake Docker call '+str(args))

class OrchestrationFixtures(unittest.TestCase):
    def run_cleanup(self,fake):
        with tempfile.TemporaryDirectory(prefix='r05-pure-cleanup-') as directory:
            root=Path(directory);(root/'evidence').mkdir()
            with patch('subprocess.run',side_effect=AssertionError('no subprocess execution')):
                return CLEAN['teardown'](root,{'task_id':TASK},fake)

    def test_owned_server_is_terminal_before_exact_ID_removal(self):
        fake=FakeDocker();result=self.run_cleanup(fake)
        self.assertTrue(result['complete'])
        self.assertFalse(fake.container_present);self.assertFalse(fake.network_present)
        self.assertLess(fake.calls.index(('stop','--time','5',CID)),fake.calls.index(('rm',CID)))
        self.assertTrue(all('prune' not in call and '--force' not in call for call in fake.calls))

    def test_foreign_or_weakened_objects_are_not_mutated(self):
        variants=[('container','Id','c'*64),('container','Name','/other'),
                  ('network','Name','other-network'),('network','Internal',False),
                  ('network','EnableIPv6',False),('network','Driver','host')]
        for kind,key,value in variants:
            with self.subTest(kind=kind,key=key):
                fake=FakeDocker();getattr(fake,kind)[key]=value
                with self.assertRaises(RuntimeError):self.run_cleanup(fake)
                self.assertFalse(any(call[0] in ('stop','rm') or call[:2]==('network','rm') for call in fake.calls))
        fake=FakeDocker();fake.container['Config']['Labels']['r05.task']='foreign'
        with self.assertRaises(RuntimeError):self.run_cleanup(fake)
        self.assertTrue(fake.container_present)

    def test_terminal_failure_preserves_objects(self):
        fake=FakeDocker()
        original=fake.__call__
        def refusal(*args):
            if args==('stop','--time','5',CID):return CID  # reports success but did not stop
            return original(*args)
        with self.assertRaises(RuntimeError):self.run_cleanup(refusal)
        self.assertTrue(fake.container_present);self.assertTrue(fake.network_present)

    def test_attached_network_is_preserved(self):
        fake=FakeDocker();fake.network['Containers']={'foreign':{}}
        with self.assertRaises(RuntimeError):self.run_cleanup(fake)
        self.assertTrue(fake.network_present)
        self.assertNotIn(('network','rm',NID),fake.calls)

    def test_evidence_roundtrip_hash_and_zero_uploaded_storage(self):
        import gzip,hashlib
        with tempfile.TemporaryDirectory(prefix='r05-pure-evidence-') as directory:
            root=Path(directory);(root/'probe.stderr').write_bytes(b'partial\xff\x00transport')
            payload,record=BUNDLE['evidence_bundle'](root)
            self.assertEqual(record['sha256'],hashlib.sha256(payload).hexdigest())
            self.assertEqual(record['uploaded_artifact_bytes'],0)
            self.assertLessEqual(len(payload),BUNDLE['MAX_BUNDLE_BYTES'])
            with tarfile.open(fileobj=io.BytesIO(gzip.decompress(payload)),mode='r:') as archive:
                self.assertEqual(archive.extractfile('probe.stderr').read(),b'partial\xff\x00transport')

    def test_evidence_size_and_count_bounds_fail_closed(self):
        with tempfile.TemporaryDirectory(prefix='r05-pure-evidence-') as directory:
            root=Path(directory);(root/'large').write_bytes(b'x'*(BUNDLE['MAX_FILE_BYTES']+1))
            with self.assertRaises(RuntimeError):BUNDLE['evidence_bundle'](root)
        with tempfile.TemporaryDirectory(prefix='r05-pure-evidence-') as directory:
            root=Path(directory)
            for index in range(BUNDLE['MAX_FILES']+1):(root/str(index)).write_bytes(b'')
            with self.assertRaises(RuntimeError):BUNDLE['evidence_bundle'](root)

    def test_nonregular_evidence_is_refused(self):
        with tempfile.TemporaryDirectory(prefix='r05-pure-evidence-') as directory:
            root=Path(directory);(root/'result').write_bytes(b'synthetic')
            with patch.object(Path,'is_symlink',return_value=True):
                with self.assertRaises(RuntimeError):BUNDLE['evidence_bundle'](root)

    def test_unapproved_fetch_origin_and_redirect_are_refused(self):
        with tempfile.TemporaryDirectory(prefix='r05-pure-download-') as directory:
            with self.assertRaises(RuntimeError):
                BOOT['fetch']('https://example.com/product',Path(directory)/'file',10,'0'*64)
        with self.assertRaises(RuntimeError):BOOT['NoRedirect']().redirect_request(None,None,None,None,None,None)

    def test_fetch_size_and_hash_bounds_without_network(self):
        import hashlib
        class Opener:
            def open(self,*args,**kwargs):return io.BytesIO(b'synthetic bytes')
        with tempfile.TemporaryDirectory(prefix='r05-pure-download-') as directory:
            root=Path(directory)
            with patch('urllib.request.build_opener',return_value=Opener()):
                good=hashlib.sha256(b'synthetic bytes').hexdigest()
                BOOT['fetch']('https://nodejs.org/dist/v22.23.3/test',root/'good',100,good)
                with self.assertRaises(RuntimeError):BOOT['fetch']('https://nodejs.org/dist/v22.23.3/test',root/'size',2,good)
                with self.assertRaises(RuntimeError):BOOT['fetch']('https://nodejs.org/dist/v22.23.3/test',root/'hash',100,'0'*64)

if __name__=='__main__':unittest.main()
