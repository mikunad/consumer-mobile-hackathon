import json
import os
import platform
import re
import stat
import time
import subprocess
import uuid
from pathlib import Path


REVYL_URL = "https://docs.revyl.com/remote-builds/caching"
CAPY_URL = "https://docs.capy.ai/cloud-phones"
REVIEWED_READABLE_SHA256 = "24c2eacdef14a2d9ae80a3aa7a83851d209ef4b8b379f9df479890f9305fadd5"
REQUIRED = {"tests/simulator-provisioner/" + name for name in
            ("provision.py", "global_pf.py", "lease.py", "job.py", "netprobe.py", "status.py", "controller.ts", "launch_provenance.py", "drive.py", "vsock_control.py", "root_capsule.py", "vsock-profile.json")}
REQUIRED.add("tests/mac-enforcement/control-sockets.c")
NONCE_DIRECTORY = Path("/private/var/run/calledit-qa-launches")
AUTHORITY_SCOPE = {"tool": "mobile.build", "platform": "ios", "source": "workspace", "provider": "revyl-remote-builds",
                   "guest": "one-clean-single-use-private-vm", "cache": "compilation-only", "entry": "archived-build-commands"}


def sealed_digest(value):
    from provision import digest
    return digest(json.dumps(value, sort_keys=True, separators=(",", ":")).encode())


def root_launch_witness(authorization, lease_pid):
    from provision import digest, regular, require
    directory = NONCE_DIRECTORY
    require(directory.resolve() == directory and directory.is_dir() and directory.stat().st_uid == 0 and
            directory.stat().st_mode & 0o022 == 0, "root-owned single-use launch ledger missing or writable")
    path = directory / (authorization["launchNonce"] + ".json")
    raw = regular(str(path), 16_384)
    info = path.stat()
    require(info.st_uid == 0 and info.st_mode & 0o222 == 0, "root-owned immutable launch witness required")
    witness = json.loads(raw)
    require(set(witness) == {"version", "chain", "chainSHA256", "rootGuard", "consumedAt"} and witness["version"] == 2 and
            witness["chain"] == {key: value for key, value in authorization.items() if key not in {"chainSHA256", "checkedAt"}} and
            witness["chainSHA256"] == authorization["chainSHA256"] and
            witness["rootGuard"]["pid"] == lease_pid and witness["rootGuard"]["uid"] == 0 and
            type(witness["consumedAt"]) is int and witness["consumedAt"] <= authorization["checkedAt"],
            "root launch witness does not bind this nonce/current boot/sealed source and guard")
    return witness, digest(raw)


def verify_trusted_launch(path, expected_sha256, run_id, consume=False):
    from provision import digest, regular, require
    from root_capsule import capsule_info, source_root
    from vsock_control import fingerprint_paths, SOURCE_SHA256
    require(isinstance(expected_sha256, str) and re.fullmatch(r"[a-f0-9]{64}", expected_sha256), "parent-pinned trusted launch-context hash required")
    path = Path(path)
    raw = regular(str(path), 65_536)
    require(digest(raw) == expected_sha256, "trusted parent launch context changed")
    capsule = capsule_info()
    if capsule:
        require(str(path) == capsule["info"]["privateContextPath"] and
                regular(capsule["info"]["originalContextPath"], 65_536) == raw, "original and immutable private root authority differ")
    context = json.loads(raw)
    require(set(context) == {"version", "runID", "launchNonce", "reviewedAuthority", "launchPlan", "sourceManifest"} and
            type(context["version"]) is int and context["version"] == 2 and context["runID"] == str(uuid.UUID(run_id)).upper(), "exact trusted mobile-build launch provenance required")
    nonce = str(uuid.UUID(context["launchNonce"])).upper()
    require(context["launchNonce"] == nonce and uuid.UUID(nonce).version == 4 and nonce != context["runID"], "unique canonical random launch nonce required")
    def reference(value, limit):
        require(isinstance(value, dict) and set(value) == {"file", "sha256"} and re.fullmatch(r"[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}", value["file"]) and
                re.fullmatch(r"[a-f0-9]{64}", value["sha256"]), "bounded captured provenance artifact required")
        content = regular(str(path.parent / value["file"]), limit)
        require(digest(content) == value["sha256"], "captured provenance artifact changed")
        if capsule:
            require(regular(str(Path(capsule["info"]["originalContextPath"]).parent / value["file"]), limit) == content,
                    "current original proof differs from immutable root authority copy")
        return content
    authority_raw = reference(context["reviewedAuthority"], 1_048_576)
    authority = json.loads(authority_raw)
    source = authority.get("source", {})
    snapshot = source.get("snapshot", "")
    require(authority.get("kind") == "reviewed-provider-guarantee-and-trusted-tool-route" and
            source.get("url") == REVYL_URL and source.get("readableContentSHA256") == REVIEWED_READABLE_SHA256 and
            digest((snapshot.rstrip("\n") + "\n").encode()) == REVIEWED_READABLE_SHA256 and
            "Every remote build runs in a clean, single-use VM" in snapshot and "Concurrent builds work in private VMs" in snapshot,
            "actual reviewed authoritative provider guarantee snapshot required")
    route = authority.get("toolRoute", {})
    require(route.get("documentation") == CAPY_URL and route.get("sourceKind") == "workspace" and
            "mobile.build" in route.get("authority", "") and "Revyl remote build commands" in route.get("execution", ""),
            "actual reviewed mobile.build-to-Revyl workspace route required")
    manifest_raw = reference(context["sourceManifest"], 1_048_576)
    manifest = json.loads(manifest_raw)
    require(set(manifest) == {"version", "runID", "launchNonce", "files", "configurationFiles"} and type(manifest["version"]) is int and manifest["version"] == 2 and
            manifest["runID"] == context["runID"] and manifest["launchNonce"] == nonce and
            isinstance(manifest["files"], dict) and REQUIRED.issubset(manifest["files"]) and len(manifest["files"]) <= 10_000 and
            isinstance(manifest["configurationFiles"], dict) and 0 < len(manifest["configurationFiles"]) <= 128 and
            all(name in manifest["files"] and fingerprint == manifest["files"][name]
                for name, fingerprint in manifest["configurationFiles"].items()),
            "unique archived launch nonce and reviewed source manifest required")
    root = source_root()
    for name, fingerprint in manifest["files"].items():
        relative = Path(name)
        require(not relative.is_absolute() and ".." not in relative.parts and re.fullmatch(r"[a-f0-9]{64}", fingerprint), "invalid archived source binding")
        require(digest(regular(str(root / relative), 64 * 1024 * 1024)) == fingerprint, "actual archived harness source differs from parent-observed launch")
        if capsule:
            require(capsule["info"]["contextSHA256"] == expected_sha256 and capsule["info"]["sourceManifestSHA256"] == digest(manifest_raw) and
                    capsule["info"]["copiedFiles"] == manifest["files"] and
                    digest(regular(str(Path(capsule["directory"]) / relative), 64 * 1024 * 1024)) == fingerprint,
                    "immutable private root code differs from the original sealed execution closure")
    code_root = Path(__file__).resolve().parents[2]
    harness = {str(file.relative_to(code_root)): manifest["files"].get(str(file.relative_to(code_root))) for file in fingerprint_paths().values()}
    require(harness and all(harness.values()) and "tests/simulator-provisioner/vsock-profile.json" in manifest["configurationFiles"] and
            manifest["files"]["tests/mac-enforcement/control-sockets.c"] == SOURCE_SHA256 and
            not {name for name in harness if name.endswith((".py", ".ts"))}.intersection(manifest["configurationFiles"]),
            "all actual harness sources and separate launch configuration must be sealed")
    plan_raw = reference(context["launchPlan"], 65_536)
    plan = json.loads(plan_raw)
    now = int(time.time() * 1000)
    require(set(plan) == {"version", "kind", "runID", "launchNonce", "sourceManifestSHA256", "issuedAt", "expiresAt", "scope"} and
            type(plan["version"]) is int and plan["version"] == 2 and plan["kind"] == "trusted-parent-prelaunch-plan" and
            plan["runID"] == context["runID"] and plan["launchNonce"] == nonce and plan["sourceManifestSHA256"] == digest(manifest_raw) and
            plan["scope"] == AUTHORITY_SCOPE,
            "sealed trusted-parent mobile.build workspace plan required; generic/local/paired or self-claimed exclusivity refused")
    require(type(plan["issuedAt"]) is int and type(plan["expiresAt"]) is int and
            now - 7_200_000 <= plan["issuedAt"] <= now + 5_000 and now < plan["expiresAt"] <= plan["issuedAt"] + 7_200_000,
            "fresh bounded single-job prelaunch plan required")
    require(platform.system() == "Darwin", "trusted plan is restricted to the actual fresh remote macOS guest")
    boot = subprocess.run(["/usr/sbin/sysctl", "-n", "kern.bootsessionuuid"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, timeout=5, check=False)
    require(boot.returncode == 0, "actual current guest boot identity unavailable")
    boot_uuid = str(uuid.UUID(boot.stdout.decode().strip())).upper()
    chain = {"version": 2, "authorityScope": AUTHORITY_SCOPE, "runID": context["runID"], "launchNonce": nonce,
             "contextSHA256": digest(raw), "sourceManifestSHA256": digest(manifest_raw), "launchPlanSHA256": digest(plan_raw),
             "harnessSHA256": sealed_digest(harness), "guardSHA256": sealed_digest({name: manifest["files"][name] for name in REQUIRED}),
             "configurationSHA256": sealed_digest(manifest["configurationFiles"]), "reviewedAuthoritySHA256": digest(authority_raw),
             "controlProfileSHA256": manifest["files"]["tests/simulator-provisioner/vsock-profile.json"],
             "controlInspectorSourceSHA256": manifest["files"]["tests/mac-enforcement/control-sockets.c"],
             "providerReadableSHA256": REVIEWED_READABLE_SHA256, "guestBootSessionUUID": boot_uuid}
    authorization = {**chain, "chainSHA256": sealed_digest(chain), "checkedAt": now}
    if consume:
        require(os.geteuid() == 0, "only the independent root guard can consume launch authority")
        birth = subprocess.run(["/bin/ps", "-p", str(os.getpid()), "-o", "lstart="], stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5, check=False)
        require(birth.returncode == 0 and bool(birth.stdout.strip()), "independent root guard birth observation unavailable")
        try:
            NONCE_DIRECTORY.mkdir(mode=0o755)
            os.chmod(NONCE_DIRECTORY, 0o755)
        except FileExistsError:
            pass
        info = NONCE_DIRECTORY.stat()
        require(NONCE_DIRECTORY.resolve() == NONCE_DIRECTORY and stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and
                info.st_mode & 0o022 == 0, "root-owned single-use launch ledger required")
        marker = NONCE_DIRECTORY / (nonce + ".json")
        fd = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as file:
            guard = {"pid": os.getpid(), "uid": 0, "birth": " ".join(birth.stdout.decode().split())}
            if capsule:
                guard.update({"capsuleDirectory": capsule["directory"], "capsuleInfoSHA256": capsule["sha256"]})
            json.dump({"version": 2, "chain": chain, "chainSHA256": authorization["chainSHA256"], "rootGuard": guard, "consumedAt": now}, file, sort_keys=True)
            file.flush()
            os.fchmod(file.fileno(), 0o444)
            os.fsync(file.fileno())
    elif NONCE_DIRECTORY.exists() and (NONCE_DIRECTORY / (nonce + ".json")).exists():
        witness = json.loads(regular(str(NONCE_DIRECTORY / (nonce + ".json")), 16_384))
        root_launch_witness(authorization, witness["rootGuard"]["pid"])
    return authorization
