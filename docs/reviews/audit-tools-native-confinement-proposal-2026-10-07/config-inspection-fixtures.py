#!/usr/bin/env python3
"""Independent synthetic Docker-inspection fixtures; no daemon or subprocess calls."""
import ast
import copy
import json
from pathlib import Path
import runpy
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parent
SCOPE=runpy.run_path(str(ROOT/'r05-launcher.py'),run_name='inspection_fixture_import')
CHECK=SCOPE['validate_created_config']
PROFILE=json.loads((ROOT/'r05-seccomp.json').read_text())
CFG={'uid':1001,'gid':1001}
# Deliberately authored inspection data, independent of launcher.build().
MOUNTS=[('/owned/workspace','/work',False),('/owned/harness','/harness',True),
        ('/owned/runtime/node','/tools',True),('/owned/harness/empty-shm','/dev/shm',True),
        ('/owned/harness/passwd','/etc/passwd',True),('/owned/harness/group','/etc/group',True)]
BASE={'Config':{'User':'1001:1001'},'Mounts':[
    {'Type':'bind','Source':src,'Destination':dst,'RW':not ro,'Propagation':'rprivate'}
    for src,dst,ro in MOUNTS], 'HostConfig':{
    'NetworkMode':'none','ReadonlyRootfs':True,'Privileged':False,'CapAdd':None,
    'CapDrop':['ALL'],'IpcMode':'private','CgroupnsMode':'private','PidMode':'',
    'Devices':[],'PortBindings':{},
    'SecurityOpt':['no-new-privileges=true','seccomp='+json.dumps(PROFILE,separators=(',',':'))],
    'Mounts':[{'Type':'bind','Source':src,'Target':dst,'ReadOnly':ro,
               'BindOptions':{'Propagation':'rprivate','NonRecursive':True}}
              for src,dst,ro in MOUNTS]}}

class InspectionFixtures(unittest.TestCase):
    def check(self,spec):
        # Any accidental process path causes the pure fixture to fail immediately.
        with patch('subprocess.run',side_effect=AssertionError('no process execution')):
            CHECK(spec,CFG,MOUNTS,'none',PROFILE)

    def reject(self,mutate):
        spec=copy.deepcopy(BASE)
        mutate(spec)
        with self.assertRaises(RuntimeError):
            self.check(spec)

    def test_reviewed_configuration_and_equivalent_json_format(self):
        self.check(copy.deepcopy(BASE))
        spec=copy.deepcopy(BASE)
        spec['HostConfig']['SecurityOpt'].reverse()
        spec['HostConfig']['SecurityOpt'][0]='seccomp='+json.dumps(PROFILE,indent=4,sort_keys=True)
        self.check(spec)

    def test_weak_missing_duplicate_and_extra_security_options(self):
        good=BASE['HostConfig']['SecurityOpt']
        variants=[['no-new-privileges=false',good[1]],['no-new-privileges',good[1]],
                  ['x-no-new-privileges=true',good[1]],[good[0]],[],None,
                  good+[good[0]],good+['apparmor=unconfined'],
                  [good[0],good[1], 'seccomp=unconfined'],[good[0],17]]
        for value in variants:
            with self.subTest(options=value if value is None else str(value)[:70]):
                self.reject(lambda s:s['HostConfig'].__setitem__('SecurityOpt',value))

    def test_unconfined_builtin_path_malformed_and_drifted_profile(self):
        changed=copy.deepcopy(PROFILE)
        changed['defaultAction']='SCMP_ACT_ALLOW'
        added=copy.deepcopy(PROFILE)
        added['syscalls'].append({'names':['socket'],'action':'SCMP_ACT_ALLOW'})
        typed=copy.deepcopy(PROFILE)
        typed['syscalls'][-1]['args'][0]['value']=True
        variants=['unconfined','builtin','/owned/harness/r05-seccomp.json','{',
                  '{}',json.dumps(changed),json.dumps(added),json.dumps(typed),
                  json.dumps(PROFILE).replace('{','{"defaultAction":"SCMP_ACT_ALLOW",',1)]
        for value in variants:
            with self.subTest(profile=value[:70]):
                self.reject(lambda s:s['HostConfig']['SecurityOpt'].__setitem__(1,'seccomp='+value))

    def test_observed_bind_propagation_readonly_type_source_and_duplicates(self):
        for field,value in [('Propagation','shared'),('Propagation','rslave'),('Propagation',''),
                            ('RW',True),('RW',1),('Type','volume'),('Source','/host/home')]:
            with self.subTest(field=field,value=value):
                self.reject(lambda s:s['Mounts'][1].__setitem__(field,value))
        self.reject(lambda s:s['Mounts'][1].pop('Propagation'))
        self.reject(lambda s:s['Mounts'].append(copy.deepcopy(s['Mounts'][1])))
        self.reject(lambda s:s['Mounts'].__setitem__(0,copy.deepcopy(s['Mounts'][1])))
        self.reject(lambda s:s.pop('Mounts'))

    def test_declared_nonrecursive_and_propagation_settings(self):
        for field,value in [('Propagation','rshared'),('Propagation','private'),
                            ('NonRecursive',False),('NonRecursive',1),
                            ('CreateMountpoint',True),('ReadOnlyNonRecursive',True),
                            ('ReadOnlyForceRecursive',True)]:
            with self.subTest(field=field,value=value):
                self.reject(lambda s:s['HostConfig']['Mounts'][0]['BindOptions'].__setitem__(field,value))
        for field in ('Propagation','NonRecursive'):
            with self.subTest(missing=field):
                self.reject(lambda s:s['HostConfig']['Mounts'][0]['BindOptions'].pop(field))
        self.reject(lambda s:s['HostConfig']['Mounts'][0].pop('BindOptions'))
        self.reject(lambda s:s['HostConfig'].pop('Mounts'))

    def test_declared_mount_identity_readonly_type_and_duplicates(self):
        for field,value in [('ReadOnly',False),('ReadOnly',1),('Type','volume'),
                            ('Source','/var/run/docker.sock'),('Target','/host-home'),
                            ('VolumeOptions',{'DriverConfig':{'Name':'local'}})]:
            with self.subTest(field=field,value=value):
                self.reject(lambda s:s['HostConfig']['Mounts'][1].__setitem__(field,value))
        self.reject(lambda s:s['HostConfig']['Mounts'].append(copy.deepcopy(s['HostConfig']['Mounts'][0])))
        self.reject(lambda s:s['HostConfig']['Mounts'].__setitem__(0,copy.deepcopy(s['HostConfig']['Mounts'][1])))

    def test_existing_network_user_rootfs_and_capability_guards(self):
        for field,value in [('NetworkMode','host'),('Privileged',True),('ReadonlyRootfs',False),
                            ('CapAdd',['SYS_ADMIN']),('CapDrop',[]),('IpcMode','host'),
                            ('CgroupnsMode','host'),('PidMode','host'),
                            ('Devices',[{'PathOnHost':'/dev/sda'}]),
                            ('PortBindings',{'80/tcp':[{'HostPort':'80'}]})]:
            with self.subTest(field=field):
                self.reject(lambda s:s['HostConfig'].__setitem__(field,value))
        self.reject(lambda s:s['Config'].__setitem__('User','0:0'))

    def test_actual_gate_precedes_both_start_paths(self):
        tree=ast.parse((ROOT/'r05-launcher.py').read_text())
        execute=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='execute')
        calls=[n for n in ast.walk(execute) if isinstance(n,ast.Call)]
        gates=[n.lineno for n in calls if isinstance(n.func,ast.Name) and n.func.id=='validate_created_config']
        self.assertEqual(len(gates),1)
        starts=[n.lineno for n in calls if isinstance(n.func,ast.Name) and n.func.id=='docker'
                and n.args and isinstance(n.args[0],ast.Constant) and n.args[0].value=='start']
        starts += [n.lineno for n in calls if isinstance(n.func,ast.Attribute) and n.func.attr=='run'
                   and n.args and isinstance(n.args[0],ast.List)
                   and any(isinstance(v,ast.Constant) and v.value=='start' for v in n.args[0].elts)]
        self.assertEqual(len(starts),2)
        self.assertTrue(all(gates[0]<line for line in starts))

if __name__=='__main__':
    unittest.main()
