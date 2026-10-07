#!/usr/bin/env python3
"""Pure timeout-transport fixtures; never execute Docker or native/product code."""
import hashlib
import json
from pathlib import Path
import runpy
import subprocess
import tempfile
import unittest

module=runpy.run_path(str(Path(__file__).with_name("r05-launcher.py")),run_name="fixture_import")
capture=module["preserve_timeout_output"]

class CaptureFixtures(unittest.TestCase):
    def capture_case(self, stdout, stderr):
        with tempfile.TemporaryDirectory(prefix="r05-timeout-capture-") as directory:
            root=Path(directory)
            error=subprocess.TimeoutExpired(["source-fixture-only"],60,output=stdout,stderr=stderr)
            record=capture(root,"probe","a"*64,error)
            stored=json.loads((root/"probe-timeout.json").read_text())
            self.assertEqual(stored,record)
            self.assertTrue(record["timed_out"])
            self.assertEqual(record["cleanup"],"not_yet_observed")
            for name,value in (("stdout",stdout),("stderr",stderr)):
                expected=value if isinstance(value,bytes) else (value or "").encode("utf-8")
                self.assertEqual((root/("probe."+name)).read_bytes(),expected)
                self.assertEqual(record[name+"_capture_available"],value is not None)
                self.assertEqual(record[name+"_bytes"],len(expected))
                self.assertEqual(record[name+"_sha256"],hashlib.sha256(expected).hexdigest())

    def test_timeout_preserves_non_utf8_and_nul_bytes(self):
        self.capture_case(b"partial\x00stdout\xff",b"\xfeerror-before-timeout")

    def test_timeout_preserves_text_with_utf8_encoding(self):
        self.capture_case("partial stdout \u03bb","partial stderr \u00e9")

    def test_absent_transport_is_not_claimed_as_captured(self):
        self.capture_case(None,None)

    def test_empty_captured_transport_remains_distinct_from_absence(self):
        self.capture_case(b"",None)

    def test_cleanup_failure_does_not_erase_preceding_capture(self):
        with tempfile.TemporaryDirectory(prefix="r05-timeout-capture-") as directory:
            root=Path(directory)
            error=subprocess.TimeoutExpired(["source-fixture-only"],60,
                output=b"proof before cleanup",stderr=b"diagnostic before cleanup")
            try:
                capture(root,"probe","b"*64,error)
                raise RuntimeError("synthetic later ownership-query failure")
            except RuntimeError:
                pass
            self.assertEqual((root/"probe.stdout").read_bytes(),b"proof before cleanup")
            self.assertEqual((root/"probe.stderr").read_bytes(),b"diagnostic before cleanup")
            self.assertEqual(json.loads((root/"probe-timeout.json").read_text())["cleanup"],
                             "not_yet_observed")

if __name__=="__main__":
    unittest.main()