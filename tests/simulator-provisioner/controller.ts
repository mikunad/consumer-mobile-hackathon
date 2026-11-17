import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import type { ProvisioningVerifier } from "../qa-adapter/evidence";
import { canonicalUUID, parseManifest, type ExpectedRun } from "../qa-adapter/manifest";

const execute = promisify(execFile);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function sealedDigest(value: Record<string, unknown>): string {
  return sha256(Buffer.from(JSON.stringify(value, (_key, entry: unknown) => {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      return Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
    }
    return entry;
  })));
}

const protectedStatusBootstrap = String.raw`
import hashlib,json,os,stat,subprocess,sys,uuid
from pathlib import Path
def need(ok):
 if not ok: raise RuntimeError("Protected read-only status admission failed")
def read(path,limit=67108864):
 path=Path(path);need(path.is_absolute() and path.resolve()==path)
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  info=os.fstat(fd);need(stat.S_ISREG(info.st_mode) and info.st_uid==0 and info.st_mode&0o222==0 and 0<info.st_size<=limit)
  with os.fdopen(os.dup(fd),'rb') as f: raw=f.read(limit+1)
  need(0<len(raw)<=limit);return raw
 finally: os.close(fd)
def sha(raw): return hashlib.sha256(raw).hexdigest()
need(os.geteuid()==0 and len(sys.argv)==6)
nonce,run,owner,folder,harness_sha=sys.argv[1:]
need(str(uuid.UUID(nonce)).upper()==nonce and uuid.UUID(nonce).version==4 and str(uuid.UUID(run)).upper()==run and owner.isdecimal() and int(owner)>1)
capsule=Path('/private/var/run/calledit-qa-capsules')/nonce
for path in (capsule,*capsule.parents):
 info=path.stat();need(path.resolve()==path and info.st_uid==0 and info.st_mode&0o022==0 and stat.S_ISDIR(info.st_mode))
 query=subprocess.run(['/bin/ls','-lde',str(path)],env={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','HOME':'/var/root','LANG':'C','LC_ALL':'C'},stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=5,check=False)
 need(query.returncode==0 and len(query.stdout)<=16384 and all(' deny ' in line and ' allow ' not in line and line.lstrip()[:1].isdigit() for line in query.stdout.decode().splitlines()[1:]))
witness_raw=read(Path('/private/var/run/calledit-qa-launches')/(nonce+'.json'),16384);witness=json.loads(witness_raw)
need(witness['chain']['runID']==run and witness['chain']['launchNonce']==nonce and witness['chain']['harnessSHA256']==harness_sha and witness['rootGuard']['capsuleDirectory']==str(capsule))
info_raw=read(capsule/'capsule-info.json',1048576);need(sha(info_raw)==witness['rootGuard']['capsuleInfoSHA256']);info=json.loads(info_raw)
for name,pin in info['copiedFiles'].items():
 relative=Path(name);need(not relative.is_absolute() and '..' not in relative.parts and str(relative)==name and sha(read(capsule/relative))==pin)
runtime=json.loads(read(Path('/private/var/run/calledit-qa-helpers')/nonce/'control-witness.json',1048576))
need(runtime['rootLaunchWitnessSHA256']==sha(witness_raw) and runtime['rootGuardPID']==witness['rootGuard']['pid'] and runtime['ownerPID']==int(owner) and str(runtime['ownerUID'])==os.environ.get('SUDO_UID') and runtime['ownerUID']>0 and runtime['outputDirectory']==folder)
directory=Path(folder);directory_info=directory.stat()
need(directory.is_absolute() and directory.resolve()==directory and stat.S_ISDIR(directory_info.st_mode) and directory_info.st_mode&0o077==0 and {'device':directory_info.st_dev,'inode':directory_info.st_ino,'uid':directory_info.st_uid}==runtime['outputDirectoryIdentity'] and directory_info.st_uid==runtime['ownerUID'])
os.environ.clear();os.environ.update({'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','HOME':'/var/root','LANG':'en_US.UTF-8','TMPDIR':folder+'/'})
harness=capsule/'tests/simulator-provisioner';script=harness/'status.py'
launcher="import runpy,sys;sys.path.insert(0,sys.argv[1]);sys.argv=sys.argv[2:];runpy.run_path(sys.argv[0],run_name='__main__')"
os.execv('/usr/bin/python3',['/usr/bin/python3','-I','-S','-c',launcher,str(harness),str(script),'--directory',folder,'--run-id',run,'--owner-pid',owner])
`;

export class LiveIsolationUnproven extends Error {
  constructor() { super("Actual authorized runner/kernel isolation provenance is unavailable or changed"); }
}

function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new LiveIsolationUnproven();
}

async function bounded(path: string, limit = 1_048_576): Promise<Buffer> {
  requireValue(isAbsolute(path) && await realpath(path) === resolve(path));
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    requireValue(stat.isFile() && stat.size > 0 && stat.size <= limit);
    const bytes = await handle.readFile();
    requireValue(bytes.length > 0 && bytes.length <= limit);
    return bytes;
  } finally { await handle.close(); }
}

type Context = {
  version: number; phase: string; ownerPID: number; simulatorUDID: string; harnessDirectory: string;
  manifestPath: string; receiptPath: string; manifestSHA256: string;
  trustedLaunchContext: string; trustedLaunchSHA256: string;
  request: { runID: string; nativeSourceRevision: string; backendSourceRevision: string; fixtureSetID: string; sourceCardOrigin: string };
};

type LiveStatus = {
  runID: string; ownerPID: number; leasePID: number; anchor: string; checkedAt: number;
  leaseReadySHA256: string; networkProofSHA256: string; sourceFingerprints: Record<string, string>;
  device: { runID: string; simulatorUDID: string; independentErase: { exit: number } } | null;
  rootLaunchWitnessSHA256: string;
  controlRuntimeSHA256: string; controller: { rootControlWitnessSHA256: string };
  runnerAuthorization: {
    version: number; runID: string; launchNonce: string; guestBootSessionUUID: string; contextSHA256: string;
    sourceManifestSHA256: string; launchPlanSHA256: string; harnessSHA256: string; guardSHA256: string;
    configurationSHA256: string; reviewedAuthoritySHA256: string; chainSHA256: string;
    providerReadableSHA256: string; authorityScope: Record<string, string>; checkedAt: number;
    controlProfileSHA256: string; controlInspectorSourceSHA256: string;
  };
};

export function createLiveProvisioningController(options: {
  contextPath: string;
  expected: ExpectedRun;
  expectedHarnessSources: Readonly<Record<string, string>>;
  expectedSourceCardOrigin: string;
}): { verify: ProvisioningVerifier; assertLiveIsolation: () => Promise<void> } {
  requireValue(isAbsolute(options.contextPath) && Object.keys(options.expectedHarnessSources).length >= 8);
  requireValue(Object.values(options.expectedHarnessSources).every((value) => /^[a-f0-9]{64}$/.test(value)));
  requireValue(options.expectedHarnessSources["status.py"] && options.expectedHarnessSources["lease.py"] && options.expectedHarnessSources["launch_provenance.py"]);
  requireValue(options.expectedHarnessSources["vsock-profile.json"] && options.expectedHarnessSources["control-sockets.c"] &&
    options.expectedHarnessSources["root_capsule.py"] && options.expectedHarnessSources["vsock_control.py"]);
  const sourcePins = Object.freeze({ ...options.expectedHarnessSources });
  const sourceMap = Object.fromEntries(Object.entries(sourcePins)
    .map(([name, hash]) => [(name === "control-sockets.c" ? "tests/mac-enforcement/" : "tests/simulator-provisioner/") + name, hash]));
  const harnessSHA256 = sealedDigest(sourceMap);
  requireValue(options.expectedSourceCardOrigin === "https://cards.qa-runtime.invalid");
  const expectedRun = canonicalUUID(options.expected.runID);
  const folder = dirname(options.contextPath);

  async function inspect(): Promise<{ context: Context; live: LiveStatus }> {
    try {
      requireValue(process.platform === "darwin");
      const context = JSON.parse((await bounded(options.contextPath, 65_536)).toString()) as Context;
      requireValue(context.version === 1 && context.phase === "isolated-runtime" && context.ownerPID > 1 &&
        canonicalUUID(context.request.runID) === expectedRun && canonicalUUID(context.simulatorUDID) === canonicalUUID(options.expected.simulatorUDID) &&
        context.request.nativeSourceRevision === options.expected.nativeSourceRevision && context.request.backendSourceRevision === options.expected.backendSourceRevision &&
        context.request.fixtureSetID === options.expected.fixtureSetID && context.request.sourceCardOrigin === options.expectedSourceCardOrigin);
      requireValue(dirname(context.manifestPath) === folder && dirname(context.receiptPath) === folder && isAbsolute(context.harnessDirectory));
      for (const [name, fingerprint] of Object.entries(sourcePins)) {
        requireValue((/^[A-Za-z0-9_-]+\.(?:py|ts)$/.test(name) || name === "vsock-profile.json" || name === "control-sockets.c") &&
          sha256(await bounded(name === "control-sockets.c" ? join(context.harnessDirectory, "..", "mac-enforcement", name) : join(context.harnessDirectory, name))) === fingerprint);
      }
      const launchBytes = await bounded(context.trustedLaunchContext, 65_536);
      const launch = JSON.parse(launchBytes.toString()) as { version: number; runID: string; launchNonce: string };
      requireValue(launch.version === 2 && launch.runID === expectedRun && canonicalUUID(launch.launchNonce) === launch.launchNonce &&
        sha256(launchBytes) === context.trustedLaunchSHA256);
      const result = await execute("/usr/bin/sudo", ["-n", "/usr/bin/python3", "-I", "-S", "-c", protectedStatusBootstrap,
        launch.launchNonce, expectedRun, String(context.ownerPID), folder, harnessSHA256], {
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: userInfo().homedir, TMPDIR: folder, LANG: "en_US.UTF-8", NODE_ENV: "test" },
        timeout: 15_000, maxBuffer: 1_048_576,
      });
      const live = JSON.parse(result.stdout) as LiveStatus;
      requireValue(canonicalUUID(live.runID) === expectedRun && live.ownerPID === context.ownerPID && live.leasePID > 1 &&
        live.checkedAt <= Date.now() + 1_000 && live.checkedAt >= Date.now() - 15_000 &&
        isDeepStrictEqual(live.sourceFingerprints, sourcePins));
      requireValue(live.device && canonicalUUID(live.device.simulatorUDID) === canonicalUUID(options.expected.simulatorUDID) && live.device.independentErase.exit === 0);
      const authorization = live.runnerAuthorization;
      requireValue(authorization.version === 2 && canonicalUUID(authorization.runID) === expectedRun &&
        canonicalUUID(authorization.launchNonce) === authorization.launchNonce && authorization.launchNonce !== expectedRun &&
        canonicalUUID(authorization.guestBootSessionUUID) === authorization.guestBootSessionUUID);
      requireValue(/^[a-f0-9]{64}$/.test(live.controlRuntimeSHA256) && live.controller.rootControlWitnessSHA256 === live.controlRuntimeSHA256);
      requireValue([authorization.contextSHA256, authorization.sourceManifestSHA256, authorization.launchPlanSHA256,
        authorization.harnessSHA256, authorization.guardSHA256, authorization.configurationSHA256,
        authorization.reviewedAuthoritySHA256, authorization.providerReadableSHA256, authorization.chainSHA256,
        authorization.controlProfileSHA256, authorization.controlInspectorSourceSHA256,
        live.rootLaunchWitnessSHA256].every((value) => /^[a-f0-9]{64}$/.test(value)));
      const { chainSHA256, checkedAt, ...chain } = authorization;
      requireValue(checkedAt >= Date.now() - 15_000 && checkedAt <= Date.now() + 1_000 && sealedDigest(chain) === chainSHA256 &&
        isDeepStrictEqual(authorization.authorityScope, { tool: "mobile.build", platform: "ios", source: "workspace", provider: "revyl-remote-builds",
          guest: "one-clean-single-use-private-vm", cache: "compilation-only", entry: "archived-build-commands" }));
      requireValue(launch.version === 2 && launch.runID === expectedRun && launch.launchNonce === authorization.launchNonce &&
        sha256(launchBytes) === context.trustedLaunchSHA256 && context.trustedLaunchSHA256 === authorization.contextSHA256);
      requireValue(harnessSHA256 === authorization.harnessSHA256 && authorization.controlProfileSHA256 === sourcePins["vsock-profile.json"] &&
        authorization.controlInspectorSourceSHA256 === sourcePins["control-sockets.c"]);
      return { context, live };
    } catch { throw new LiveIsolationUnproven(); }
  }

  const assertLiveIsolation = async () => { await inspect(); };
  const verify: ProvisioningVerifier = async ({ receipt, artifacts }) => {
    try {
      const { context, live } = await inspect();
      const manifest = parseManifest(await bounded(context.manifestPath, 16_384), options.expected);
      requireValue(manifest.sha256 === receipt.manifestSHA256 && manifest.sha256 === context.manifestSHA256 &&
        canonicalUUID(receipt.runID) === expectedRun && canonicalUUID(receipt.simulatorUDID) === canonicalUUID(options.expected.simulatorUDID));
      const records = new Map<string, Record<string, unknown>>();
      for (const artifact of receipt.artifacts) {
        requireValue(/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(artifact.file));
        const bytes = await bounded(join(folder, artifact.file));
        requireValue(sha256(bytes) === artifact.sha256 && sha256(bytes) === sha256(artifacts.get(artifact.kind) ?? new Uint8Array()));
        records.set(artifact.kind, JSON.parse(bytes.toString()) as Record<string, unknown>);
      }
      requireValue(records.size === 4);
      const created = records.get("simulator-created");
      const erased = records.get("simulator-erased");
      const empty = records.get("empty-state-verified");
      const denied = records.get("outbound-denied");
      requireValue(created && erased && empty && denied);
      for (const record of [created, erased, empty, denied]) {
        requireValue(canonicalUUID(record.runID) === expectedRun && canonicalUUID(record.simulatorUDID) === canonicalUUID(options.expected.simulatorUDID));
      }
      requireValue(isDeepStrictEqual(erased.independentLeaseErase, live.device));
      requireValue(empty.priorQAAppGroupFiles === 0 && Array.isArray(empty.systemBundleIDs) && !empty.systemBundleIDs.includes("com.mikunad.calledit.qa.host"));
      const messages = empty.messages as { counts: Record<string, number> }[];
      const contacts = empty.contacts as { count: number }[];
      requireValue(Array.isArray(messages) && messages.every((entry) => Object.values(entry.counts).every((count) => count === 0)) &&
        Array.isArray(contacts) && contacts.every((entry) => entry.count === 0));
      requireValue(denied.leaseReadySHA256 === live.leaseReadySHA256 && denied.networkProofSHA256 === live.networkProofSHA256 &&
        denied.sourceCardOrigin === options.expectedSourceCardOrigin);
      const lease = denied.lease as { runnerAuthorization: LiveStatus["runnerAuthorization"]; controlRuntimeSHA256: string };
      requireValue(lease.runnerAuthorization.chainSHA256 === live.runnerAuthorization.chainSHA256 && lease.controlRuntimeSHA256 === live.controlRuntimeSHA256);
      const kernel = denied.kernelVerification as { verifiedAt: number };
      requireValue(typeof kernel.verifiedAt === "number" && typeof denied.simulatorBootStartedAt === "number" && kernel.verifiedAt <= denied.simulatorBootStartedAt);
      await assertLiveIsolation();
      return Object.freeze({ approved: true as const, verificationID: "revyl-live-" + expectedRun.replaceAll("-", "").toLowerCase() });
    } catch { throw new LiveIsolationUnproven(); }
  };
  return Object.freeze({ verify, assertLiveIsolation });
}
