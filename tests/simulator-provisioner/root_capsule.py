import ast
import json
from pathlib import Path


ROOT_BOOTSTRAP = r'''
import hashlib,json,os,stat,subprocess,sys,uuid
from pathlib import Path
def need(ok,reason="Root capsule admission failed"):
 if not ok: raise RuntimeError(reason)
def namespace(path):
 info=path.stat();detail=str(path)+' uid='+str(info.st_uid)+' mode='+oct(stat.S_IMODE(info.st_mode))
 need(path.resolve()==path and info.st_uid==0 and info.st_mode&0o022==0,'Root capsule namespace rejected: '+detail)
 query=subprocess.run(['/bin/ls','-lde',str(path)],env={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','HOME':'/var/root','LANG':'C','LC_ALL':'C'},stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=5,check=False)
 entries=query.stdout.decode(errors='replace').splitlines()[1:]
 need(query.returncode==0 and len(query.stdout)<=16384 and all(' deny ' in line and ' allow ' not in line and line.lstrip()[:1].isdigit() for line in entries),'Root capsule namespace ACL rejected: '+detail+' acl='+repr(entries)[:2048])
def read(path,limit=67108864):
 path=Path(path)
 need(path.is_absolute() and path.resolve()==path)
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  info=os.fstat(fd);need(stat.S_ISREG(info.st_mode) and 0<info.st_size<=limit)
  with os.fdopen(os.dup(fd),'rb') as f: data=f.read(limit+1)
  need(0<len(data)<=limit);return data
 finally: os.close(fd)
def sha(raw): return hashlib.sha256(raw).hexdigest()
def store(path,raw):
 path.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb') as f:
  f.write(raw);f.flush();os.fchmod(f.fileno(),0o400);os.fsync(f.fileno())
need(os.geteuid()==0 and len(sys.argv)==10)
source,context_path,context_sha,manifest_sha,folder,owner,run,seconds= sys.argv[1:9]
caller=sys.argv[9]
need(caller.isdecimal() and int(caller)>0 and os.environ.get('SUDO_UID')==caller)
source=Path(source);need(source.is_absolute() and source.resolve()==source)
raw=read(context_path,65536);need(sha(raw)==context_sha)
context=json.loads(raw);need(context['version']==2 and context['runID']==run)
nonce=context['launchNonce'];need(str(uuid.UUID(nonce)).upper()==nonce and uuid.UUID(nonce).version==4)
artifacts={}
for name in ('sourceManifest','launchPlan','reviewedAuthority'):
 ref=context[name];need(set(ref)=={'file','sha256'} and Path(ref['file']).name==ref['file'])
 data=read(Path(context_path).parent/ref['file'],1048576);need(sha(data)==ref['sha256']);artifacts[name]=data
need(sha(artifacts['sourceManifest'])==manifest_sha)
manifest=json.loads(artifacts['sourceManifest']);need(manifest['runID']==run and manifest['launchNonce']==nonce)
required={'provision.py','lease.py','global_pf.py','launch_provenance.py','root_capsule.py','vsock_control.py','status.py','netprobe.py','job.py','drive.py','controller.ts','vsock-profile.json'}
need({'tests/simulator-provisioner/'+name for name in required}.issubset(manifest['files']) and 'tests/mac-enforcement/control-sockets.c' in manifest['files'])
base=Path('/private/var/run/calledit-qa-capsules')
for parent in base.parents:
 namespace(parent)
try: base.mkdir(mode=0o755);os.chmod(base,0o755)
except FileExistsError: pass
need(base.resolve()==base and base.stat().st_uid==0 and base.stat().st_mode&0o022==0)
namespace(base)
capsule=base/nonce;capsule.mkdir(mode=0o700)
total=0
for name,pin in manifest['files'].items():
 relative=Path(name);need(not relative.is_absolute() and '..' not in relative.parts and str(relative)==name)
 data=read(source/relative);total+=len(data);need(total<=134217728 and sha(data)==pin)
 store(capsule/relative,data)
for name,pin in manifest['files'].items(): need(sha(read(source/name))==pin and sha(read(capsule/name))==pin)
authority=capsule/'root-authority';private_context=authority/Path(context_path).name
store(private_context,raw)
for name,data in artifacts.items(): store(authority/context[name]['file'],data)
info={'version':1,'sourceRoot':str(source),'contextSHA256':context_sha,'sourceManifestSHA256':manifest_sha,'copiedFiles':manifest['files'],'originalContextPath':context_path,'privateContextPath':str(private_context)}
store(capsule/'capsule-info.json',json.dumps(info,sort_keys=True,separators=(',',':')).encode()+b'\n')
for path in sorted(capsule.rglob('*'),reverse=True):
 if path.is_dir(): os.chmod(path,0o500)
os.chmod(capsule,0o500)
os.environ.clear();os.environ.update({'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','HOME':'/var/root','LANG':'en_US.UTF-8','SUDO_UID':caller,'TMPDIR':folder+'/'})
harness=capsule/'tests/simulator-provisioner';lease=harness/'lease.py'
launcher="import runpy,sys;sys.path.insert(0,sys.argv[1]);sys.argv=sys.argv[2:];runpy.run_path(sys.argv[0],run_name='__main__')"
os.execv('/usr/bin/python3',['/usr/bin/python3','-I','-S','-c',launcher,str(harness),str(lease),'--directory',folder,'--owner-pid',owner,'--run-id',run,'--seconds',seconds,'--trusted-launch-context',str(private_context),'--trusted-launch-sha256',context_sha])
'''


def capsule_info():
    from provision import digest, regular, require
    root = Path(__file__).resolve().parents[2]
    path = root / "capsule-info.json"
    if not path.exists():
        return None
    require(str(root.parent) == "/private/var/run/calledit-qa-capsules" and root.stat().st_uid == 0 and root.stat().st_mode & 0o222 == 0,
            "root code must execute only from its protected capsule")
    require(all(parent.stat().st_uid == 0 and parent.stat().st_mode & 0o022 == 0 for parent in root.parents),
            "root capsule has a writable namespace ancestor")
    raw = regular(str(path))
    require(path.stat().st_uid == 0 and path.stat().st_mode & 0o222 == 0, "root capsule metadata is writable")
    return {"directory": str(root), "info": json.loads(raw), "sha256": digest(raw)}


def source_root():
    info = capsule_info()
    return Path(info["info"]["sourceRoot"]) if info else Path(__file__).resolve().parents[2]


def pinned_bootstrap(context_path, context_sha256):
    from provision import digest, regular, require
    raw = regular(context_path, 65_536)
    require(digest(raw) == context_sha256, "root bootstrap context pin changed")
    context = json.loads(raw)
    reference = context["sourceManifest"]
    manifest_raw = regular(str(Path(context_path).parent / reference["file"]))
    require(digest(manifest_raw) == reference["sha256"], "root bootstrap manifest pin changed")
    manifest = json.loads(manifest_raw)
    name = "tests/simulator-provisioner/root_capsule.py"
    bootstrap_bytes = regular(str(source_root() / name))
    require(digest(bootstrap_bytes) == manifest["files"][name], "root bootstrap literal source changed")
    assignments = [node for node in ast.parse(bootstrap_bytes).body if isinstance(node, ast.Assign) and
                   any(isinstance(target, ast.Name) and target.id == "ROOT_BOOTSTRAP" for target in node.targets)]
    require(len(assignments) == 1 and isinstance(assignments[0].value, ast.Constant) and isinstance(assignments[0].value.value, str),
            "fixed literal stdlib-only root bootstrap required")
    return ast.literal_eval(assignments[0].value), reference["sha256"]
